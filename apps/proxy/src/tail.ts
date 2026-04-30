import type { TailEntry } from "./types.js";

export type Subscriber = (entry: TailEntry) => void;
export type ClearSubscriber = () => void;

export interface TailRing {
  push(entry: TailEntry): void;
  snapshot(): TailEntry[];
  clear(): void;
  subscribe(fn: Subscriber): () => void;
  subscribeClear(fn: ClearSubscriber): () => void;
}

export function createRing(capacity: number): TailRing {
  if (capacity <= 0) throw new Error("capacity must be > 0");
  const buf: (TailEntry | undefined)[] = new Array(capacity);
  let head = 0;
  let count = 0;
  const subs = new Set<Subscriber>();
  const clearSubs = new Set<ClearSubscriber>();

  return {
    push(entry) {
      buf[head] = entry;
      head = (head + 1) % capacity;
      if (count < capacity) count++;
      for (const fn of subs) {
        try {
          fn(entry);
        } catch {
          // swallow subscriber errors
        }
      }
    },
    snapshot() {
      const out: TailEntry[] = [];
      const start = count < capacity ? 0 : head;
      for (let i = 0; i < count; i++) {
        const e = buf[(start + i) % capacity];
        if (e) out.push(e);
      }
      return out;
    },
    clear() {
      for (let i = 0; i < buf.length; i++) buf[i] = undefined;
      head = 0;
      count = 0;
      for (const fn of clearSubs) {
        try {
          fn();
        } catch {
          // swallow subscriber errors
        }
      }
    },
    subscribe(fn) {
      subs.add(fn);
      return () => {
        subs.delete(fn);
      };
    },
    subscribeClear(fn) {
      clearSubs.add(fn);
      return () => {
        clearSubs.delete(fn);
      };
    },
  };
}
