import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { sha512Of } from "../src/publish.js";
import type { Store, StoredEntry } from "../src/types.js";

const TOKEN = "test-token";
const PUBLIC_URL = "https://toolbox.example/temporaryurl";
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);

interface MemoryStore extends Store {
  refreshed: string[];
  seed(short: string, entry: StoredEntry, body: Buffer): void;
}

function memoryStore(): MemoryStore {
  const entries = new Map<string, StoredEntry>();
  const bodies = new Map<string, Buffer>();
  const shorts = new Map<string, string>();
  const refreshed: string[] = [];

  const seed = (short: string, entry: StoredEntry, body: Buffer): void => {
    entries.set(short, entry);
    bodies.set(short, body);
    shorts.set(entry.sha512, short);
  };

  return {
    refreshed,
    seed,
    shortOf: async (sha512) => shorts.get(sha512) ?? null,
    entry: async (short) => entries.get(short) ?? null,
    body: async (short) => bodies.get(short) ?? null,
    claim: async (short, entry, body) => {
      if (entries.has(short)) return false;
      seed(short, entry, body);
      return true;
    },
    refresh: async (short) => {
      refreshed.push(short);
    },
    ping: async () => true,
  };
}

interface Boot {
  url: string;
  store: MemoryStore;
  close: () => Promise<void>;
}

async function boot(env: NodeJS.ProcessEnv = { TEMPORARYURL_UPLOAD_TOKEN: TOKEN }): Promise<Boot> {
  const store = memoryStore();
  const config = loadConfig({ TEMPORARYURL_PUBLIC_URL: PUBLIC_URL, TEMPORARYURL_MAX_BYTES: "64", ...env });
  const server = http.createServer((req, res) => void createApp(config, store)(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    store,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const upload = (b: Boot, body: Buffer, type: string, query = "", token = TOKEN) =>
  fetch(`${b.url}/${query}`, {
    method: "POST",
    redirect: "manual",
    headers: { authorization: `Bearer ${token}`, "content-type": type },
    body,
  });

describe("temporaryurl", () => {
  let b: Boot | null = null;
  afterEach(async () => {
    await b?.close();
    b = null;
  });

  it("answers an upload with a 301 to the short sha512 and the extension", async () => {
    b = await boot();
    const sha512 = sha512Of(JPEG);

    const resp = await upload(b, JPEG, "image/jpeg");
    const body = (await resp.json()) as { url: string; sha512: string };

    expect(resp.status).toBe(301);
    expect(resp.headers.get("location")).toBe(`${PUBLIC_URL}/${sha512.slice(0, 7)}.jpg`);
    expect(body.url).toBe(resp.headers.get("location"));
    expect(body.sha512).toBe(sha512);
  });

  it("serves the bytes with the stored type, sandboxed", async () => {
    b = await boot();
    const location = (await upload(b, JPEG, "image/jpeg")).headers.get("location")!;

    const resp = await fetch(`${b.url}${new URL(location).pathname.replace("/temporaryurl", "")}`);

    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toBe("image/jpeg");
    expect(resp.headers.get("content-length")).toBe(String(JPEG.length));
    expect(resp.headers.get("content-security-policy")).toBe("sandbox");
    expect(Buffer.from(await resp.arrayBuffer())).toEqual(JPEG);
  });

  it("answers HEAD without a body and If-None-Match with 304", async () => {
    b = await boot();
    const short = sha512Of(JPEG).slice(0, 7);
    await upload(b, JPEG, "image/jpeg");

    const head = await fetch(`${b.url}/${short}.jpg`, { method: "HEAD" });
    const cached = await fetch(`${b.url}/${short}.jpg`, { headers: { "if-none-match": `"${sha512Of(JPEG)}"` } });

    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(JPEG.length));
    expect(cached.status).toBe(304);
  });

  it("gives the same content the same URL and refreshes its expiry", async () => {
    b = await boot();

    const first = (await upload(b, JPEG, "image/jpeg")).headers.get("location");
    const second = (await upload(b, JPEG, "image/jpeg")).headers.get("location");

    expect(second).toBe(first);
    expect(b.store.refreshed).toEqual([sha512Of(JPEG).slice(0, 7)]);
  });

  it("lengthens the short id like git when the prefix is taken", async () => {
    b = await boot();
    const sha512 = sha512Of(JPEG);
    const other = { sha512: `${sha512.slice(0, 7)}${"0".repeat(121)}`, type: "image/png", ext: "png", size: 1 };
    b.store.seed(sha512.slice(0, 7), other, Buffer.from([0]));

    const resp = await upload(b, JPEG, "image/jpeg");

    expect(resp.headers.get("location")).toBe(`${PUBLIC_URL}/${sha512.slice(0, 8)}.jpg`);
  });

  it("takes the extension from ?name= when the type has none", async () => {
    b = await boot();

    const resp = await upload(b, Buffer.from("c2pa"), "application/octet-stream", "?name=asset.c2pa");
    const served = await fetch(new URL(resp.headers.get("location")!).pathname.replace("/temporaryurl", b.url));

    expect(resp.headers.get("location")).toMatch(/\.c2pa$/);
    expect(served.headers.get("content-type")).toBe("application/c2pa");
  });

  it("refuses an upload whose extension it can't tell", async () => {
    b = await boot();

    const resp = await upload(b, Buffer.from("x"), "application/octet-stream");

    expect(resp.status).toBe(400);
  });

  it("refuses uploads without the token, and all uploads when no token is configured", async () => {
    b = await boot();
    expect((await upload(b, JPEG, "image/jpeg", "", "wrong")).status).toBe(401);
    await b.close();

    b = await boot({});
    expect((await upload(b, JPEG, "image/jpeg")).status).toBe(503);
  });

  it("refuses a file over the size limit", async () => {
    b = await boot();

    const resp = await upload(b, Buffer.alloc(65), "image/jpeg");

    expect(resp.status).toBe(413);
  });

  it("never lists stored files", async () => {
    b = await boot();
    await upload(b, JPEG, "image/jpeg");

    const index = await (await fetch(`${b.url}/`)).text();

    expect(index).not.toContain(sha512Of(JPEG).slice(0, 7));
    expect((await fetch(`${b.url}/0000000.jpg`)).status).toBe(404);
  });
});
