/**
 * Electron main process — application entry.
 *
 * Security posture:
 * - contextIsolation + sandbox renderer, nodeIntegration off
 * - strict CSP, no remote content
 * - all privileged work happens here; renderer talks over typed IPC only
 */

import { app, BrowserWindow, ipcMain, session, dialog, shell, safeStorage } from "electron";
import path from "node:path";
import { promises as fs } from "node:fs";
import { STORAGE_FILES, ActivityLog, HostKeyStore, ProfileStore, Vault } from "./storage";
import { SessionRegistry } from "./sessions";
import { OperationService } from "./operations";
import { TransferManager } from "./transfers";
import { MetricsService, LogService, ProcessManager, ServicesManager } from "./monitoring";
import { TerminalService } from "./terminal";
import { EDITOR_MAX_BYTES } from "../shared/paths";
import { classifyFsError, isSerializedVpsmError, vpsmError, type SerializedVpsmError } from "../shared/errors";
import type { ActivityEntry, ServerProfile, TransferState, FileOperation, LogLine } from "../shared/protocol";

let win: BrowserWindow | null = null;

/* ---------------- service singletons ---------------- */

let profiles: ProfileStore;
let vault: Vault;
let hostKeys: HostKeyStore;
let activity: ActivityLog;
let registry: SessionRegistry;
let operations: OperationService;
let transfers: TransferManager;
let metrics: MetricsService;
let services: ServicesManager;
let processes: ProcessManager;
let logService: LogService;
let terminalService: TerminalService;

function userDataDir(): string {
  // E2E/tests can isolate their data directory
  const override = process.env.VPSM_USER_DATA;
  if (override && override.trim().length > 0) return path.resolve(override);
  return app.getPath("userData");
}

function sendEvent(ev: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send("vpsm:event", ev);
}

async function initServices(): Promise<void> {
  const dir = userDataDir();
  await fs.mkdir(dir, { recursive: true });

  // Electron safeStorage-backed encoder (DPAPI / Keychain / libsecret)
  const encoder = {
    encrypt: (plain: string) => safeStorage.encryptString(plain),
    decrypt: (blob: Buffer) => safeStorage.decryptString(blob),
    isAvailable: () => safeStorage.isEncryptionAvailable()
  };

  profiles = new ProfileStore(path.join(dir, STORAGE_FILES.profiles));
  vault = new Vault(path.join(dir, STORAGE_FILES.vault), encoder);
  hostKeys = new HostKeyStore(path.join(dir, STORAGE_FILES.hostKeys));
  activity = new ActivityLog(path.join(dir, STORAGE_FILES.activity));
  await Promise.all([profiles.load(), vault.load(), hostKeys.load(), activity.load()]);

  registry = new SessionRegistry(profiles, vault, hostKeys, activity, {
    onStatus: (profileId, status, message, error) =>
      sendEvent({ type: "profile-state", profileId, state: { id: profileId, status, message, error } })
  });

  operations = new OperationService({
    getSession: (id) => registry.requireConnected(id),
    logActivity: (profileId, entry: ActivityEntry) => activity.add(profileId, entry)
  });

  transfers = new TransferManager({
    getSession: (id) => registry.requireConnected(id),
    onUpdate: (state: TransferState) => sendEvent({ type: "transfer", state }),
    onActivity: async (profileId, summary, detail) => activity.add(profileId, { at: Date.now(), kind: "transfer", summary, detail })
  });

  metrics = new MetricsService();
  services = new ServicesManager();
  processes = new ProcessManager();

  logService = new LogService(
    (id, line: LogLine) => sendEvent({ type: "log-line", streamId: id, line }),
    (id, reason) => sendEvent({ type: "log-closed", streamId: id, reason })
  );

  terminalService = new TerminalService(
    (termId, data) => sendEvent({ type: "terminal-output", termId, data }),
    (termId, reason) => sendEvent({ type: "terminal-exit", termId, reason })
  );
}

/* ---------------- helpers ---------------- */

function toNumber(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function serializeError(err: unknown): SerializedVpsmError {
  if (isSerializedVpsmError(err)) return err;
  if (err instanceof Error) return classifyFsError(err, err.message);
  return vpsmError("EINTERNAL", String(err));
}

function handle(channel: string, fn: (...args: any[]) => Promise<unknown> | unknown): void {
  ipcMain.handle(channel, async (_event, ...args: any[]) => {
    try {
      const value = await fn(...args);
      return { ok: true, value };
    } catch (err) {
      return { ok: false, error: serializeError(err) };
    }
  });
}

/* ---------------- IPC registration ---------------- */

function registerIpc(): void {
  /* profiles */
  handle("profiles:list", () => profiles.list());
  handle("profiles:save", async (input: Record<string, unknown>) => {
    const id = typeof input.id === "string" && input.id.length > 0 ? input.id : `srv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const existing = profiles.get(id);
    const name = String(input.name ?? "").trim() || `${input.username}@${input.host}`;
    const host = String(input.host ?? "").trim();
    if (!host) throw vpsmError("EINVAL_INPUT", "Host is required");
    const port = toNumber(input.port, 22);
    const authMethod = input.authMethod === "key" ? "key" : "password";
    if (authMethod === "password" && !input.secret && !existing && vault.has(id) === false) {
      throw vpsmError("EINVAL_INPUT", "Password is required for password authentication");
    }
    if (authMethod === "key" && !input.secret && !existing && vault.has(id) === false) {
      throw vpsmError("EINVAL_INPUT", "A private key is required for key authentication");
    }
    if (authMethod === "key" && typeof input.secret === "string") {
      // basic key sanity check
      if (!input.secret.includes("PRIVATE KEY")) {
        throw vpsmError("EINVAL_INPUT", "This doesn't look like an SSH private key", { detail: "Paste the full key file content, including the BEGIN/END lines." });
      }
    }
    const profile: ServerProfile = {
      id,
      name,
      host,
      port,
      username: String(input.username ?? "root").trim() || "root",
      authMethod,
      hasCredential: input.secret !== undefined ? true : vault.has(id),
      hasPassphrase: input.passphrase !== undefined ? Boolean(input.passphrase) : Boolean(existing?.hasPassphrase),
      hostKeyFingerprint: hostKeys.get(host, port)?.fingerprint,
      color: typeof input.color === "string" ? input.color : existing?.color ?? paletteColor(profiles.list().length),
      lastConnectedAt: existing?.lastConnectedAt,
      createdAt: existing?.createdAt ?? Date.now()
    };
    await profiles.upsert(profile);
    if (input.forgetSecret === true) {
      await vault.delete(id);
      profile.hasCredential = false;
      await profiles.upsert(profile);
    } else if (typeof input.secret === "string") {
      await vault.set(id, {
        password: authMethod === "password" ? input.secret : undefined,
        privateKey: authMethod === "key" ? input.secret : undefined,
        passphrase: typeof input.passphrase === "string" && input.passphrase.length > 0 ? input.passphrase : undefined
      });
    }
    return profiles.get(id);
  });
  handle("profiles:delete", async (id: string) => {
    await registry.deleteProfile(id);
  });
  handle("profiles:duplicate", async (id: string) => {
    const src = profiles.get(id);
    if (!src) throw vpsmError("EINVAL_INPUT", "Unknown profile");
    const copy: ServerProfile = {
      ...src,
      id: `srv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      name: `${src.name} (copy)`,
      createdAt: Date.now(),
      lastConnectedAt: undefined,
      hasCredential: false,
      hasPassphrase: false
    };
    await profiles.upsert(copy);
    return copy;
  });

  /* connection */
  handle("conn:connect", async (id: string, opts: { acceptHostKey?: boolean }) => {
    await registry.connect(id, opts ?? {});
    const session = registry.requireConnected(id);
    const home = await session.realpath(".");
    return { ok: true, home, username: profiles.get(id)?.username ?? "" };
  });
  handle("conn:disconnect", async (id: string) => {
    await registry.disconnect(id);
    transfers.list(id).forEach((t) => {
      if (t.status === "running" || t.status === "queued") void transfers.cancel(t.id);
    });
    metrics.invalidate(id);
  });
  handle("conn:state", (id: string) => registry.getState(id));
  handle("hostkey:get", (id: string) => {
    const p = profiles.get(id);
    if (!p) return null;
    const saved = hostKeys.get(p.host, p.port);
    return saved ? { fingerprint: saved.fingerprint, keyType: saved.keyType, verified: true } : null;
  });

  /* fs */
  handle("fs:list", (id: string, dir: string) => operations.listDir(id, dir));
  handle("fs:home", (id: string) => operations.homeDir(id));
  handle("fs:stat", (id: string, p: string) => operations.stat(id, p));
  handle("fs:operation", (id: string, op: FileOperation) => operations.runOperation(id, op));
  handle("fs:sizeOf", (id: string, paths: string[]) => operations.sizeOf(id, paths));
  handle("fs:search", (id: string, baseDir: string, query: string, opts: { maxDepth: number; maxResults: number }) =>
    operations.search(id, baseDir, query, opts));
  handle("fs:readFile", async (id: string, p: string) => {
    const session = registry.requireConnected(id);
    const entry = await operations.stat(id, p);
    if (entry.kind === "directory") throw vpsmError("EINVAL_INPUT", "This is a folder, not a file");
    const res = await session.readFileToString(p, EDITOR_MAX_BYTES);
    return res;
  });

  /* transfers */
  handle("transfers:upload", (id: string, localPath: string, remoteDir: string, overwrite: boolean) =>
    transfers.startUpload(id, localPath, remoteDir, Boolean(overwrite)));
  handle("transfers:download", (id: string, remotePath: string, localPath: string) =>
    transfers.startDownload(id, remotePath, localPath));
  handle("transfers:list", (profileId: string) => transfers.list(profileId));
  handle("transfers:cancel", (transferId: string) => transfers.cancel(transferId));
  handle("transfers:resume", (transferId: string) => transfers.resume(transferId));

  /* dialogs */
  handle("dialog:pickFile", async (mode: "open" | "save", defaultName?: string) => {
    if (!win) return null;
    if (mode === "open") {
      const r = await dialog.showOpenDialog(win, { properties: ["openFile", "multiSelections"] });
      return r.canceled ? null : r.filePaths.join("|");
    }
    const r = await dialog.showSaveDialog(win, { defaultPath: defaultName });
    return r.canceled ? null : r.filePath ?? null;
  });

  /* metrics / services / processes */
  handle("metrics:get", async (id: string) => {
    const session = registry.requireConnected(id);
    return await metrics.sample(session, id);
  });
  handle("services:list", async (id: string) => {
    const session = registry.requireConnected(id);
    return await services.list(session, id);
  });
  handle("services:action", async (id: string, unit: string, action: "start" | "stop" | "restart") => {
    const session = registry.requireConnected(id);
    return await services.action(session, unit, action);
  });
  handle("processes:list", async (id: string) => {
    const session = registry.requireConnected(id);
    return await processes.list(session);
  });
  handle("processes:kill", async (id: string, pid: number, signal?: string) => {
    const session = registry.requireConnected(id);
    await processes.kill(session, pid, signal ?? "TERM");
    await activity.add(id, { at: Date.now(), kind: "process", summary: `Killed process ${pid}`, detail: `signal=${signal ?? "TERM"}` });
  });

  /* logs */
  handle("logs:start", (id: string, opts: { mode: "journal" | "file"; unit?: string; filePath?: string }) => {
    const session = registry.requireConnected(id);
    return logService.start(session, opts);
  });
  handle("logs:stop", (streamId: string) => logService.stop(streamId));

  /* terminal */
  handle("terminal:open", async (id: string, size: { cols: number; rows: number }) => {
    const session = registry.requireConnected(id);
    return await terminalService.open(session, id, size);
  });
  handle("terminal:input", (termId: string, data: string) => terminalService.write(termId, data));
  handle("terminal:resize", (termId: string, size: { cols: number; rows: number }) => terminalService.resize(termId, size));
  handle("terminal:close", (termId: string) => terminalService.close(termId));

  /* sudo */
  handle("sudo:verify", async (id: string, password: string) => {
    const session = registry.requireConnected(id);
    const err = await session.verifySudo(String(password));
    if (!err) {
      await activity.add(id, { at: Date.now(), kind: "security", summary: "sudo credentials verified" });
    }
    return { ok: !err, error: err ?? undefined };
  });
  handle("sudo:forget", (id: string) => {
    registry.forgetSudo(id);
  });
  handle("system:power", async (id: string, action: "reboot" | "poweroff") => {
    if (action !== "reboot" && action !== "poweroff") {
      throw vpsmError("EINVAL_INPUT", "Invalid power action");
    }
    const session = registry.requireConnected(id);
    const r = await session.execSudo(`systemctl ${action}`);
    await activity.add(id, { at: Date.now(), kind: "system", summary: action === "reboot" ? "Reboot requested" : "Shutdown requested" });
    return { output: (r.stderr || r.stdout || "command sent").slice(0, 500) };
  });

  /* trash / activity */
  handle("trash:list", (profileId: string) => operations.listTrash(profileId));
  handle("trash:empty", async (profileId: string) => operations.emptyTrash(profileId));
  handle("activity:list", (profileId: string) => activity.list(profileId));
  handle("activity:clear", async () => activity.clear());

  /* app */
  handle("app:info", () => ({
    version: app.getVersion(),
    platform: process.platform,
    secureStorage: vault.secureStorageAvailable(),
    userDataDir: userDataDir()
  }));
  handle("shell:showItem", (p: string) => {
    shell.showItemInFolder(p);
  });
}

let colorCursor = 0;
const PALETTE = ["#4f8cff", "#22c55e", "#f59e0b", "#ef4444", "#a855f7", "#06b6d4", "#ec4899", "#84cc16"];
function paletteColor(_i: number): string {
  return PALETTE[colorCursor++ % PALETTE.length];
}

/* ---------------- window ---------------- */

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 420,
    minHeight: 560,
    show: false,
    backgroundColor: "#0b0f17",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(path.join(__dirname, "../renderer/index.html"));
  }

  win.once("ready-to-show", () => {
    win?.show();
    // helpful during development/testing with VPSM_TEST=1: don't steal focus
    if (process.env.VPSM_TEST === "1") win?.blur();
  });

  win.on("closed", () => {
    win = null;
  });
}

function applyCsp(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws://localhost:5183 http://localhost:5183"
        ]
      }
    });
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    applyCsp();
    await initServices();
    registerIpc();
    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    // stop every live stream before quitting
    try { logService?.stopAll(); } catch { /* noop */ }
    try { terminalService?.closeAll(); } catch { /* noop */ }
    if (process.platform !== "darwin") app.quit();
  });
}
