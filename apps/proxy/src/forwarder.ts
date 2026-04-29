import http from "node:http";
import https from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isAllowedTarget } from "./allowlist.js";
import {
  sanitizeOutboundHeaders,
  sanitizeInboundHeaders,
  flattenForDisplay,
  type SanitizedHeaders,
} from "./headers.js";
import { classifyBody } from "./body.js";
import type { TailEntry } from "./types.js";
import type { TailRing } from "./tail.js";
import type { Config } from "./config.js";

interface ForwarderDeps {
  config: Config;
  tail: TailRing;
}

let counter = 0;
function nextId(startMs: number): string {
  counter = (counter + 1) % 1_000_000;
  return `${startMs}-${counter.toString().padStart(6, "0")}`;
}

function headerString(v: string | string[] | undefined): string | null {
  if (v === undefined) return null;
  return Array.isArray(v) ? v[0] ?? null : v;
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) {
    try { res.end(); } catch { /* ignore */ }
    return;
  }
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

export function createForwarder(deps: ForwarderDeps) {
  const cap = deps.config.bodyCaptureBytes;

  return function handleForward(req: IncomingMessage, res: ServerResponse): void {
    const startedAt = new Date();
    const startMs = Date.now();

    const targetHeaderRaw = req.headers["x-target"];
    const targetHeader = Array.isArray(targetHeaderRaw)
      ? targetHeaderRaw[0]
      : targetHeaderRaw;

    if (!targetHeader) {
      writeJson(res, 400, { error: "X-TARGET header required" });
      return;
    }

    const result = isAllowedTarget(targetHeader, deps.config.allowedHosts);
    if (!result.ok) {
      const status = result.reason === "host not allowed" ? 403 : 400;
      const body =
        status === 403
          ? { error: "host not allowed", allowed: deps.config.allowedHosts }
          : { error: result.reason };
      writeJson(res, status, body);

      if (status === 403) {
        const headersForLog = flattenForDisplay(
          sanitizeOutboundHeaders(req.headers, "(rejected)"),
        );
        const responseBody = JSON.stringify(body);
        deps.tail.push({
          id: nextId(startMs),
          startedAt: startedAt.toISOString(),
          durationMs: Date.now() - startMs,
          method: req.method ?? "GET",
          target: targetHeader,
          request: {
            headers: headersForLog,
            body: { kind: "empty" },
          },
          response: {
            status: 403,
            statusText: "Forbidden",
            headers: { "content-type": "application/json" },
            body: {
              kind: "text",
              bytes: responseBody.length,
              truncated: false,
              data: responseBody,
            },
          },
          error: "host not allowed",
        });
      }
      return;
    }

    const target = result.parsed;
    const lib = target.protocol === "https:" ? https : http;
    const outboundHeaders = sanitizeOutboundHeaders(req.headers, target.host);

    // Capture observers
    const reqChunks: Buffer[] = [];
    let reqTotal = 0;
    let reqStored = 0;
    req.on("data", (chunk: Buffer) => {
      reqTotal += chunk.length;
      if (reqStored < cap) {
        const remaining = cap - reqStored;
        const take = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
        reqChunks.push(take);
        reqStored += take.length;
      }
    });

    let inboundHeaders: SanitizedHeaders = {};
    const resChunks: Buffer[] = [];
    let resTotal = 0;
    let resStored = 0;
    let respStatus = 0;
    let respStatusText = "";

    let finalized = false;
    function finalize(error?: string, includeResponse = true): void {
      if (finalized) return;
      finalized = true;
      const reqCT = headerString(req.headers["content-type"]);
      const reqCE = headerString(req.headers["content-encoding"]);
      const responseCT = headerString(inboundHeaders["content-type"]);
      const responseCE = headerString(inboundHeaders["content-encoding"]);

      const entry: TailEntry = {
        id: nextId(startMs),
        startedAt: startedAt.toISOString(),
        durationMs: Date.now() - startMs,
        method: req.method ?? "GET",
        target: targetHeader as string,
        request: {
          headers: flattenForDisplay(outboundHeaders),
          body: classifyBody(Buffer.concat(reqChunks), {
            contentType: reqCT,
            contentEncoding: reqCE,
            totalBytes: reqTotal,
            cap,
          }),
        },
      };
      if (includeResponse && respStatus !== 0) {
        entry.response = {
          status: respStatus,
          statusText: respStatusText,
          headers: flattenForDisplay(inboundHeaders),
          body: classifyBody(Buffer.concat(resChunks), {
            contentType: responseCT,
            contentEncoding: responseCE,
            totalBytes: resTotal,
            cap,
          }),
        };
      }
      if (error) entry.error = error;
      deps.tail.push(entry);
    }

    const outboundReq = lib.request(target, {
      method: req.method,
      headers: outboundHeaders,
    });

    let responseStarted = false;
    let timedOut = false;

    outboundReq.setTimeout(deps.config.timeoutMs, () => {
      timedOut = true;
      outboundReq.destroy(new Error("__proxy_timeout__"));
    });

    outboundReq.on("response", (targetRes) => {
      responseStarted = true;
      inboundHeaders = sanitizeInboundHeaders(targetRes.headers);
      respStatus = targetRes.statusCode ?? 502;
      respStatusText = targetRes.statusMessage ?? "";

      try {
        for (const [name, value] of Object.entries(inboundHeaders)) {
          res.setHeader(name, value);
        }
        res.writeHead(respStatus, respStatusText);
      } catch {
        // already sent — fall through; data will fail-write below
      }

      targetRes.on("data", (chunk: Buffer) => {
        resTotal += chunk.length;
        if (resStored < cap) {
          const remaining = cap - resStored;
          const take = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
          resChunks.push(take);
          resStored += take.length;
        }
        try { res.write(chunk); } catch { /* client gone */ }
      });

      let endSeen = false;
      targetRes.on("end", () => {
        endSeen = true;
        try { res.end(); } catch { /* ignore */ }
        finalize();
      });

      targetRes.on("error", (err) => {
        try { res.end(); } catch { /* ignore */ }
        // When a mid-response timeout fires, outboundReq.destroy() propagates
        // here with err.message === "aborted" (Node rewrites it), so also
        // honour the timedOut flag set by setTimeout().
        const label = timedOut || err.message === "__proxy_timeout__"
          ? "upstream timeout"
          : `upstream error: ${err.message}`;
        finalize(label);
      });

      targetRes.on("close", () => {
        // Safety net for abnormal closes where neither end nor error fired.
        // Skip when end already saw us through — close can race ahead of end
        // in some Node versions, and we don't want to mislabel clean responses.
        if (endSeen) return;
        try { res.end(); } catch { /* ignore */ }
        finalize(timedOut ? "upstream timeout" : "upstream closed prematurely");
      });
    });

    outboundReq.on("error", (err: Error & { code?: string }) => {
      if (responseStarted) return; // handled in targetRes.error path
      const isTimeout = err.message === "__proxy_timeout__";
      if (isTimeout) {
        writeJson(res, 504, { error: "upstream timeout" });
        finalize("upstream timeout", false);
      } else {
        writeJson(res, 502, {
          error: "upstream connection failed",
          detail: err.message,
        });
        finalize(`upstream connection failed: ${err.message}`, false);
      }
    });

    req.on("aborted", () => {
      try { outboundReq.destroy(); } catch { /* ignore */ }
      finalize("client aborted");
    });

    req.pipe(outboundReq);
  };
}
