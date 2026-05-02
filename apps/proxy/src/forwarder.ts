import http from "node:http";
import https from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isAllowedTarget } from "./allowlist.js";
import {
  sanitizeOutboundHeaders,
  headerString,
  type SanitizedHeaders,
} from "./headers.js";
import { CaptureBuffer } from "./capture.js";
import { ResponseLifecycle } from "./response-lifecycle.js";
import { classifyBody } from "./body.js";
import type { Recorder, RequestSide, ResponseSide } from "./recorder.js";
import type { Config } from "./config.js";

class ProxyTimeoutError extends Error {
  readonly name = "ProxyTimeoutError";
  constructor() { super("upstream timeout"); }
}

interface ForwarderDeps { config: Config; recorder: Recorder; }

interface ProxyContext {
  req:             IncomingMessage;
  res:             ServerResponse;
  target:          URL;
  targetHeader:    string;
  startedAt:       Date;
  startMs:         number;
  outboundHeaders: SanitizedHeaders;
  reqCapture:      CaptureBuffer;
  lifecycle:       ResponseLifecycle;
  cap:             number;
  timeoutMs:       number;
  recorder:        Recorder;
}

const labelMidResponseError = (timedOut: boolean, err: Error): string => {
  // Node rewrites the timeout sentinel into "aborted" mid-response, so trust the flag too.
  if (timedOut || err instanceof ProxyTimeoutError) return "upstream timeout";
  return `upstream error: ${err.message}`;
};

const readTargetHeader = (req: IncomingMessage): string | null => {
  const raw = req.headers["x-target"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value && value.length > 0 ? value : null;
};

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) {
    try { res.end(); } catch { /* ignore */ }
    return;
  }
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

const buildRequestSide = (ctx: ProxyContext): RequestSide => ({
  headers: ctx.outboundHeaders,
  body: classifyBody(ctx.reqCapture.bytes(), {
    contentType:     headerString(ctx.req.headers["content-type"]),
    contentEncoding: headerString(ctx.req.headers["content-encoding"]),
    totalBytes:      ctx.reqCapture.totalBytes,
    cap:             ctx.cap,
  }),
});

const buildResponseSide = (ctx: ProxyContext): ResponseSide | undefined => {
  if (!ctx.lifecycle.hasStarted()) return undefined;
  const headers = ctx.lifecycle.inboundHeaders();
  return {
    status:     ctx.lifecycle.responseStatus(),
    statusText: ctx.lifecycle.responseStatusText(),
    headers,
    body: classifyBody(ctx.lifecycle.capture.bytes(), {
      contentType:     headerString(headers["content-type"]),
      contentEncoding: headerString(headers["content-encoding"]),
      totalBytes:      ctx.lifecycle.capture.totalBytes,
      cap:             ctx.cap,
    }),
  };
};

const finalize = (ctx: ProxyContext, error: string | undefined): void => {
  ctx.lifecycle.finalizeOnce(() => ctx.recorder.record({
    startedAt: ctx.startedAt,
    startMs:   ctx.startMs,
    method:    ctx.req.method ?? "GET",
    target:    ctx.targetHeader,
    request:   buildRequestSide(ctx),
    response:  buildResponseSide(ctx),
    error,
  }));
};

export function createForwarder(deps: ForwarderDeps) {
  const { config, recorder } = deps;
  const cap = config.bodyCaptureBytes;

  function rejectInvalidTarget(
    res: ServerResponse,
    req: IncomingMessage,
    targetHeader: string,
    reason: string,
    startedAt: Date,
    startMs: number,
  ): void {
    const isHostNotAllowed = reason === "host not allowed";
    const status = isHostNotAllowed ? 403 : 400;
    const body = isHostNotAllowed
      ? { error: reason, allowed: config.allowedHosts }
      : { error: reason };
    const serialized = JSON.stringify(body);
    writeJson(res, status, body);

    if (!isHostNotAllowed) return;
    recorder.record({
      startedAt,
      startMs,
      method: req.method ?? "GET",
      target: targetHeader,
      request: {
        headers: sanitizeOutboundHeaders(req.headers, "(rejected)"),
        body: { kind: "empty" },
      },
      response: {
        status: 403,
        statusText: "Forbidden",
        headers: { "content-type": "application/json" },
        body: { kind: "text", bytes: serialized.length, truncated: false, data: serialized },
      },
      error: reason,
    });
  }

  return function handleForward(req: IncomingMessage, res: ServerResponse): void {
    const startedAt = new Date();
    const startMs = Date.now();

    const targetHeader = readTargetHeader(req);
    if (!targetHeader) {
      writeJson(res, 400, { error: "X-TARGET header required" });
      return;
    }

    const allow = isAllowedTarget(targetHeader, config.allowedHosts);
    if (!allow.ok) {
      rejectInvalidTarget(res, req, targetHeader, allow.reason, startedAt, startMs);
      return;
    }

    proxy({
      req,
      res,
      target:          allow.parsed,
      targetHeader,
      startedAt,
      startMs,
      outboundHeaders: sanitizeOutboundHeaders(req.headers, allow.parsed.host),
      reqCapture:      new CaptureBuffer(cap),
      lifecycle:       new ResponseLifecycle(cap),
      cap,
      timeoutMs:       config.timeoutMs,
      recorder,
    });
  };
}

function proxy(ctx: ProxyContext): void {
  const { req, res, target, outboundHeaders, reqCapture, lifecycle, timeoutMs } = ctx;
  const transport = target.protocol === "https:" ? https : http;

  req.on("data", (chunk: Buffer) => reqCapture.observe(chunk));

  const outboundReq = transport.request(target, {
    method: req.method,
    headers: outboundHeaders,
  });

  outboundReq.setTimeout(timeoutMs, () => {
    lifecycle.markTimedOut();
    outboundReq.destroy(new ProxyTimeoutError());
  });

  outboundReq.on("response", (targetRes) => {
    lifecycle.markStarted(targetRes);

    try {
      Object.entries(lifecycle.inboundHeaders()).forEach(([n, v]) => res.setHeader(n, v));
      res.writeHead(lifecycle.responseStatus(), lifecycle.responseStatusText());
    } catch { /* already sent */ }

    targetRes.on("data", (chunk: Buffer) => {
      lifecycle.capture.observe(chunk);
      try { res.write(chunk); } catch { /* client gone */ }
    });

    targetRes.on("end", () => {
      lifecycle.markEnded();
      try { res.end(); } catch { /* ignore */ }
      finalize(ctx, undefined);
    });

    targetRes.on("error", (err) => {
      try { res.end(); } catch { /* ignore */ }
      finalize(ctx, labelMidResponseError(lifecycle.wasTimedOut(), err));
    });

    targetRes.on("close", () => {
      // close can race ahead of end on some Node versions — skip if end already finalized
      if (lifecycle.hasEnded()) return;
      try { res.end(); } catch { /* ignore */ }
      finalize(ctx, lifecycle.wasTimedOut() ? "upstream timeout" : "upstream closed prematurely");
    });
  });

  outboundReq.on("error", (err: Error) => {
    if (lifecycle.hasStarted()) return; // handled in targetRes.error path
    if (err instanceof ProxyTimeoutError) {
      writeJson(res, 504, { error: "upstream timeout" });
      finalize(ctx, "upstream timeout");
      return;
    }
    writeJson(res, 502, { error: "upstream connection failed", detail: err.message });
    finalize(ctx, `upstream connection failed: ${err.message}`);
  });

  req.on("close", () => {
    if (req.complete) return;          // body fully read; close is normal
    try { outboundReq.destroy(); } catch { /* ignore */ }
    finalize(ctx, "client aborted");
  });

  req.pipe(outboundReq);
}
