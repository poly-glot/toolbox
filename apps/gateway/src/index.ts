/**
 * Gateway - Path-based reverse proxy for toolbox apps
 *
 * Routes requests to the appropriate app based on URL path prefix.
 * Each app runs on its own port and the gateway strips the prefix before forwarding.
 *
 * Route configuration is defined via APP_ROUTES environment variable:
 *   APP_ROUTES=webhook:3001,another-app:3002
 *
 * Requests to /webhook/* are proxied to localhost:3001/*
 * Requests to /another-app/* are proxied to localhost:3002/*
 * Requests to / serve the toolbox index page
 */

import http from "node:http";
import httpProxy from "http-proxy";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT || "8080", 10);

interface AppRoute {
  prefix: string;
  target: string;
  port: number;
}

function parseRoutes(): AppRoute[] {
  const routesEnv = process.env.APP_ROUTES || "webhook:3001";
  return routesEnv.split(",").map((entry) => {
    const [prefix, portStr] = entry.trim().split(":");
    const port = parseInt(portStr, 10);
    return {
      prefix: `/${prefix}`,
      target: `http://127.0.0.1:${port}`,
      port,
    };
  });
}

const routes = parseRoutes();
const proxy = httpProxy.createProxyServer({});

// Handle proxy errors gracefully
proxy.on("error", (err, _req, res) => {
  console.error(`[gateway] Proxy error: ${err.message}`);
  if (res instanceof http.ServerResponse && !res.headersSent) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Bad Gateway", message: err.message }));
  }
});

// ---------------------------------------------------------------------------
// Index page
// ---------------------------------------------------------------------------

function serveIndex(res: http.ServerResponse): void {
  const appList = routes
    .map(
      (r) => `
        <tr>
          <td><a href="${r.prefix}/">${r.prefix.slice(1)}</a></td>
          <td>${r.target}</td>
          <td><span class="status" data-app="${r.prefix.slice(1)}">checking...</span></td>
        </tr>`,
    )
    .join("\n");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Toolbox - junaid.guru</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace; background: #0d1117; color: #c9d1d9; padding: 2rem; }
    h1 { color: #58a6ff; margin-bottom: 0.5rem; }
    .subtitle { color: #8b949e; margin-bottom: 2rem; }
    table { width: 100%; border-collapse: collapse; margin-top: 1rem; }
    th, td { padding: 0.75rem 1rem; text-align: left; border-bottom: 1px solid #21262d; }
    th { color: #58a6ff; font-weight: 600; background: #161b22; }
    tr:hover { background: #161b22; }
    a { color: #58a6ff; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .status { font-size: 0.85rem; }
    .status-ok { color: #3fb950; }
    .status-err { color: #f85149; }
  </style>
</head>
<body>
  <h1>Toolbox</h1>
  <p class="subtitle">toolbox.junaid.guru</p>

  <table>
    <thead>
      <tr><th>App</th><th>Internal Target</th><th>Status</th></tr>
    </thead>
    <tbody>${appList}</tbody>
  </table>

  <script>
    document.querySelectorAll('.status').forEach(async (el) => {
      const app = el.dataset.app;
      try {
        const resp = await fetch('/' + app + '/health', { signal: AbortSignal.timeout(3000) });
        el.textContent = resp.ok ? 'healthy' : resp.status + ' ' + resp.statusText;
        el.className = resp.ok ? 'status status-ok' : 'status status-err';
      } catch {
        el.textContent = 'unreachable';
        el.className = 'status status-err';
      }
    });
  </script>
</body>
</html>`;

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
  const url = req.url || "/";

  // Health check for the gateway itself
  if (url === "/health" || url === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        service: "gateway",
        apps: routes.map((r) => r.prefix.slice(1)),
      }),
    );
    return;
  }

  // Index page
  if (url === "/" || url === "") {
    serveIndex(res);
    return;
  }

  // Find matching route
  for (const route of routes) {
    if (url === route.prefix || url.startsWith(route.prefix + "/")) {
      // Strip the prefix: /webhook/foo -> /foo
      // If url is exactly /webhook, rewrite to /
      const stripped = url.slice(route.prefix.length) || "/";
      req.url = stripped;

      proxy.web(req, res, { target: route.target });
      return;
    }
  }

  // No route matched
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      error: "Not Found",
      message: `No app registered for path: ${url}`,
      availableApps: routes.map((r) => r.prefix),
    }),
  );
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

server.listen(PORT, () => {
  console.log(`[gateway] Listening on port ${PORT}`);
  console.log(`[gateway] Routes:`);
  for (const route of routes) {
    console.log(`  ${route.prefix}/* -> ${route.target}/*`);
  }
});
