import type { BodySnippet } from "./types.js";

const TEXT_TYPE_PATTERNS: RegExp[] = [
  /^text\//i,
  /^application\/json\b/i,
  /^application\/xml\b/i,
  /^application\/x-www-form-urlencoded\b/i,
  /\+json\b/i,
  /\+xml\b/i,
];

function isTextContentType(ct: string | null): boolean {
  if (!ct) return false;
  return TEXT_TYPE_PATTERNS.some((re) => re.test(ct));
}

function isCompressed(ce: string | null): boolean {
  if (!ce) return false;
  const v = ce.toLowerCase().trim();
  return v !== "" && v !== "identity";
}

function hexPreview(buf: Buffer, n = 256): string {
  return buf.subarray(0, n).toString("hex");
}

function tryStrictUtf8(buf: Buffer): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return null;
  }
}

function lenientUtf8(buf: Buffer): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(buf);
}

export interface ClassifyOptions {
  contentType: string | null;
  contentEncoding: string | null;
  totalBytes: number;
  cap: number;
}

export function classifyBody(captured: Buffer, opts: ClassifyOptions): BodySnippet {
  if (opts.totalBytes === 0) return { kind: "empty" };

  if (isCompressed(opts.contentEncoding)) {
    return {
      kind: "binary",
      bytes: opts.totalBytes,
      contentType: opts.contentType,
      preview: hexPreview(captured),
    };
  }

  if (isTextContentType(opts.contentType)) {
    const truncated = opts.totalBytes > opts.cap;
    if (truncated) {
      return {
        kind: "text",
        bytes: opts.totalBytes,
        truncated: true,
        data: lenientUtf8(captured),
      };
    }
    const decoded = tryStrictUtf8(captured);
    if (decoded !== null) {
      return { kind: "text", bytes: opts.totalBytes, truncated: false, data: decoded };
    }
  }

  return {
    kind: "binary",
    bytes: opts.totalBytes,
    contentType: opts.contentType,
    preview: hexPreview(captured),
  };
}
