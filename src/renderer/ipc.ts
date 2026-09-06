import type { SerializedVpsmError, VpsmErrorCode } from "../shared/errors";

/** Preload API surface (see preload.ts). Declared once, consumed via hooks. */
export interface IpcEnvelope<T> {
  ok: boolean;
  value?: T;
  error?: SerializedVpsmError;
}

export interface VpsmBridge {
  listProfiles(): Promise<IpcEnvelope<import("../shared/protocol").ServerProfile[]>>;
  saveProfile(input: Record<string, unknown>): Promise<IpcEnvelope<import("../shared/protocol").ServerProfile>>;
  deleteProfile(id: string): Promise<IpcEnvelope<void>>;
  duplicateProfile(id: string): Promise<IpcEnvelope<import("../shared/protocol").ServerProfile>>;

  connect(id: string, opts?: { acceptHostKey?: boolean }): Promise<IpcEnvelope<{ home: string; username: string }>>;
  disconnect(id: string): Promise<IpcEnvelope<void>>;
  getState(id: string): Promise<IpcEnvelope<import("../shared/protocol").ServerState>>;
  getHostKey(id: string): Promise<IpcEnvelope<{ fingerprint: string; keyType: string; verified: boolean } | null>>;

  listDir(id: string, dir: string): Promise<IpcEnvelope<import("../shared/protocol").ListDirResult>>;
  homeDir(id: string): Promise<IpcEnvelope<string>>;
  stat(id: string, p: string): Promise<IpcEnvelope<import("../shared/protocol").FileEntry>>;
  runOperation(id: string, op: import("../shared/protocol").FileOperation): Promise<IpcEnvelope<import("../shared/protocol").OperationResult>>;
  sizeOf(id: string, paths: string[]): Promise<IpcEnvelope<{ bytes: number; files: number }>>;
  search(id: string, baseDir: string, query: string, opts: { maxDepth: number; maxResults: number }): Promise<IpcEnvelope<import("../shared/protocol").SearchResult[]>>;
  readFile(id: string, p: string): Promise<IpcEnvelope<{ content: string; size: number; mtimeMs: number; truncated: boolean }>>;

  startUpload(id: string, localPath: string, remoteDir: string, overwrite: boolean): Promise<IpcEnvelope<string>>;
  startDownload(id: string, remotePath: string, localPath: string): Promise<IpcEnvelope<string>>;
  listTransfers(profileId: string): Promise<IpcEnvelope<import("../shared/protocol").TransferState[]>>;
  cancelTransfer(transferId: string): Promise<IpcEnvelope<void>>;
  resumeTransfer(transferId: string): Promise<IpcEnvelope<void>>;
  pickLocalFile(mode: "open" | "save", defaultName?: string): Promise<IpcEnvelope<string | null>>;

  getMetrics(id: string): Promise<IpcEnvelope<import("../shared/protocol").MetricsSnapshot>>;

  listServices(id: string): Promise<IpcEnvelope<import("../shared/protocol").ServiceInfo[]>>;
  serviceAction(id: string, unit: string, action: "start" | "stop" | "restart"): Promise<IpcEnvelope<{ ok: boolean; output: string }>>;
  listProcesses(id: string): Promise<IpcEnvelope<import("../shared/protocol").ProcessInfo[]>>;
  killProcess(id: string, pid: number, signal?: string): Promise<IpcEnvelope<void>>;

  startLogStream(id: string, opts: { mode: "journal" | "file"; unit?: string; filePath?: string }): Promise<IpcEnvelope<string>>;
  stopLogStream(streamId: string): Promise<IpcEnvelope<void>>;

  openTerminal(id: string, size: { cols: number; rows: number }): Promise<IpcEnvelope<string>>;
  terminalInput(termId: string, data: string): Promise<IpcEnvelope<void>>;
  resizeTerminal(termId: string, size: { cols: number; rows: number }): Promise<IpcEnvelope<void>>;
  closeTerminal(termId: string): Promise<IpcEnvelope<void>>;

  verifySudo(id: string, password: string): Promise<IpcEnvelope<{ ok: boolean; error?: SerializedVpsmError }>>;
  forgetSudo(id: string): Promise<IpcEnvelope<void>>;
  systemPower(id: string, action: "reboot" | "poweroff"): Promise<IpcEnvelope<{ output: string }>>;

  listTrash(profileId: string): Promise<IpcEnvelope<import("../shared/protocol").TrashItem[]>>;
  emptyTrash(profileId: string): Promise<IpcEnvelope<void>>;
  listActivity(profileId: string): Promise<IpcEnvelope<import("../shared/protocol").ActivityEntry[]>>;
  clearActivity(): Promise<IpcEnvelope<void>>;

  appInfo(): Promise<IpcEnvelope<{ version: string; platform: string; secureStorage: boolean; userDataDir: string }>>;

  onEvent(handler: (ev: unknown) => void): () => void;
}

declare global {
  interface Window {
    vpsm: VpsmBridge;
  }
}

export class VpsmApiError extends Error {
  constructor(public readonly sErr: SerializedVpsmError) {
    super(sErr.message);
    this.name = "VpsmApiError";
  }
}

/** unwrap IpcEnvelope → value or throw VpsmApiError */
export async function call<T>(p: Promise<IpcEnvelope<T>>): Promise<T> {
  const res = await p;
  if (!res.ok || res.error) {
    throw new VpsmApiError(res.error ?? { __vpsmError: true, code: "EINTERNAL", message: "Unknown IPC failure" });
  }
  return res.value as T;
}

export const USER_FACING_MESSAGES: Record<VpsmErrorCode, string> = {
  EINVAL_PATH: "Invalid path or name.",
  EINVAL_INPUT: "Invalid input.",
  EPERM: "You don't have permission to do this. Try connecting with an account that has sufficient permissions.",
  EACCES_ROOT: "This action needs administrator (root) privileges on the server.",
  ENOENT: "The file or folder no longer exists on the server.",
  EEXIST: "An item with this name already exists.",
  ENOTEMPTY: "The folder is not empty.",
  ENOSPC: "The server's disk is full.",
  EROFS: "The destination filesystem is read-only.",
  EXDEV: "This crosses filesystem boundaries.",
  ECONN: "Connection problem. Check that the server is reachable and try again.",
  EAUTH: "Authentication failed. Check username, password or key.",
  EHOSTKEY: "The server's host key changed or is unknown. Verify it before connecting.",
  ETIMEDOUT: "The operation timed out.",
  ECANCELED: "Cancelled.",
  ENOSUDO: "sudo is not available on this server.",
  EREMOTE: "The server returned an error.",
  ESSH: "SSH protocol error.",
  EINTERNAL: "Something went wrong."
};
