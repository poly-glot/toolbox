import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createForwarder } from "../src/forwarder.js";
import { createRing } from "../src/tail.js";
import {
  startTargetServer,
  type RunningTarget,
  type TargetHandler,
} from "./helpers/target-server.js";
import type { Config } from "../src/config.js";

interface Harness {
  proxyUrl: string;
  target: RunningTarget;
  tail: ReturnType<typeof createRing>;
  close: () => Promise<void>;
}

async function startHarness(opts: {
  config?: Partial<Config>;
  handler: TargetHandler;
  allowLocalhost?: boolean;
}): Promise<Harness> {
  const target = await startTargetServer(opts.handler);
  const allowLocalhost = opts.allowLocalhost ?? true;
  const config: Config = {
    port: 0,
    allowedHosts: allowLocalhost ? ["localhost", "storyteq.com", "storyteq.work"] : ["storyteq.com"],
    tailSize: 50,
    bodyCaptureBytes: 64 * 1024,
    timeoutMs: 5_000,
    ...opts.config,
  };
  const tail = createRing(config.tailSize);
  const handleForward = createForwarder({ config, tail });

  const server = http.createServer((req, res) => {
    if (req.url === "/forward" || req.url?.startsWith("/forward?")) {
      handleForward(req, res);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as AddressInfo;
  const proxyUrl = `http://127.0.0.1:${addr.port}/forward`;

  return {
    proxyUrl,
    target,
    tail,
    close: async () => {
      await new Promise<void>((r) => server.close(() => r()));
      await target.close();
    },
  };
}

describe("forwarder", () => {
  let h: Harness | null = null;
  afterEach(async () => {
    if (h) {
      await h.close();
      h = null;
    }
  });

  it("forwards a GET, returns the upstream response, and records a tail entry", async () => {
    h = await startHarness({
      handler: (_a, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"ok":true}');
      },
    });
    const resp = await fetch(h.proxyUrl, {
      headers: { "x-target": h.target.localhostUrl("/") },
    });
    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe('{"ok":true}');

    const snap = h.tail.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0].method).toBe("GET");
    expect(snap[0].response?.status).toBe(200);
    expect(snap[0].response?.body).toMatchObject({ kind: "text", data: '{"ok":true}' });
    // Clean GET must NOT be tagged with an error label, even if Node fires
    // `close` after `end` on the upstream IncomingMessage.
    expect(snap[0].error).toBeUndefined();
  });

  it("forwards a POST with body and captures both directions", async () => {
    h = await startHarness({
      handler: ({ body }, res) => {
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ received: body.toString("utf-8") }));
      },
    });
    const resp = await fetch(h.proxyUrl, {
      method: "POST",
      headers: {
        "x-target": h.target.localhostUrl("/"),
        "content-type": "application/json",
      },
      body: '{"name":"junaid"}',
    });
    expect(resp.status).toBe(201);
    const json = await resp.json() as { received: string };
    expect(json.received).toBe('{"name":"junaid"}');

    const e = h.tail.snapshot()[0];
    expect(e.request.body).toMatchObject({ kind: "text", data: '{"name":"junaid"}' });
    expect(e.response?.body).toMatchObject({ kind: "text" });
  });

  it("rejects missing X-TARGET with 400 and no tail entry", async () => {
    h = await startHarness({ handler: (_a, res) => res.end("nope") });
    const resp = await fetch(h.proxyUrl);
    expect(resp.status).toBe(400);
    expect(h.tail.snapshot()).toHaveLength(0);
  });

  it("rejects disallowed host with 403 and records the rejection", async () => {
    h = await startHarness({
      allowLocalhost: false,
      handler: (_a, res) => res.end("nope"),
    });
    const resp = await fetch(h.proxyUrl, {
      headers: { "x-target": "https://example.com/x" },
    });
    expect(resp.status).toBe(403);
    const snap = h.tail.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0].response?.status).toBe(403);
    expect(snap[0].error).toBe("host not allowed");
  });

  it("strips hop-by-hop and X-TARGET on the way out, rewrites Host", async () => {
    let receivedHeaders: NodeJS.Dict<string | string[]> = {};
    h = await startHarness({
      handler: ({ headers }, res) => {
        receivedHeaders = headers;
        res.writeHead(200).end("ok");
      },
    });
    await fetch(h.proxyUrl, {
      headers: {
        "x-target": h.target.localhostUrl("/"),
        "x-custom": "kept",
        "connection": "keep-alive",
        "authorization": "Bearer abc",
      },
    });
    expect(receivedHeaders["x-target"]).toBeUndefined();
    expect(receivedHeaders["x-custom"]).toBe("kept");
    expect(receivedHeaders["authorization"]).toBe("Bearer abc");
    expect(receivedHeaders["host"]).toBe(h.target.localhostHost);
  });

  it("passes through 4xx response status verbatim", async () => {
    h = await startHarness({
      handler: (_a, res) => {
        res.writeHead(418, { "content-type": "text/plain" });
        res.end("teapot");
      },
    });
    const resp = await fetch(h.proxyUrl, {
      headers: { "x-target": h.target.localhostUrl("/") },
    });
    expect(resp.status).toBe(418);
    expect(await resp.text()).toBe("teapot");
    expect(h.tail.snapshot()[0].response?.status).toBe(418);
  });

  it("does NOT follow redirects", async () => {
    h = await startHarness({
      handler: (_a, res) => {
        res.writeHead(302, { location: "https://elsewhere.example.com/" });
        res.end();
      },
    });
    const resp = await fetch(h.proxyUrl, {
      headers: { "x-target": h.target.localhostUrl("/") },
      redirect: "manual",
    });
    expect(resp.status).toBe(302);
    expect(resp.headers.get("location")).toBe("https://elsewhere.example.com/");
  });

  it("returns 504 and records error when upstream times out", async () => {
    h = await startHarness({
      config: { timeoutMs: 100 },
      handler: () => { /* never respond */ },
    });
    const resp = await fetch(h.proxyUrl, {
      headers: { "x-target": h.target.localhostUrl("/") },
    });
    expect(resp.status).toBe(504);
    expect(h.tail.snapshot()[0].error).toBe("upstream timeout");
  });

  it("returns 502 and records error when upstream connection fails", async () => {
    h = await startHarness({ handler: () => {} });
    // Get a port we know is closed.
    const probe = http.createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    const closedPort = (probe.address() as AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));

    const resp = await fetch(h.proxyUrl, {
      headers: { "x-target": `http://localhost:${closedPort}/` },
    });
    expect(resp.status).toBe(502);
    expect(h.tail.snapshot()[0].error).toMatch(/upstream connection failed/);
  });

  it("captures truncated request body and marks truncated:true", async () => {
    h = await startHarness({
      config: { bodyCaptureBytes: 16 },
      handler: ({ body }, res) => res.writeHead(200).end(`${body.length}`),
    });
    const big = "x".repeat(1000);
    const resp = await fetch(h.proxyUrl, {
      method: "POST",
      headers: {
        "x-target": h.target.localhostUrl("/"),
        "content-type": "text/plain",
      },
      body: big,
    });
    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe("1000");
    const e = h.tail.snapshot()[0];
    expect(e.request.body.kind).toBe("text");
    if (e.request.body.kind === "text") {
      expect(e.request.body.bytes).toBe(1000);
      expect(e.request.body.truncated).toBe(true);
      expect(e.request.body.data.length).toBe(16);
    }
  });

  it("records a tail entry when upstream closes the socket mid-response", async () => {
    h = await startHarness({
      handler: ({}, res) => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.write("hi");
        // Defer destroy to next tick so headers/data actually flush onto the
        // wire before the RST. Without this, the proxy sees the abort during
        // connect/headers and goes through outboundReq.on("error") instead of
        // targetRes — which isn't the bug we're trying to exercise.
        setImmediate(() => res.socket?.destroy());
      },
    });
    try {
      await fetch(h.proxyUrl, { headers: { "x-target": h.target.localhostUrl("/") } });
    } catch {
      // fetch may throw on abnormal close; the tail-entry assertion is what matters.
    }
    // Allow event loop to drain so finalize fires.
    await new Promise((r) => setTimeout(r, 50));
    const snap = h.tail.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0].error).toBeDefined();
    // status was started, so response field should be populated
    expect(snap[0].response?.status).toBe(200);
  });

  it("records 'upstream timeout' (not the sentinel) when timeout fires after response began", async () => {
    h = await startHarness({
      config: { timeoutMs: 100 },
      handler: ({}, res) => {
        // Send headers immediately so responseStarted = true, then never finish the body.
        res.writeHead(200, { "content-type": "text/plain" });
        res.write("partial");
        // Don't call res.end(); don't destroy. The proxy's setTimeout should fire.
      },
    });
    try {
      await fetch(h.proxyUrl, { headers: { "x-target": h.target.localhostUrl("/") } });
    } catch {
      // expected: socket may close abruptly when proxy destroys outboundReq
    }
    await new Promise((r) => setTimeout(r, 250));
    const snap = h.tail.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0].error).toBe("upstream timeout");
    // Make sure the sentinel did NOT leak through
    expect(snap[0].error).not.toMatch(/proxy_timeout/);
  });
});
