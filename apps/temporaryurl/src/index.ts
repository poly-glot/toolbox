import http from "node:http";
import { Redis } from "ioredis";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createRedisStore } from "./redis-store.js";

const config = loadConfig();

const redis = new Redis({ ...config.redis, maxRetriesPerRequest: 2 });
redis.on("error", (error) => console.error(`[temporaryurl] redis: ${error.message}`));

const handle = createApp(config, createRedisStore(redis));

http.createServer((req, res) => void handle(req, res)).listen(config.port, () => {
  console.log(`[temporaryurl] listening on :${config.port}`);
  console.log(`[temporaryurl] public URL ${config.publicUrl}, ttl ${config.ttlSeconds}s, max ${config.maxBytes} bytes`);
  console.log(`[temporaryurl] uploads: ${config.uploadToken ? "token-protected" : "disabled (set TEMPORARYURL_UPLOAD_TOKEN)"}`);
});
