import { describe, expect, it } from "vitest";
import { classifyFsError, isSerializedVpsmError, vpsmError } from "./errors";

describe("classifyFsError", () => {
  it("maps permission errors", () => {
    const e = classifyFsError({ code: "EACCES", message: "permission denied" }, "rename /x");
    expect(e.code).toBe("EPERM");
    expect(e.errno).toBe("EACCES");
    expect(e.message).toContain("Permission denied");
  });

  it("maps ENOENT / EEXIST / ENOSPC", () => {
    expect(classifyFsError({ code: "ENOENT" }, "open").code).toBe("ENOENT");
    expect(classifyFsError({ code: "EEXIST" }, "mkdir").code).toBe("EEXIST");
    expect(classifyFsError({ code: "ENOSPC" }, "write").code).toBe("ENOSPC");
    expect(classifyFsError({ code: "EROFS" }, "write").code).toBe("EROFS");
  });

  it("maps connection failures", () => {
    expect(classifyFsError(new Error("connect ECONNREFUSED 1.2.3.4:22"), "connect").code).toBe("ECONN");
    expect(classifyFsError(new Error("Timed out"), "connect").code).toBe("ETIMEDOUT");
  });

  it("maps auth failures", () => {
    const e = classifyFsError(new Error("All configured authentication methods failed"), "connect");
    expect(e.code).toBe("EAUTH");
  });
});

describe("vpsmError helpers", () => {
  it("creates and detects serialized errors", () => {
    const e = vpsmError("EHOSTKEY", "host key changed");
    expect(isSerializedVpsmError(e)).toBe(true);
    expect(isSerializedVpsmError({ code: "X" })).toBe(false);
    expect(isSerializedVpsmError(null)).toBe(false);
    expect(isSerializedVpsmError("err")).toBe(false);
  });
});
