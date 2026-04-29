const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "te",
  "transfer-encoding",
  "trailer",
  "upgrade",
  "proxy-authenticate",
  "proxy-authorization",
]);

export type SanitizedHeaders = Record<string, string | string[]>;

export function sanitizeOutboundHeaders(
  inHeaders: NodeJS.Dict<string | string[]>,
  targetHost: string,
): SanitizedHeaders {
  const out: SanitizedHeaders = {};
  for (const [name, value] of Object.entries(inHeaders)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (
      HOP_BY_HOP.has(lower) ||
      lower === "host" ||
      lower === "x-target" ||
      lower === "content-length"
    ) {
      continue;
    }
    out[name] = value;
  }
  out.host = targetHost;
  return out;
}

export function sanitizeInboundHeaders(
  inHeaders: NodeJS.Dict<string | string[]>,
): SanitizedHeaders {
  const out: SanitizedHeaders = {};
  for (const [name, value] of Object.entries(inHeaders)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    out[name] = value;
  }
  return out;
}

export function flattenForDisplay(headers: SanitizedHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}
