/**
 * Typed error codes shared across the process boundary.
 * Main throws SerializedVpsmError; renderer maps code → user-facing copy.
 */

export const VPSM_ERROR_CODES = [
  "EINVAL_PATH", // unsafe/invalid path or name
  "EINVAL_INPUT", // generic invalid input
  "EPERM", // permission denied on remote
  "EACCES_ROOT", // operation needs elevated privileges
  "ENOENT", // remote entry not found
  "EEXIST", // destination already exists
  "ENOTEMPTY", // directory not empty (permanent delete without -r is refused)
  "ENOSPC", // no space left on device
  "EROFS", // read-only filesystem
  "EXDEV", // cross-device link (handled by fallback)
  "ECONN", // connection failed / lost
  "EAUTH", // authentication failed
  "EHOSTKEY", // host key mismatch / unknown
  "ETIMEDOUT", // operation timed out
  "ECANCELED", // cancelled by user
  "ENOSUDO", // sudo required but not available/unauthorized
  "EREMOTE", // remote command exited non-zero
  "ESSH", // low-level ssh protocol error
  "EINTERNAL" // unexpected internal error
] as const;

export type VpsmErrorCode = (typeof VPSM_ERROR_CODES)[number];

export interface SerializedVpsmError {
  readonly __vpsmError: true;
  code: VpsmErrorCode;
  message: string;
  /** Extra human-facing detail (e.g. remote stderr excerpt). */
  detail?: string;
  /** Remote errno string when known (EACCES, ENOSPC...). */
  errno?: string;
}

export function vpsmError(
  code: VpsmErrorCode,
  message: string,
  extra?: { detail?: string; errno?: string }
): SerializedVpsmError {
  return { __vpsmError: true, code, message, ...extra };
}

export function isSerializedVpsmError(x: unknown): x is SerializedVpsmError {
  return (
    typeof x === "object" &&
    x !== null &&
    (x as Record<string, unknown>)["__vpsmError"] === true &&
    typeof (x as Record<string, unknown>)["code"] === "string"
  );
}

/** Map a raw ssh2/Node error to a SerializedVpsmError with user-facing message.
 *  `errnoCode` is the numeric SFTP status code when available (2=NO_SUCH_FILE,
 *  3=PERMISSION_DENIED, 4=FAILURE, 11=EOF-ish failures). */
export function classifyFsError(err: unknown, context: string, errnoCode?: number): SerializedVpsmError {
  const e = err as { code?: string; message?: string; level?: string } | null;
  const raw = e?.message ?? String(err);
  const code = e?.code ?? "";

  // numeric SFTP status codes from the wire (custom code field)
  if (errnoCode === 2) return vpsmError("ENOENT", `Not found: ${context}`, { detail: "The file or folder no longer exists on the server." });
  if (errnoCode === 3) return vpsmError("EPERM", `Permission denied: ${context}`, { detail: "You don't have permission to access or modify this item. Try connecting with an account that has sufficient permissions." });
  if (errnoCode === 4) {
    // generic failure: keep any server-provided message (e.g. "Failure")
    if (/no such file|not found/i.test(raw)) return vpsmError("ENOENT", `Not found: ${context}`);
    if (/permission/i.test(raw)) return vpsmError("EPERM", `Permission denied: ${context}`);
    return vpsmError("EREMOTE", raw || `Operation failed on server: ${context}`);
  }

  switch (code) {
    case "EACCES":
    case "EPERM":
      return vpsmError("EPERM", `Permission denied: ${context}`, { detail: "You don't have permission to access or modify this item. Try connecting with an account that has sufficient permissions.", errno: code });
    case "ENOENT":
      return vpsmError("ENOENT", `Not found: ${context}`, { detail: "The file or folder no longer exists on the server.", errno: code });
    case "EEXIST":
      return vpsmError("EEXIST", `Already exists: ${context}`, { detail: "An item with this name already exists in the destination.", errno: code });
    case "ENOTEMPTY":
      return vpsmError("ENOTEMPTY", `Directory not empty: ${context}`, { errno: code });
    case "ENOSPC":
      return vpsmError("ENOSPC", `No space left on device: ${context}`, { detail: "The server's disk is full. Free some space and try again.", errno: code });
    case "EROFS":
      return vpsmError("EROFS", `Read-only filesystem: ${context}`, { detail: "The destination filesystem is mounted read-only.", errno: code });
    case "EXDEV":
      return vpsmError("EXDEV", `Cross-device move: ${context}`, { errno: code });
    case "EISDIR":
      return vpsmError("EINVAL_INPUT", `Is a directory: ${context}`, { errno: code });
    case "ENAMETOOLONG":
      return vpsmError("EINVAL_PATH", `Name too long: ${context}`, { errno: code });
    default:
      break;
  }
  // message-based fallbacks (SFTP wire errors arrive with numeric codes)
  if (/no such file/i.test(raw)) {
    return vpsmError("ENOENT", `Not found: ${context}`, { detail: "The file or folder no longer exists on the server." });
  }
  if (/permission denied/i.test(raw)) {
    return vpsmError("EPERM", `Permission denied: ${context}`, { detail: "You don't have permission to access or modify this item. Try connecting with an account that has sufficient permissions." });
  }
  if (/no space left/i.test(raw)) {
    return vpsmError("ENOSPC", `No space left on device: ${context}`, { detail: "The server's disk is full. Free some space and try again." });
  }
  if (e?.level === "client-socket" || /ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket (hung up|closed)/i.test(`${code} ${raw}`)) {
    return vpsmError("ECONN", `Connection problem: ${context}`, { detail: raw });
  }
  if (/All configured authentication methods failed|Authentication failed/i.test(raw)) {
    return vpsmError("EAUTH", "Authentication failed", { detail: "Check the username, password or private key for this server." });
  }
  if (/timed out|timeout/i.test(raw)) {
    return vpsmError("ETIMEDOUT", `Timed out: ${context}`, { detail: raw });
  }
  return vpsmError("EINTERNAL", raw || `Unexpected error: ${context}`);
}
