import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("returns sensible defaults with empty env", () => {
    const c = loadConfig({});
    expect(c.port).toBe(3002);
    expect(c.allowedHosts).toEqual(["storyteq.com", "storyteq.work"]);
    expect(c.tailSize).toBe(500);
    expect(c.bodyCaptureBytes).toBe(65536);
    expect(c.timeoutMs).toBe(30_000);
    expect(c.tailSecret).toBeNull();
  });

  it("respects PROXY_ALLOWED_HOSTS comma list with trimming", () => {
    const c = loadConfig({ PROXY_ALLOWED_HOSTS: " a.example.com , b.example.com ,, " });
    expect(c.allowedHosts).toEqual(["a.example.com", "b.example.com"]);
  });

  it("parses numeric env vars; falls back on garbage", () => {
    const c = loadConfig({
      PORT: "9999",
      PROXY_TAIL_SIZE: "10",
      PROXY_BODY_CAPTURE_BYTES: "abc",
      PROXY_TIMEOUT_MS: "1234",
    });
    expect(c.port).toBe(9999);
    expect(c.tailSize).toBe(10);
    expect(c.bodyCaptureBytes).toBe(65536);
    expect(c.timeoutMs).toBe(1234);
  });

  it("trims and treats empty PROXY_TAIL_SECRET as null (disabled)", () => {
    expect(loadConfig({ PROXY_TAIL_SECRET: "" }).tailSecret).toBeNull();
    expect(loadConfig({ PROXY_TAIL_SECRET: "   " }).tailSecret).toBeNull();
  });

  it("loads PROXY_TAIL_SECRET when set", () => {
    expect(loadConfig({ PROXY_TAIL_SECRET: "shh" }).tailSecret).toBe("shh");
  });
});
