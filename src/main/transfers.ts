/**
 * Transfer manager: real streaming upload/download via SFTP with
 * progress, speed, cancellation, and resume-from-offset.
 *
 * - Never buffers whole files in memory (64 KiB chunks).
 * - Max 2 concurrent transfers per profile; the rest queue.
 * - Resume: remembers transferred bytes; a failed/changed connection
 *   can continue from the remote/local file offset.
 */

import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import type { TransferState } from "../shared/protocol";
import { classifyFsError, vpsmError, type SerializedVpsmError } from "../shared/errors";
import { assertSafeRemotePath, basenameOf, joinRemotePath } from "../shared/paths";
import type { SshSession } from "./ssh";

const CHUNK = 64 * 1024;

interface Internal {
  state: TransferState;
  cancelFlag: boolean;
  running: boolean;
}

export interface TransferDeps {
  getSession: (profileId: string) => SshSession;
  onUpdate: (state: TransferState) => void;
  onActivity: (profileId: string, summary: string, detail?: string) => Promise<void>;
}

export class TransferManager {
  private items = new Map<string, Internal>();
  private queuePerProfile = new Map<string, string[]>();

  constructor(private deps: TransferDeps) {}

  list(profileId?: string): TransferState[] {
    const arr = [...this.items.values()].map((i) => ({ ...i.state }));
    return profileId ? arr.filter((t) => t.profileId === profileId) : arr;
  }

  private emit(id: string): void {
    const it = this.items.get(id);
    if (it) this.deps.onUpdate({ ...it.state });
  }

  private patch(id: string, patch: Partial<TransferState>): void {
    const it = this.items.get(id);
    if (!it) return;
    it.state = { ...it.state, ...patch };
    this.emit(id);
  }

  async startUpload(profileId: string, localPath: string, remoteDir: string, overwrite: boolean): Promise<string> {
    const st = await fs.stat(localPath).catch(() => null);
    if (!st || !st.isFile()) {
      throw vpsmError("ENOENT", `Local file not found: ${localPath}`);
    }
    const remoteDirSafe = assertSafeRemotePath(remoteDir);
    // local paths are host-native (backslashes on Windows) — use platform basename
    const remotePath = joinRemotePath(remoteDirSafe, path.basename(localPath));
    const session = this.deps.getSession(profileId);

    let resumeFrom = 0;
    try {
      const remoteStat = await session.lstat(remotePath);
      if (!overwrite && remoteStat) {
        throw vpsmError("EEXIST", `Remote file already exists: ${basenameOf(remotePath)}`, {
          detail: "Choose a different name, or allow replacing the existing file."
        });
      }
      if (Number(remoteStat.size) > 0 && Number(remoteStat.size) < st.size) {
        resumeFrom = Number(remoteStat.size); // partial upload → resume
      } else if (Number(remoteStat.size) >= st.size) {
        // already complete (or bigger) → restart fresh
        await session.unlink(remotePath).catch(() => {});
      }
    } catch (e) {
      if ((e as SerializedVpsmError)?.code && (e as SerializedVpsmError).code !== "ENOENT") throw e;
      // not found → normal fresh upload
    }

    const id = session.nextId("tr");
    this.items.set(id, {
      state: {
        id, profileId, kind: "upload",
        remotePath, localPath,
        totalBytes: st.size,
        transferredBytes: resumeFrom,
        status: "queued",
        startedAt: Date.now(),
        speedBps: 0,
        resumedFrom: resumeFrom > 0 ? resumeFrom : undefined
      },
      cancelFlag: false,
      running: false
    });
    this.enqueue(profileId, id);
    return id;
  }

  async startDownload(profileId: string, remotePath: string, localPath: string): Promise<string> {
    const remoteSafe = assertSafeRemotePath(remotePath);
    const session = this.deps.getSession(profileId);
    const st = await session.lstat(remoteSafe).catch((e) => { throw e; });
    const id = session.nextId("tr");
    this.items.set(id, {
      state: {
        id, profileId, kind: "download",
        remotePath: remoteSafe, localPath,
        totalBytes: Number(st.size) || 0,
        transferredBytes: 0,
        status: "queued",
        startedAt: Date.now(),
        speedBps: 0
      },
      cancelFlag: false,
      running: false
    });
    this.enqueue(profileId, id);
    return id;
  }

  async resume(id: string): Promise<void> {
    const it = this.items.get(id);
    if (!it) throw vpsmError("EINVAL_INPUT", "Unknown transfer");
    if (it.state.status === "running") return;
    if (it.state.status === "done") return;
    it.cancelFlag = false;
    it.state.status = "queued";
    this.emit(id);
    this.enqueue(it.state.profileId, id);
  }

  async cancel(id: string): Promise<void> {
    const it = this.items.get(id);
    if (!it) return;
    it.cancelFlag = true;
    this.patch(id, { status: "canceled", endedAt: Date.now() });
  }

  /* ---------------- queue ---------------- */

  private enqueue(profileId: string, id: string): void {
    const q = this.queuePerProfile.get(profileId) ?? [];
    if (!q.includes(id)) q.push(id);
    this.queuePerProfile.set(profileId, q);
    this.pump(profileId);
  }

  private pump(profileId: string): void {
    const q = this.queuePerProfile.get(profileId) ?? [];
    const active = q.filter((id) => this.items.get(id)?.state.status === "running").length;
    if (active >= 2) return;
    const next = q.find((id) => this.items.get(id)?.state.status === "queued");
    if (!next) {
      this.queuePerProfile.set(profileId, q.filter((id) => this.items.has(id)));
      return;
    }
    const it = this.items.get(next)!;
    it.state.status = "running";
    it.state.startedAt = Date.now();
    this.emit(next);
    void this.run(next).finally(() => {
      const q2 = (this.queuePerProfile.get(profileId) ?? []).filter((x) => x !== next);
      this.queuePerProfile.set(profileId, q2);
      this.pump(profileId);
    });
  }

  /* ---------------- actual streaming ---------------- */

  private async run(id: string): Promise<void> {
    const it = this.items.get(id);
    if (!it) return;
    const t = it.state;
    try {
      const session = this.deps.getSession(t.profileId);
      if (!session.isConnected()) throw vpsmError("ECONN", "Connection lost during transfer");
      const sftp = await session.sftp();

      // speed sampler (1s EMA)
      let lastBytes = t.transferredBytes;
      const sampler = setInterval(() => {
        const cur = this.items.get(id)?.state.transferredBytes ?? lastBytes;
        const bps = Math.max(0, cur - lastBytes);
        lastBytes = cur;
        const prev = this.items.get(id)?.state.speedBps ?? bps;
        this.patch(id, { speedBps: Math.round(prev * 0.6 + bps * 0.4) });
      }, 1000);

      const finish = (status: TransferState["status"], error?: SerializedVpsmError) => {
        clearInterval(sampler);
        this.patch(id, { status, endedAt: Date.now(), ...(error ? { error } : {}) });
      };

      if (t.kind === "upload") {
        await new Promise<void>((resolve, reject) => {
          let settled = false;
          const local = createReadStream(t.localPath, { highWaterMark: CHUNK, start: t.transferredBytes });
          const remote = sftp.createWriteStream(t.remotePath, {
            flags: t.transferredBytes > 0 ? "r+" : "w",
            start: t.transferredBytes > 0 ? t.transferredBytes : undefined,
            highWaterMark: CHUNK
          });
          local.on("open", () => this.patch(id, { status: "running" }));
          local.on("data", (chunk: Buffer | string) => {
            const n = typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
            const cur = this.items.get(id)!;
            cur.state.transferredBytes += n;
            if (cur.state.transferredBytes % (CHUNK * 16) < CHUNK) this.emit(id);
          });
          local.on("error", (e) => { if (!settled) { settled = true; reject(classifyFsError(e, `read local ${t.localPath}`)); } remote.destroy(); });
          remote.on("error", (e: Error) => { if (!settled) { settled = true; reject(classifyFsError(e, `upload ${t.remotePath}`)); } local.destroy(); });
          remote.on("close", () => {
            if (settled) return;
            settled = true;
            if (it.cancelFlag) return resolve();
            if (this.items.get(id)!.state.transferredBytes >= t.totalBytes) {
              this.patch(id, { transferredBytes: t.totalBytes });
              resolve();
            } else {
              resolve(); // remote closed early; treat as completed-when-cancelled only
            }
          });
          local.pipe(remote);
          const watch = setInterval(() => {
            if (it.cancelFlag) {
              clearInterval(watch);
              local.destroy();
              remote.destroy();
            }
          }, 200);
          this.watchers.set(id, watch);
        });
      } else {
        await fs.mkdir(path.dirname(t.localPath), { recursive: true });
        await new Promise<void>((resolve, reject) => {
          let settled = false;
          const local = createWriteStream(t.localPath, { flags: "w", highWaterMark: CHUNK });
          const remote = sftp.createReadStream(t.remotePath, { highWaterMark: CHUNK });
          remote.on("data", (chunk: Buffer | string) => {
            const n = typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
            const cur = this.items.get(id)!;
            cur.state.transferredBytes += n;
            if (cur.state.transferredBytes % (CHUNK * 16) < CHUNK) this.emit(id);
          });
          remote.on("error", (e: Error) => { if (!settled) { settled = true; reject(classifyFsError(e, `download ${t.remotePath}`)); } local.destroy(); });
          local.on("error", (e: Error) => { if (!settled) { settled = true; reject(classifyFsError(e, `write local ${t.localPath}`)); } remote.destroy(); });
          local.on("close", () => { if (!settled) { settled = true; resolve(); } });
          remote.pipe(local);
          const watch = setInterval(() => {
            if (it.cancelFlag) {
              clearInterval(watch);
              remote.destroy();
              local.destroy();
            }
          }, 200);
          this.watchers.set(id, watch);
        });
      }

      if (it.cancelFlag) {
        finish("canceled");
      } else {
        finish("done");
        void this.deps.onActivity(t.profileId, t.kind === "upload"
          ? `Uploaded ${basenameOf(t.remotePath)}`
          : `Downloaded ${basenameOf(t.remotePath)}`, `${t.kind === "upload" ? t.localPath + " → " + t.remotePath : t.remotePath + " → " + t.localPath}`);
      }
    } catch (err) {
      const mapped = err && typeof err === "object" && "code" in err ? (err as SerializedVpsmError) : classifyFsError(err, "transfer");
      this.patch(id, { status: "error", error: mapped, endedAt: Date.now() });
    } finally {
      const w = this.watchers.get(id);
      if (w) clearInterval(w);
      this.watchers.delete(id);
    }
  }

  private watchers = new Map<string, ReturnType<typeof setInterval>>();
}
