import type { IncomingMessage, ServerResponse } from "node:http";
import { loadConfig, type Config } from "./config.js";
import { createRing, type TailRing } from "./tail.js";
import { createRecorder } from "./recorder.js";
import { createForwarder } from "./forwarder.js";
import { createSseHandler } from "./sse.js";
import { renderUI } from "./ui.js";
import { authenticate, denyResponse } from "./auth.js";

export type Handler = (req: IncomingMessage, res: ServerResponse) => void;

interface Route {
  method: string | null;   // null = any
  path: string;
  handler: Handler;
}

export interface App {
  config: Config;
  tail:   TailRing;
  dispatch: Handler;
}

const matches = (r: Route, method: string, path: string): boolean =>
  r.path === path && (r.method === null || r.method === method);

const pathOnly = (url: string): string => {
  const q = url.indexOf("?");
  return q === -1 ? url : url.slice(0, q);
};

const health = (_req: IncomingMessage, res: ServerResponse): void => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ status: "ok", service: "proxy" }));
};

const serveUi = (_req: IncomingMessage, res: ServerResponse): void => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(renderUI());
};

const clearTail = (ring: TailRing): Handler => (_req, res) => {
  ring.clear();
  res.writeHead(204);
  res.end();
};

const notFound = (res: ServerResponse): void => {
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
};

const makeDispatch = (routes: readonly Route[]): Handler => (req, res) => {
  const path = pathOnly(req.url ?? "/");
  const method = req.method ?? "GET";
  const route = routes.find((r) => matches(r, method, path));
  if (route) { route.handler(req, res); return; }
  notFound(res);
};

export function createApp(env: NodeJS.ProcessEnv = process.env): App {
  const config   = loadConfig(env);
  const tail     = createRing(config.tailSize);
  const recorder = createRecorder(tail);
  const forward  = createForwarder({ config, recorder });
  const sse      = createSseHandler({ tail });

  const gated = (handler: Handler): Handler => (req, res) => {
    const outcome = authenticate(config.tailSecret, req);
    if (outcome.kind === "allowed") { handler(req, res); return; }
    denyResponse(res, outcome);
  };

  const routes: readonly Route[] = [
    { method: null,     path: "/health",  handler: health },
    { method: null,     path: "/healthz", handler: health },
    { method: "GET",    path: "/",        handler: gated(serveUi) },
    { method: "GET",    path: "/tail",    handler: gated(sse) },
    { method: "DELETE", path: "/tail",    handler: gated(clearTail(tail)) },
    { method: null,     path: "/forward", handler: forward },
  ];

  return { config, tail, dispatch: makeDispatch(routes) };
}
