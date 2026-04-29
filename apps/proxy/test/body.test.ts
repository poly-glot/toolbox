import { describe, it, expect } from "vitest";
import { classifyBody } from "../src/body.js";

const CAP = 16;

describe("classifyBody", () => {
  it("returns empty when totalBytes is 0", () => {
    expect(classifyBody(Buffer.alloc(0), {
      contentType: null, contentEncoding: null, totalBytes: 0, cap: CAP,
    })).toEqual({ kind: "empty" });
  });

  it("classifies application/json text under cap", () => {
    const buf = Buffer.from('{"a":1}');
    const r = classifyBody(buf, {
      contentType: "application/json", contentEncoding: null,
      totalBytes: buf.length, cap: CAP,
    });
    expect(r).toEqual({ kind: "text", bytes: 7, truncated: false, data: '{"a":1}' });
  });

  it("classifies text/plain", () => {
    const buf = Buffer.from("hello");
    const r = classifyBody(buf, {
      contentType: "text/plain; charset=utf-8", contentEncoding: null,
      totalBytes: 5, cap: CAP,
    });
    expect(r.kind).toBe("text");
    if (r.kind === "text") expect(r.data).toBe("hello");
  });

  it("classifies application/vnd.api+json (suffix match)", () => {
    const buf = Buffer.from('{"x":2}');
    const r = classifyBody(buf, {
      contentType: "application/vnd.api+json", contentEncoding: null,
      totalBytes: 7, cap: CAP,
    });
    expect(r.kind).toBe("text");
  });

  it("marks text body as truncated when totalBytes > cap", () => {
    const data = "x".repeat(CAP);
    const r = classifyBody(Buffer.from(data), {
      contentType: "text/plain", contentEncoding: null,
      totalBytes: CAP + 100, cap: CAP,
    });
    expect(r).toEqual({ kind: "text", bytes: CAP + 100, truncated: true, data });
  });

  it("classifies as binary when content-type is non-text", () => {
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const r = classifyBody(buf, {
      contentType: "image/png", contentEncoding: null,
      totalBytes: 4, cap: CAP,
    });
    expect(r.kind).toBe("binary");
    if (r.kind === "binary") {
      expect(r.preview).toBe("89504e47");
      expect(r.contentType).toBe("image/png");
    }
  });

  it("classifies as binary when content-type says text but bytes are not valid UTF-8", () => {
    const buf = Buffer.from([0xff, 0xfe, 0x00]);
    const r = classifyBody(buf, {
      contentType: "text/plain", contentEncoding: null,
      totalBytes: 3, cap: CAP,
    });
    expect(r.kind).toBe("binary");
  });

  it("classifies as binary when content-encoding is gzip even for text-typed bodies", () => {
    const buf = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00]);
    const r = classifyBody(buf, {
      contentType: "application/json", contentEncoding: "gzip",
      totalBytes: 6, cap: CAP,
    });
    expect(r.kind).toBe("binary");
  });

  it("treats content-encoding 'identity' as not compressed", () => {
    const buf = Buffer.from('{"a":1}');
    const r = classifyBody(buf, {
      contentType: "application/json", contentEncoding: "identity",
      totalBytes: 7, cap: CAP,
    });
    expect(r.kind).toBe("text");
  });

  it("uses lenient decode for truncated text", () => {
    const trunc = Buffer.from([0x68, 0x69, 0xc3]); // "hi" + first byte of split é
    const r = classifyBody(trunc, {
      contentType: "text/plain", contentEncoding: null,
      totalBytes: 4, cap: 3,
    });
    expect(r.kind).toBe("text");
    if (r.kind === "text") {
      expect(r.truncated).toBe(true);
      expect(r.data.startsWith("hi")).toBe(true);
    }
  });
});
