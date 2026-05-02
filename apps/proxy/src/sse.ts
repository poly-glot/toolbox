import type { IncomingMessage, ServerResponse } from "node:http";
import type { TailRing } from "./tail.js";
import type { TailEntry } from "./types.js";

export interface SseDeps {
  tail: TailRing;
  heartbeatMs?: number;
}

export function createSseHandler(deps: SseDeps) {
  const heartbeat = deps.heartbeatMs ?? 15_000;

  return function handleSse(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });

    const seen = new Set<string>();
    const queue: TailEntry[] = [];
    let snapshotSent = false;

    function send(event: string, data: unknown): void {
      try {
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      } catch {
        // connection closed
      }
    }

    const unsubscribe = deps.tail.subscribe((entry) => {
      if (snapshotSent) {
        if (seen.has(entry.id)) return;
        seen.add(entry.id);
        send("entry", entry);
      } else {
        queue.push(entry);
      }
    });

    const unsubscribeClear = deps.tail.subscribeClear(() => {
      seen.clear();
      send("cleared", {});
    });

    // Take snapshot, send it, mark IDs as seen, then drain queue.
    const snap = deps.tail.snapshot();
    for (const e of snap) seen.add(e.id);
    send("snapshot", snap);
    snapshotSent = true;

    // Safe single-pass dedup: recorder IDs are monotonic per ring, so the queue
    // cannot contain two entries with the same id between subscribe and snapshot.
    const fresh = queue.filter((e) => !seen.has(e.id));
    queue.length = 0;
    fresh.forEach((e) => seen.add(e.id));
    fresh.forEach((e) => send("entry", e));

    // After drain, post-snapshot entries have unique IDs from the counter;
    // we no longer need the seen set for dedup.
    seen.clear();

    const interval = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
        // ignore
      }
    }, heartbeat);

    function cleanup(): void {
      clearInterval(interval);
      unsubscribe();
      unsubscribeClear();
    }

    req.on("close", cleanup);
    res.on("close", cleanup);
  };
}
