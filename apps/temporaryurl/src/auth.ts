import crypto from "node:crypto";
import type { IncomingMessage } from "node:http";

export type UploadPermission = "allowed" | "unauthorized" | "disabled";

const BEARER_PREFIX = "bearer ";

const constantTimeEqual = (a: string, b: string): boolean => {
  const left = Buffer.from(a, "utf-8");
  const right = Buffer.from(b, "utf-8");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
};

const presentedToken = (req: IncomingMessage): string | null => {
  const header = req.headers["authorization"];
  if (!header || !header.toLowerCase().startsWith(BEARER_PREFIX)) return null;
  return header.slice(BEARER_PREFIX.length).trim();
};

export function uploadPermission(token: string | null, req: IncomingMessage): UploadPermission {
  if (token === null) return "disabled";

  const presented = presentedToken(req);
  return presented !== null && constantTimeEqual(presented, token) ? "allowed" : "unauthorized";
}
