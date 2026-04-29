import { describe, it, expect } from "vitest";
import { isAllowedTarget } from "../src/allowlist.js";

const HOSTS = ["storyteq.com", "storyteq.work"];

describe("isAllowedTarget", () => {
  it("accepts apex match", () => {
    const r = isAllowedTarget("https://storyteq.com/x", HOSTS);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.parsed.hostname).toBe("storyteq.com");
  });

  it("accepts subdomain match", () => {
    const r = isAllowedTarget("https://api.storyteq.com/x?a=1", HOSTS);
    expect(r.ok).toBe(true);
  });

  it("accepts deep subdomain match", () => {
    const r = isAllowedTarget("https://eu.cdn.storyteq.work/path", HOSTS);
    expect(r.ok).toBe(true);
  });

  it("accepts other apex", () => {
    const r = isAllowedTarget("http://api.storyteq.work/", HOSTS);
    expect(r.ok).toBe(true);
  });

  it("rejects suffix injection", () => {
    const r = isAllowedTarget("https://evil.storyteq.com.attacker.com/", HOSTS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("host not allowed");
  });

  it("rejects unrelated host", () => {
    const r = isAllowedTarget("https://example.com/", HOSTS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("host not allowed");
  });

  it("rejects IPv4 literal", () => {
    const r = isAllowedTarget("http://127.0.0.1/", HOSTS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("IP literal not allowed");
  });

  it("rejects IPv6 literal", () => {
    const r = isAllowedTarget("http://[::1]/", HOSTS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("IP literal not allowed");
  });

  it("rejects ftp scheme", () => {
    const r = isAllowedTarget("ftp://api.storyteq.com/", HOSTS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("scheme must be http or https");
  });

  it("rejects malformed URL", () => {
    const r = isAllowedTarget("not a url", HOSTS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("invalid URL");
  });

  it("accepts mixed-case apex in input array", () => {
    const r = isAllowedTarget("https://api.storyteq.com/", ["STORYTEQ.com"]);
    expect(r.ok).toBe(true);
  });

  it("rejects IPv4-mapped IPv6 literal", () => {
    const r = isAllowedTarget("http://[::ffff:127.0.0.1]/", HOSTS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("IP literal not allowed");
  });

  it("rejects IPv4 non-canonical decimal literal", () => {
    const r = isAllowedTarget("http://2130706433/", HOSTS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("IP literal not allowed");
  });

  it("rejects trailing-dot hostname", () => {
    const r = isAllowedTarget("https://storyteq.com./", HOSTS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("host not allowed");
  });

  it("rejects when allowlist is empty", () => {
    const r = isAllowedTarget("https://api.storyteq.com/", []);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("host not allowed");
  });

  it("accepts URL with explicit port", () => {
    const r = isAllowedTarget("https://api.storyteq.com:8443/x", HOSTS);
    expect(r.ok).toBe(true);
  });

  it("accepts URL with userinfo", () => {
    const r = isAllowedTarget("https://user:pw@api.storyteq.com/", HOSTS);
    expect(r.ok).toBe(true);
  });
});
