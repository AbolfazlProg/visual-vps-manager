/**
 * Remote POSIX path utilities (shared between main and renderer).
 *
 * Security contract:
 * - All remote paths entering an operation MUST pass `assertSafeRemotePath`.
 * - Normalization is purely lexical (no filesystem access): resolves `.`/`..`,
 *   collapses duplicate separators, guarantees an absolute POSIX path.
 * - After normalization no `..` segment can survive, which kills
 *   path-traversal through user-supplied names.
 */

export class PathValidationError extends Error {
  readonly code = "EINVAL_PATH";
  constructor(message: string) {
    super(message);
    this.name = "PathValidationError";
  }
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** Normalize a remote POSIX path lexically. Accepts absolute paths (and treats
 *  relative input as an error — callers must always work with absolute paths). */
export function normalizeRemotePath(input: string): string {
  if (typeof input !== "string" || input.length === 0) {
    throw new PathValidationError("Path must be a non-empty string");
  }
  if (input.includes("\u0000")) {
    throw new PathValidationError("Path contains a NUL byte");
  }
  if (CONTROL_CHARS.test(input)) {
    throw new PathValidationError("Path contains control characters");
  }
  if (!input.startsWith("/")) {
    throw new PathValidationError(`Path must be absolute: ${input}`);
  }
  const out: string[] = [];
  for (const seg of input.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length === 0) {
        throw new PathValidationError(`Path escapes the root directory: ${input}`);
      }
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return "/" + out.join("/");
}

/** Validate + normalize; throws PathValidationError on traversal/control chars. */
export function assertSafeRemotePath(input: string): string {
  return normalizeRemotePath(input);
}

/** Join a (already safe) directory with a single entry name. Validates the name. */
export function joinRemotePath(dir: string, name: string): string {
  validateEntryName(name);
  const d = normalizeRemotePath(dir);
  return d === "/" ? `/${name}` : `${d}/${name}`;
}

/** Validate a single path segment used for create/rename/mkdir.
 *  Rejects separators, NUL, control chars, and the reserved names "." and "..". */
export function validateEntryName(name: string): void {
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new PathValidationError("Name must not be empty");
  }
  if (name === "." || name === "..") {
    throw new PathValidationError(`Reserved name not allowed: ${name}`);
  }
  if (name.includes("/") || name.includes("\\")) {
    throw new PathValidationError(`Name must not contain path separators: ${name}`);
  }
  if (name.includes("\u0000")) {
    throw new PathValidationError("Name contains a NUL byte");
  }
  if (CONTROL_CHARS.test(name)) {
    throw new PathValidationError("Name contains control characters");
  }
  if (name.length > 255) {
    throw new PathValidationError("Name is longer than 255 characters");
  }
}

export function basenameOf(p: string): string {
  const n = normalizeRemotePath(p);
  const idx = n.lastIndexOf("/");
  return idx === -1 ? n : n.slice(idx + 1) || "/";
}

export function dirnameOf(p: string): string {
  const n = normalizeRemotePath(p);
  const idx = n.lastIndexOf("/");
  if (idx <= 0) return "/";
  return n.slice(0, idx);
}

/** Is `child` equal to or located inside `parent`? Both must be safe paths. */
export function isWithinPath(child: string, parent: string): boolean {
  const c = normalizeRemotePath(child);
  const p = normalizeRemotePath(parent);
  if (c === p) return true;
  return c.startsWith(p === "/" ? "/" : p + "/");
}

/** Default file display size cap for the text editor (bytes). */
export const EDITOR_MAX_BYTES = 8 * 1024 * 1024;
