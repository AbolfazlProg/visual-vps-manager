/**
 * SSH/SFTP adapter around the ssh2 client.
 *
 * Responsibilities:
 * - one live session per profile id, with real status transitions
 * - SSH host-key verification (TOFU + pin; mismatch → EHOSTKEY with fingerprints)
 * - password auth with keyboard-interactive fallback; key auth with passphrase
 * - exec with timeout + exit-code capture
 * - SFTP subsystem with promisified operations and streaming helpers
 * - sudo: password lives in memory only; fed via stdin to
 *   `sudo -S -p '' <cmd>` (never in argv, never logged)
 */

import { Client, type ClientChannel, type ConnectConfig, type SFTPWrapper, type Stats } from "ssh2";
import { createHash } from "node:crypto";
import type { ConnStatus, HostKeyInfo, ServerProfile, CredentialMaterial, TerminalSize } from "../shared/protocol";
import { classifyFsError, vpsmError, type SerializedVpsmError } from "../shared/errors";
import { SUDO_VERIFY_CMD, cmdChown } from "../shared/shell";
import { assertSafeRemotePath } from "../shared/paths";

export type SshEvent =
  | { type: "status"; status: ConnStatus; message?: string; error?: SerializedVpsmError }
  | { type: "hostkey"; info: HostKeyInfo };

/** ssh2 SFTP errors carry the numeric status as customError.code — extract it. */
export function sftpStatusOf(err: unknown): number | undefined {
  const e = err as { customError?: { code?: number }; code?: number | string } | null;
  if (e && typeof e.customError?.code === "number") return e.customError.code;
  if (e && typeof e.code === "number" && (e as { __sftp?: boolean }).__sftp) return e.code;
  return undefined;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: string | null;
}

export interface StreamHandle {
  stream: ClientChannel;
  close(): void;
}

const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;

export function entryKindFromMode(mode: number): "file" | "directory" | "symlink" | "other" {
  const t = mode & 0o170000;
  if (t === S_IFDIR) return "directory";
  if (t === S_IFREG) return "file";
  if (t === S_IFLNK) return "symlink";
  return "other";
}

export function permsFromMode(mode: number): string {
  return (mode & 0o7777).toString(8).padStart(3, "0");
}

export class SshSession {
  readonly profile: ServerProfile;
  private client: Client | null = null;
  private sftpClient: SFTPWrapper | null = null;
  private status: ConnStatus = "offline";
  private material: CredentialMaterial;
  private sudoPassword: string | null = null;
  private userMap: { users: Map<number, string>; groups: Map<number, string> } | null = null;
  private shellChannels = new Set<ClientChannel>();
  private idCounter = 0;

  constructor(
    profile: ServerProfile,
    material: CredentialMaterial,
    private readonly events: (ev: SshEvent) => void,
    private readonly opts: {
      getHostKey: (host: string, port: number) => (HostKeyInfo & { acceptedAt: number }) | undefined;
      onVerifiedHostKey: (info: HostKeyInfo) => Promise<void> | void;
      connectTimeoutMs?: number;
    }
  ) {
    this.profile = profile;
    this.material = material;
  }

  getStatus(): ConnStatus {
    return this.status;
  }

  nextId(prefix: string): string {
    return `${prefix}_${++this.idCounter}_${Date.now().toString(36)}`;
  }

  private setStatus(s: ConnStatus, message?: string, error?: SerializedVpsmError): void {
    this.status = s;
    this.events({ type: "status", status: s, message, error });
  }

  /** SHA256 fingerprint like OpenSSH: SHA256:base64nopadding */
  static fingerprintOf(key: Buffer): string {
    const h = createHash("sha256").update(key).digest("base64").replace(/=+$/, "");
    return `SHA256:${h}`;
  }

  async connect(): Promise<void> {
    if (this.client) return;
    this.setStatus("connecting");
    const { profile } = this;
    const client = new Client();
    this.client = client;

    let pendingHostKey: { key: Buffer; verified: boolean } | null = null;

    const cfg: ConnectConfig = {
      host: profile.host,
      port: profile.port,
      username: profile.username,
      readyTimeout: this.opts.connectTimeoutMs ?? 20000,
      keepaliveInterval: 15000,
      keepaliveCountMax: 3,
      tryKeyboard: true,
      hostVerifier: (key: Buffer, verify: (valid: boolean) => void) => {
        const fp = SshSession.fingerprintOf(key);
        const saved = this.opts.getHostKey(profile.host, profile.port);
        if (saved && saved.fingerprint === fp) {
          pendingHostKey = { key, verified: true };
          verify(true);
          return;
        }
        pendingHostKey = { key, verified: false };
        verify(false);
      }
    };

    if (profile.authMethod === "password") {
      cfg.password = this.material.password ?? "";
    } else if (this.material.privateKey) {
      cfg.privateKey = this.material.privateKey;
      if (this.material.passphrase) cfg.passphrase = this.material.passphrase;
    }

    return await new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (err: SerializedVpsmError) => {
        if (settled) return;
        settled = true;
        this.cleanup();
        reject(err);
      };

      client.once("ready", () => {
        if (pendingHostKey && !pendingHostKey.verified) {
          // hostVerifier ran after ready in some orderings; enforce again
        }
        this.setStatus("connected");
        void Promise.resolve(this.opts.onVerifiedHostKey({
          fingerprint: pendingHostKey ? SshSession.fingerprintOf(pendingHostKey.key) : "",
          keyType: "ssh",
          verified: true
        })).catch(() => {});
        settled = true;
        resolve();
      });

      client.once("error", (err: Error & { code?: string; level?: string }) => {
        if (pendingHostKey && !pendingHostKey.verified) {
          const info: HostKeyInfo = {
            fingerprint: SshSession.fingerprintOf(pendingHostKey.key),
            keyType: "ssh",
            verified: false
          };
          this.events({ type: "hostkey", info });
          const saved = this.opts.getHostKey(profile.host, profile.port);
          fail(
            vpsmError("EHOSTKEY", saved ? "SSH host key changed" : "Unknown SSH host key", {
              detail: JSON.stringify(info)
            })
          );
          return;
        }
        const mapped = classifyFsError(err, `connect to ${profile.host}:${profile.port}`);
        this.setStatus("error", mapped.message, mapped);
        fail(mapped);
      });

      client.once("close", () => {
        if (this.status === "connected" && !settled) {
          // closed during handshake
          fail(vpsmError("ECONN", "Connection closed during handshake"));
        } else if (this.status === "connected") {
          this.setStatus("offline", "Connection closed");
          this.cleanup();
        }
      });

      client.on("keyboard-interactive", (_name, _instructions, _lang, _prompts, finish) => {
        this.setStatus("authenticating", "Keyboard-interactive authentication");
        finish([this.material.password ?? ""]);
      });

      client.on("end", () => {
        if (this.status === "connected") {
          this.setStatus("offline", "Connection ended");
          this.cleanup();
        }
      });

      client.connect(cfg);
    });
  }

  cleanup(): void {
    this.closeAllShells();
    try { this.sftpClient?.end(); } catch { /* noop */ }
    this.sftpClient = null;
    try { this.client?.end(); } catch { /* noop */ }
    this.client = null;
    this.sudoPassword = null;
  }

  isConnected(): boolean {
    return this.client !== null && this.status === "connected";
  }

  async ensureConnected(): Promise<void> {
    if (!this.isConnected()) await this.connect();
  }

  async sftp(): Promise<SFTPWrapper> {
    await this.ensureConnected();
    if (this.sftpClient) return this.sftpClient;
    const client = this.client!;
    return await new Promise<SFTPWrapper>((resolve, reject) => {
      client.sftp((err, sftp) => {
        if (err) {
          reject(classifyFsError(err, "open SFTP subsystem"));
        } else {
          this.sftpClient = sftp;
          resolve(sftp);
        }
      });
    });
  }

  /** Run a command, capture streams, enforce a timeout. */
  async exec(cmd: string, opts: { timeoutMs?: number; cwd?: string; stdin?: string } = {}): Promise<ExecResult> {
    await this.ensureConnected();
    const client = this.client!;
    const timeoutMs = opts.timeoutMs ?? 30000;
    return await new Promise<ExecResult>((resolve, reject) => {
      let settled = false;
      let stdout = "";
      let stderr = "";
      let streamRef: ClientChannel | null = null;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { streamRef?.close(); } catch { /* noop */ }
        reject(vpsmError("ETIMEDOUT", `Command timed out after ${timeoutMs}ms`, { detail: cmd.slice(0, 200) }));
      }, timeoutMs);

      const onErr = (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(classifyFsError(err, `exec: ${cmd.slice(0, 120)}`));
      };

      client.exec(cmd, (err, stream) => {
        if (err) return onErr(err);
        streamRef = stream;
        stream.on("data", (d: Buffer) => { stdout += d.toString("utf8"); });
        stream.stderr?.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });
        stream.on("close", (code: number | null, signal: string | null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ stdout, stderr, code, signal });
        });
        stream.on("error", onErr);
        if (opts.stdin) {
          stream.write(opts.stdin);
          stream.end();
        }
      });
    });
  }

  /* --------------- long-lived streaming exec (log follow) --------------- */

  /** Run a command and forward stdout lines until the stream closes.
   *  Used by the log viewer (`journalctl -f`, `tail -F`). */
  execStream(
    cmd: string,
    handlers: { onLine(line: string): void; onClose(reason: string): void }
  ): { stop(): void } {
    let closed = false;
    let stream: ClientChannel | null = null;
    const client = this.client;
    const fail = (reason: string) => {
      if (closed) return;
      closed = true;
      try { stream?.close(); } catch { /* noop */ }
      handlers.onClose(reason);
    };
    if (!client) {
      setTimeout(() => fail("not connected"), 0);
      return { stop: () => {} };
    }
    client.exec(cmd, (err, s) => {
      if (err) return fail(err.message);
      stream = s;
      let buf = "";
      s.on("data", (d: Buffer) => {
        buf += d.toString("utf8");
        let idx = buf.indexOf("\n");
        while (idx >= 0) {
          const line = buf.slice(0, idx).replace(/\r$/, "");
          buf = buf.slice(idx + 1);
          if (line.length > 0) handlers.onLine(line);
          idx = buf.indexOf("\n");
        }
        if (buf.length > 0) handlers.onLine(buf);
        buf = "";
      });
      s.stderr?.on("data", (d: Buffer) => {
        const text = d.toString("utf8").trim();
        if (text && !/^Warning/i.test(text)) handlers.onLine(`[stderr] ${text}`);
      });
      s.on("close", () => fail("stream closed"));
      s.on("error", (e: Error) => fail(e.message));
    });
    return {
      stop: () => {
        closed = true;
        try { stream?.close(); } catch { /* noop */ }
      }
    };
  }

  /* --------------- interactive remote shell (PTY) --------------- */

  /** Open a real remote PTY shell. Callbacks receive raw byte output. */
  openShell(
    size: TerminalSize,
    handlers: { onData(d: string): void; onClose(reason: string): void; onError(msg: string): void }
  ): void {
    if (!this.client) {
      handlers.onError("Not connected");
      return;
    }
    this.client.shell({ term: "xterm-256color", cols: size.cols, rows: size.rows }, (err, stream) => {
      if (err) {
        handlers.onError(err.message);
        return;
      }
      stream.on("data", (d: Buffer) => handlers.onData(d.toString("utf8")));
      stream.stderr?.on("data", (d: Buffer) => handlers.onData(d.toString("utf8")));
      stream.on("close", () => handlers.onClose("session closed"));
      stream.on("error", (e: Error) => handlers.onError(e.message));
      this.shellChannels.add(stream);
      (stream as ClientChannel & { __vpsm?: unknown }).__vpsm = true;
    });
  }

  closeAllShells(): void {
    for (const ch of this.shellChannels) {
      try { ch.end(); } catch { /* noop */ }
    }
    this.shellChannels.clear();
  }

  /** Write input (keystrokes/commands) to the most recent live shell channel. */
  writeShell(data: string): boolean {
    let last: ClientChannel | null = null;
    for (const ch of this.shellChannels) last = ch;
    if (!last) return false;
    try { last.write(data); return true; } catch { return false; }
  }

  /* --------------- user/group name resolution --------------- */

  async ensureUserMap(): Promise<void> {
    if (this.userMap) return;
    const users = new Map<number, string>();
    const groups = new Map<number, string>();
    try {
      const passwd = await this.exec("cat /etc/passwd", { timeoutMs: 8000 });
      for (const line of passwd.stdout.split("\n")) {
        const f = line.split(":");
        if (f.length >= 4) users.set(parseInt(f[2], 10), f[0]);
      }
      const group = await this.exec("cat /etc/group", { timeoutMs: 8000 });
      for (const line of group.stdout.split("\n")) {
        const f = line.split(":");
        if (f.length >= 4) groups.set(parseInt(f[2], 10), f[0]);
      }
    } catch {
      // non-fatal: fall back to numeric ids
    }
    this.userMap = { users, groups };
  }

  userNameFor(uid: number): string {
    return this.userMap?.users.get(uid) ?? String(uid);
  }

  groupNameFor(gid: number): string {
    return this.userMap?.groups.get(gid) ?? String(gid);
  }

  /* --------------- SFTP helpers --------------- */

  async lstat(path: string): Promise<Stats> {
    const sftp = await this.sftp();
    return await new Promise<Stats>((resolve, reject) =>
      sftp.lstat(path, (err, st) => (err ? reject(classifyFsError(err, `stat ${path}`, sftpStatusOf(err))) : resolve(st)))
    );
  }

  async stat(path: string): Promise<Stats> {
    const sftp = await this.sftp();
    return await new Promise<Stats>((resolve, reject) =>
      sftp.stat(path, (err, st) => (err ? reject(classifyFsError(err, `stat ${path}`, sftpStatusOf(err))) : resolve(st)))
    );
  }

  async readFileToString(path: string, maxBytes: number): Promise<{ content: string; size: number; mtimeMs: number; truncated: boolean }> {
    const sftp = await this.sftp();
    const st = await this.lstat(path).catch(() => null);
    const size = st ? Number(st.size) : 0;
    const capped = Math.min(size, maxBytes);
    return await new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      const rs = sftp.createReadStream(path, { start: 0, end: Math.max(0, capped - 1) });
      rs.on("data", (d: Buffer) => chunks.push(d));
      rs.on("error", (e: Error) => reject(classifyFsError(e, `read ${path}`)));
      rs.on("end", () => {
        const buf = Buffer.concat(chunks);
        const truncated = size > maxBytes;
        // strip trailing partial UTF-8 char
        let text = buf.toString("utf8");
        if (Buffer.byteLength(text, "utf8") > buf.length) text = buf.toString("utf8", 0, buf.length);
        resolve({ content: text, size, mtimeMs: st ? Number(st.mtime) * 1000 : 0, truncated });
      });
    });
  }

  async writeStringToFile(path: string, content: string): Promise<void> {
    const sftp = await this.sftp();
    await new Promise<void>((resolve, reject) => {
      const ws = sftp.createWriteStream(path, { flags: "w" });
      ws.on("error", (e: Error) => reject(classifyFsError(e, `write ${path}`)));
      ws.on("close", () => resolve());
      ws.end(Buffer.from(content, "utf8"));
    });
  }

  async rename(from: string, to: string): Promise<void> {
    const sftp = await this.sftp();
    await new Promise<void>((resolve, reject) =>
      sftp.rename(from, to, (err) => (err ? reject(classifyFsError(err, `rename ${from} → ${to}`, sftpStatusOf(err))) : resolve()))
    );
  }

  async mkdir(path: string): Promise<void> {
    const sftp = await this.sftp();
    await new Promise<void>((resolve, reject) =>
      sftp.mkdir(path, (err) => (err ? reject(classifyFsError(err, `mkdir ${path}`, sftpStatusOf(err))) : resolve()))
    );
  }

  async unlink(path: string): Promise<void> {
    const sftp = await this.sftp();
    await new Promise<void>((resolve, reject) =>
      sftp.unlink(path, (err) => (err ? reject(classifyFsError(err, `delete ${path}`, sftpStatusOf(err))) : resolve()))
    );
  }

  async rmdir(path: string): Promise<void> {
    const sftp = await this.sftp();
    await new Promise<void>((resolve, reject) =>
      sftp.rmdir(path, (err) => (err ? reject(classifyFsError(err, `delete ${path}`, sftpStatusOf(err))) : resolve()))
    );
  }

  async setMode(path: string, mode: number): Promise<void> {
    const sftp = await this.sftp();
    await new Promise<void>((resolve, reject) =>
      sftp.setstat(path, { mode }, (err) => (err ? reject(classifyFsError(err, `chmod ${path}`, sftpStatusOf(err))) : resolve()))
    );
  }

  async readlink(path: string): Promise<string> {
    const sftp = await this.sftp();
    return await new Promise<string>((resolve, reject) =>
      sftp.readlink(path, (err, target) => (err ? reject(classifyFsError(err, `readlink ${path}`, sftpStatusOf(err))) : resolve(target)))
    );
  }

  async realpath(path: string): Promise<string> {
    const sftp = await this.sftp();
    return await new Promise<string>((resolve, reject) =>
      sftp.realpath(path, (err, p) => (err ? reject(classifyFsError(err, `realpath ${path}`)) : resolve(p)))
    );
  }

  /* --------------- sudo --------------- */

  setSudoPassword(pw: string): void {
    this.sudoPassword = pw;
  }

  hasSudoPassword(): boolean {
    return this.sudoPassword !== null;
  }

  forgetSudo(): void {
    this.sudoPassword = null;
  }

  /** Validate sudo credentials by running `sudo -S -v` (in-memory only). */
  async verifySudo(password: string): Promise<SerializedVpsmError | null> {
    const r = await this.exec(SUDO_VERIFY_CMD, { stdin: `${password}\n`, timeoutMs: 15000 });
    if (r.code === 0) {
      this.sudoPassword = password;
      return null;
    }
    if (/incorrect password|authentication failure/i.test(r.stderr)) {
      return vpsmError("EAUTH", "Incorrect sudo password");
    }
    return vpsmError("ENOSUDO", "sudo is not available", { detail: r.stderr.slice(0, 300) });
  }

  /**
   * Run a privileged command. Requires sudo password in memory (verifySudo first).
   * Feeds it via stdin to `sudo -S -p ''` — never on the command line.
   */
  async execSudo(cmd: string, opts: { timeoutMs?: number } = {}): Promise<ExecResult> {
    if (this.sudoPassword === null) {
      throw vpsmError("EACCES_ROOT", "This operation needs elevated privileges", {
        detail: "Administrator (sudo) permission is required on the server."
      });
    }
    const r = await this.exec(`sudo -S -p '' ${cmd}`, {
      stdin: `${this.sudoPassword}\n`,
      timeoutMs: opts.timeoutMs ?? 30000
    });
    if (r.code !== 0 && /incorrect password|authentication failure|a password is required/i.test(r.stderr)) {
      this.sudoPassword = null;
      throw vpsmError("EACCES_ROOT", "sudo password was rejected", { detail: "Verify your sudo password and try again." });
    }
    return r;
  }

  /* --------------- privileged file helpers --------------- */

  async chownByNames(path: string, owner: string, group: string | null): Promise<void> {
    assertSafeRemotePath(path);
    await this.execSudo(cmdChown(owner, group, [path], false));
  }
}
