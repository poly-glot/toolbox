import type { TailEntry } from "./types.js";

export type Subscriber      = (entry: TailEntry) => void;
export type ClearSubscriber = () => void;

export interface TailRing {
  push(entry: TailEntry): void;
  snapshot(): TailEntry[];
  clear(): void;
  subscribe(fn: Subscriber): () => void;
  subscribeClear(fn: ClearSubscriber): () => void;
}

function notifyAll<F extends (...args: never[]) => void>(
  fns: Iterable<F>,
  ...args: Parameters<F>
): void {
  for (const fn of fns) {
    try { fn(...args); } catch { /* swallow subscriber errors */ }
  }
}

export function createRing(capacity: number): TailRing {
  if (capacity <= 0) throw new Error("capacity must be > 0");
  const buf: (TailEntry | undefined)[] = new Array(capacity);
  let head = 0;
  let count = 0;
  const subs      = new Set<Subscriber>();
  const clearSubs = new Set<ClearSubscriber>();

  return {
    push(entry) {
      buf[head] = entry;
      head = (head + 1) % capacity;
      if (count < capacity) count++;
      notifyAll(subs, entry);
    },
    snapshot() {
      const start = count < capacity ? 0 : head;
      return Array.from({ length: count }, (_, i) => buf[(start + i) % capacity])
        .filter((e): e is TailEntry => e !== undefined);
    },
    clear() {
      buf.fill(undefined);
      head = 0;
      count = 0;
      notifyAll(clearSubs);
    },
    subscribe(fn) {
      subs.add(fn);
      return () => { subs.delete(fn); };
    },
    subscribeClear(fn) {
      clearSubs.add(fn);
      return () => { clearSubs.delete(fn); };
    },
  };
}
