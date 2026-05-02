export interface Config {
  port: number;
  allowedHosts: string[];
  tailSize: number;
  bodyCaptureBytes: number;
  timeoutMs: number;
  tailSecret: string | null;
}

function parseInt10(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function parseSecret(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: parseInt10(env.PORT, 3002),
    allowedHosts: (env.PROXY_ALLOWED_HOSTS ?? "storyteq.com,storyteq.work")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    tailSize: parseInt10(env.PROXY_TAIL_SIZE, 500),
    bodyCaptureBytes: parseInt10(env.PROXY_BODY_CAPTURE_BYTES, 65536),
    timeoutMs: parseInt10(env.PROXY_TIMEOUT_MS, 30_000),
    tailSecret: parseSecret(env.PROXY_TAIL_SECRET),
  };
}
