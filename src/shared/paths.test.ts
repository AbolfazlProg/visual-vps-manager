import { describe, expect, it } from "vitest";
import {
  assertSafeRemotePath,
  basenameOf,
  dirnameOf,
  isWithinPath,
  joinRemotePath,
  normalizeRemotePath,
  validateEntryName
} from "./paths";

describe("normalizeRemotePath", () => {
  it("normalizes absolute paths", () => {
    expect(normalizeRemotePath("/var/www/html")).toBe("/var/www/html");
    expect(normalizeRemotePath("/var//www/./html/")).toBe("/var/www/html");
    expect(normalizeRemotePath("/")).toBe("/");
  });

  it("resolves .. lexically", () => {
    expect(normalizeRemotePath("/var/www/../log")).toBe("/var/log");
    expect(normalizeRemotePath("/a/b/c/../../d")).toBe("/a/d");
  });

  it("rejects traversal above root", () => {
    expect(() => normalizeRemotePath("/../etc")).toThrow();
    expect(() => normalizeRemotePath("/a/../../etc")).toThrow();
  });

  it("rejects relative paths, NUL and control chars", () => {
    expect(() => normalizeRemotePath("var/www")).toThrow();
    expect(() => normalizeRemotePath("/var\u0000/www")).toThrow();
    expect(() => normalizeRemotePath("/var\t/www")).toThrow();
  });
});

describe("validateEntryName", () => {
  it("accepts ordinary names", () => {
    expect(() => validateEntryName("website.zip")).not.toThrow();
    expect(() => validateEntryName(".hidden")).not.toThrow();
    expect(() => validateEntryName("my folder")).not.toThrow();
    expect(() => validateEntryName("package.json")).not.toThrow();
  });

  it("rejects separators, reserved names and unsafe chars", () => {
    expect(() => validateEntryName("a/b")).toThrow();
    expect(() => validateEntryName("..")).toThrow();
    expect(() => validateEntryName(".")).toThrow();
    expect(() => validateEntryName("")).toThrow();
    expect(() => validateEntryName("a\u0000b")).toThrow();
    expect(() => validateEntryName("a\nb")).toThrow();
  });
});

describe("joinRemotePath / basename / dirname", () => {
  it("joins safely", () => {
    expect(joinRemotePath("/var/www", "site")).toBe("/var/www/site");
    expect(joinRemotePath("/", "etc")).toBe("/etc");
    expect(() => joinRemotePath("/var", "../etc/passwd")).toThrow();
  });

  it("splits", () => {
    expect(basenameOf("/var/www/site.html")).toBe("site.html");
    expect(basenameOf("/var")).toBe("var");
    expect(basenameOf("/")).toBe("/");
    expect(dirnameOf("/var/www/site.html")).toBe("/var/www");
    expect(dirnameOf("/var")).toBe("/");
  });
});

describe("isWithinPath", () => {
  it("detects containment", () => {
    expect(isWithinPath("/a/b", "/a")).toBe(true);
    expect(isWithinPath("/a/bc", "/a/b")).toBe(false);
    expect(isWithinPath("/a", "/a")).toBe(true);
    expect(isWithinPath("/a/b/../c", "/a")).toBe(true);
  });
});

describe("assertSafeRemotePath", () => {
  it("is normalize + guard", () => {
    expect(assertSafeRemotePath("/home/user/site/./js/../index.html")).toBe("/home/user/site/index.html");
    expect(() => assertSafeRemotePath("/home/user/../../../etc/shadow")).toThrow();
  });
});
