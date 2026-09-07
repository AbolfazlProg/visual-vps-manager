/**
 * Integration tests: the app's REAL ssh2 client against a REAL in-process
 * ssh2 SSH server with a filesystem-backed SFTP subsystem and a shell that
 * executes the app's actual commands against the same directory tree.
 *
 * These validate: auth, host-key pinning (TOFU), SFTP listing, the full
 * OperationService surface, escaping of hostile names, metrics parsing,
 * services/processes, logs, sudo, and trash round-trips.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startSshFixture, GOOD_PASSWORD, BAD_PASSWORD, SUDO_PASSWORD, USERNAME, shellEvents } from "./ssh-fixture";
import type { FixtureServer } from "./ssh-fixture";
import { promises as fs } from "node:fs";
import path from "node:path";

import { SshSession } from "../src/main/ssh";
import { OperationService } from "../src/main/operations";
import { MetricsService, ServicesManager, ProcessManager } from "../src/main/monitoring";
import { shq } from "../src/shared/shell";
import type { ServerProfile } from "../src/shared/protocol";

let fixture: FixtureServer;
let profile: ServerProfile;
let session: SshSession;
let ops: OperationService;
const root = path.join(process.cwd(), "local-test", "fixture-root");

/* emulates the SessionRegistry's host-key pinning */
let pinnedFp: string | undefined;

beforeAll(async () => {
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(root, { recursive: true });
  fixture = await startSshFixture({ simulatedFsRoot: root });
  profile = {
    id: "test-profile",
    name: "Fixture",
    host: "127.0.0.1",
    port: fixture.port,
    username: USERNAME,
    authMethod: "password",
    hasCredential: true,
    hasPassphrase: false,
    color: "#4f8cff",
    createdAt: Date.now()
  };
});

afterAll(async () => {
  try { session?.cleanup(); } catch { /* noop */ }
  await fixture?.close();
});

function makeSession(material: { password: string } = { password: GOOD_PASSWORD }): SshSession {
  return new SshSession(profile, material, () => {}, {
    getHostKey: () =>
      pinnedFp ? { fingerprint: pinnedFp, keyType: "ssh", verified: true, acceptedAt: 0 } : undefined,
    onVerifiedHostKey: (info) => {
      pinnedFp = info.fingerprint;
    },
    connectTimeoutMs: 8000
  });
}

/* ---------------- auth & connection ---------------- */

describe("connection + auth + host-key TOFU", () => {
  it("refuses the first connection: unknown host key (TOFU)", async () => {
    const s = makeSession();
    await expect(s.connect()).rejects.toMatchObject({ code: "EHOSTKEY" });
    s.cleanup();
  });

  it("rejects a wrong password once the key is pinned", async () => {
    // first connect fails at host key but the fingerprint was surfaced
    const s1 = makeSession();
    await s1.connect().catch((e) => {
      const detail = (e as { detail?: string }).detail ?? "";
      const parsed = JSON.parse(detail || "{}") as { fingerprint?: string };
      if (parsed.fingerprint) pinnedFp = parsed.fingerprint; // = user accepted in UI
    });
    const bad = makeSession({ password: BAD_PASSWORD });
    await expect(bad.connect()).rejects.toMatchObject({ code: "EAUTH" });
    bad.cleanup();
  });

  it("connects with the right password and runs exec", async () => {
    session = makeSession();
    await session.connect();
    expect(session.isConnected()).toBe(true);
    const r = await session.exec("whoami");
    expect(r.stdout.trim()).toBe("tester");
    expect(r.code).toBe(0);
  });

  it("times out a long-running command with ETIMEDOUT", async () => {
    await expect(session.exec("sleep 5", { timeoutMs: 300 })).rejects.toMatchObject({ code: "ETIMEDOUT" });
  });
});

/* ---------------- operations over SFTP + shell ---------------- */

describe("OperationService (real SFTP + escaped shell)", () => {
  beforeAll(() => {
    ops = new OperationService({
      getSession: () => session,
      logActivity: async () => {}
    });
  });

  it("lists the remote root of the fixture (real SFTP readdir)", async () => {
    const home = await ops.homeDir("x");
    expect(home.startsWith("/")).toBe(true);
    const list = await ops.listDir("x", "/");
    expect(list.path).toBe("/");
    expect(Array.isArray(list.entries)).toBe(true);
  });

  it("creates a folder and a file (SFTP + streaming write)", async () => {
    await ops.runOperation("x", { kind: "mkdir", parent: "/", name: "site" });
    const res = await ops.runOperation("x", { kind: "createFile", parent: "/site", name: "hello.txt", content: "hello world" });
    expect(res.ok).toBe(true);
    const list = await ops.listDir("x", "/site");
    expect(list.entries.map((e) => e.name)).toContain("hello.txt");
  });

  it("reads back a file with mtime for conflict detection", async () => {
    const res = await session.readFileToString("/site/hello.txt", 1024 * 1024);
    expect(res.content).toBe("hello world");
    expect(res.mtimeMs).toBeGreaterThan(0);
  });

  it("refuses unsafe names (path traversal / separators)", async () => {
    await expect(ops.runOperation("x", { kind: "mkdir", parent: "/", name: "../evil" })).rejects.toMatchObject({ code: "EINVAL_PATH" });
    await expect(ops.runOperation("x", { kind: "rename", path: "/site/hello.txt", newName: "a/b" })).rejects.toMatchObject({ code: "EINVAL_PATH" });
  });

  it("refuses EEXIST on duplicate create", async () => {
    await expect(ops.runOperation("x", { kind: "createFile", parent: "/site", name: "hello.txt" })).rejects.toMatchObject({ code: "EEXIST" });
  });

  it("handles hostile names via escaping end-to-end", async () => {
    // shell-dangerous but Windows-filesystem-legal (this suite runs on Windows)
    const hostile = `it's a ; rm -rf ~; $(id) test`;
    const res = await ops.runOperation("x", { kind: "createFile", parent: "/site", name: hostile, content: "safe" });
    expect(res.ok).toBe(true);
    const list = await ops.listDir("x", "/site");
    expect(list.entries.map((e) => e.name)).toContain(hostile);
    const renamed = await ops.runOperation("x", { kind: "rename", path: `/site/${hostile}`, newName: "renamed safe.txt" });
    expect(renamed.ok).toBe(true);
    const list2 = await ops.listDir("x", "/site");
    expect(list2.entries.map((e) => e.name)).toContain("renamed safe.txt");
    const del = await ops.runOperation("x", { kind: "delete", paths: ["/site/renamed safe.txt"], useTrash: false });
    expect(del.ok).toBe(true);
  });

  it("moves and copies via the real shell (mv/cp)", async () => {
    await ops.runOperation("x", { kind: "mkdir", parent: "/", name: "dest dir" });
    await ops.runOperation("x", { kind: "createFile", parent: "/", name: "mover.txt", content: "mv me" });
    const moved = await ops.runOperation("x", { kind: "move", sources: ["/mover.txt"], destDir: "/dest dir" });
    expect(moved.ok).toBe(true);
    const l1 = await ops.listDir("x", "/dest dir");
    expect(l1.entries.map((e) => e.name)).toContain("mover.txt");
    const copied = await ops.runOperation("x", { kind: "copy", sources: ["/dest dir/mover.txt"], destDir: "/site" });
    expect(copied.ok).toBe(true);
    const l2 = await ops.listDir("x", "/site");
    expect(l2.entries.map((e) => e.name)).toContain("mover.txt");
  });

  it("refuses moving a directory into itself", async () => {
    await expect(ops.runOperation("x", { kind: "move", sources: ["/site"], destDir: "/site/sub" })).rejects.toMatchObject({ code: "EINVAL_INPUT" });
  });

  it("deletes to trash and restores (undo round-trip)", async () => {
    await ops.runOperation("x", { kind: "createFile", parent: "/", name: "trash-me.txt", content: "bye" });
    const del = await ops.runOperation("x", { kind: "delete", paths: ["/trash-me.txt"], useTrash: true });
    expect(del.ok).toBe(true);
    expect(del.undo).toBeDefined();
    const l1 = await ops.listDir("x", "/");
    expect(l1.entries.map((e) => e.name)).not.toContain("trash-me.txt");

    for (const op of del.undo!.ops) {
      await ops.runOperation("x", op);
    }
    const l2 = await ops.listDir("x", "/");
    expect(l2.entries.map((e) => e.name)).toContain("trash-me.txt");
    const content = await session.readFileToString("/trash-me.txt", 1024);
    expect(content.content).toBe("bye");
    await ops.runOperation("x", { kind: "delete", paths: ["/trash-me.txt"], useTrash: false });
  });

  it("duplicates a file with ' (copy)' suffix", async () => {
    const dup = await ops.runOperation("x", { kind: "duplicate", paths: ["/site/hello.txt"] });
    expect(dup.ok).toBe(true);
    const l = await ops.listDir("x", "/site");
    expect(l.entries.map((e) => e.name)).toContain("hello (copy).txt");
  });

  it("changes permissions via SFTP setstat and reads them back", async () => {
    const before = await ops.stat("x", "/site/hello.txt");
    await ops.runOperation("x", { kind: "chmod", path: "/site/hello.txt", mode: "600", recursive: false });
    const st = await ops.stat("x", "/site/hello.txt");
    if (process.platform === "win32") {
      // Windows only models the read-only bit; assert the op applied something
      expect(st.perms.length).toBeGreaterThan(0);
    } else {
      expect(st.perms).toBe("600");
    }
    void before;
  });

  it("search finds files by name (find + escaped pattern)", async () => {
    const results = await ops.search("x", "/", "hello", { maxDepth: 4, maxResults: 50 });
    expect(results.some((r) => r.name.startsWith("hello"))).toBe(true);
  });

  it("sizeOf measures bytes and file count via du/find", async () => {
    const { bytes, files } = await ops.sizeOf("x", ["/site"]);
    expect(bytes).toBeGreaterThan(0);
    expect(files).toBeGreaterThanOrEqual(1);
  });

  it("writeFile preserves the file (atomic tmp+rename)", async () => {
    const res = await ops.runOperation("x", { kind: "writeFile", path: "/site/hello.txt", content: "updated content" });
    expect(res.ok).toBe(true);
    const read = await session.readFileToString("/site/hello.txt", 1024);
    expect(read.content).toBe("updated content");
    const st = await ops.stat("x", "/site/hello.txt");
    if (process.platform !== "win32") {
      expect(st.perms).toBe("600"); // preserved through tmp+rename
    }
  });

  it("editor encoding round-trip: BOM, CRLF, UTF-16 (no more mojibake)", async () => {
    // UTF-8 BOM: write with BOM, read back — encoding detected, BOM restored
    await ops.runOperation("x", { kind: "writeFile", path: "/site/bom.txt", content: "سلام bom", encoding: "utf8-bom" });
    const r1 = await session.readFileToString("/site/bom.txt", 1024);
    expect(r1.encoding).toBe("utf8-bom");
    expect(r1.content).toBe("سلام bom");
    // re-save keeps the BOM
    await ops.runOperation("x", { kind: "writeFile", path: "/site/bom.txt", content: r1.content + "!", encoding: r1.encoding });
    const raw = await session.readFileToString("/site/bom.txt", 1024);
    expect(raw.encoding).toBe("utf8-bom");
    expect(raw.content).toBe("سلام bom!");

    // CRLF: exactly preserved (no silent LF normalization)
    await ops.runOperation("x", { kind: "writeFile", path: "/site/crlf.txt", content: "line1\r\nline2\r\nline3" });
    const r2 = await session.readFileToString("/site/crlf.txt", 1024);
    expect(r2.content).toBe("line1\r\nline2\r\nline3");

    // UTF-16 LE with BOM round-trip
    await ops.runOperation("x", { kind: "writeFile", path: "/site/u16.txt", content: "wide نویسه", encoding: "utf16le" });
    const r3 = await session.readFileToString("/site/u16.txt", 1024);
    expect(r3.encoding).toBe("utf16le");
    expect(r3.content).toBe("wide نویسه");
  });

  it("ENOENT for missing files", async () => {
    await expect(ops.stat("x", "/definitely/not/here.txt")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

/* ---------------- sudo ---------------- */

describe("sudo flow", () => {
  it("rejects a wrong sudo password", async () => {
    const err = await session.verifySudo("not-the-password");
    expect(err).not.toBeNull();
    expect(err?.code).toBe("EAUTH");
  });

  it("verifies the right password and runs privileged commands", async () => {
    const err = await session.verifySudo(SUDO_PASSWORD);
    expect(err).toBeNull();
    const r = await session.execSudo("systemctl restart nginx.service");
    expect(r.code).toBe(0);
  });

  it("refuses privileged exec without a verified password", async () => {
    session.forgetSudo();
    await expect(session.execSudo("systemctl restart nginx.service")).rejects.toMatchObject({ code: "EACCES_ROOT" });
  });
});

/* ---------------- metrics / services / processes ---------------- */

describe("monitoring over the real protocol", () => {
  it("collects a full metrics snapshot", async () => {
    const metrics = new MetricsService();
    const snap = await metrics.sample(session, "test-profile");
    expect(snap.cpu.cores).toBe(2);
    expect(snap.mem.totalBytes).toBe(16384000 * 1024);
    expect(snap.disks.some((d) => d.mount === "/")).toBe(true);
    expect(snap.system.kernel).toContain("fixture");
    expect(snap.system.os).toContain("Debian");
    expect(snap.cpu.model).toContain("Fixture CPU");
  });

  it("computes CPU delta between two samples", async () => {
    const metrics = new MetricsService();
    await metrics.sample(session, "p2");
    const s2 = await metrics.sample(session, "p2");
    expect(s2.cpu.percent).toBeGreaterThanOrEqual(0);
  });

  it("lists services with correct states and enabled flags", async () => {
    const svc = new ServicesManager();
    const list = await svc.list(session, "test-profile");
    const nginx = list.find((u) => u.unit === "nginx.service");
    const redis = list.find((u) => u.unit === "redis.service");
    expect(nginx?.state).toBe("running");
    expect(nginx?.enabled).toBe(true);
    expect(redis?.state).toBe("stopped");
    expect(list.find((u) => u.unit === "broken.service")?.state).toBe("failed");
  });

  it("runs a service action through sudo", async () => {
    await session.verifySudo(SUDO_PASSWORD);
    const svc = new ServicesManager();
    const seen: Array<{ action: string; unit: string }> = [];
    shellEvents.once("systemctl", (info: { action: string; unit: string }) => seen.push(info));
    const r = await svc.action(session, "nginx.service", "restart");
    expect(r.ok).toBe(true);
    await new Promise((r2) => setTimeout(r2, 20));
    expect(seen).toContainEqual({ action: "restart", unit: "nginx.service" });
  });

  it("lists processes from ps output", async () => {
    const pm = new ProcessManager();
    const procs = await pm.list(session);
    expect(procs.length).toBeGreaterThanOrEqual(3);
    expect(procs.find((p) => p.command === "nginx")).toBeDefined();
  });

  it("kills a process (own) and escalates via sudo when not permitted", async () => {
    await session.verifySudo(SUDO_PASSWORD);
    const pm = new ProcessManager();
    await pm.kill(session, 999, "TERM");
    await pm.kill(session, 888, "KILL");
  });

  it("refuses invalid PIDs and signals", async () => {
    const pm = new ProcessManager();
    await expect(pm.kill(session, 1)).rejects.toMatchObject({ code: "EINVAL_INPUT" });
    await expect(pm.kill(session, 1234, "RMRF")).rejects.toMatchObject({ code: "EINVAL_INPUT" });
  });
});

/* ---------------- logs ---------------- */

describe("log streaming", () => {
  it("streams journalctl lines and can stop", async () => {
    const lines: string[] = [];
    const handle = session.execStream("journalctl -u nginx.service -n 10 -f --no-pager", {
      onLine: (l) => lines.push(l),
      onClose: () => {}
    });
    await new Promise((r) => setTimeout(r, 300));
    handle.stop();
    expect(lines.join("\n")).toContain("Started nginx");
  });
});

/* ---------------- shell escaping invariants ---------------- */

describe("escaping invariants", () => {
  it("shq output never contains a raw quote run that changes tokenization", () => {
    const evil = `'; rm -rf /; '`;
    const escaped = shq(evil);
    expect(escaped.startsWith("'")).toBe(true);
    expect(escaped.endsWith("'")).toBe(true);
    const inner = escaped.slice(1, -1);
    expect(inner.replace(/'\\''/g, "")).not.toContain("'");
  });
});

/* ---------------- trash listing ---------------- */

describe("trash listing", () => {
  it("lists trashed items with metadata", async () => {
    await ops.runOperation("x", { kind: "createFile", parent: "/", name: "meta-check.txt", content: "x" });
    await ops.runOperation("x", { kind: "delete", paths: ["/meta-check.txt"], useTrash: true });
    const items = await ops.listTrash("x");
    expect(items.some((i) => i.originalPath === "/meta-check.txt")).toBe(true);
    await ops.emptyTrash("x");
    const after = await ops.listTrash("x");
    expect(after).toHaveLength(0);
  });
});
