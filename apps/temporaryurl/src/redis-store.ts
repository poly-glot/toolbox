import type { Redis } from "ioredis";
import type { Store, StoredEntry } from "./types.js";

const CLAIM = `
if redis.call("SET", KEYS[1], ARGV[1], "EX", ARGV[4], "NX") then
  redis.call("SET", KEYS[2], ARGV[2], "EX", ARGV[4])
  redis.call("SET", KEYS[3], ARGV[3], "EX", ARGV[4])
  return 1
end
return 0
`;

export function createRedisStore(redis: Redis, prefix = "temporaryurl:"): Store {
  const metaKey = (short: string) => `${prefix}meta:${short}`;
  const bodyKey = (short: string) => `${prefix}body:${short}`;
  const shaKey = (sha512: string) => `${prefix}sha512:${sha512}`;

  return {
    shortOf: (sha512) => redis.get(shaKey(sha512)),

    entry: async (short) => {
      const raw = await redis.get(metaKey(short));
      return raw === null ? null : (JSON.parse(raw) as StoredEntry);
    },

    body: (short) => redis.getBuffer(bodyKey(short)),

    claim: async (short, entry, body, ttlSeconds) => {
      const keys = [metaKey(short), bodyKey(short), shaKey(entry.sha512)];
      const claimed = await redis.eval(CLAIM, keys.length, ...keys, JSON.stringify(entry), body, short, ttlSeconds);
      return claimed === 1;
    },

    refresh: async (short, sha512, ttlSeconds) => {
      await redis
        .multi()
        .expire(metaKey(short), ttlSeconds)
        .expire(bodyKey(short), ttlSeconds)
        .set(shaKey(sha512), short, "EX", ttlSeconds)
        .exec();
    },

    ping: async () => (await redis.ping()) === "PONG",
  };
}
