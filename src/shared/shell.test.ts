import { describe, expect, it } from "vitest";
import {
  buildCommand,
  cmdChmod,
  cmdChown,
  cmdCpRecursive,
  cmdMkdirs,
  cmdMv,
  cmdRmRecursive,
  cmdDuBytes,
  parseOctalMode,
  shq,
  sudoCmd
} from "./shell";

describe("shq (single-quote escaping)", () => {
  it("escapes quotes correctly", () => {
    expect(shq("abc")).toBe("'abc'");
    expect(shq("it's")).toBe(`'it'\\''s'`);
    expect(shq("a b; c")).toBe("'a b; c'");
    expect(shq("$(rm -rf /)")).toBe("'$(rm -rf /)'");
    expect(shq("`id`")).toBe("'`id`'");
    expect(shq("'")).toBe(`''\\'''`);
  });

  it("survives re-parsing", () => {
    // simulate POSIX shell word-splitting of a double-quoted shq result
    const escape = (s: string) => shq(s);
    const input = `weird "name" with; semicolons & $(danger) 'quotes' \\ backslash`;
    const cmd = `printf %s ${escape(input)}`;
    // naive verification: the payload contains no unescaped shell metacharacters
    expect(cmd.startsWith("printf %s '")).toBe(true);
    expect(cmd.endsWith("'")).toBe(true);
    // every single quote inside is the '\'' sequence
    const inner = cmd.slice("printf %s ".length + 1, -1);
    const reassembled = inner.replace(/'\\''/g, "'");
    expect(reassembled).toBe(input);
  });
});

describe("command builders", () => {
  it("builds mv with escaped args", () => {
    expect(cmdMv(["/home/u/my file.txt"], "/home/u/dest dir/")).toBe(
      `mv -- '/home/u/my file.txt' '/home/u/dest dir/'`
    );
  });

  it("builds cp -r, rm -rf, mkdir -p", () => {
    expect(cmdCpRecursive(["/a b"], "/c d")).toBe(`cp -r -- '/a b' '/c d'`);
    expect(cmdRmRecursive(["/x y", "/z"])).toBe(`rm -rf -- '/x y' /z`);
    expect(cmdMkdirs(["/a", "/b c"])).toBe(`mkdir -p -- /a '/b c'`);
  });

  it("builds chmod/chown with validated mode/user", () => {
    expect(cmdChmod("750", ["/s"], true)).toBe(`chmod -R 750 -- /s`);
    expect(() => cmdChmod("999", ["/s"], false)).toThrow();
    expect(cmdChown("www-data", "www-data", ["/s"], false)).toBe(`chown www-data:www-data -- /s`);
    expect(() => cmdChown("bad;user", null, ["/s"], false)).toThrow();
  });

  it("builds du/sudo", () => {
    expect(cmdDuBytes(["/a b"])).toBe(`du -sb -- '/a b'`);
    expect(sudoCmd("systemctl restart nginx")).toBe("sudo -n systemctl restart nginx");
  });

  it("rejects empty sources", () => {
    expect(() => cmdMv([], "/d")).toThrow();
    expect(() => cmdCpRecursive([], "/d")).toThrow();
    expect(() => cmdRmRecursive([])).toThrow();
  });
});

describe("buildCommand + parseOctalMode", () => {
  it("leaves whitelist tokens unquoted, escapes paths", () => {
    expect(buildCommand(["tar", "-czf", "/tmp/a b.tgz", "/var/www"])).toBe(
      `tar -czf '/tmp/a b.tgz' /var/www`
    );
  });
  it("parses octal modes", () => {
    expect(parseOctalMode("755")).toBe(0o755);
    expect(parseOctalMode("4755")).toBe(0o4755);
    expect(() => parseOctalMode("8")).toThrow();
    expect(() => parseOctalMode("ab")).toThrow();
  });
});
