import http from "node:http";
import { loadConfig } from "./config.js";
import { createRing } from "./tail.js";
import { createForwarder } from "./forwarder.js";
import { createSseHandler } from "./sse.js";
import { renderUI } from "./ui.js";

const config = loadConfig();
const tail = createRing(config.tailSize);
const handleForward = createForwarder({ config, tail });
const handleSse = createSseHandler({ tail });

const server = http.createServer((req, res) => {
  const url = req.url ?? "/";

  if (url === "/health" || url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", service: "proxy" }));
    return;
  }

  if (req.method === "GET" && (url === "/" || url === "")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(renderUI());
    return;
  }

  if (req.method === "GET" && (url === "/tail" || url.startsWith("/tail?"))) {
    handleSse(req, res);
    return;
  }

  if (url === "/forward" || url.startsWith("/forward?")) {
    handleForward(req, res);
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

server.listen(config.port, () => {
  console.log(`[proxy] listening on :${config.port}`);
  console.log(`[proxy] allowed hosts: ${config.allowedHosts.join(", ")}`);
  console.log(
    `[proxy] tail size=${config.tailSize}, body cap=${config.bodyCaptureBytes}, timeout=${config.timeoutMs}ms`,
  );
});
