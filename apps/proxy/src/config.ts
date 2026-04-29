export interface Config {
  port: number;
  allowedHosts: string[];
  tailSize: number;
  bodyCaptureBytes: number;
  timeoutMs: number;
}

function parseInt10(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
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
  };
}
