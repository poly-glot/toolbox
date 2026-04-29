import { describe, it, expect } from "vitest";
import { startTargetServer } from "./target-server.js";

describe("target-server helper", () => {
  it("starts and serves a fixed response", async () => {
    const t = await startTargetServer((_a, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("hello");
    });
    const resp = await fetch(t.url("/"));
    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe("hello");
    await t.close();
  });
});
