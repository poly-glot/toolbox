import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app.js";

interface Boot {
  url: string;
  close: () => Promise<void>;
}

async function boot(env: NodeJS.ProcessEnv = {}): Promise<Boot> {
  const { dispatch } = createApp({ ...env, PORT: "0", PROXY_ALLOWED_HOSTS: "storyteq.com" });
  const server = http.createServer(dispatch);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => {
      server.closeAllConnections();
      server.close(() => r());
    }),
  };
}

describe("app (HTTP-level auth gate)", () => {
  let b: Boot | null = null;
  afterEach(async () => { if (b) { await b.close(); b = null; } });

  it("GET /health is open without secret", async () => {
    b = await boot({});
    const resp = await fetch(`${b.url}/health`);
    expect(resp.status).toBe(200);
  });

  it("GET / returns 503 when PROXY_TAIL_SECRET is unset", async () => {
    b = await boot({});
    const resp = await fetch(`${b.url}/`);
    expect(resp.status).toBe(503);
    const body = await resp.json() as { error: string };
    expect(body.error).toMatch(/PROXY_TAIL_SECRET/);
  });

  it("GET /tail returns 503 when PROXY_TAIL_SECRET is unset", async () => {
    b = await boot({});
    const resp = await fetch(`${b.url}/tail`);
    expect(resp.status).toBe(503);
  });

  it("DELETE /tail returns 503 when PROXY_TAIL_SECRET is unset", async () => {
    b = await boot({});
    const resp = await fetch(`${b.url}/tail`, { method: "DELETE" });
    expect(resp.status).toBe(503);
  });

  it("GET / returns 401 when secret is set but no credential is presented", async () => {
    b = await boot({ PROXY_TAIL_SECRET: "s3cret" });
    const resp = await fetch(`${b.url}/`);
    expect(resp.status).toBe(401);
    expect(resp.headers.get("www-authenticate")).toMatch(/Bearer/);
  });

  it("GET / with valid Bearer token returns 200 + HTML", async () => {
    b = await boot({ PROXY_TAIL_SECRET: "s3cret" });
    const resp = await fetch(`${b.url}/`, { headers: { authorization: "Bearer s3cret" } });
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toMatch(/text\/html/);
    expect(await resp.text()).toMatch(/toolbox \/ proxy tail/);
  });

  it("GET /tail?secret=… returns 200 SSE stream", async () => {
    b = await boot({ PROXY_TAIL_SECRET: "s3cret" });
    const ctrl = new AbortController();
    const resp = await fetch(`${b.url}/tail?secret=s3cret`, { signal: ctrl.signal });
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toMatch(/text\/event-stream/);
    ctrl.abort();
    // Give the server's req.on("close") a tick to fire so the SSE heartbeat
    // interval is cleared before afterEach forces connection teardown.
    await new Promise((r) => setTimeout(r, 10));
  });

  it("GET /forward stays open without secret (returns 400 because X-TARGET is missing)", async () => {
    b = await boot({ PROXY_TAIL_SECRET: "s3cret" });
    const resp = await fetch(`${b.url}/forward`);
    expect(resp.status).toBe(400);
    const body = await resp.json() as { error: string };
    expect(body.error).toMatch(/X-TARGET/);
  });
});
