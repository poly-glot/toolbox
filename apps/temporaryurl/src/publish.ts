import crypto from "node:crypto";
import type { Published, Store } from "./types.js";

const MIN_SHORT_LENGTH = 7;

export interface Upload {
  body: Buffer;
  type: string;
  ext: string;
}

export const sha512Of = (body: Buffer): string => crypto.createHash("sha512").update(body).digest("hex");

async function reuse(store: Store, short: string, sha512: string, ttlSeconds: number): Promise<Published | null> {
  const entry = await store.entry(short);
  if (entry?.sha512 !== sha512) return null;

  await store.refresh(short, sha512, ttlSeconds);
  return { short, entry };
}

export async function publish(store: Store, upload: Upload, ttlSeconds: number): Promise<Published> {
  const sha512 = sha512Of(upload.body);
  const entry = { sha512, type: upload.type, ext: upload.ext, size: upload.body.length };

  const known = await store.shortOf(sha512);
  const reused = known === null ? null : await reuse(store, known, sha512, ttlSeconds);
  if (reused) return reused;

  let length = MIN_SHORT_LENGTH;
  while (length <= sha512.length) {
    const short = sha512.slice(0, length);

    const taken = await store.entry(short);
    if (taken?.sha512 === sha512) return { short, entry: taken };
    if (taken) {
      length += 1;
      continue;
    }

    if (await store.claim(short, entry, upload.body, ttlSeconds)) return { short, entry };
  }

  throw new Error(`no free short id for ${sha512}`);
}
