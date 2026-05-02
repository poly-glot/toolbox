import { describe, it, expect } from "vitest";
import { ResponseLifecycle } from "../src/response-lifecycle.js";
import type { IncomingMessage } from "node:http";

const fakeRes = (opts: { status?: number; statusMessage?: string; headers?: Record<string, string> }): IncomingMessage =>
  ({
    statusCode:    opts.status,
    statusMessage: opts.statusMessage,
    headers:       opts.headers ?? {},
  } as unknown as IncomingMessage);

describe("ResponseLifecycle", () => {
  it("starts with all queries returning false / zero", () => {
    const l = new ResponseLifecycle(1024);
    expect(l.hasStarted()).toBe(false);
    expect(l.hasEnded()).toBe(false);
    expect(l.wasTimedOut()).toBe(false);
    expect(l.responseStatus()).toBe(0);
    expect(l.responseStatusText()).toBe("");
    expect(l.inboundHeaders()).toEqual({});
  });

  it("captures status, statusText, and sanitized headers on markStarted", () => {
    const l = new ResponseLifecycle(1024);
    l.markStarted(fakeRes({
      status: 201,
      statusMessage: "Created",
      headers: { "content-type": "application/json", "transfer-encoding": "chunked" },
    }));
    expect(l.hasStarted()).toBe(true);
    expect(l.responseStatus()).toBe(201);
    expect(l.responseStatusText()).toBe("Created");
    // hop-by-hop stripped:
    expect(l.inboundHeaders()).toEqual({ "content-type": "application/json" });
  });

  it("falls back to 502/'' when statusCode/statusMessage are absent", () => {
    const l = new ResponseLifecycle(1024);
    l.markStarted(fakeRes({}));
    expect(l.responseStatus()).toBe(502);
    expect(l.responseStatusText()).toBe("");
  });

  it("markEnded and markTimedOut update their queries independently", () => {
    const l = new ResponseLifecycle(1024);
    l.markEnded();
    expect(l.hasEnded()).toBe(true);
    expect(l.wasTimedOut()).toBe(false);
    l.markTimedOut();
    expect(l.wasTimedOut()).toBe(true);
  });

  it("finalizeOnce runs the function exactly once across multiple calls", () => {
    const l = new ResponseLifecycle(1024);
    let calls = 0;
    l.finalizeOnce(() => calls++);
    l.finalizeOnce(() => calls++);
    l.finalizeOnce(() => calls++);
    expect(calls).toBe(1);
  });

  it("exposes a CaptureBuffer the caller can observe into", () => {
    const l = new ResponseLifecycle(10);
    l.capture.observe(Buffer.from("abc"));
    expect(l.capture.totalBytes).toBe(3);
    expect(l.capture.bytes().toString("utf-8")).toBe("abc");
  });
});
