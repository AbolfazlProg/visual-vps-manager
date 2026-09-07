import { describe, expect, it } from "vitest";
import { decodeText, encodeText } from "./encoding";

describe("decodeText / encodeText", () => {
  it("detects plain UTF-8", () => {
    const buf = Buffer.from("hello world", "utf8");
    const r = decodeText(buf);
    expect(r.encoding).toBe("utf8");
    expect(r.content).toBe("hello world");
  });

  it("detects and strips UTF-8 BOM, and restores it on encode", () => {
    const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("سلام دنیا", "utf8")]);
    const r = decodeText(buf);
    expect(r.encoding).toBe("utf8-bom");
    expect(r.content).toBe("سلام دنیا");
    const back = encodeText(r.content, r.encoding);
    expect(back.equals(buf)).toBe(true);
  });

  it("detects UTF-16LE with BOM and round-trips", () => {
    const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("wide text", "utf16le")]);
    const r = decodeText(buf);
    expect(r.encoding).toBe("utf16le");
    expect(r.content).toBe("wide text");
    expect(encodeText(r.content, r.encoding).equals(buf)).toBe(true);
  });

  it("detects UTF-16BE with BOM and round-trips", () => {
    const body = Buffer.from("wide be", "utf16le");
    for (let i = 0; i + 1 < body.length; i += 2) {
      const t = body[i]; body[i] = body[i + 1]; body[i + 1] = t;
    }
    const buf = Buffer.concat([Buffer.from([0xfe, 0xff]), body]);
    const r = decodeText(buf);
    expect(r.encoding).toBe("utf16be");
    expect(r.content).toBe("wide be");
    expect(encodeText(r.content, r.encoding).equals(buf)).toBe(true);
  });

  it("refuses binary content (NUL bytes) instead of producing garbage", () => {
    const buf = Buffer.from([0x41, 0x00, 0x42, 0x00, 0xff, 0xfe, 0x01, 0x02]);
    expect(() => decodeText(buf)).toThrow("BINARY");
  });

  it("tolerates a torn multi-byte tail only when truncated", () => {
    // "é" in UTF-8 is C3 A9 — cut the second byte
    const torn = Buffer.from([0x41, 0xc3]);
    expect(() => decodeText(torn, false)).toThrow("BINARY");
    const r = decodeText(torn, true);
    expect(r.content.startsWith("A")).toBe(true);
  });

  it("keeps CRLF line endings intact (no normalization)", () => {
    const buf = Buffer.from("line1\r\nline2\r\n", "utf8");
    expect(decodeText(buf).content).toBe("line1\r\nline2\r\n");
  });
});
