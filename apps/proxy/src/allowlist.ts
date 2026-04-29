const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

export interface AllowlistOk {
  ok: true;
  parsed: URL;
}

export interface AllowlistBad {
  ok: false;
  reason:
    | "invalid URL"
    | "scheme must be http or https"
    | "IP literal not allowed"
    | "host not allowed";
}

export type AllowlistResult = AllowlistOk | AllowlistBad;

function isIpLiteral(host: string): boolean {
  if (host.startsWith("[") && host.endsWith("]")) return true;
  return IPV4.test(host);
}

export function isAllowedTarget(rawUrl: string, allowedHosts: string[]): AllowlistResult {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "invalid URL" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: "scheme must be http or https" };
  }
  const host = parsed.hostname;
  if (isIpLiteral(host)) {
    return { ok: false, reason: "IP literal not allowed" };
  }
  // Note: trailing-dot hostnames (e.g. "storyteq.com.") are intentionally rejected by this exact-match contract.
  for (const apex of allowedHosts) {
    const apexLower = apex.toLowerCase();
    if (host === apexLower || host.endsWith("." + apexLower)) {
      return { ok: true, parsed };
    }
  }
  return { ok: false, reason: "host not allowed" };
}
