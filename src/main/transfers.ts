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
import { assertSafeRemotePath, basenameOf, dirnameOf, joinRemotePath } from "../shared/paths";
import { validateEntryName as validateSegment } from "../shared/paths";
import type { SshSession } from "./ssh";

/** Validate each segment of a relative path (a/b/c) and join under `dir`. */
function joinRemoteDeep(dir: string, rel: string): string {
  let cur = dir;
  for (const seg of rel.split("/")) {
    if (!seg || seg === "." || seg === "..") {
      throw vpsmError("EINVAL_PATH", `Invalid path segment in folder: ${rel}`);
    }
    validateSegment(seg);
    cur = cur === "/" ? `/${seg}` : `${cur}/${seg}`;
  }
  return cur;
}

const CHUNK = 64 * 1024;

interface Internal {
  state: TransferState;
  cancelFlag: boolean;
  running: boolean;
  /** server-side cleanup command executed when the transfer settles (archives) */
  cleanupCmd?: string;
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
    // keep the file extension even if the save dialog dropped it
    if (!path.extname(localPath) && path.extname(remoteSafe)) {
      localPath += path.extname(remoteSafe);
    }
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

  /**
   * Smart upload: files AND folders. A folder is walked recursively and
   * uploaded as many parallel file transfers under remoteDir/<folderName>/…
   * Returns the number of queued file transfers.
   */
  async smartUpload(profileId: string, localPaths: string[], remoteDir: string, overwrite: boolean): Promise<number> {
    let queued = 0;
    for (const p of localPaths) {
      const st = await fs.stat(p).catch(() => null);
      if (!st) throw vpsmError("ENOENT", `Local path not found: ${p}`);
      if (st.isDirectory()) {
        queued += await this.folderUpload(profileId, p, remoteDir, overwrite);
      } else if (st.isFile()) {
        await this.startUpload(profileId, p, remoteDir, overwrite);
        queued++;
      }
    }
    return queued;
  }

  /** Recursive folder upload: one batched mkdir, then parallel file transfers. */
  private async folderUpload(profileId: string, localDir: string, remoteDir: string, _overwrite: boolean): Promise<number> {
    const rootName = path.basename(localDir);
    validateSegment(rootName);
    const remoteRoot = assertSafeRemotePath(joinRemotePath(assertSafeRemotePath(remoteDir), rootName));

    const files: Array<{ abs: string; rel: string; size: number }> = [];
    const subDirs: string[] = [];
    const walk = async (dir: string, rel: string): Promise<void> => {
      const items = await fs.readdir(dir, { withFileTypes: true });
      for (const it of items) {
        const abs = path.join(dir, it.name);
        const r = rel ? `${rel}/${it.name}` : it.name;
        if (it.isDirectory()) {
          subDirs.push(r);
          await walk(abs, r);
        } else if (it.isFile()) {
          const s = await fs.stat(abs);
          files.push({ abs, rel: r, size: s.size });
        }
      }
    };
    await walk(localDir, "");

    // one round-trip to create the whole remote tree
    const session = this.deps.getSession(profileId);
    const mkdirPaths = [remoteRoot, ...subDirs.map((d) => joinRemoteDeep(remoteRoot, d))];
    const { cmdMkdirs } = await import("../shared/shell");
    const mr = await session.exec(cmdMkdirs(mkdirPaths), { timeoutMs: 60000 }).catch((e) => { throw e; });
    if (mr.code !== 0) {
      throw vpsmError("EREMOTE", `Cannot create remote folders`, { detail: (mr.stderr || mr.stdout).slice(0, 300) });
    }

    let count = 0;
    for (const f of files) {
      const remotePath = joinRemoteDeep(remoteRoot, f.rel);
      const id = session.nextId("tr");
      this.items.set(id, {
        state: {
          id, profileId, kind: "upload",
          remotePath, localPath: f.abs,
          totalBytes: f.size,
          transferredBytes: 0,
          status: "queued",
          startedAt: Date.now(),
          speedBps: 0
        },
        cancelFlag: false,
        running: false
      });
      this.enqueue(profileId, id);
      count++;
    }
    return count;
  }

  /**
   * Folder download: pack the folder server-side (zip when available, tar.gz
   * otherwise), stream the archive down, then delete the server-side temp.
   */
  async startFolderDownload(profileId: string, remotePath: string, localPath: string): Promise<string> {
    const remoteSafe = assertSafeRemotePath(remotePath);
    const session = this.deps.getSession(profileId);
    const parent = dirnameOf(remoteSafe);
    const base = basenameOf(remoteSafe);

    const which = await session.exec("command -v zip", { timeoutMs: 8000 });
    const hasZip = which.code === 0 && which.stdout.trim().length > 0;

    const mk = await session.exec("mktemp -d", { timeoutMs: 10000 });
    if (mk.code !== 0 || !mk.stdout.trim()) {
      throw vpsmError("EREMOTE", "Cannot create a temporary folder on the server");
    }
    const tmp = mk.stdout.trim();
    const ext = hasZip ? ".zip" : ".tar.gz";
    const arch = `${tmp}/archive${ext}`;
    const { shq } = await import("../shared/shell");
    const cmd = hasZip
      ? `(cd ${shq(parent)} && zip -r -q ${shq(arch)} ${shq(base)})`
      : `(cd ${shq(parent)} && tar -czf ${shq(arch)} ${shq(base)})`;
    const r = await session.exec(cmd, { timeoutMs: 900000 });
    if (r.code !== 0) {
      await session.exec(`rm -rf ${shq(tmp)}`, { timeoutMs: 15000 }).catch(() => {});
      throw vpsmError("EREMOTE", `Packing the folder failed on the server`, { detail: (r.stderr || r.stdout).slice(0, 300) });
    }
    const st = await session.lstat(arch);
    if (!path.extname(localPath)) localPath += ext;

    const id = session.nextId("tr");
    this.items.set(id, {
      state: {
        id, profileId, kind: "download",
        remotePath: arch, localPath,
        totalBytes: Number(st.size) || 0,
        transferredBytes: 0,
        status: "queued",
        startedAt: Date.now(),
        speedBps: 0
      },
      cancelFlag: false,
      running: false,
      cleanupCmd: `rm -rf ${shq(tmp)}`
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
        if (it.cleanupCmd) {
          // remove server-side temp (archive) — best effort, never blocks the UI
          void this.deps.getSession(t.profileId).exec(it.cleanupCmd, { timeoutMs: 20000 }).catch(() => {});
        }
        // NOTE: local paths are host-native (Windows backslashes) — never run the
        // POSIX basenameOf() on them (it throws EINVAL_PATH).
        const localName = path.basename(t.localPath);
        void this.deps.onActivity(t.profileId, t.kind === "upload"
          ? `Uploaded ${basenameOf(t.remotePath)}`
          : `Downloaded ${localName}`, `${t.kind === "upload" ? t.localPath + " → " + t.remotePath : t.remotePath + " → " + t.localPath}`);
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
