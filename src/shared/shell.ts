/**
 * Shell helpers for the few operations that must run through the remote shell.
 *
 * Rule: UI never builds commands. Operation services build them using ONLY
 * these helpers. Every dynamic value goes through `shq()` (single-quote
 * escaping), which makes command injection impossible for any input that
 * survives `assertSafeRemotePath` / `validateEntryName`.
 */

/** Single-quote escape for POSIX shells. Safe for any bytes except NUL. */
export function shq(value: string): string {
  if (value.includes("\u0000")) {
    throw new Error("Cannot shell-escape a string containing NUL");
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Quote only if needed (cosmetic — the whitelist contains no shell
 *  metacharacters, so leaving such tokens unquoted is safe). */
export function shqAuto(value: string): string {
  if (/^[A-Za-z0-9_\-./:+=@^%,]+$/.test(value) && value.length > 0) {
    return value;
  }
  return shq(value);
}

export interface CommandSpec {
  /** argv without the shell; every element is escaped before joining. */
  argv: string[];
}

/** Build a single shell command string from argv with strict escaping.
 *  Tokens matching the safe whitelist stay readable; everything else
 *  (paths, names, patterns) is single-quote escaped. */
export function buildCommand(argv: string[]): string {
  return argv.map(shqAuto).join(" ");
}

/**
 * Validate an octal permission string ("755", "0644", "4755").
 * Returns the numeric mode, throws on invalid input.
 */
export function parseOctalMode(octal: string): number {
  if (!/^[0-7]{3,4}$/.test(octal)) {
    throw new Error(`Invalid permission mode: ${octal}`);
  }
  return parseInt(octal, 8);
}

/** `mv`, `cp`, `rm` argument builders that refuse empty argv. */

export function cmdMv(src: string[], dest: string): string {
  if (src.length === 0) throw new Error("mv requires at least one source");
  return buildCommand(["mv", "--", ...src, dest]);
}

export function cmdCpRecursive(src: string[], dest: string): string {
  if (src.length === 0) throw new Error("cp requires at least one source");
  return buildCommand(["cp", "-r", "--", ...src, dest]);
}

export function cmdRmRecursive(paths: string[]): string {
  if (paths.length === 0) throw new Error("rm requires at least one path");
  return buildCommand(["rm", "-rf", "--", ...paths]);
}

export function cmdChmod(octal: string, paths: string[], recursive: boolean): string {
  parseOctalMode(octal);
  if (paths.length === 0) throw new Error("chmod requires at least one path");
  return buildCommand(recursive ? ["chmod", "-R", octal, "--", ...paths] : ["chmod", octal, "--", ...paths]);
}

export function cmdChown(owner: string, group: string | null, paths: string[], recursive: boolean): string {
  if (!/^[A-Za-z0-9_.-]+$/.test(owner)) throw new Error(`Invalid owner name: ${owner}`);
  if (group !== null && !/^[A-Za-z0-9_.-]+$/.test(group)) throw new Error(`Invalid group name: ${group}`);
  if (paths.length === 0) throw new Error("chown requires at least one path");
  const spec = group !== null ? `${owner}:${group}` : owner;
  return buildCommand(recursive ? ["chown", "-R", spec, "--", ...paths] : ["chown", spec, "--", ...paths]);
}

export function cmdDuBytes(paths: string[]): string {
  if (paths.length === 0) throw new Error("du requires at least one path");
  return buildCommand(["du", "-sb", "--", ...paths]);
}

export function cmdMkdirs(paths: string[]): string {
  if (paths.length === 0) throw new Error("mkdir requires at least one path");
  return buildCommand(["mkdir", "-p", "--", ...paths]);
}

/**
 * sudo strategy: `sudo -S -p '' -v` validates credentials from stdin
 * (password never appears in argv or logs). Later commands run with
 * `sudo -n` while the timestamp is valid.
 */
export const SUDO_VERIFY_CMD = `sudo -S -p '' -v`;
export function sudoCmd(cmd: string): string {
  return `sudo -n ${cmd}`;
}
