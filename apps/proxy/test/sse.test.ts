import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createSseHandler } from "../src/sse.js";
import { createRing } from "../src/tail.js";
import type { TailEntry } from "../src/types.js";

function makeEntry(id: string): TailEntry {
  return {
    id,
    startedAt: new Date().toISOString(),
    durationMs: 0,
    method: "GET",
    target: "https://api.storyteq.com/",
    request: { headers: {}, body: { kind: "empty" } },
  };
}

interface SseServer {
  url: string;
  tail: ReturnType<typeof createRing>;
  close(): Promise<void>;
}

async function startSseServer(opts?: { heartbeatMs?: number }): Promise<SseServer> {
  const tail = createRing(50);
  const handle = createSseHandler({ tail, heartbeatMs: opts?.heartbeatMs ?? 60_000 });
  const server = http.createServer((req, res) => handle(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/`,
    tail,
    close: () => new Promise((r) => {
      server.closeAllConnections();
      server.close(() => r());
    }),
  };
}

interface ParsedEvent {
  event: string;
  data: string;
}

async function readEvents(url: string, count: number, timeoutMs = 2000): Promise<ParsedEvent[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { signal: ctrl.signal });
    if (!resp.body) throw new Error("no body");
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const events: ParsedEvent[] = [];
    while (events.length < count) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const lines = block.split("\n");
        let event = "message";
        let data = "";
        for (const line of lines) {
          if (line.startsWith(":")) continue;
          if (line.startsWith("event: ")) event = line.slice(7);
          else if (line.startsWith("data: ")) data += (data ? "\n" : "") + line.slice(6);
        }
        if (data) events.push({ event, data });
        if (events.length >= count) break;
      }
    }
    return events;
  } finally {
    clearTimeout(timer);
  }
}

describe("createSseHandler", () => {
  let s: SseServer | null = null;
  afterEach(async () => { if (s) { await s.close(); s = null; } });

  it("emits a snapshot event with current ring contents on connect", async () => {
    s = await startSseServer();
    s.tail.push(makeEntry("a"));
    s.tail.push(makeEntry("b"));

    const events = await readEvents(s.url, 1);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("snapshot");
    const arr = JSON.parse(events[0].data);
    expect(arr).toHaveLength(2);
    expect(arr[0].id).toBe("a");
    expect(arr[1].id).toBe("b");
  });

  it("emits new entries as 'entry' events after the snapshot", async () => {
    s = await startSseServer();
    const ctrl = new AbortController();
    const respPromise = fetch(s.url, { signal: ctrl.signal });

    // Wait briefly so the connection registers, then push.
    await new Promise((r) => setTimeout(r, 50));
    s.tail.push(makeEntry("x"));

    const resp = await respPromise;
    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const events: ParsedEvent[] = [];

    const deadline = Date.now() + 2000;
    while (events.length < 2 && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const lines = block.split("\n");
        let event = "message";
        let data = "";
        for (const line of lines) {
          if (line.startsWith(":")) continue;
          if (line.startsWith("event: ")) event = line.slice(7);
          else if (line.startsWith("data: ")) data += (data ? "\n" : "") + line.slice(6);
        }
        if (data) events.push({ event, data });
      }
    }
    ctrl.abort();

    expect(events[0].event).toBe("snapshot");
    expect(events[1].event).toBe("entry");
    expect(JSON.parse(events[1].data).id).toBe("x");
  });

  it("emits heartbeat comments at the configured interval", async () => {
    s = await startSseServer({ heartbeatMs: 50 });
    const ctrl = new AbortController();
    const resp = await fetch(s.url, { signal: ctrl.signal });
    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    let raw = "";
    const deadline = Date.now() + 500;
    while (Date.now() < deadline && !raw.includes(": ping")) {
      const { value, done } = await reader.read();
      if (done) break;
      raw += decoder.decode(value, { stream: true });
    }
    ctrl.abort();
    expect(raw).toContain(": ping");
  });
});
