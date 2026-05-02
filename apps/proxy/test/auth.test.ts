import { describe, it, expect } from "vitest";
import { authenticate } from "../src/auth.js";
import type { IncomingMessage } from "node:http";

const fakeReq = (opts: { url?: string; auth?: string }): IncomingMessage =>
  ({
    url: opts.url ?? "/tail",
    headers: opts.auth ? { authorization: opts.auth } : {},
  } as unknown as IncomingMessage);

describe("authenticate", () => {
  it("returns 'misconfigured' when no secret is set", () => {
    expect(authenticate(null, fakeReq({ auth: "Bearer anything" })))
      .toEqual({ kind: "misconfigured" });
  });

  it("returns 'unauthorized: missing-credential' when no header or query", () => {
    expect(authenticate("s3cret", fakeReq({})))
      .toEqual({ kind: "unauthorized", reason: "missing-credential" });
  });

  it("returns 'unauthorized: wrong-credential' for a mismatched bearer", () => {
    expect(authenticate("s3cret", fakeReq({ auth: "Bearer wrong" })))
      .toEqual({ kind: "unauthorized", reason: "wrong-credential" });
  });

  it("returns 'unauthorized: wrong-credential' for a mismatched ?secret", () => {
    expect(authenticate("s3cret", fakeReq({ url: "/tail?secret=wrong" })))
      .toEqual({ kind: "unauthorized", reason: "wrong-credential" });
  });

  it("returns 'allowed' for a matching Bearer (case-insensitive scheme)", () => {
    expect(authenticate("s3cret", fakeReq({ auth: "Bearer s3cret" })))
      .toEqual({ kind: "allowed" });
    expect(authenticate("s3cret", fakeReq({ auth: "bearer s3cret" })))
      .toEqual({ kind: "allowed" });
  });

  it("returns 'allowed' for a matching ?secret query parameter", () => {
    expect(authenticate("s3cret", fakeReq({ url: "/tail?secret=s3cret" })))
      .toEqual({ kind: "allowed" });
  });
});
