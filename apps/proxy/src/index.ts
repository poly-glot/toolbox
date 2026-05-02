import http from "node:http";
import { createApp } from "./app.js";

const { dispatch, config } = createApp();

http.createServer(dispatch).listen(config.port, () => {
  console.log(`[proxy] listening on :${config.port}`);
  console.log(`[proxy] allowed hosts: ${config.allowedHosts.join(", ")}`);
  console.log(`[proxy] tail size=${config.tailSize}, body cap=${config.bodyCaptureBytes}, timeout=${config.timeoutMs}ms`);
  console.log(`[proxy] tail UI: ${config.tailSecret ? "secret-protected" : "disabled (set PROXY_TAIL_SECRET)"}`);
});
