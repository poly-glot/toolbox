export interface Config {
  port: number;
  publicUrl: string;
  uploadToken: string | null;
  maxBytes: number;
  ttlSeconds: number;
  redis: {
    host: string;
    port: number;
    password: string | undefined;
  };
}

const MEBIBYTE = 1024 * 1024;
const WEEK_IN_SECONDS = 7 * 24 * 60 * 60;

function parseInt10(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseSecret(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: parseInt10(env.PORT, 3003),
    publicUrl: (env.TEMPORARYURL_PUBLIC_URL ?? "http://localhost:8080/temporaryurl").replace(/\/+$/, ""),
    uploadToken: parseSecret(env.TEMPORARYURL_UPLOAD_TOKEN),
    maxBytes: parseInt10(env.TEMPORARYURL_MAX_BYTES, 25 * MEBIBYTE),
    ttlSeconds: parseInt10(env.TEMPORARYURL_TTL_SECONDS, WEEK_IN_SECONDS),
    redis: {
      host: env.REDIS_HOST ?? "127.0.0.1",
      port: parseInt10(env.REDIS_PORT, 6379),
      password: parseSecret(env.REDIS_PASSWORD) ?? undefined,
    },
  };
}
