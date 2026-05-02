import { flattenForDisplay, type SanitizedHeaders } from "./headers.js";
import type { TailRing } from "./tail.js";
import type { TailEntry, BodySnippet } from "./types.js";

export interface RequestSide  { headers: SanitizedHeaders; body: BodySnippet; }
export interface ResponseSide { status: number; statusText: string; headers: SanitizedHeaders; body: BodySnippet; }

export interface Exchange {
  startedAt: Date;
  startMs: number;
  method: string;
  target: string;
  request: RequestSide;
  response?: ResponseSide;
  error?: string;
}

export interface Recorder { record(exchange: Exchange): void; }

export function createRecorder(tail: TailRing): Recorder {
  let counter = 0;
  // Modulo wraps after 1M entries within the same millisecond — the tail is
  // for debugging and a clash here is harmless.
  const nextId = (startMs: number): string => {
    counter = (counter + 1) % 1_000_000;
    return `${startMs}-${counter.toString().padStart(6, "0")}`;
  };

  const buildResponse = (r: ResponseSide) => ({
    status:     r.status,
    statusText: r.statusText,
    headers:    flattenForDisplay(r.headers),
    body:       r.body,
  });

  return {
    record(x) {
      const entry: TailEntry = {
        id:         nextId(x.startMs),
        startedAt:  x.startedAt.toISOString(),
        durationMs: Date.now() - x.startMs,
        method:     x.method,
        target:     x.target,
        request:    { headers: flattenForDisplay(x.request.headers), body: x.request.body },
        ...(x.response && { response: buildResponse(x.response) }),
        ...(x.error !== undefined && { error: x.error }),
      };
      tail.push(entry);
    },
  };
}
