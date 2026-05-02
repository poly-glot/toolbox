import type { RawHeaders, DisplayHeaders } from "./types.js";

export type SanitizedHeaders = Record<string, string | string[]>;

const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "te", "transfer-encoding", "trailer",
  "upgrade", "proxy-authenticate", "proxy-authorization",
]);

const STRIPPED_OUTBOUND = new Set([...HOP_BY_HOP, "host", "x-target", "content-length"]);

const isStrippedOutbound = (name: string): boolean => STRIPPED_OUTBOUND.has(name.toLowerCase());
const isHopByHop         = (name: string): boolean => HOP_BY_HOP.has(name.toLowerCase());
const isDefinedEntry     = <V,>(e: [string, V | undefined]): e is [string, V] => e[1] !== undefined;

export function sanitizeOutboundHeaders(headers: RawHeaders, host: string): SanitizedHeaders {
  const kept = Object.entries(headers).filter(isDefinedEntry).filter(([n]) => !isStrippedOutbound(n));
  return { ...Object.fromEntries(kept), host };
}

export function sanitizeInboundHeaders(headers: RawHeaders): SanitizedHeaders {
  const kept = Object.entries(headers).filter(isDefinedEntry).filter(([n]) => !isHopByHop(n));
  return Object.fromEntries(kept);
}

export const flattenForDisplay = (headers: SanitizedHeaders): DisplayHeaders =>
  Object.fromEntries(
    Object.entries(headers).map(([n, v]) => [n, Array.isArray(v) ? v.join(", ") : v]),
  );

export const headerString = (v: string | string[] | undefined): string | null =>
  v === undefined ? null : Array.isArray(v) ? v[0] ?? null : v;
