/**
 * In-process REAL SSH server fixture (ssh2 server mode).
 *
 * - Real SSH handshake + auth (password, keyboard-interactive, key)
 * - Real SFTP subsystem backed by a temp directory on disk
 * - Simulated remote shell that executes the exact commands the app
 *   produces against the same temp directory — validating escaping,
 *   command construction and side effects end-to-end.
 */

import { Server, utils } from "ssh2";
import { promises as fs, createReadStream, createWriteStream, type Stats as FsStats } from "node:fs";
import path from "node:path";
import os from "node:os";
import { once } from "node:events";
import { EventEmitter } from "node:events";

/** SFTP status codes (RFC draft-ietf-secsh-filexfer-02 §7) — stable protocol constants. */
const SFTP_STATUS = {
  OK: 0,
  EOF: 1,
  NO_SUCH_FILE: 2,
  PERMISSION_DENIED: 3,
  FAILURE: 4,
  BAD_MESSAGE: 5,
  NO_CONNECTION: 6,
  CONNECTION_LOST: 7,
  OP_UNSUPPORTED: 8
} as const;

export const GOOD_PASSWORD = "secret-pass";
export const BAD_PASSWORD = "wrong-pass";
export const SUDO_PASSWORD = "sudo-pass";
export const USERNAME = "tester";

export interface FixtureServer {
  port: number;
  hostKeyFingerprint: string;
  rootDir: string;
  close(): Promise<void>;
  /** hard-drop all live connections (simulates a network cut) */
  killConnections(): void;
}

/** tokenizer: POSIX-style, supports '...' with '\'' escapes (inverse of shq) */
export function tokenize(command: string): string[] {
  const out: string[] = [];
  let cur = "";
  let has = false;
  let i = 0;
  while (i < command.length) {
    const c = command[i];
    if (c === "'") {
      has = true;
      i++;
      while (i < command.length) {
        if (command[i] === "'") {
          if (command[i + 1] === "'" && command[i + 2] === "'") {
            // weird case handled below
          }
          // check '\'' pattern: ' closes then \' opens...
          if (command.startsWith("'\\''", i)) {
            cur += "'";
            i += 4;
            continue;
          }
          i++;
          break;
        }
        cur += command[i];
        i++;
      }
      continue;
    }
    if (c === '"' ) {
      has = true;
      i++;
      while (i < command.length && command[i] !== '"') {
        if (command[i] === "\\" && i + 1 < command.length) {
          cur += command[i + 1];
          i += 2;
          continue;
        }
        cur += command[i];
        i++;
      }
      i++;
      continue;
    }
    if (c === "\\" && i + 1 < command.length) {
      cur += command[i + 1];
      has = true;
      i += 2;
      continue;
    }
    if (/\s/.test(c)) {
      if (has || cur.length > 0) out.push(cur);
      cur = "";
      has = false;
      i++;
      continue;
    }
    cur += c;
    has = true;
    i++;
  }
  if (has || cur.length > 0) out.push(cur);
  return out;
}

interface PendingRead { buf: Buffer }
type Handle = { type: "file"; path: string; read?: PendingRead; write?: Buffer[]; append?: boolean; flags: string } | { type: "dir"; path: string };

export async function startSshFixture(options: { simulatedFsRoot?: string } = {}): Promise<FixtureServer> {
  const rootDir = options.simulatedFsRoot ?? await fs.mkdtemp(path.join(os.tmpdir(), "vpsm-fix-"));
  (globalThis as { __vpsmFixtureRoot?: string }).__vpsmFixtureRoot = rootDir;
  const keyPair = utils.generateKeyPairSync("rsa", { bits: 2048 }) as unknown as { private?: string; privateKey?: string; PUBLIC?: string; PRIVATE?: string };
  const hostKeyPem = (keyPair.private ?? keyPair.privateKey ?? keyPair.PRIVATE ?? String(keyPair)) as string;
  if (!hostKeyPem || !hostKeyPem.includes("PRIVATE KEY")) {
    throw new Error("Failed to generate host key for fixture");
  }

  const activeConns = new Set<import("node:net").Socket>();
  const srv = new Server(
    { hostKeys: [hostKeyPem] },
    (client) => {
      // clients legitimately disconnect during KEX (host-key TOFU rejection)
      client.on("ready", () => activeConns.add((client as unknown as { _sock?: import("node:net").Socket })._sock!));
      client.on("error", () => {});
      client.on("end", () => {});
      
      client.on("authentication", (ctx) => {
        const okUser = ctx.username === USERNAME;
        if (ctx.method === "password" && okUser && ctx.password === GOOD_PASSWORD) {
          ctx.accept();
          return;
        }
        if (ctx.method === "keyboard-interactive" && okUser) {
          ctx.prompt("Password: ", (answers) => {
            if (answers && answers[0] === GOOD_PASSWORD) ctx.accept();
            else ctx.reject(["password"]);
          });
          return;
        }
        ctx.reject(["password", "keyboard-interactive"]);
      });

      client.on("ready", () => {
        client.on("session", (accept) => {
          const session = accept();
          // accept PTY requests so client shell({ pty }) works
          session.on("pty", (acceptPty) => {
            try { acceptPty(); } catch { /* noop */ }
          });
          session.on("sftp", (acceptSftp) => {
            const sftp: SFTPStream = acceptSftp();
            attachSftp(sftp, rootDir);
          });
          session.on("exec", (acceptExec, rejectExec, info) => {
            const stream = acceptExec();
            runFakeShell(stream, info.command);
          });
          session.on("shell", (acceptShell) => {
            const stream = acceptShell();
            stream.write("Welcome to fixture shell (vpsm-test).\r\n");
            stream.write("tester@fixture:~$ ");
            stream.on("data", (d: Buffer) => {
              const text = d.toString("utf8");
              if (text.includes("\u0003")) {
                stream.write("^C\r\n");
                stream.write("tester@fixture:~$ ");
                return;
              }
              if (text.includes("\u0004") || text.includes("exit")) {
                stream.write("logout\r\n");
                stream.end();
                return;
              }
              stream.write(text);
            });
            stream.on("close", () => { /* done */ });
          });
        });
      });
    }
  );

  srv.listen(0, "127.0.0.1");
  srv.on("error", () => {});
  srv.on("connectionError", () => {});
  await once(srv, "listening");
  const addr = srv.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;

  return {
    port,
    hostKeyFingerprint: "",
    rootDir,
    killConnections: () => {
      for (const sock of [...activeConns]) { try { sock.destroy(); } catch { /* noop */ } }
    },
    close: async () => {
      for (const sock of [...activeConns]) { try { sock.destroy(); } catch { /* noop */ } }
      srv.close(() => {});
      // force-destroy lingering sockets so Node can exit
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => { try { srv.unref?.(); } catch { /* noop */ } resolve(); }, 800);
        srv.close(() => { clearTimeout(t); resolve(); });
      });
      await fs.rm(rootDir, { recursive: true, force: true }).catch(() => {});
    }
  };
}

/* ---------------- SFTP server backed by fs ---------------- */

interface SftpServerStream {
  on(event: string, cb: (...args: never[]) => void): unknown;
  status(reqId: number, code: number): void;
  handle(reqId: number, buf: Buffer): void;
  attrs(reqId: number, attrs: unknown): void;
  data(reqId: number, buf: Buffer): void;
  name(reqId: number, names: unknown): void;
}

function attachSftp(sftp: SftpServerStream, root: string): void {
  let handleSeq = 1;
  const handles = new Map<string, Handle>();
  const DEBUG_SFTP = process.env.VPSM_FIXTURE_DEBUG === "1";
  sftp.on("request", (req: { id?: number; action?: string }) => {
    if (DEBUG_SFTP) console.log("[fixture][sftp]", req?.action, req?.id);
  });

  const real = (p: string): string => {
    const np = path.posix.normalize(p);
    const abs = np.startsWith("/") ? np : "/" + np;
    return path.join(root, abs);
  };

  const attrsFromStats = (st: FsStats) => ({
    mode: st.mode,
    uid: st.uid,
    gid: st.gid,
    size: st.size,
    atime: Math.floor(st.atimeMs / 1000),
    mtime: Math.floor(st.mtimeMs / 1000)
  });

  sftp.on("REALPATH", (reqId, p) => {
    const np = path.posix.normalize(String(p));
    sftp.name(reqId, [{ filename: np.startsWith("/") ? np : "/" + np, longname: String(p) }]);
  });

  sftp.on("STAT", (reqId, p) => { void statPath(); async function statPath() {
    try {
      const st = await fs.stat(real(String(p)));
      sftp.attrs(reqId, attrsFromStats(st));
    } catch {
      sftp.status(reqId, SFTP_STATUS.NO_SUCH_FILE);
    }
  } });

  sftp.on("LSTAT", (reqId, p) => { void lstatPath(); async function lstatPath() {
    try {
      const st = await fs.lstat(real(String(p)));
      sftp.attrs(reqId, attrsFromStats(st));
    } catch {
      sftp.status(reqId, SFTP_STATUS.NO_SUCH_FILE);
    }
  } });

  sftp.on("OPENDIR", (reqId, p) => {
    void (async () => {
      try {
        await fs.access(real(String(p)));
        const h = Buffer.from([handleSeq++ & 0xff, (handleSeq >> 8) & 0xff]);
        handles.set(h.toString("hex"), { type: "dir", path: String(p) });
        sftp.handle(reqId, h);
      } catch {
        sftp.status(reqId, SFTP_STATUS.NO_SUCH_FILE);
      }
    })();
  });

  sftp.on("READDIR", (reqId, h) => {
    const hd = handles.get((h as Buffer).toString("hex"));
    if (!hd || hd.type !== "dir") {
      sftp.status(reqId, SFTP_STATUS.FAILURE);
      return;
    }
    // second+ READDIR on the same handle → EOF (client expects it to terminate)
    if (hd.dirSent) {
      sftp.status(reqId, SFTP_STATUS.EOF);
      return;
    }
    void (async () => {
      try {
        const items = await fs.readdir(real(hd.path), { withFileTypes: true });
        const names = [] as Array<{ filename: string; longname: string; attrs: unknown }>;
        for (const it of items) {
          const st = await fs.lstat(real(path.posix.join(hd.path, it.name)));
          names.push({
            filename: it.name,
            longname: it.name,
            attrs: attrsFromStats(st)
          });
        }
        hd.dirSent = true;
        if (names.length > 0) {
          sftp.name(reqId, names as never);
        } else {
          sftp.status(reqId, SFTP_STATUS.EOF);
        }
      } catch (e) {
        if (DEBUG_SFTP) console.error("[fixture][READDIR] failed:", (e as Error)?.message);
        sftp.status(reqId, SFTP_STATUS.FAILURE);
      }
    })();
  });

  sftp.on("OPEN", (reqId, p, pflags, attrs) => {
    void attrs;
    if (DEBUG_SFTP) console.log("[fixture][OPEN]", String(p), "pflags", pflags);
    void (async () => {
      const flags = String(pflags);
      const rp = real(String(p));
      try {
        // open flags come as numeric constants; translate common ones
        // ssh2 pflags: READ=1, WRITE=2, APPEND=4, CREAT=8, TRUNC=16, EXCL=32
        const wantCreate = (pflags & 8) !== 0;
        const wantTrunc = (pflags & 16) !== 0;
        const wantExcl = (pflags & 32) !== 0;
        const wantWrite = (pflags & 2) !== 0 || (pflags & 4) !== 0;
        if (wantExcl && wantCreate) {
          let st: FsStats | null = null;
          try { st = await fs.lstat(rp); } catch { st = null; }
          if (st) {
            sftp.status(reqId, SFTP_STATUS.FAILURE);
            return;
          }
        }
        if (wantWrite && wantTrunc) {
          await fs.writeFile(rp, Buffer.alloc(0), { flag: wantCreate ? "w" : "r+" });
        } else if (wantWrite && !wantTrunc) {
          await fs.access(rp).catch(async () => { await fs.writeFile(rp, Buffer.alloc(0)); });
        }
        const h = Buffer.from([handleSeq++ & 0xff, (handleSeq >> 8) & 0xff]);
        handles.set((h as Buffer).toString("hex"), { type: "file", path: String(p), flags: `0x${flags}`, buf: [] } as never);
        const handle = handles.get((h as Buffer).toString("hex")) as unknown as { type: "file"; path: string; flags: string; buf: Buffer[]; append?: boolean };
        handle.buf = [];
        handle.append = (pflags & 4) !== 0 && !wantTrunc;
        sftp.handle(reqId, h);
      } catch (e) {
        console.error("[fixture] OPEN failed:", String(p), "pflags:", pflags, (e as Error)?.message);
        sftp.status(reqId, SFTP_STATUS.FAILURE);
      }
    })();
  });

  sftp.on("WRITE", (reqId, h, offset, data) => {
    void offset;
    if (DEBUG_SFTP) {
      const hd = handles.get((h as Buffer).toString("hex"));
      console.log("[fixture][WRITE]", hd && hd.type === "file" ? hd.path : "?", typeof data === "object" ? (data as Buffer).length : String(data).length);
    }
    const hd = handles.get((h as Buffer).toString("hex"));
    if (!hd || hd.type !== "file") {
      sftp.status(reqId, SFTP_STATUS.FAILURE);
      return;
    }
    hd.buf.push(Buffer.from(data));
    sftp.status(reqId, SFTP_STATUS.OK);
  });

  sftp.on("CLOSE", (reqId, h) => {
    const hd = handles.get((h as Buffer).toString("hex"));
    if (!hd) {
      sftp.status(reqId, SFTP_STATUS.FAILURE);
      return;
    }
    handles.delete((h as Buffer).toString("hex"));
    if (hd.type === "file") {
      void (async () => {
        try {
          const rp = real(hd.path);
          const data = Buffer.concat(hd.buf ?? []);
          if (data.length > 0) {
            await fs.appendFile(rp, data);
          }
          sftp.status(reqId, SFTP_STATUS.OK);
        } catch (e) {
          console.error("[fixture] CLOSE/append failed:", hd.path, (e as Error)?.message);
          sftp.status(reqId, SFTP_STATUS.FAILURE);
        }
      })();
    } else {
      sftp.status(reqId, SFTP_STATUS.OK);
    }
  });

  sftp.on("READ", (reqId, h, offset, size) => {
    const hd = handles.get((h as Buffer).toString("hex"));
    if (!hd || hd.type !== "file") {
      sftp.status(reqId, SFTP_STATUS.FAILURE);
      return;
    }
    void (async () => {
      try {
        const rp = real(hd.path);
        const chunks: Buffer[] = [];
        const rs = createReadStream(rp, { start: offset, end: offset + size - 1 });
        for await (const c of rs) chunks.push(c as Buffer);
        const buf = Buffer.concat(chunks);
        if (buf.length === 0) sftp.status(reqId, SFTP_STATUS.EOF);
        else sftp.data(reqId, buf);
      } catch {
        sftp.status(reqId, SFTP_STATUS.FAILURE);
      }
    })();
  });

  sftp.on("MKDIR", (reqId, p, attrs) => {
    void attrs;
    void (async () => {
      try {
        await fs.mkdir(real(String(p)));
        sftp.status(reqId, SFTP_STATUS.OK);
      } catch (e) {
        sftp.status(reqId, mapErr(e));
      }
    })();
  });

  sftp.on("RMDIR", (reqId, p) => {
    void (async () => {
      try {
        await fs.rmdir(real(String(p)));
        sftp.status(reqId, SFTP_STATUS.OK);
      } catch (e) {
        sftp.status(reqId, mapErr(e));
      }
    })();
  });

  sftp.on("REMOVE", (reqId, p) => {
    void (async () => {
      try {
        await fs.unlink(real(String(p)));
        sftp.status(reqId, SFTP_STATUS.OK);
      } catch (e) {
        sftp.status(reqId, mapErr(e));
      }
    })();
  });

  sftp.on("RENAME", (reqId, from, to) => {
    void (async () => {
      try {
        await fs.rename(real(String(from)), real(String(to)));
        sftp.status(reqId, SFTP_STATUS.OK);
      } catch (e) {
        sftp.status(reqId, mapErr(e));
      }
    })();
  });

  sftp.on("SETSTAT", (reqId, p, attrs) => {
    void (async () => {
      try {
        const rp = real(String(p));
        if (typeof attrs.mode === "number") await fs.chmod(rp, attrs.mode);
        sftp.status(reqId, SFTP_STATUS.OK);
      } catch (e) {
        sftp.status(reqId, mapErr(e));
      }
    })();
  });

  sftp.on("READLINK", (reqId, p) => {
    void (async () => {
      try {
        const target = await fs.readlink(real(String(p)));
        sftp.name(reqId, [{ filename: String(target), longname: String(target) }]);
      } catch {
        sftp.status(reqId, SFTP_STATUS.NO_SUCH_FILE);
      }
    })();
  });

  sftp.on("error", () => { /* connection closing */ });
}

function mapErr(e: unknown): number {
  const code = (e as { code?: string })?.code;
  if (code === "ENOENT") return SFTP_STATUS.NO_SUCH_FILE;
  if (code === "EEXIST" || code === "ENOTEMPTY") return SFTP_STATUS.FAILURE;
  if (code === "EACCES" || code === "EPERM") return SFTP_STATUS.PERMISSION_DENIED;
  return SFTP_STATUS.FAILURE;
}

/* ---------------- fake shell over exec ---------------- */

const EventEmitterLocal = EventEmitter;

export const shellEvents = new EventEmitterLocal();

function runFakeShell(stream: { write(s: string | Buffer): void; end(): void; close(): void; stderr?: { write(s: string | Buffer): void }; exitCode?: (c: number) => void; on(ev: string, cb: (x?: unknown) => void): void; signal?(s: string): void; stdin?: unknown }, rawCommand: string): void {
  const stderrWrite = (s: string) => { try { (stream as unknown as { stderr: { write(s: string): void } }).stderr.write(s); } catch { /* noop */ } };
  const out = (s: string) => stream.write(s);

  // stdin handling for sudo -S
  let stdinText = "";
  const stdinHandler = (d: Buffer) => { stdinText += d.toString("utf8"); };
  stream.on("data", stdinHandler);

  const finish = (code: number) => {
    // send exit status to the client, then close the channel
    try { (stream as unknown as { exit(c: number): void }).exit(code); } catch { /* noop */ }
    try { (stream as unknown as { end(): void }).end(); } catch { /* noop */ }
    try { (stream as unknown as { close(): void }).close(); } catch { /* noop */ }
  };

  void (async () => {
    await new Promise((r) => setTimeout(r, 5));
    let stdinText2 = "";
    try { stdinText2 = stdinText; } catch { /* noop */ }
    void stdinText2;
    const code = await execLine(rawCommand, out, stderrWrite, () => stdinText);
    finish(code);
  })().catch(() => finish(1));
}

type OutFn = (s: string) => void;

/** Split a command line on a top-level separator, respecting quotes and parens. */
function splitTopLevel(cmd: string, sep: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let depth = 0;
  let inSq = false;
  let inDq = false;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === "'" && !inDq) { inSq = !inSq; cur += c; continue; }
    if (c === '"' && !inSq) { inDq = !inDq; cur += c; continue; }
    if (!inSq && !inDq) {
      if (c === "(") depth++;
      else if (c === ")") depth = Math.max(0, depth - 1);
      else if (depth === 0 && cmd.startsWith(sep, i)) {
        parts.push(cur);
        cur = "";
        i += sep.length - 1;
        continue;
      }
    }
    cur += c;
  }
  parts.push(cur);
  return parts;
}

async function execLine(rawCommand: string, out: OutFn, err: OutFn, getStdin: () => string, privileged = false): Promise<number> {
  let cmd = rawCommand.trim();

  // sudo wrapper
  if (cmd.startsWith("sudo ")) {
    const m = cmd.match(/^sudo\s+-S\s+-p\s+''\s+(.*)$/s);
    if (m) {
      const stdin = getStdin();
      if (!stdin.trim().startsWith(SUDO_PASSWORD)) {
        err("[sudo] password for tester: \nsudo: 1 incorrect password attempt\n");
        return 1;
      }
      cmd = m[1].trim();
      if (cmd === "-v") return 0;
      return await execLine(cmd, out, err, getStdin, true);
    } else {
      const m2 = cmd.match(/^sudo\s+-n\s+(.*)$/s);
      if (m2) return await execLine(m2[1].trim(), out, err, getStdin, true);
      else { err(`sudo: unknown invocation: ${cmd}\n`); return 1; }
    }
  }

  // drop stderr redirects the app uses
  cmd = cmd.replace(/2>\/dev\/null/g, "").trim();
  if (cmd.length === 0) return 0;

  // strip one level of wrapping parentheses: ( ... )
  if (cmd.startsWith("(") && cmd.endsWith(")")) {
    return await execLine(cmd.slice(1, -1).trim(), out, err, getStdin, privileged);
  }

  // ; sequences (lowest precedence): run all, return last code
  {
    const parts = splitTopLevel(cmd, ";").map((s) => s.trim()).filter(Boolean);
    if (parts.length > 1) {
      let code = 0;
      for (const part of parts) {
        code = await execLine(part, out, err, getStdin, privileged);
      }
      return code;
    }
  }

  // || chains: run each part until one succeeds
  {
    const parts = splitTopLevel(cmd, "||").map((s) => s.trim()).filter(Boolean);
    if (parts.length > 1) {
      let code = 1;
      for (const part of parts) {
        code = await execLine(part, out, err, getStdin, privileged);
        if (code === 0) return 0;
      }
      return code;
    }
  }

  // && chains: run each part, stop on failure
  {
    const parts = splitTopLevel(cmd, "&&").map((s) => s.trim()).filter(Boolean);
    if (parts.length > 1) {
      for (const part of parts) {
        const code = await execLine(part, out, err, getStdin, privileged);
        if (code !== 0) return code;
      }
      return 0;
    }
  }

  // && chaining (only simple two-part support used by kill check)
  if (cmd.includes("&&")) {
    const [left, right] = cmd.split("&&").map((s) => s.trim());
    const c1 = await execLine(left, out, err, getStdin);
    if (c1 !== 0) return c1;
    return await execLine(right, out, err, getStdin);
  }

  // pipes used by the app: find ... | wc -l ; find ... | head -n N
  if (cmd.includes("|")) {
    const parts = cmd.split("|").map((s) => s.trim());
    let buffer = "";
    const bufOut: OutFn = (s) => { buffer += s; };
    for (let i = 0; i < parts.length; i++) {
      const isLast = i === parts.length - 1;
      const sink = isLast ? out : bufOut;
      const part = parts[i];
      if (part.startsWith("wc -l")) {
        const lines = buffer.split("\n").filter((l) => l.length > 0).length;
        sink(`${lines}\n`);
        return 0;
      }
      if (part.startsWith("head")) {
        const tok = tokenize(part);
        let n = 10;
        const nIdx = tok.indexOf("-n");
        if (nIdx >= 0) n = parseInt(tok[nIdx + 1], 10) || 10;
        else {
          const short = tok.find((t) => /^-\d+$/.test(t));
          if (short) n = parseInt(short.slice(1), 10);
        }
        const lines = buffer.split("\n");
        sink(lines.slice(0, n).join("\n") + (lines.length > n ? "\n" : ""));
        return 0;
      }
      if (part.startsWith("find")) {
        const code = await cmdFind(part, sink, err);
        if (code !== 0) return code;
        continue;
      }
      const code = await execLine(part, sink, err, getStdin);
      if (code !== 0) return code;
    }
    return 0;
  }

  const argv = tokenize(cmd);
  if (argv.length === 0) return 0;
  const [cmd0, ...args] = argv;

  switch (cmd0) {
    case "echo": out(args.join(" ") + "\n"); return 0;
    case "true": return 0;

    case "command": out("/usr/bin/systemctl\n"); return 0;

    case "whoami": out("tester\n"); return 0;

    case "cat": {
      const p = args.find((a) => !a.startsWith("-"));
      if (!p) return 1;
      if (p === "/etc/passwd") {
        out("root:x:0:0:root:/root:/bin/bash\ntester:x:1000:1000:Tester:/home/tester:/bin/bash\nwww-data:x:33:33:www:/var/www:/usr/sbin/nologin\n");
        return 0;
      }
      if (p === "/etc/group") {
        out("root:x:0:\ntester:x:1000:\nwww-data:x:33:\n");
        return 0;
      }
      if (p === "/proc/stat") {
        out("cpu  100 0 50 1000 0 0 0 0 0 0\ncpu0 60 0 20 500 0 0 0 0 0 0\ncpu1 40 0 30 500 0 0 0 0 0 0\nintr 12345\nctxt 999\n");
        return 0;
      }
      if (p === "/proc/meminfo") {
        out("MemTotal:       16384000 kB\nMemFree:         2000000 kB\nMemAvailable:    8192000 kB\nCached:          4000000 kB\nSReclaimable:      50000 kB\nSwapTotal:       2097148 kB\nSwapFree:        1048574 kB\n");
        return 0;
      }
      if (p === "/proc/loadavg") {
        out("0.10 0.15 0.20 1/100 1234\n");
        return 0;
      }
      if (p === "/proc/uptime") {
        out("12345.67 45678.9\n");
        return 0;
      }
      if (p === "/proc/net/dev") {
        out("Inter-|   Receive                                                |  Transmit\n face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n  eth0: 1000000 10 0 0 0 0 0 0 2000000 10 0 0 0 0 0 0\n");
        return 0;
      }
      try {
        out(await fs.readFile(fixPath(p), "utf8"));
        return 0;
      } catch {
        err(`cat: ${p}: No such file or directory\n`);
        return 1;
      }
    }

    case "head": {
      // head -n 6 /etc/os-release ; head -1 /proc/cpuinfo
      const file = args.find((a) => !a.startsWith("-") && !/^\d+$/.test(a));
      const n = (() => { const idx = args.indexOf("-n"); return idx >= 0 ? parseInt(args[idx + 1], 10) : 1; })();
      if (!file) return 1;
      if (file === "/etc/os-release") {
        out(`PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\nNAME="Debian GNU/Linux"\nVERSION_ID="12"\nVERSION="12 (bookworm)"\nVERSION_CODENAME=bookworm\nID=debian\n`);
        return 0;
      }
      try {
        const text = await fs.readFile(fixPath(file), "utf8");
        out(text.split("\n").slice(0, n).join("\n") + "\n");
        return 0;
      } catch {
        err(`head: ${file}: No such file or directory\n`);
        return 1;
      }
    }

    case "grep": {
      const text = args[args.length - 1];
      if (text === "/proc/cpuinfo") {
        if (args.includes("-c")) {
          out("2\n");
        } else {
          out("model name\t: Fixture CPU Model @ 2.0GHz\n");
        }
        return 0;
      }
      return 1;
    }

    case "uname": out("Linux 6.1.0-fixture x86_64 GNU/Linux\n"); return 0;
    case "hostname": out("fixture-host\n"); return 0;
    case "nproc": out("2\n"); return 0;
    case "df": {
      out("Filesystem fstype 1B-blocks Used Available Use% Mounted on\n");
      out("/dev/svda1 ext4 421544923136 210000000000 211544923136 50% /\n");
      out("tmpfs tmpfs 1050000000 0 1050000000 0% /dev/shm\n");
      return 0;
    }

    case "ps": {
      out("  PID USER                 %CPU %MEM    RSS S COMMAND\n");
      out("    1 root                  0.0  0.5   8192 S systemd\n");
      out("  777 www-data              1.2  3.0  32768 S nginx\n");
      out("  999 tester                9.9  1.0  16384 S sleepyproc\n");
      return 0;
    }

    case "systemctl": {
      if (args.includes("--version")) { out("systemd 252 (fixture)\n"); return 0; }
      if (args.includes("list-units")) {
        out("nginx.service        loaded active   running  A high performance web server\n");
        out("docker.service       loaded active   running  Docker Application Container Engine\n");
        out("redis.service        loaded inactive dead     In-memory data store\n");
        out("broken.service       loaded failed   failed   Broken service\n");
        return 0;
      }
      if (args.includes("list-unit-files")) {
        out("nginx.service  enabled\nredis.service  disabled\nbroken.service enabled\n");
        return 0;
      }
      if (args.includes("is-active")) {
        const unit = args[args.length - 1];
        out(unit === "nginx.service" ? "active\n" : "inactive\n");
        return 0;
      }
      const action = args[0];
      const unit = args[1] ?? "";
      if (["start", "stop", "restart", "reboot", "poweroff"].includes(action)) {
        shellEvents.emit("systemctl", { action, unit });
        return 0;
      }
      return 0;
    }

    case "journalctl": {
      // live stream: emit a few lines then stay open
      out("2025-01-01T10:00:00+0000 fixture systemd[1]: Started nginx.\n");
      out("2025-01-01T10:00:01+0000 fixture nginx[777]: ready for connections\n");
      return 0;
    }

    case "tail": {
      const p = args.find((a) => a.startsWith("/"));
      try {
        const text = await fs.readFile(fixPath(p ?? ""), "utf8");
        const n = (() => { const idx = args.indexOf("-n"); return idx >= 0 ? parseInt(args[idx + 1], 10) : 10; })();
        const lines = text.split("\n").filter(Boolean);
        out(lines.slice(-n).map((l) => l + "\n").join(""));
        return 0;
      } catch {
        err(`tail: cannot open '${p}'\n`);
        return 1;
      }
    }

    case "sleep": {
      const s = parseFloat(args[0] ?? "0");
      await new Promise((r) => setTimeout(r, Math.min(s, 60) * 1000));
      return 0;
    }

    case "kill": {
      const pid = parseInt(args.find((a) => /^\d+$/.test(a)) ?? "", 10);
      if (pid === 999) return 0;
      if (pid === 888) {
        if (privileged) return 0;
        err("kill: (888): Operation not permitted\n");
        return 1;
      }
      err(`kill: (${args[1] ?? "?"}): No such process\n`);
      return 1;
    }

    case "du": {
      // du -sb -- paths
      const paths = args.filter((a) => a.startsWith("/"));
      for (const p of paths) {
        try {
          const size = await dirSize(fixPath(p));
          out(`${size}\t${p}\n`);
        } catch {
          err(`du: cannot access '${p}': No such file or directory\n`);
          return 1;
        }
      }
      return 0;
    }

    case "find": {
      return await cmdFind(cmd, out, err);
    }

    case "mkdir": {
      const paths = args.filter((a) => a.startsWith("/"));
      try {
        for (const p of paths) await fs.mkdir(fixPath(p), { recursive: args.includes("-p") });
        return 0;
      } catch (e) {
        err(`mkdir: ${errMsg(e)}\n`);
        return 1;
      }
    }

    case "mv": {
      // mv -- src... destDir | mv -- src dest
      const paths = args.filter((a) => a.startsWith("/"));
      const rest = args.filter((a) => !a.startsWith("/"));
      void rest;
      if (paths.length < 2) { err("mv: missing destination\n"); return 1; }
      const dest = paths[paths.length - 1];
      const sources = paths.slice(0, -1);
      try {
        const destStat = await fs.stat(fixPath(dest)).catch(() => null);
        const destIsDir = destStat?.isDirectory() ?? false;
        for (const s of sources) {
          const target = destIsDir ? path.posix.join(dest, path.posix.basename(s)) : dest;
          await fs.rename(fixPath(s), fixPath(target));
        }
        return 0;
      } catch (e) {
        err(`mv: ${errMsg(e)}\n`);
        return 1;
      }
    }

    case "cp": {
      const paths = args.filter((a) => a.startsWith("/"));
      if (paths.length < 2) { err("cp: missing destination\n"); return 1; }
      const dest = paths[paths.length - 1];
      const sources = paths.slice(0, -1);
      try {
        const destStat = await fs.stat(fixPath(dest)).catch(() => null);
        const destIsDir = destStat?.isDirectory() ?? false;
        for (const s of sources) {
          const target = destIsDir ? path.posix.join(dest, path.posix.basename(s)) : dest;
          await copyRecursive(fixPath(s), fixPath(target));
        }
        return 0;
      } catch (e) {
        err(`cp: ${errMsg(e)}\n`);
        return 1;
      }
    }

    case "rm": {
      const paths = args.filter((a) => a.startsWith("/"));
      for (const p of paths) {
        try {
          await fs.rm(fixPath(p), { recursive: true, force: args.includes("-f") });
        } catch (e) {
          err(`rm: ${errMsg(e)}\n`);
          return 1;
        }
      }
      return 0;
    }

    case "chmod": {
      const mode = args.find((a) => /^[0-7]{3,4}$/.test(a));
      const paths = args.filter((a) => a.startsWith("/"));
      if (!mode) return 1;
      try {
        if (args.includes("-R")) {
          for (const p of paths) await chmodRecursive(fixPath(p), parseInt(mode, 8));
        } else {
          for (const p of paths) await fs.chmod(fixPath(p), parseInt(mode, 8));
        }
        return 0;
      } catch (e) {
        err(`chmod: ${errMsg(e)}\n`);
        return 1;
      }
    }

    case "chown": {
      const spec = args.find((a) => a.includes(":") || /^[a-z_][a-z0-9_-]*$/.test(a));
      shellEvents.emit("chown", { spec, paths: args.filter((a) => a.startsWith("/")) });
      return 0;
    }

    default:
      err(`${cmd0}: command not found\n`);
      return 127;
  }
}

async function cmdFind(cmd: string, out: OutFn, err: OutFn): Promise<number> {
  const argv = tokenize(cmd);
  const baseIdx = argv.findIndex((a) => a.startsWith("/"));
  const bases: string[] = [];
  for (let i = baseIdx; i < argv.length && argv[i].startsWith("/"); i++) bases.push(argv[i]);
  const maxdepth = (() => { const i = argv.indexOf("-maxdepth"); return i >= 0 ? parseInt(argv[i + 1], 10) : 99; })();
  const inameIdx = argv.indexOf("-iname");
  const pattern = inameIdx >= 0 ? argv[inameIdx + 1] : null;
  const usePrintf = argv.includes("-printf");
  const typeFilesOnly = argv.includes("-type") && argv[argv.indexOf("-type") + 1] === "f";

  const toRegex = (pat: string): RegExp => {
    const inner = pat.replace(/^\*/, "").replace(/\*$/, "");
    return new RegExp(`^.*${escapeRegex(inner)}.*$`, "i");
  };

  const walk = async (dir: string, depth: number): Promise<void> => {
    let items: Awaited<ReturnType<typeof fs.readdir>> = [];
    try {
      items = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      const full = path.posix.join(dir, it.name);
      const rel = "/" + path.posix.relative("/", full.replace(/\\/g, "/")).replace(/\\/g, "");
      const isDir = it.isDirectory();
      if (pattern) {
        const re = toRegex(pattern);
        if (re.test(it.name)) {
          const st = await fs.lstat(full);
          if (usePrintf) out(`${isDir ? "d" : "f"}\t${st.size}\t${rel}\n`);
          else out(`${rel}\n`);
        }
      } else if (usePrintf) {
        const st = await fs.lstat(full);
        out(`${isDir ? "d" : "f"}\t${st.size}\t${rel}\n`);
      } else if (typeFilesOnly) {
        if (!isDir) out(`${rel}\n`);
      } else {
        out(`${rel}\n`);
      }
      if (isDir && depth < maxdepth) await walk(full, depth + 1);
    }
  };

  try {
    for (const b of bases) await walk(fixPath(b), 1);
    return 0;
  } catch (e) {
    err(`find: ${errMsg(e)}\n`);
    return 1;
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function fixPath(p: string): string {
  // resolves inside the fixture root; called only with app-produced paths
  const root = (globalThis as { __vpsmFixtureRoot?: string }).__vpsmFixtureRoot ?? ".";
  return path.join(root, p.replace(/^\/+/, ""));
}

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  const st = await fs.stat(dir).catch(() => null);
  if (!st) return 0;
  if (st.isFile()) return st.size;
  const items = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const it of items) {
    const full = path.join(dir, it.name);
    if (it.isDirectory()) total += await dirSize(full);
    else {
      const s = await fs.stat(full).catch(() => null);
      total += s?.size ?? 0;
    }
  }
  return total;
}

async function copyRecursive(src: string, dest: string): Promise<void> {
  const st = await fs.lstat(src);
  if (st.isDirectory()) {
    await fs.mkdir(dest, { recursive: true });
    for (const it of await fs.readdir(src, { withFileTypes: true })) {
      await copyRecursive(path.join(src, it.name), path.join(dest, it.name));
    }
  } else {
    await fs.copyFile(src, dest);
  }
}

async function chmodRecursive(dir: string, mode: number): Promise<void> {
  await fs.chmod(dir, mode).catch(() => {});
  const items = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const it of items) {
    const full = path.join(dir, it.name);
    if (it.isDirectory()) await chmodRecursive(full, mode);
    else await fs.chmod(full, mode).catch(() => {});
  }
}

function errMsg(e: unknown): string {
  const err = e as { code?: string; message?: string };
  if (err.code === "ENOENT") return "No such file or directory";
  if (err.code === "EEXIST") return "File exists";
  if (err.code === "ENOTEMPTY") return "Directory not empty";
  if (err.code === "EACCES" || err.code === "EPERM") return "Permission denied";
  return err.message ?? "error";
}

