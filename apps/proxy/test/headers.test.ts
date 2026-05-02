import { describe, it, expect } from "vitest";
import {
  sanitizeOutboundHeaders,
  sanitizeInboundHeaders,
  flattenForDisplay,
  headerString,
} from "../src/headers.js";

describe("sanitizeOutboundHeaders", () => {
  it("drops hop-by-hop headers (case-insensitive)", () => {
    const out = sanitizeOutboundHeaders({
      Connection: "keep-alive",
      "Keep-Alive": "timeout=5",
      TE: "trailers",
      "Transfer-Encoding": "chunked",
      Trailer: "x-foo",
      Upgrade: "h2c",
      "Proxy-Authenticate": "Basic",
      "proxy-authorization": "Basic abc",
      authorization: "Bearer xyz",
    }, "api.storyteq.com");
    expect(out).toEqual({
      authorization: "Bearer xyz",
      host: "api.storyteq.com",
    });
  });

  it("drops X-TARGET", () => {
    const out = sanitizeOutboundHeaders({
      "x-target": "https://x/y",
      accept: "application/json",
    }, "api.storyteq.com");
    expect(out["x-target"]).toBeUndefined();
    expect(out.accept).toBe("application/json");
  });

  it("drops content-length and rewrites host", () => {
    const out = sanitizeOutboundHeaders({
      "content-length": "42",
      host: "old.example.com",
    }, "api.storyteq.com");
    expect(out["content-length"]).toBeUndefined();
    expect(out.host).toBe("api.storyteq.com");
  });

  it("preserves array-valued headers", () => {
    const out = sanitizeOutboundHeaders({
      "x-multi": ["a", "b"],
    }, "api.storyteq.com");
    expect(out["x-multi"]).toEqual(["a", "b"]);
  });

  it("skips undefined values", () => {
    const out = sanitizeOutboundHeaders({
      foo: undefined,
      bar: "y",
    }, "api.storyteq.com");
    expect("foo" in out).toBe(false);
    expect(out.bar).toBe("y");
  });
});

describe("sanitizeInboundHeaders", () => {
  it("drops hop-by-hop and preserves the rest, including set-cookie arrays", () => {
    const out = sanitizeInboundHeaders({
      "transfer-encoding": "chunked",
      connection: "close",
      "content-type": "application/json",
      "set-cookie": ["a=1", "b=2"],
    });
    expect(out["transfer-encoding"]).toBeUndefined();
    expect(out.connection).toBeUndefined();
    expect(out["content-type"]).toBe("application/json");
    expect(out["set-cookie"]).toEqual(["a=1", "b=2"]);
  });
});

describe("flattenForDisplay", () => {
  it("joins arrays with ', '", () => {
    const out = flattenForDisplay({
      "set-cookie": ["a=1", "b=2"],
      accept: "application/json",
    });
    expect(out["set-cookie"]).toBe("a=1, b=2");
    expect(out.accept).toBe("application/json");
  });
});

describe("headerString", () => {
  it("returns null for undefined", () => {
    expect(headerString(undefined)).toBeNull();
  });

  it("returns the first element for arrays, else the string", () => {
    expect(headerString(["first", "second"])).toBe("first");
    expect(headerString("only")).toBe("only");
    expect(headerString([])).toBeNull();
  });
});
