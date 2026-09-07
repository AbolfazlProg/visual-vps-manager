/**
 * Text encoding detection/encoding for the editor.
 *
 * The editor previously decoded every file as UTF-8 blindly — files with a
 * BOM, UTF-16 files and binary files all turned into unreadable garbage.
 * This module detects the encoding (BOM first, then strict UTF-8 validation),
 * refuses binary files, and can re-encode on save so files round-trip
 * byte-faithfully.
 */

export type TextEncoding = "utf8" | "utf8-bom" | "utf16le" | "utf16be";

export interface DecodeResult {
  content: string;
  encoding: TextEncoding;
}

/** Heuristic: NUL bytes in a buffer that is not UTF-16 → binary file. */
export function looksBinary(buf: Buffer): boolean {
  return buf.includes(0);
}

/**
 * Decode a buffer, detecting BOM / UTF-16 / UTF-8.
 * Throws Error("BINARY") for non-text content (caller maps to EBINARY).
 * When `truncated` is true (editor cap hit), a broken multi-byte sequence at
 * the very end is tolerated instead of rejecting the whole file.
 */
export function decodeText(buf: Buffer, truncated = false): DecodeResult {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { content: new TextDecoder("utf-8").decode(buf.subarray(3)), encoding: "utf8-bom" };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { content: new TextDecoder("utf-16le").decode(buf.subarray(2)), encoding: "utf16le" };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return { content: new TextDecoder("utf-16be").decode(buf.subarray(2)), encoding: "utf16be" };
  }
  try {
    const strict = new TextDecoder("utf-8", { fatal: true });
    const content = strict.decode(buf);
    if (looksBinary(buf)) throw new Error("BINARY");
    return { content, encoding: "utf8" };
  } catch (e) {
    if ((e as Error).message === "BINARY") throw e;
    if (truncated) {
      // tolerate a torn multi-byte sequence at the cut point
      const lenient = new TextDecoder("utf-8");
      return { content: lenient.decode(buf), encoding: "utf8" };
    }
    throw new Error("BINARY");
  }
}

/** Encode text back to its original encoding (BOM restored where present). */
export function encodeText(content: string, encoding: TextEncoding): Buffer {
  switch (encoding) {
    case "utf8":
      return Buffer.from(content, "utf8");
    case "utf8-bom":
      return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(content, "utf8")]);
    case "utf16le":
      return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(content, "utf16le")]);
    case "utf16be": {
      const le = Buffer.from(content, "utf16le");
      for (let i = 0; i + 1 < le.length; i += 2) {
        const t = le[i];
        le[i] = le[i + 1];
        le[i + 1] = t;
      }
      return Buffer.concat([Buffer.from([0xfe, 0xff]), le]);
    }
    default:
      return Buffer.from(content, "utf8");
  }
}
