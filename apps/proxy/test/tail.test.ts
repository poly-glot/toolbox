import { describe, it, expect, vi } from "vitest";
import { createRing } from "../src/tail.js";
import type { TailEntry } from "../src/types.js";

function entry(id: string): TailEntry {
  return {
    id,
    startedAt: "2026-04-29T00:00:00Z",
    durationMs: 0,
    method: "GET",
    target: "https://api.storyteq.com/",
    request: { headers: {}, body: { kind: "empty" } },
  };
}

describe("createRing", () => {
  it("snapshot returns oldest -> newest", () => {
    const r = createRing(3);
    r.push(entry("1"));
    r.push(entry("2"));
    r.push(entry("3"));
    expect(r.snapshot().map((e) => e.id)).toEqual(["1", "2", "3"]);
  });

  it("overwrites oldest when capacity exceeded", () => {
    const r = createRing(3);
    r.push(entry("1"));
    r.push(entry("2"));
    r.push(entry("3"));
    r.push(entry("4"));
    r.push(entry("5"));
    expect(r.snapshot().map((e) => e.id)).toEqual(["3", "4", "5"]);
  });

  it("subscribers receive new pushes", () => {
    const r = createRing(3);
    const fn = vi.fn();
    r.subscribe(fn);
    r.push(entry("1"));
    r.push(entry("2"));
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn.mock.calls[0][0].id).toBe("1");
  });

  it("multiple subscribers all receive each push", () => {
    const r = createRing(3);
    const a = vi.fn();
    const b = vi.fn();
    r.subscribe(a);
    r.subscribe(b);
    r.push(entry("1"));
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
  });

  it("unsubscribe stops further notifications", () => {
    const r = createRing(3);
    const fn = vi.fn();
    const unsub = r.subscribe(fn);
    r.push(entry("1"));
    unsub();
    r.push(entry("2"));
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("subscriber error does not break other subscribers", () => {
    const r = createRing(3);
    const bad = vi.fn(() => { throw new Error("boom"); });
    const good = vi.fn();
    r.subscribe(bad);
    r.subscribe(good);
    expect(() => r.push(entry("1"))).not.toThrow();
    expect(good).toHaveBeenCalledOnce();
  });

  it("snapshot before any push returns empty array", () => {
    const r = createRing(3);
    expect(r.snapshot()).toEqual([]);
  });
});
