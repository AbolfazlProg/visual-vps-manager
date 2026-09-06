/** Renderer-side re-exports + small UI-only types. */
export type {
  ActivityEntry,
  AuthMethod,
  ConnStatus,
  CredentialMaterial,
  DiskSample,
  EntryKind,
  FileEntry,
  FileOperation,
  ListDirResult,
  LogLine,
  MemSample,
  MetricsSnapshot,
  NetSample,
  OperationResult,
  ProcessInfo,
  SearchResult,
  ServerProfile,
  ServerState,
  ServiceInfo,
  ServiceState,
  SortDir,
  SortKey,
  TerminalSize,
  TransferKind,
  TransferState,
  TransferStatus,
  TrashItem,
  UndoDescriptor,
  CpuSample,
  SystemInfo
} from "../shared/protocol";

export type { VpsmErrorCode, SerializedVpsmError } from "../shared/errors";
export type { IpcEnvelope } from "./ipc";
