import type { IncomingMessage, ServerResponse } from "node:http";
import { uploadPermission } from "./auth.js";
import type { Config } from "./config.js";
import { declaredType, extensionOf, typeOf } from "./media.js";
import { publish } from "./publish.js";
import type { Store, StoredEntry } from "./types.js";

export type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

const SHORT_URL = /^\/([0-9a-f]{7,128})(?:\.[a-z0-9]{1,10})?$/;
const IMMUTABLE_FOR_A_DAY = "public, max-age=86400, immutable";

const USAGE = `temporaryurl

POST /temporaryurl with the file as the raw body, its Content-Type, and
Authorization: Bearer <token>. Add ?name=file.ext when the type has no known extension.

The answer is a 301 whose Location is /temporaryurl/<short sha512>.<ext>. The short id is
the shortest unique prefix of the content's SHA-512, at least 7 characters, like git's.
The same content always gets the same URL. Files expire unless uploaded again.
`;

const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { "cache-control": "no-store", "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

async function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size <= maxBytes) chunks.push(chunk);
  }

  return size <= maxBytes ? Buffer.concat(chunks) : null;
}

const fileHeaders = (entry: StoredEntry): Record<string, string | number> => ({
  "cache-control": IMMUTABLE_FOR_A_DAY,
  "content-length": entry.size,
  "content-security-policy": "sandbox",
  "content-type": entry.type,
  etag: `"${entry.sha512}"`,
  "x-content-type-options": "nosniff",
});

export function createApp(config: Config, store: Store): Handler {
  const health: Handler = async (_req, res) => {
    const storeIsUp = await store.ping().catch(() => false);
    sendJson(res, storeIsUp ? 200 : 503, { service: "temporaryurl", status: storeIsUp ? "ok" : "store unavailable" });
  };

  const usage: Handler = async (_req, res) => {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end(USAGE);
  };

  const upload: Handler = async (req, res) => {
    const permission = uploadPermission(config.uploadToken, req);
    if (permission === "disabled") return sendJson(res, 503, { error: "uploads disabled: TEMPORARYURL_UPLOAD_TOKEN not set" });
    if (permission === "unauthorized") return sendJson(res, 401, { error: "unauthorized" });

    if (Number(req.headers["content-length"] ?? 0) > config.maxBytes) {
      return sendJson(res, 413, { error: `larger than ${config.maxBytes} bytes` });
    }

    const body = await readBody(req, config.maxBytes);
    if (body === null) return sendJson(res, 413, { error: `larger than ${config.maxBytes} bytes` });
    if (body.length === 0) return sendJson(res, 400, { error: "empty body: send the file as the request body" });

    const query = new URL(req.url ?? "/", "http://localhost").searchParams;
    const type = declaredType(req.headers["content-type"]);
    const ext = extensionOf(query.get("name"), type);
    if (ext === null) {
      return sendJson(res, 400, { error: "unknown extension: send a known Content-Type or ?name=file.ext" });
    }

    const { short, entry } = await publish(store, { body, ext, type: typeOf(ext, type) }, config.ttlSeconds);
    const url = `${config.publicUrl}/${short}.${entry.ext}`;

    res.writeHead(301, { "cache-control": "no-store", "content-type": "application/json", location: url });
    res.end(JSON.stringify({ url, short, sha512: entry.sha512, type: entry.type, size: entry.size, expiresInSeconds: config.ttlSeconds }));
  };

  const serve = (short: string): Handler => async (req, res) => {
    const entry = await store.entry(short);
    if (entry === null) return sendJson(res, 404, { error: "not found or expired" });

    if (req.headers["if-none-match"] === `"${entry.sha512}"`) {
      res.writeHead(304, { "cache-control": IMMUTABLE_FOR_A_DAY, etag: `"${entry.sha512}"` });
      res.end();
      return;
    }

    if (req.method === "HEAD") {
      res.writeHead(200, fileHeaders(entry));
      res.end();
      return;
    }

    const body = await store.body(short);
    if (body === null) return sendJson(res, 404, { error: "not found or expired" });

    res.writeHead(200, fileHeaders(entry));
    res.end(body);
  };

  const route = (method: string, path: string): Handler | null => {
    const reads = method === "GET" || method === "HEAD";
    if (path === "/health" || path === "/healthz") return health;
    if (path === "/" && method === "POST") return upload;
    if (path === "/" && reads) return usage;

    const short = path.match(SHORT_URL)?.[1];
    return short && reads ? serve(short) : null;
  };

  return async (req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    const handler = route(req.method ?? "GET", path);
    if (handler === null) return sendJson(res, 404, { error: "not found" });

    try {
      await handler(req, res);
    } catch (error) {
      console.error(`[temporaryurl] ${req.method} ${path} failed:`, error);
      if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
    }
  };
}
