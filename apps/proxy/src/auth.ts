import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export type AuthOutcome =
  | { kind: "allowed" }
  | { kind: "unauthorized"; reason: "missing-credential" | "wrong-credential" }
  | { kind: "misconfigured" };

export type DeniedOutcome = Exclude<AuthOutcome, { kind: "allowed" }>;

const BEARER_PREFIX = "bearer ";

const constantTimeEqual = (a: string, b: string): boolean => {
  const ab = Buffer.from(a, "utf-8");
  const bb = Buffer.from(b, "utf-8");
  // Length check is required (timingSafeEqual throws on length mismatch).
  // This leaks secret length via timing — acceptable for a config-managed Bearer secret.
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
};

const fromBearer = (req: IncomingMessage): string | null => {
  const raw = req.headers["authorization"];
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (!header || !header.toLowerCase().startsWith(BEARER_PREFIX)) return null;
  return header.slice(BEARER_PREFIX.length).trim();
};

const fromQuery = (req: IncomingMessage): string | null => {
  const url = req.url ?? "";
  const q = url.indexOf("?");
  if (q === -1) return null;
  return new URLSearchParams(url.slice(q + 1)).get("secret");
};

const presentedSecret = (req: IncomingMessage): string | null =>
  fromBearer(req) ?? fromQuery(req);

export function authenticate(secret: string | null, req: IncomingMessage): AuthOutcome {
  if (secret === null) return { kind: "misconfigured" };
  const presented = presentedSecret(req);
  if (presented === null) return { kind: "unauthorized", reason: "missing-credential" };
  if (!constantTimeEqual(presented, secret)) return { kind: "unauthorized", reason: "wrong-credential" };
  return { kind: "allowed" };
}

export function denyResponse(res: ServerResponse, outcome: DeniedOutcome): void {
  switch (outcome.kind) {
    case "unauthorized":
      res.writeHead(401, {
        "content-type": "application/json",
        "www-authenticate": "Bearer realm=\"proxy-tail\"",
      });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    case "misconfigured":
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "tail disabled: PROXY_TAIL_SECRET not set" }));
      return;
  }
}
