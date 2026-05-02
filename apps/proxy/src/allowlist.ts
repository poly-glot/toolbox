const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

export interface AllowlistOk { ok: true; parsed: URL; }

export interface AllowlistBad {
  ok: false;
  reason:
    | "invalid URL"
    | "scheme must be http or https"
    | "IP literal not allowed"
    | "host not allowed";
}

export type AllowlistResult = AllowlistOk | AllowlistBad;

const tryParseUrl = (raw: string): URL | null => { try { return new URL(raw); } catch { return null; } };

const isHttpScheme = (u: URL): boolean       => u.protocol === "http:" || u.protocol === "https:";
const isIpLiteral  = (host: string): boolean => host.startsWith("[") || IPV4.test(host);

const matchesApex = (host: string) => (apex: string): boolean => {
  const lower = apex.toLowerCase();
  return host === lower || host.endsWith("." + lower);
};

export function isAllowedTarget(rawUrl: string, allowedHosts: string[]): AllowlistResult {
  const parsed = tryParseUrl(rawUrl);
  if (!parsed)                                          return { ok: false, reason: "invalid URL" };
  if (!isHttpScheme(parsed))                            return { ok: false, reason: "scheme must be http or https" };
  if (isIpLiteral(parsed.hostname))                     return { ok: false, reason: "IP literal not allowed" };
  if (!allowedHosts.some(matchesApex(parsed.hostname))) return { ok: false, reason: "host not allowed" };
  return { ok: true, parsed };
}
