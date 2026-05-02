import { describe, it, expect } from "vitest";
import { CaptureBuffer } from "../src/capture.js";

describe("CaptureBuffer", () => {
  it("counts every byte observed via totalBytes", () => {
    const c = new CaptureBuffer(1000);
    c.observe(Buffer.from("hello"));
    c.observe(Buffer.from(" world"));
    expect(c.totalBytes).toBe(11);
  });

  it("stores up to cap bytes and discards the rest, but counts them all", () => {
    const c = new CaptureBuffer(5);
    c.observe(Buffer.from("hello world"));
    expect(c.totalBytes).toBe(11);
    expect(c.bytes().toString("utf-8")).toBe("hello");
  });

  it("splits a single oversize chunk at the cap boundary", () => {
    const c = new CaptureBuffer(3);
    c.observe(Buffer.from("abcdefg"));
    expect(c.bytes().toString("utf-8")).toBe("abc");
    expect(c.totalBytes).toBe(7);
  });

  it("stops storing once the cap is reached, even if subsequent chunks are small", () => {
    const c = new CaptureBuffer(3);
    c.observe(Buffer.from("abc"));
    c.observe(Buffer.from("xy"));
    expect(c.bytes().toString("utf-8")).toBe("abc");
    expect(c.totalBytes).toBe(5);
  });

  it("totalBytes is read-only — no setter is exposed", () => {
    const c = new CaptureBuffer(10);
    c.observe(Buffer.from("abc"));
    expect(() => {
      // @ts-expect-error totalBytes is readonly via getter
      c.totalBytes = 999;
    }).toThrow(TypeError);
    expect(c.totalBytes).toBe(3);
  });
});
