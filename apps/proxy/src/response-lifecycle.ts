import type { IncomingMessage } from "node:http";
import { sanitizeInboundHeaders, type SanitizedHeaders } from "./headers.js";
import { CaptureBuffer } from "./capture.js";

export class ResponseLifecycle {
  readonly capture: CaptureBuffer;

  private started   = false;
  private ended     = false;
  private timedOut  = false;
  private finalized = false;

  private headers: SanitizedHeaders = {};
  private status = 0;
  private statusText = "";

  constructor(captureBytes: number) {
    this.capture = new CaptureBuffer(captureBytes);
  }

  // transitions
  markStarted(targetRes: IncomingMessage): void {
    this.started    = true;
    this.headers    = sanitizeInboundHeaders(targetRes.headers);
    this.status     = targetRes.statusCode    ?? 502;
    this.statusText = targetRes.statusMessage ?? "";
  }
  markEnded():    void { this.ended    = true; }
  markTimedOut(): void { this.timedOut = true; }

  // queries
  hasStarted():        boolean          { return this.started; }
  hasEnded():          boolean          { return this.ended; }
  wasTimedOut():       boolean          { return this.timedOut; }
  inboundHeaders():    SanitizedHeaders { return this.headers; }
  responseStatus():    number           { return this.status; }
  responseStatusText(): string          { return this.statusText; }

  // lifecycle dedupe
  finalizeOnce(fn: () => void): void {
    if (this.finalized) return;
    this.finalized = true;
    fn();
  }
}
