import type { SerializedVpsmError } from "./errors";

/** Connection authentication methods. */
export type AuthMethod = "password" | "key";

export interface ServerProfile {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authMethod: AuthMethod;
  /** True when a secret is stored in the OS-encrypted vault. */
  hasCredential: boolean;
  /** True when an SSH key passphrase is stored (key auth only). */
  hasPassphrase: boolean;
  /** SHA256 fingerprint of the pinned host key (base64, no padding), if accepted. */
  hostKeyFingerprint?: string;
  color: string;
  lastConnectedAt?: number;
  createdAt: number;
}

/** Secret material never persisted in plaintext; resolved from vault at connect time. */
export interface CredentialMaterial {
  password?: string;
  privateKey?: string;
  passphrase?: string;
}

export type ConnStatus =
  | "offline"
  | "connecting"
  | "connected"
  | "authenticating"
  | "error"
  | "hostkey";

export interface ServerState {
  id: string;
  status: ConnStatus;
  message?: string;
  error?: SerializedVpsmError;
  hostKey?: HostKeyInfo;
  since?: number;
}

export interface HostKeyInfo {
  /** SHA256:... fingerprint */
  fingerprint: string;
  keyType: string;
  /** True when the key was seen before and matches the pin. */
  verified: boolean;
}

/* ---------------- filesystem model ---------------- */

export type EntryKind = "file" | "directory" | "symlink";

export interface FileEntry {
  name: string;
  path: string;
  kind: EntryKind;
  size: number;
  mode: number; // raw st_mode bits
  perms: string; // "755" style (type bits stripped)
  uid: number;
  gid: number;
  owner: string;
  group: string;
  mtimeMs: number;
  /** symlink target when kind === "symlink" */
  target?: string;
  /** resolved kind for symlinks (does the target exist / dir or file) */
  linkTargetKind?: EntryKind | "broken";
  /** best-effort flag: current user can write into parent (we can rename/delete) */
  parentWritable?: boolean;
}

export interface ListDirResult {
  path: string;
  entries: FileEntry[];
  truncated: boolean;
  /** absolute home dir of the connected user (computed once per session) */
}

export interface SearchResult {
  name: string;
  path: string;
  kind: "file" | "directory";
  size: number;
}

export interface ProbeResult {
  ok: boolean;
  whoami: string;
  home: string;
  longnames: boolean;
  canWriteCwd: boolean;
  os: string;
}

/* ---------------- operation requests (UI → main) ---------------- */

export type SortKey = "name" | "size" | "mtime" | "kind";
export type SortDir = "asc" | "desc";

export interface MoveOp { kind: "move"; sources: string[]; destDir: string }
export interface CopyOp { kind: "copy"; sources: string[]; destDir: string }
export interface RenameOp { kind: "rename"; path: string; newName: string }
export interface DeleteOp { kind: "delete"; paths: string[]; useTrash: boolean }
export interface RestoreOp { kind: "restore"; trashIds: string[] }
export interface MkdirOp { kind: "mkdir"; parent: string; name: string }
export interface CreateFileOp { kind: "createFile"; parent: string; name: string; content?: string }
export interface DuplicateOp { kind: "duplicate"; paths: string[] }
export interface ChmodOp { kind: "chmod"; path: string; mode: string; recursive: boolean }
export interface ChownOp { kind: "chown"; path: string; owner: string; group: string | null; recursive: boolean }
export interface ReadFileOp { kind: "readFile"; path: string; maxSize: number }
export interface WriteFileOp { kind: "writeFile"; path: string; content: string; expectedMtime?: number; encoding?: import("./encoding").TextEncoding }
export interface StatOp { kind: "stat"; path: string }

export type FileOperation =
  | MoveOp | CopyOp | RenameOp | DeleteOp | RestoreOp | MkdirOp | CreateFileOp
  | DuplicateOp | ChmodOp | ChownOp | ReadFileOp | WriteFileOp | StatOp;

export interface OperationResult {
  ok: true;
  op: FileOperation;
  message: string;
  /** paths affected, for activity log and UI refresh */
  affected: string[];
  /** undo descriptor if the operation supports it */
  undo?: UndoDescriptor;
  warnings?: string[];
}

export interface UndoDescriptor {
  label: string;
  /** inverse operations executed server-side by OperationService.undo */
  ops: FileOperation[];
}

/* ---------------- trash ---------------- */

export interface TrashItem {
  id: string;
  originalPath: string;
  trashPath: string;
  deletedAt: number;
  sizeBytes: number;
  profileId: string;
}

/* ---------------- transfers ---------------- */

export type TransferKind = "upload" | "download";
export type TransferStatus = "queued" | "running" | "done" | "error" | "canceled" | "paused";

export interface TransferState {
  id: string;
  profileId: string;
  kind: TransferKind;
  remotePath: string;
  localPath: string;
  totalBytes: number;
  transferredBytes: number;
  status: TransferStatus;
  startedAt: number;
  endedAt?: number;
  error?: SerializedVpsmError;
  speedBps: number;
  /** resume support: bytes already present before (re)start */
  resumedFrom?: number;
}

/* ---------------- metrics ---------------- */

export interface CpuSample {
  percent: number;
  cores: number;
  perCore?: number[];
  load1: number; load5: number; load15: number;
  model: string;
}

export interface MemSample {
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  cachedBytes: number;
  percent: number;
  swapTotalBytes: number;
  swapUsedBytes: number;
}

export interface DiskSample {
  filesystem: string;
  mount: string;
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  percent: number;
}

export interface NetSample {
  rxBytes: number;
  txBytes: number;
  rxBps: number;
  txBps: number;
  totalRxBytes: number;
  totalTxBytes: number;
}

export interface SystemInfo {
  hostname: string;
  os: string;
  osVersion: string;
  kernel: string;
  arch: string;
  cpuModel: string;
  uptimeSec: number;
  cores: number;
}

export interface MetricsSnapshot {
  at: number;
  cpu: CpuSample;
  mem: MemSample;
  disks: DiskSample[];
  net: NetSample;
  system: SystemInfo;
}

/* ---------------- services / processes / logs ---------------- */

export type ServiceState = "running" | "stopped" | "failed" | "unknown" | "static";

export interface ServiceInfo {
  unit: string;
  description: string;
  state: ServiceState;
  enabled: boolean;
  pid?: number;
  since?: string;
}

export interface ProcessInfo {
  pid: number;
  user: string;
  cpuPercent: number;
  memPercent: number;
  rssBytes: number;
  command: string;
  state: string;
}

export interface LogLine { t: number; source: string; line: string }

/* ---------------- terminal ---------------- */

export interface TerminalSize { cols: number; rows: number }

/* ---------------- IPC channel map ---------------- */

export interface IpcResult<T> {
  ok: boolean;
  value?: T;
  error?: SerializedVpsmError;
}

export interface VpsmApi {
  /* profiles */
  listProfiles(): Promise<ServerProfile[]>;
  saveProfile(input: Partial<ServerProfile> & { id?: string; secret?: string; passphrase?: string; forgetSecret?: boolean }): Promise<ServerProfile>;
  deleteProfile(id: string): Promise<void>;
  duplicateProfile(id: string): Promise<ServerProfile>;
  /* connection */
  connect(id: string, opts?: { acceptHostKey?: boolean }): Promise<ProbeResult>;
  disconnect(id: string): Promise<void>;
  testConnection(id: string): Promise<{ ok: boolean; error?: SerializedVpsmError; fingerprint?: string }>;
  getState(id: string): Promise<ServerState>;
  /* fs */
  listDir(id: string, path: string): Promise<ListDirResult>;
  homeDir(id: string): Promise<string>;
  stat(id: string, path: string): Promise<FileEntry>;
  runOperation(id: string, op: FileOperation): Promise<OperationResult>;
  /* transfers */
  startUpload(id: string, localPath: string, remoteDir: string): Promise<string>;
  startDownload(id: string, remotePath: string, localDir: string): Promise<string>;
  cancelTransfer(transferId: string): Promise<void>;
  listTransfers(profileId: string): Promise<TransferState[]>;
  pickLocalFile(mode: "open" | "save", defaultName?: string): Promise<string | null>;
  /* metrics */
  getMetrics(id: string): Promise<MetricsSnapshot>;
  /* services */
  listServices(id: string): Promise<ServiceInfo[]>;
  serviceAction(id: string, unit: string, action: "start" | "stop" | "restart"): Promise<{ ok: boolean; output: string }>;
  listProcesses(id: string): Promise<ProcessInfo[]>;
  killProcess(id: string, pid: number, signal?: string): Promise<void>;
  /* logs */
  streamLogs(id: string, unit: string | null, mode: "journal" | "file", filePath?: string): Promise<string>;
  stopLogStream(streamId: string): Promise<void>;
  /* terminal */
  openTerminal(id: string, size: TerminalSize): Promise<string>;
  terminalInput(termId: string, data: string): Promise<void>;
  resizeTerminal(termId: string, size: TerminalSize): Promise<void>;
  closeTerminal(termId: string): Promise<void>;
  /* sudo */
  verifySudo(id: string, password: string): Promise<{ ok: boolean; error?: SerializedVpsmError }>;
  sudoAvailable(id: string): Promise<boolean>;
  /* trash/activity */
  listTrash(profileId: string): Promise<TrashItem[]>;
  emptyTrash(profileId: string): Promise<void>;
  getActivityLog(profileId: string): Promise<ActivityEntry[]>;
  /* app */
  getTheme(): Promise<"dark" | "light">;
  setTheme(theme: "dark" | "light"): Promise<void>;
}

export interface ActivityEntry {
  at: number;
  summary: string;
  detail?: string;
  kind: "fs" | "service" | "process" | "session" | "transfer" | "security" | "system";
}
