/**
 * LIVE VPS verification — runs ONLY when VPSM_LIVE=1 and credentials exist in
 * local-test/live-vps.json (gitignored).
 *
 * SAFETY RULES:
 * - every mutation happens inside a dedicated isolated directory
 *   `$HOME/.vpsm-live-test` which is removed again at the end
 * - read-only probes only outside that directory (uname, df, /proc,
 *   systemctl list, ps, journalctl)
 * - NO service start/stop/restart, NO process kill, NO sudo on the live box
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, promises as fs, createWriteStream, createReadStream } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { SshSession } from "../src/main/ssh";
import { OperationService } from "../src/main/operations";
import { MetricsService, ServicesManager, ProcessManager } from "../src/main/monitoring";
import { TransferManager } from "../src/main/transfers";
import type { ServerProfile } from "../src/shared/protocol";
import { shq } from "../src/shared/shell";

const d = process.env.VPSM_LIVE === "1" ? describe : describe.skip;

let cfg: { host: string; port: number; username: string; password: string };
let session: SshSession;
let ops: OperationService;
let transfers: TransferManager;
let home = "";
let testDir = "";
let TESTFILE_OK = false;

d("LIVE VPS (isolated directory)", () => {
  beforeAll(async () => {
    const credPath = path.join(process.cwd(), "local-test", "live-vps.json");
    cfg = JSON.parse(readFileSync(credPath, "utf8"));
    const profile: ServerProfile = {
      id: "live",
      name: "Live VPS",
      host: cfg.host,
      port: cfg.port,
      username: cfg.username,
      authMethod: "password",
      hasCredential: true,
      hasPassphrase: false,
      color: "#22c55e",
      createdAt: Date.now()
    };

    let pinned: string | undefined;
    session = new SshSession(profile, { password: cfg.password }, () => {}, {
      getHostKey: () => (pinned ? { fingerprint: pinned, keyType: "ssh", verified: true, acceptedAt: 0 } : undefined),
      onVerifiedHostKey: (info) => { pinned = info.fingerprint; },
      connectTimeoutMs: 30000
    });

    // TOFU: first connect is refused and yields the fingerprint
    try {
      await session.connect();
    } catch (e) {
      const detail = (e as { detail?: string }).detail ?? "";
      const parsed = JSON.parse(detail || "{}") as { fingerprint?: string };
      if (!parsed.fingerprint) throw e;
      console.log(`\n[LIVE] host key fingerprint (pinned for this run): ${parsed.fingerprint}\n`);
      pinned = parsed.fingerprint;
      await session.connect();
    }
    expect(session.isConnected()).toBe(true);

    ops = new OperationService({ getSession: () => session, logActivity: async () => {} });
    transfers = new TransferManager({
      getSession: () => session,
      onUpdate: () => {},
      onActivity: async () => {}
    });

    home = await ops.homeDir("live");
    testDir = `${home}/.vpsm-live-test`;
    // idempotent start: our own isolated dir is wiped and recreated fresh
    const prep = await session.exec(`rm -rf -- ${shq(testDir)} && mkdir -p -- ${shq(testDir)} && test -d ${shq(testDir)} && echo VPSM_TESTDIR_OK`, { timeoutMs: 30000 });
    expect(prep.stdout).toContain("VPSM_TESTDIR_OK");
    TESTFILE_OK = true;
  }, 60000);

  afterAll(async () => {
    // cleanup: remove ONLY the isolated test directory (escaped), verify gone
    if (session?.isConnected() && TESTFILE_OK) {
      const r = await session.exec(`rm -rf -- ${shq(testDir)} && echo VPSM_CLEAN_OK`, { timeoutMs: 30000 });
      console.log(`[LIVE] cleanup: exit=${r.code} ${r.stdout.trim()}`);
      const check = await session.exec(`test -d ${shq(testDir)} && echo EXISTS || echo GONE`, { timeoutMs: 15000 });
      expect(check.stdout).toContain("GONE");
    }
    session?.cleanup();
  });

  it("marks the isolated directory usable (create + verify)", async () => {
    const r = await session.exec(`mkdir -p -- ${shq(testDir)} && test -d ${shq(testDir)} && echo VPSM_TESTDIR_OK`, { timeoutMs: 30000 });
    expect(r.stdout).toContain("VPSM_TESTDIR_OK");
    TESTFILE_OK = true;
  });

  it("lists the home directory (real SFTP readdir)", async () => {
    const list = await ops.listDir("live", home);
    expect(list.path).toBe(home);
    expect(list.entries.some((e) => e.name === ".vpsm-live-test")).toBe(true);
  });

  it("full file-op cycle inside the isolated directory", async () => {
    // create folder + file
    await ops.runOperation("live", { kind: "mkdir", parent: testDir, name: "site" });
    const created = await ops.runOperation("live", { kind: "createFile", parent: `${testDir}/site`, name: "hello.txt", content: "live hello world" });
    expect(created.ok).toBe(true);

    // read back
    const read = await session.readFileToString(`${testDir}/site/hello.txt`, 1024 * 1024);
    expect(read.content).toBe("live hello world");

    // listing shows owner/perms (real Linux)
    const entries = await ops.listDir("live", `${testDir}/site`);
    const hello = entries.entries.find((e) => e.name === "hello.txt");
    expect(hello).toBeDefined();
    expect(hello!.owner).toBe("root");
    expect(hello!.group).toBe("root");
    expect(hello!.size).toBe(16); // "live hello world".length

    // hostile name round-trip (injection safety on the real shell)
    const hostile = `it's a ; rm -rf ~; $(id) test`;
    await ops.runOperation("live", { kind: "createFile", parent: `${testDir}/site`, name: hostile, content: "safe" });
    const l1 = await ops.listDir("live", `${testDir}/site`);
    expect(l1.entries.map((e) => e.name)).toContain(hostile);
    await ops.runOperation("live", { kind: "delete", paths: [`${testDir}/site/${hostile}`], useTrash: false });

    // rename / copy / move / duplicate
    await ops.runOperation("live", { kind: "rename", path: `${testDir}/site/hello.txt`, newName: "hello-renamed.txt" });
    const copied = await ops.runOperation("live", { kind: "copy", sources: [`${testDir}/site/hello-renamed.txt`], destDir: testDir });
    expect(copied.ok).toBe(true);
    await ops.runOperation("live", { kind: "mkdir", parent: testDir, name: "mv-target" });
    const moved = await ops.runOperation("live", { kind: "move", sources: [`${testDir}/hello-renamed.txt`], destDir: `${testDir}/mv-target` });
    expect(moved.ok).toBe(true);
    const dup = await ops.runOperation("live", { kind: "duplicate", paths: [`${testDir}/site/hello-renamed.txt`] });
    expect(dup.ok).toBe(true);
    const l2 = await ops.listDir("live", `${testDir}/site`);
    expect(l2.entries.map((e) => e.name)).toContain("hello-renamed (copy).txt");

    // moving onto an existing target must fail with a CLEAR EEXIST (live-found issue, now fixed)
    await expect(
      ops.runOperation("live", { kind: "move", sources: [`${testDir}/mv-target/hello-renamed.txt`], destDir: `${testDir}/site` })
    ).rejects.toMatchObject({ code: "EEXIST" });
  }, 90000);

  it("chmod via SFTP setstat sticks (real permission bits)", async () => {
    await ops.runOperation("live", { kind: "chmod", path: `${testDir}/site/hello-renamed.txt`, mode: "640", recursive: false });
    const st = await ops.stat("live", `${testDir}/site/hello-renamed.txt`);
    expect(st.perms).toBe("640");
  }, 60000);

  it("trash → restore → permanent delete", async () => {
    await ops.runOperation("live", { kind: "createFile", parent: `${testDir}/site`, name: "trash-live.txt", content: "to the trash and back" });
    const del = await ops.runOperation("live", { kind: "delete", paths: [`${testDir}/site/trash-live.txt`], useTrash: true });
    expect(del.ok).toBe(true);
    const items = await ops.listTrash("live");
    expect(items.some((i) => i.originalPath === `${testDir}/site/trash-live.txt`)).toBe(true);
    // restore via undo descriptor
    for (const op of del.undo!.ops) await ops.runOperation("live", op);
    const content = await session.readFileToString(`${testDir}/site/trash-live.txt`, 1024);
    expect(content.content).toBe("to the trash and back");
    // permanent delete
    const perm = await ops.runOperation("live", { kind: "delete", paths: [`${testDir}/site/trash-live.txt`], useTrash: false });
    expect(perm.ok).toBe(true);
  }, 90000);

  it("remote search and size probe", async () => {
    const results = await ops.search("live", testDir, "hello", { maxDepth: 3, maxResults: 50 });
    expect(results.length).toBeGreaterThanOrEqual(1);
    const { bytes, files } = await ops.sizeOf("live", [`${testDir}/site`]);
    expect(bytes).toBeGreaterThan(0);
    expect(files).toBeGreaterThanOrEqual(1);
  }, 60000);

  it("upload + download a 1 MB file with identical SHA256", async () => {
    const localDir = path.join(process.cwd(), "local-test");
    const localPath = path.join(localDir, "live-upload.bin");
    const remotePath = `${testDir}/live-upload.bin`;
    const buf = randomBytes(1024 * 1024);
    await fs.writeFile(localPath, buf);
    const sha = createHash("sha256").update(buf).digest("hex");

    const id = await transfers.startUpload("live", localPath, testDir, true);
    for (let i = 0; i < 120 && transfers.list().find((t) => t.id === id)?.status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 250));
    }
    const up = transfers.list().find((t) => t.id === id)!;
    expect(up.status).toBe("done");
    expect(up.totalBytes).toBe(1024 * 1024);

    // server-side size check
    const st = await session.lstat(remotePath);
    expect(Number(st.size)).toBe(1024 * 1024);

    const dlPath = path.join(localDir, "live-download.bin");
    const did = await transfers.startDownload("live", remotePath, dlPath);
    for (let i = 0; i < 120 && transfers.list().find((t) => t.id === did)?.status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 250));
    }
    const down = transfers.list().find((t) => t.id === did)!;
    expect(down.status).toBe("done");
    const dlBuf = await fs.readFile(dlPath);
    expect(createHash("sha256").update(dlBuf).digest("hex")).toBe(sha);
  }, 120000);

  it("metrics snapshot reflects the real server", async () => {
    const metrics = new MetricsService();
    await metrics.sample(session, "live"); // prime deltas
    const snap = await metrics.sample(session, "live");
    console.log(`[LIVE] cpu=${snap.cpu.percent}% cores=${snap.cpu.cores} mem=${(snap.mem.totalBytes / 1024 ** 3).toFixed(1)}GB disk=${snap.disks[0]?.percent.toFixed(0)}% os=${snap.system.os} ${snap.system.kernel}`);
    expect(snap.cpu.cores).toBeGreaterThanOrEqual(1);
    expect(snap.mem.totalBytes).toBeGreaterThan(0);
    expect(snap.disks.length).toBeGreaterThanOrEqual(1);
    expect(snap.system.kernel).toContain("5.15");
    expect(snap.system.os).toContain("Ubuntu");
  }, 60000);

  it("services + processes lists are readable (read-only)", async () => {
    const svc = new ServicesManager();
    const list = await svc.list(session, "live");
    console.log(`[LIVE] services visible: ${list.length} (running: ${list.filter((s) => s.state === "running").length})`);
    expect(list.length).toBeGreaterThan(0);

    const pm = new ProcessManager();
    const procs = await pm.list(session);
    console.log(`[LIVE] processes visible: ${procs.length}`);
    expect(procs.length).toBeGreaterThan(5);
  }, 60000);

  it("log stream reads journal lines", async () => {
    const lines: string[] = [];
    const handle = session.execStream("journalctl -n 5 --no-pager", {
      onLine: (l) => lines.push(l),
      onClose: () => {}
    });
    await new Promise((r) => setTimeout(r, 4000));
    handle.stop();
    console.log(`[LIVE] journal lines: ${lines.length}`);
    expect(lines.length).toBeGreaterThan(0);
  }, 30000);

  it("interactive PTY shell: input round-trip (echo of typed command + execution)", async () => {
    const chunks: string[] = [];
    const handle = await session.openShell({ cols: 100, rows: 30 }, {
      onData: (d) => chunks.push(d),
      onClose: () => {},
      onError: (m) => chunks.push(`[error] ${m}`)
    });
    // let the shell prompt come up, then type through the REAL input path
    await new Promise((r) => setTimeout(r, 2000));
    handle.write("echo VPSM_LIVE_PTY_OK_$((40+2))\n");
    await new Promise((r) => setTimeout(r, 3000));
    handle.end();
    const joined = chunks.join("");
    const executed = joined.includes("VPSM_LIVE_PTY_OK_42");
    const echoed = joined.includes("echo VPSM_LIVE_PTY_OK");
    console.log(`[LIVE] pty input echoed: ${echoed}, command executed: ${executed}`);
    expect(echoed).toBe(true);   // keyboard input reaches the server
    expect(executed).toBe(true); // and the command actually runs
  }, 30000);
});
