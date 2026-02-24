#!/usr/bin/env node

/**
 * Webhook Retry Test Tool - Multi-Project Edition
 *
 * Path-based deployment aware: all internal links are relative so the app
 * works correctly whether accessed at / or behind a reverse proxy at /webhook.
 *
 * Routes (relative to mount point):
 *   POST /:project              - Receive webhook events (settings via query string)
 *   GET  /:project/status       - Live status dashboard (auto-refresh with toggle)
 *   GET  /:project/api          - JSON API for project state
 *   GET  /:project/reset        - Reset project state
 *   GET  /assets                - Unified asset view across all projects
 *   GET  /assets/api            - Unified asset view JSON API
 *   GET  /health                - Server health
 *   GET  /                      - Index listing all projects
 *
 * Query string parameters (applied on first POST to a project, or override per-request):
 *   ?delay=500          - Artificial response delay in ms (default: 0)
 *   ?timeout=35000      - Delay on failures to simulate caller timeout (default: 0)
 *   ?failCount=3        - Number of failures before succeeding (default: 3)
 *   ?failStatus=503     - HTTP status on failure (default: 503)
 *   ?failForever=true   - Never succeed (default: false)
 */

import http from "node:http";
import { URL } from "node:url";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProjectSettings {
  failCount: number;
  failStatus: number;
  failForever: boolean;
  timeoutMs: number;
  delayMs: number;
}

interface EventEntry {
  attempt: number;
  timestamp: string;
  status: number | null;
  eventType: string;
  eventId: string;
  supertype: string | null;
}

interface DeliveryRecord {
  attempt: number;
  timestamp: string;
  status: number;
  assetIds: (string | number)[];
  eventCount: number;
  events: {
    assetId: string | number;
    eventType: string;
    eventId: string;
    supertype: string | null;
  }[];
  headers: Record<string, string | null>;
  path: string;
}

interface ProjectState {
  settings: ProjectSettings;
  totalRequests: number;
  assetHistory: Map<string | number, EventEntry[]>;
  deliveries: DeliveryRecord[];
  assetFirstSeen: Map<string | number, Date>;
  assetLastSeen: Map<string | number, Date>;
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

function flag(name: string): boolean {
  return args.includes(`--${name}`);
}

function opt(long: string, short: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === `--${long}` || args[i] === `-${short}`) {
      return args[i + 1];
    }
  }
  return undefined;
}

if (flag("help") || flag("h")) {
  console.log(`
Webhook Retry Test Tool - Multi-Project Edition (Path-Aware)

Each project gets its own isolated endpoint with independent settings.
Works behind a reverse proxy with path prefix stripping.

Usage:
  npx tsx src/index.ts [options]

Options:
  --port, -p     Port to listen on (default: 3001)

Routes (relative to mount point):
  POST /:project             Webhook endpoint (settings via query string)
  GET  /:project/status      Live status dashboard
  GET  /:project/api         JSON summary
  GET  /:project/reset       Reset project state
  GET  /assets               Unified asset view across all projects
  GET  /assets/api           Unified asset JSON API
  GET  /health               Health check
  GET  /                     Index of all projects

Query string parameters (on POST requests):
  ?failCount=3       Failures before first success (default: 3)
  ?failStatus=503    HTTP status on failure (default: 503)
  ?failForever=true  Never succeed
  ?timeout=35000     Delay response on failure to trigger caller timeout (ms)
  ?delay=500         Artificial response delay (ms)

Examples:
  # Project "projectA" fails 5 times with 503, then succeeds
  curl -X POST "http://localhost:3001/projectA?failCount=5&failStatus=503" \\
       -H "Content-Type: application/json" -d '{"events":[]}'

  # Via gateway at toolbox.junaid.guru
  curl -X POST "https://toolbox.junaid.guru/webhook/projectA?failCount=5" \\
       -H "Content-Type: application/json" -d '{"events":[]}'
  `);
  process.exit(0);
}

const PORT = parseInt(opt("port", "p") || process.env.PORT || "3001", 10);

// ---------------------------------------------------------------------------
// Global defaults from CLI (used as fallback for projects)
// ---------------------------------------------------------------------------

const CLI_DEFAULTS: ProjectSettings = {
  failCount: parseInt(opt("fail-count", "f") || "3", 10),
  failStatus: parseInt(opt("fail-status", "s") || "503", 10),
  failForever: flag("fail-forever"),
  timeoutMs: parseInt(opt("timeout", "t") || "0", 10),
  delayMs: parseInt(opt("delay", "d") || "0", 10),
};

// ---------------------------------------------------------------------------
// Project store
// ---------------------------------------------------------------------------

const projects = new Map<string, ProjectState>();
const serverStartTime = Date.now();

function getOrCreateProject(
  projectId: string,
  queryParams?: URLSearchParams,
): ProjectState {
  let project = projects.get(projectId);

  if (!project) {
    const settings = parseSettings(queryParams);
    project = {
      settings,
      totalRequests: 0,
      assetHistory: new Map(),
      deliveries: [],
      assetFirstSeen: new Map(),
      assetLastSeen: new Map(),
      createdAt: new Date(),
    };
    projects.set(projectId, project);
    log(
      `${C.cyan}New project registered:${C.reset} ${C.bold}${projectId}${C.reset} ` +
        `[failCount=${settings.failCount}, failStatus=${settings.failStatus}, ` +
        `failForever=${settings.failForever}, timeout=${settings.timeoutMs}ms, delay=${settings.delayMs}ms]`,
    );
  } else if (queryParams && hasSettingsParams(queryParams)) {
    project.settings = parseSettings(queryParams);
  }

  return project;
}

function parseSettings(params?: URLSearchParams): ProjectSettings {
  if (!params) return { ...CLI_DEFAULTS };

  return {
    failCount: parseInt(
      params.get("failCount") ?? String(CLI_DEFAULTS.failCount),
      10,
    ),
    failStatus: parseInt(
      params.get("failStatus") ?? String(CLI_DEFAULTS.failStatus),
      10,
    ),
    failForever:
      params.get("failForever") === "true" || CLI_DEFAULTS.failForever,
    timeoutMs: parseInt(
      params.get("timeout") ?? String(CLI_DEFAULTS.timeoutMs),
      10,
    ),
    delayMs: parseInt(
      params.get("delay") ?? String(CLI_DEFAULTS.delayMs),
      10,
    ),
  };
}

function hasSettingsParams(params: URLSearchParams): boolean {
  return ["failCount", "failStatus", "failForever", "timeout", "delay"].some(
    (key) => params.has(key),
  );
}

function resetProject(projectId: string): void {
  const project = projects.get(projectId);
  if (project) {
    project.totalRequests = 0;
    project.assetHistory.clear();
    project.deliveries.length = 0;
    project.assetFirstSeen.clear();
    project.assetLastSeen.clear();
  }
}

// ---------------------------------------------------------------------------
// ANSI colors
// ---------------------------------------------------------------------------

const C = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
};

function elapsed(): string {
  return ((Date.now() - serverStartTime) / 1000).toFixed(1);
}

function log(msg: string): void {
  console.log(msg);
}

// ---------------------------------------------------------------------------
// Route matching
// ---------------------------------------------------------------------------

interface RouteMatch {
  projectId: string;
  action: "webhook" | "status" | "api" | "reset";
}

function matchRoute(
  method: string,
  pathname: string,
): RouteMatch | null {
  // POST /:project
  const webhookPost = pathname.match(/^\/([^/]+)\/?$/);
  if (method === "POST" && webhookPost) {
    return { projectId: webhookPost[1], action: "webhook" };
  }

  // GET /:project/status
  const statusGet = pathname.match(/^\/([^/]+)\/status\/?$/);
  if (method === "GET" && statusGet) {
    return { projectId: statusGet[1], action: "status" };
  }

  // GET /:project/api
  const apiGet = pathname.match(/^\/([^/]+)\/api\/?$/);
  if (method === "GET" && apiGet) {
    return { projectId: apiGet[1], action: "api" };
  }

  // GET /:project/reset
  const resetGet = pathname.match(/^\/([^/]+)\/reset\/?$/);
  if (method === "GET" && resetGet) {
    return { projectId: resetGet[1], action: "reset" };
  }

  return null;
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  // Health check
  if (req.method === "GET" && pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        service: "webhook",
        uptime: `${elapsed()}s`,
        projects: [...projects.keys()],
      }),
    );
    return;
  }

  // Unified assets view
  if (req.method === "GET" && pathname === "/assets") {
    serveUnifiedAssets(res);
    return;
  }

  // Unified assets JSON API
  if (req.method === "GET" && pathname === "/assets/api") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(buildUnifiedAssetData(), null, 2));
    return;
  }

  // Index page - list all projects
  if (req.method === "GET" && pathname === "/") {
    serveIndex(res);
    return;
  }

  // Ignore reserved paths (health, favicon, etc.)
  if (pathname === "/health" || pathname === "/favicon.ico") {
    res.writeHead(404);
    res.end();
    return;
  }

  // Route to project
  const route = matchRoute(req.method || "GET", pathname);

  if (!route) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found. Use POST /:project or GET /:project/status\n");
    return;
  }

  const { projectId, action } = route;

  switch (action) {
    case "webhook": {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString()));
      req.on("end", () =>
        handleWebhook(projectId, url.searchParams, req, res, body),
      );
      break;
    }
    case "status":
      serveStatusPage(projectId, url.searchParams, res);
      break;
    case "api": {
      const project = projects.get(projectId);
      if (!project) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `Project '${projectId}' not found` }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(buildSummary(projectId, project), null, 2));
      break;
    }
    case "reset":
      resetProject(projectId);
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(`Project '${projectId}' state reset\n`);
      log(`${C.yellow}[${projectId}] State reset${C.reset}`);
      break;
  }
});

// ---------------------------------------------------------------------------
// Webhook handler
// ---------------------------------------------------------------------------

function handleWebhook(
  projectId: string,
  queryParams: URLSearchParams,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  rawBody: string,
): void {
  const project = getOrCreateProject(projectId, queryParams);
  project.totalRequests++;
  const now = new Date();

  // Parse payload
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    log(
      `${C.red}[${elapsed()}s] [${projectId}] #${project.totalRequests} Invalid JSON payload${C.reset}`,
    );
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("Invalid JSON\n");
    return;
  }

  const events = (payload.events as Record<string, unknown>[]) || [];
  const count =
    (payload.count as number) || events.length;
  const assetIds = events.map((e) => e.assetId as string | number);
  const uniqueAssetIds = [...new Set(assetIds)];

  // Track per-asset history
  for (const event of events) {
    const id = event.assetId as string | number;
    if (!project.assetHistory.has(id)) {
      project.assetHistory.set(id, []);
    }
    project.assetHistory.get(id)!.push({
      attempt: project.totalRequests,
      timestamp: now.toISOString(),
      status: null,
      eventType: (event.eventType as string) || "unknown",
      eventId: (event.eventId as string) || "",
      supertype: (event.supertype as string) ?? null,
    });

    if (!project.assetFirstSeen.has(id)) project.assetFirstSeen.set(id, now);
    project.assetLastSeen.set(id, now);
  }

  // Decide response: fail or succeed
  const { settings } = project;
  const shouldFail =
    settings.failForever || project.totalRequests <= settings.failCount;
  const statusCode = shouldFail ? settings.failStatus : 200;

  // Update status in per-asset history
  for (const event of events) {
    const history = project.assetHistory.get(event.assetId as string | number);
    if (history && history.length > 0) {
      history[history.length - 1].status = statusCode;
    }
  }

  // Record delivery
  const delivery: DeliveryRecord = {
    attempt: project.totalRequests,
    timestamp: now.toISOString(),
    status: statusCode,
    assetIds: uniqueAssetIds,
    eventCount: count,
    events: events.map((e) => ({
      assetId: e.assetId as string | number,
      eventType: (e.eventType as string) || "unknown",
      eventId: (e.eventId as string) || "",
      supertype: (e.supertype as string) ?? null,
    })),
    headers: {
      "content-type": req.headers["content-type"] || null,
      "x-api-key": (req.headers["x-api-key"] as string) || null,
      ...extractCustomHeaders(req.headers),
    },
    path: req.url || "",
  };
  project.deliveries.push(delivery);

  // Console log
  const statusColor = shouldFail ? C.red : C.green;
  const statusLabel = shouldFail ? "FAIL" : "OK";
  const supertypes = [
    ...new Set(events.map((e) => (e.supertype as string) || "N/A")),
  ];

  log(
    `${C.bold}[${elapsed()}s]${C.reset} ` +
      `${C.cyan}[${projectId}]${C.reset} ` +
      `#${project.totalRequests} ${statusColor}${statusCode} ${statusLabel}${C.reset} | ` +
      `${count} event(s) | ` +
      `assets: [${uniqueAssetIds.join(", ")}] | ` +
      `types: [${events.map((e) => e.eventType).join(", ")}] | ` +
      `supertypes: [${supertypes.join(", ")}]`,
  );

  if (req.headers["x-api-key"]) {
    log(
      `  ${C.dim}API key: ${(req.headers["x-api-key"] as string).substring(0, 8)}...${C.reset}`,
    );
  }

  // Respond with optional delay/timeout simulation
  const respondDelay =
    settings.timeoutMs > 0 && shouldFail ? settings.timeoutMs : settings.delayMs;

  if (respondDelay > 0) {
    log(
      `  ${C.dim}Delaying response by ${respondDelay}ms${shouldFail && settings.timeoutMs > 0 ? " (simulating timeout)" : ""}${C.reset}`,
    );
    setTimeout(() => sendResponse(res, statusCode, shouldFail), respondDelay);
  } else {
    sendResponse(res, statusCode, shouldFail);
  }
}

function sendResponse(
  res: http.ServerResponse,
  statusCode: number,
  shouldFail: boolean,
): void {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      received: true,
      status: shouldFail ? "rejected" : "accepted",
    }),
  );
}

function extractCustomHeaders(
  headers: http.IncomingHttpHeaders,
): Record<string, string> {
  const custom: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (
      key.startsWith("x-") &&
      key !== "x-api-key" &&
      key !== "x-forwarded-for" &&
      typeof value === "string"
    ) {
      custom[key] = value;
    }
  }
  return custom;
}

// ---------------------------------------------------------------------------
// Summary builder
// ---------------------------------------------------------------------------

interface AssetSummary {
  totalAttempts: number;
  successCount: number;
  failureCount: number;
  retried: boolean;
  eventTypes: string[];
  supertypes: string[];
  retryDurationMs: number;
  timeline: { attempt: number; status: number | null; timestamp: string }[];
}

function buildSummary(
  projectId: string,
  project: ProjectState,
): Record<string, unknown> {
  const assets: Record<string, AssetSummary> = {};

  for (const [assetId, history] of project.assetHistory) {
    const attempts = history.length;
    const successes = history.filter(
      (h) => h.status !== null && h.status >= 200 && h.status < 300,
    );
    const failures = history.filter(
      (h) => h.status !== null && (h.status >= 300 || h.status < 200),
    );
    const firstSeen = project.assetFirstSeen.get(assetId);
    const lastSeen = project.assetLastSeen.get(assetId);
    const retryDuration =
      lastSeen && firstSeen ? lastSeen.getTime() - firstSeen.getTime() : 0;

    assets[String(assetId)] = {
      totalAttempts: attempts,
      successCount: successes.length,
      failureCount: failures.length,
      retried: attempts > 1,
      eventTypes: [...new Set(history.map((h) => h.eventType))],
      supertypes: [...new Set(history.filter((h) => h.supertype).map((h) => h.supertype!))],
      retryDurationMs: retryDuration,
      timeline: history.map((h) => ({
        attempt: h.attempt,
        status: h.status,
        timestamp: h.timestamp,
      })),
    };
  }

  return {
    projectId,
    totalRequests: project.totalRequests,
    totalUniqueAssets: project.assetHistory.size,
    createdAt: project.createdAt.toISOString(),
    settings: project.settings,
    assets,
    deliveries: project.deliveries,
  };
}

// ---------------------------------------------------------------------------
// Unified asset view - aggregates assets across all projects
// ---------------------------------------------------------------------------

interface UnifiedAssetEntry {
  assetId: string;
  supertype: string;
  eventTypes: string[];
  projects: Record<string, {
    received: true;
    firstSeen: string;
    lastSeen: string;
    attempts: number;
    successCount: number;
    failureCount: number;
  }>;
}

function buildUnifiedAssetData(): { projectIds: string[]; assets: UnifiedAssetEntry[] } {
  const projectIds = [...projects.keys()];
  const assetMap = new Map<string, UnifiedAssetEntry>();

  for (const [projectId, project] of projects) {
    for (const [rawAssetId, history] of project.assetHistory) {
      const assetId = String(rawAssetId);

      if (!assetMap.has(assetId)) {
        assetMap.set(assetId, {
          assetId,
          supertype: "",
          eventTypes: [],
          projects: {},
        });
      }

      const entry = assetMap.get(assetId)!;

      // Collect supertypes and event types from this project's history
      const supertypes = history
        .filter((h) => h.supertype)
        .map((h) => h.supertype!);
      if (supertypes.length > 0 && !entry.supertype) {
        entry.supertype = supertypes[0];
      }

      const eventTypes = history.map((h) => h.eventType);
      for (const et of eventTypes) {
        if (!entry.eventTypes.includes(et)) {
          entry.eventTypes.push(et);
        }
      }

      const firstSeen = project.assetFirstSeen.get(rawAssetId);
      const lastSeen = project.assetLastSeen.get(rawAssetId);
      const successes = history.filter(
        (h) => h.status !== null && h.status >= 200 && h.status < 300,
      ).length;
      const failures = history.filter(
        (h) => h.status !== null && (h.status >= 300 || h.status < 200),
      ).length;

      entry.projects[projectId] = {
        received: true,
        firstSeen: firstSeen ? firstSeen.toISOString() : "",
        lastSeen: lastSeen ? lastSeen.toISOString() : "",
        attempts: history.length,
        successCount: successes,
        failureCount: failures,
      };
    }
  }

  // Sort assets by ID (numeric-aware)
  const assets = [...assetMap.values()].sort((a, b) => {
    const numA = Number(a.assetId);
    const numB = Number(b.assetId);
    if (!Number.isNaN(numA) && !Number.isNaN(numB)) return numA - numB;
    return a.assetId.localeCompare(b.assetId);
  });

  return { projectIds, assets };
}

function serveUnifiedAssets(res: http.ServerResponse): void {
  const data = buildUnifiedAssetData();
  const { projectIds, assets } = data;

  // Project column headers
  const projectHeaders = projectIds
    .map((id) => `<th class="project-col">${escapeHtml(id)}</th>`)
    .join("\n            ");

  // Embed data as JSON for client-side filtering
  const embeddedJson = JSON.stringify(data);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Unified Asset View - Webhook</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace; background: #0d1117; color: #c9d1d9; padding: 1.5rem; font-size: 13px; }
    h1 { color: #58a6ff; margin-bottom: 0.25rem; font-size: 1.4rem; }
    .subtitle { color: #8b949e; margin-bottom: 1.5rem; }
    .nav { margin-bottom: 1rem; }
    .nav a { color: #58a6ff; text-decoration: none; margin-right: 1rem; }
    .nav a:hover { text-decoration: underline; }

    /* Search */
    .search-bar { margin-bottom: 1rem; display: flex; gap: 0.75rem; align-items: center; flex-wrap: wrap; }
    .search-bar input {
      background: #161b22; border: 1px solid #30363d; border-radius: 6px;
      color: #e6edf3; padding: 0.5rem 0.75rem; font-family: inherit; font-size: 13px;
      width: 320px; outline: none;
    }
    .search-bar input:focus { border-color: #58a6ff; }
    .search-bar input::placeholder { color: #484f58; }
    .search-count { color: #8b949e; font-size: 12px; }

    /* Stats */
    .stats-row { display: flex; gap: 1.5rem; margin-bottom: 1.5rem; flex-wrap: wrap; }
    .stat { background: #161b22; border: 1px solid #21262d; border-radius: 6px; padding: 0.75rem 1.25rem; text-align: center; min-width: 100px; }
    .stat-number { font-size: 1.6rem; font-weight: 700; color: #e6edf3; }
    .stat-label { color: #8b949e; font-size: 0.7rem; text-transform: uppercase; margin-top: 0.15rem; }

    /* Table */
    .table-wrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 0.5rem 0.75rem; text-align: left; border-bottom: 1px solid #21262d; white-space: nowrap; }
    th { color: #58a6ff; font-weight: 600; background: #161b22; position: sticky; top: 0; z-index: 1; }
    tr:hover { background: #161b22; }
    tr.hidden { display: none; }
    .project-col { text-align: center; min-width: 140px; }
    .project-cell { text-align: center; }
    .tick { color: #3fb950; font-weight: 700; font-size: 15px; }
    .cross { color: #484f58; }
    .ts { display: block; color: #8b949e; font-size: 10px; margin-top: 2px; }
    .supertype-badge {
      display: inline-block; background: #1f2937; border: 1px solid #30363d;
      border-radius: 4px; padding: 0.1rem 0.4rem; font-size: 11px; color: #79c0ff;
    }
    .event-type { color: #d2a8ff; font-size: 12px; }
    .asset-id { font-weight: 600; color: #e6edf3; }
    .empty { color: #8b949e; padding: 3rem; text-align: center; }
    .attempts { font-size: 10px; color: #8b949e; }
    .has-failure { color: #f85149; }
  </style>
</head>
<body>
  <div class="nav">
    <a href="./">Projects</a>
    <a href="assets/api">JSON API</a>
  </div>

  <h1>Unified Asset View</h1>
  <p class="subtitle">All assets across all projects</p>

  <div class="stats-row">
    <div class="stat">
      <div class="stat-number" id="stat-assets">${assets.length}</div>
      <div class="stat-label">Total Assets</div>
    </div>
    <div class="stat">
      <div class="stat-number">${projectIds.length}</div>
      <div class="stat-label">Projects</div>
    </div>
  </div>

  <div class="search-bar">
    <input type="text" id="search" placeholder="Filter by asset ID..." autofocus>
    <span class="search-count" id="search-count"></span>
  </div>

  ${assets.length === 0
    ? `<div class="empty">No assets received yet. Send webhook events to create projects.</div>`
    : `<div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>Asset ID</th>
          <th>Supertype</th>
          <th>Event Types</th>
          ${projectHeaders}
        </tr>
      </thead>
      <tbody id="asset-tbody">
      </tbody>
    </table>
  </div>`}

  <script>
    const DATA = ${embeddedJson};
    const tbody = document.getElementById('asset-tbody');
    const searchInput = document.getElementById('search');
    const searchCount = document.getElementById('search-count');
    const statAssets = document.getElementById('stat-assets');

    function formatTs(iso) {
      if (!iso) return '';
      const d = new Date(iso);
      const pad = (n) => String(n).padStart(2, '0');
      return pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + ' '
           + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    }

    function renderRows(filter) {
      if (!tbody) return;
      const q = (filter || '').toLowerCase().trim();
      let html = '';
      let shown = 0;

      for (const asset of DATA.assets) {
        if (q && !asset.assetId.toLowerCase().includes(q)) continue;
        shown++;

        const supertype = asset.supertype
          ? '<span class="supertype-badge">' + asset.supertype + '</span>'
          : '<span class="cross">-</span>';

        const eventTypes = asset.eventTypes
          .map(function(et) { return '<span class="event-type">' + et + '</span>'; })
          .join(', ');

        let projectCells = '';
        for (const pid of DATA.projectIds) {
          const p = asset.projects[pid];
          if (p) {
            const failClass = p.failureCount > 0 ? ' has-failure' : '';
            projectCells += '<td class="project-cell">'
              + '<span class="tick">&#10003;</span>'
              + '<span class="ts">' + formatTs(p.lastSeen) + '</span>'
              + '<span class="attempts' + failClass + '">'
              + p.attempts + ' attempt' + (p.attempts !== 1 ? 's' : '')
              + (p.failureCount > 0 ? ' (' + p.failureCount + ' failed)' : '')
              + '</span>'
              + '</td>';
          } else {
            projectCells += '<td class="project-cell"><span class="cross">&#8212;</span></td>';
          }
        }

        html += '<tr data-asset="' + asset.assetId.toLowerCase() + '">'
          + '<td class="asset-id">' + asset.assetId + '</td>'
          + '<td>' + supertype + '</td>'
          + '<td>' + eventTypes + '</td>'
          + projectCells
          + '</tr>';
      }

      tbody.innerHTML = html;
      searchCount.textContent = q ? shown + ' of ' + DATA.assets.length + ' assets' : '';
      statAssets.textContent = q ? shown : DATA.assets.length;
    }

    // Initial render
    renderRows('');

    // Live search
    searchInput.addEventListener('input', function() {
      renderRows(this.value);
    });

    // Keyboard shortcut: Escape clears filter
    searchInput.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') {
        this.value = '';
        renderRows('');
      }
    });
  </script>
</body>
</html>`;

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

// ---------------------------------------------------------------------------
// Index page
// All links use relative paths so they work behind a reverse proxy prefix.
// ---------------------------------------------------------------------------

function serveIndex(res: http.ServerResponse): void {
  const projectList = [...projects.entries()]
    .map(([id, p]) => {
      const settingsStr = [
        `failCount=${p.settings.failForever ? "forever" : p.settings.failCount}`,
        `failStatus=${p.settings.failStatus}`,
        p.settings.timeoutMs > 0 ? `timeout=${p.settings.timeoutMs}ms` : "",
        p.settings.delayMs > 0 ? `delay=${p.settings.delayMs}ms` : "",
      ]
        .filter(Boolean)
        .join(", ");

      return `
        <tr>
          <td><a href="${escapeHtml(id)}/status">${escapeHtml(id)}</a></td>
          <td>${p.totalRequests}</td>
          <td>${p.assetHistory.size}</td>
          <td>${settingsStr}</td>
          <td>${p.createdAt.toISOString()}</td>
          <td>
            <a href="${escapeHtml(id)}/status">Status</a> |
            <a href="${escapeHtml(id)}/api">API</a> |
            <a href="${escapeHtml(id)}/reset">Reset</a>
          </td>
        </tr>`;
    })
    .join("\n");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Webhook Test Server</title>
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
    .empty { color: #8b949e; padding: 2rem; text-align: center; }
    .usage { background: #161b22; padding: 1.5rem; border-radius: 6px; margin-top: 2rem; color: #8b949e; }
    .usage code { color: #79c0ff; }
    .nav-bar { margin-bottom: 1rem; }
    .nav-bar a { color: #58a6ff; text-decoration: none; margin-right: 1rem; }
    .nav-bar a:hover { text-decoration: underline; }
  </style>
  <meta http-equiv="refresh" content="60">
</head>
<body>
  <div class="nav-bar">
    <a href="assets">Unified Asset View</a>
  </div>

  <h1>Webhook Test Server</h1>
  <p class="subtitle">Uptime: ${elapsed()}s | Projects: ${projects.size}</p>

  ${
    projects.size === 0
      ? `<div class="empty">No projects yet. Send a POST to create one.</div>`
      : `<table>
        <thead>
          <tr><th>Project</th><th>Requests</th><th>Assets</th><th>Settings</th><th>Created</th><th>Actions</th></tr>
        </thead>
        <tbody>${projectList}</tbody>
      </table>`
  }

  <div class="usage">
    <strong>Usage:</strong><br><br>
    <code>curl -X POST "https://toolbox.junaid.guru/webhook/myproject?failCount=3&failStatus=503" \\<br>
    &nbsp;&nbsp;-H "Content-Type: application/json" \\<br>
    &nbsp;&nbsp;-d '{"events":[{"assetId":1,"eventType":"Created","supertype":"Resource"}]}'</code><br><br>
    Then visit <a href="myproject/status">myproject/status</a> for the live dashboard.
  </div>
</body>
</html>`;

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

// ---------------------------------------------------------------------------
// Status page (auto-refresh with toggle)
// All links use relative paths for path-based deployment.
// ---------------------------------------------------------------------------

function serveStatusPage(
  projectId: string,
  queryParams: URLSearchParams,
  res: http.ServerResponse,
): void {
  const project = projects.get(projectId);
  const autoRefresh = queryParams.get("autoRefresh") !== "false";
  const refreshInterval = parseInt(queryParams.get("interval") || "60", 10);

  if (!project) {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(projectId)} - Not Found</title>
  <style>
    body { font-family: 'SF Mono', monospace; background: #0d1117; color: #c9d1d9; padding: 2rem; text-align: center; }
    h1 { color: #f85149; }
    a { color: #58a6ff; }
    .hint { margin-top: 2rem; color: #8b949e; }
    code { color: #79c0ff; background: #161b22; padding: 0.25rem 0.5rem; border-radius: 4px; }
  </style>
</head>
<body>
  <h1>Project '${escapeHtml(projectId)}' not found</h1>
  <p class="hint">Send a POST to <code>${escapeHtml(projectId)}</code> to create it, then refresh this page.</p>
  <p><a href="./">Back to index</a></p>
</body>
</html>`;
    res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  const summary = buildSummary(projectId, project);
  const assets = summary.assets as Record<string, AssetSummary>;
  const deliveries = summary.deliveries as DeliveryRecord[];
  const settings = project.settings;

  // Build asset rows
  const assetRows = Object.entries(assets)
    .map(([assetId, data]) => {
      const retriedClass = data.retried ? "retried-yes" : "retried-no";
      const retriedLabel = data.retried ? "YES" : "NO";
      const duration =
        data.retryDurationMs > 0
          ? `${(data.retryDurationMs / 1000).toFixed(1)}s`
          : "-";
      const supertypeStr = data.supertypes.length > 0 ? data.supertypes.join(", ") : "N/A";

      return `
        <tr>
          <td>${escapeHtml(String(assetId))}</td>
          <td>${data.totalAttempts}</td>
          <td>${data.failureCount}</td>
          <td>${data.successCount}</td>
          <td class="${retriedClass}">${retriedLabel}</td>
          <td>${duration}</td>
          <td>${escapeHtml(data.eventTypes.join(", "))}</td>
          <td>${escapeHtml(supertypeStr)}</td>
        </tr>`;
    })
    .join("\n");

  // Build delivery timeline rows
  const deliveryRows = deliveries
    .map((d) => {
      const statusClass = d.status >= 200 && d.status < 300 ? "status-ok" : "status-fail";
      const ts = new Date(d.timestamp).toLocaleTimeString();
      const supertypes = [
        ...new Set(d.events.map((e) => e.supertype || "N/A")),
      ].join(", ");

      return `
        <tr>
          <td class="dim">${ts}</td>
          <td>#${d.attempt}</td>
          <td class="${statusClass}">${d.status}</td>
          <td>[${d.assetIds.join(", ")}]</td>
          <td>${d.eventCount}</td>
          <td>${escapeHtml(d.events.map((e) => e.eventType).join(", "))}</td>
          <td>${escapeHtml(supertypes)}</td>
        </tr>`;
    })
    .join("\n");

  // Use relative URLs for toggle links
  const toggleUrl = autoRefresh
    ? `status?autoRefresh=false`
    : `status?autoRefresh=true&interval=${refreshInterval}`;
  const toggleLabel = autoRefresh ? "Disable Auto-Refresh" : "Enable Auto-Refresh";

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(projectId)} - Webhook Status</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace; background: #0d1117; color: #c9d1d9; padding: 1.5rem; font-size: 13px; }
    h1 { color: #58a6ff; margin-bottom: 0.25rem; font-size: 1.4rem; }
    h2 { color: #58a6ff; margin: 1.5rem 0 0.5rem; font-size: 1.1rem; }
    .subtitle { color: #8b949e; margin-bottom: 1rem; }
    .top-bar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem; flex-wrap: wrap; gap: 0.5rem; }
    .settings-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 0.75rem; margin-bottom: 1.5rem; }
    .setting-card { background: #161b22; border: 1px solid #21262d; border-radius: 6px; padding: 0.75rem 1rem; }
    .setting-label { color: #8b949e; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; }
    .setting-value { color: #e6edf3; font-size: 1.1rem; font-weight: 600; margin-top: 0.25rem; }
    .setting-value.fail { color: #f85149; }
    .setting-value.ok { color: #3fb950; }
    table { width: 100%; border-collapse: collapse; margin-top: 0.5rem; }
    th, td { padding: 0.5rem 0.75rem; text-align: left; border-bottom: 1px solid #21262d; }
    th { color: #58a6ff; font-weight: 600; background: #161b22; position: sticky; top: 0; }
    tr:hover { background: #161b22; }
    .status-ok { color: #3fb950; font-weight: 600; }
    .status-fail { color: #f85149; font-weight: 600; }
    .retried-yes { color: #3fb950; font-weight: 600; }
    .retried-no { color: #d29922; }
    .dim { color: #8b949e; }
    a { color: #58a6ff; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .btn { display: inline-block; padding: 0.4rem 1rem; border-radius: 6px; border: 1px solid #30363d; background: #21262d; color: #c9d1d9; cursor: pointer; font-family: inherit; font-size: 0.8rem; text-decoration: none; }
    .btn:hover { background: #30363d; text-decoration: none; }
    .btn-active { background: #1f6feb; border-color: #1f6feb; color: #fff; }
    .empty { color: #8b949e; padding: 2rem; text-align: center; }
    .stats-row { display: flex; gap: 2rem; margin-bottom: 1.5rem; flex-wrap: wrap; }
    .stat { background: #161b22; border: 1px solid #21262d; border-radius: 6px; padding: 1rem 1.5rem; text-align: center; min-width: 120px; }
    .stat-number { font-size: 2rem; font-weight: 700; color: #e6edf3; }
    .stat-label { color: #8b949e; font-size: 0.75rem; text-transform: uppercase; margin-top: 0.25rem; }
    .refresh-indicator { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 0.5rem; }
    .refresh-on { background: #3fb950; animation: pulse 2s infinite; }
    .refresh-off { background: #f85149; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
    .nav { margin-bottom: 1rem; }
    .nav a { margin-right: 1rem; }
  </style>
</head>
<body>
  <div class="nav">
    <a href="./">All Projects</a>
    <a href="../assets">Unified Assets</a>
    <a href="api">JSON API</a>
    <a href="reset">Reset</a>
  </div>

  <div class="top-bar">
    <div>
      <h1>${escapeHtml(projectId)}</h1>
      <p class="subtitle">Webhook Status Dashboard</p>
    </div>
    <div>
      <span class="refresh-indicator ${autoRefresh ? "refresh-on" : "refresh-off"}"></span>
      <a href="${toggleUrl}" class="btn ${autoRefresh ? "btn-active" : ""}">${toggleLabel}</a>
    </div>
  </div>

  <div class="stats-row">
    <div class="stat">
      <div class="stat-number">${project.totalRequests}</div>
      <div class="stat-label">Total Requests</div>
    </div>
    <div class="stat">
      <div class="stat-number">${project.assetHistory.size}</div>
      <div class="stat-label">Unique Assets</div>
    </div>
    <div class="stat">
      <div class="stat-number">${deliveries.filter((d) => d.status >= 200 && d.status < 300).length}</div>
      <div class="stat-label">Successes</div>
    </div>
    <div class="stat">
      <div class="stat-number">${deliveries.filter((d) => d.status >= 300).length}</div>
      <div class="stat-label">Failures</div>
    </div>
  </div>

  <div class="settings-grid">
    <div class="setting-card">
      <div class="setting-label">Fail Count</div>
      <div class="setting-value fail">${settings.failForever ? "Forever" : settings.failCount}</div>
    </div>
    <div class="setting-card">
      <div class="setting-label">Fail Status</div>
      <div class="setting-value fail">${settings.failStatus}</div>
    </div>
    <div class="setting-card">
      <div class="setting-label">Timeout</div>
      <div class="setting-value">${settings.timeoutMs > 0 ? `${settings.timeoutMs}ms` : "Off"}</div>
    </div>
    <div class="setting-card">
      <div class="setting-label">Delay</div>
      <div class="setting-value">${settings.delayMs > 0 ? `${settings.delayMs}ms` : "Off"}</div>
    </div>
  </div>

  <h2>Per-Asset Retry Analysis</h2>
  ${
    Object.keys(assets).length === 0
      ? `<div class="empty">No events received yet.</div>`
      : `<table>
        <thead>
          <tr>
            <th>Asset ID</th>
            <th>Attempts</th>
            <th>Failures</th>
            <th>Successes</th>
            <th>Retried</th>
            <th>Duration</th>
            <th>Event Types</th>
            <th>Supertype</th>
          </tr>
        </thead>
        <tbody>${assetRows}</tbody>
      </table>`
  }

  <h2>Delivery Timeline</h2>
  ${
    deliveries.length === 0
      ? `<div class="empty">No deliveries yet.</div>`
      : `<table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Attempt</th>
            <th>Status</th>
            <th>Asset IDs</th>
            <th>Events</th>
            <th>Event Types</th>
            <th>Supertypes</th>
          </tr>
        </thead>
        <tbody>${deliveryRows}</tbody>
      </table>`
  }

  <script>
    const autoRefresh = ${autoRefresh};
    const intervalSec = ${refreshInterval};
    let timer = null;

    if (autoRefresh) {
      timer = setInterval(() => location.reload(), intervalSec * 1000);
    }
  </script>
</body>
</html>`;

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// Console summary (on exit)
// ---------------------------------------------------------------------------

function printSummary(): void {
  console.log(`\n${"=".repeat(70)}`);
  console.log(`${C.bold}  WEBHOOK RETRY TEST SUMMARY${C.reset}`);
  console.log("=".repeat(70));
  console.log(`  Projects: ${C.bold}${projects.size}${C.reset}`);
  console.log("-".repeat(70));

  for (const [projectId, project] of projects) {
    const summary = buildSummary(projectId, project);
    const assets = summary.assets as Record<string, AssetSummary>;

    console.log(
      `\n  ${C.cyan}${C.bold}[${projectId}]${C.reset}  ` +
        `Requests: ${C.bold}${project.totalRequests}${C.reset}  |  ` +
        `Assets: ${C.bold}${project.assetHistory.size}${C.reset}  |  ` +
        `Config: fail ${project.settings.failForever ? "forever" : `first ${project.settings.failCount}`} with ${project.settings.failStatus}`,
    );

    if (Object.keys(assets).length === 0) {
      console.log(`  ${C.dim}No webhook deliveries received.${C.reset}`);
      continue;
    }

    console.log(
      `\n  ${"Asset ID".padEnd(12)} ${"Attempts".padEnd(10)} ${"Failures".padEnd(10)} ${"Success".padEnd(10)} ${"Retried".padEnd(10)} ${"Duration".padEnd(12)} ${"Supertype".padEnd(14)} Event Types`,
    );
    console.log(`  ${"-".repeat(95)}`);

    for (const [assetId, data] of Object.entries(assets)) {
      const retriedLabel = data.retried
        ? `${C.green}YES${C.reset}`
        : `${C.yellow}NO${C.reset}`;
      const duration =
        data.retryDurationMs > 0
          ? `${(data.retryDurationMs / 1000).toFixed(1)}s`
          : "-";
      const supertypeStr = data.supertypes.length > 0 ? data.supertypes.join(",") : "N/A";

      console.log(
        `  ${String(assetId).padEnd(12)} ${String(data.totalAttempts).padEnd(10)} ${String(data.failureCount).padEnd(10)} ${String(data.successCount).padEnd(10)} ${(retriedLabel + C.reset).padEnd(19)} ${duration.padEnd(12)} ${supertypeStr.padEnd(14)} ${data.eventTypes.join(", ")}`,
      );
    }

    // Delivery timeline
    const deliveries = summary.deliveries as DeliveryRecord[];
    console.log(`\n  ${C.bold}Delivery Timeline:${C.reset}\n`);
    for (const d of deliveries) {
      const statusColor =
        d.status >= 200 && d.status < 300 ? C.green : C.red;
      const ts = new Date(d.timestamp).toLocaleTimeString();
      const supertypes = [
        ...new Set(d.events.map((e) => e.supertype || "N/A")),
      ].join(",");
      console.log(
        `  ${C.dim}${ts}${C.reset}  #${d.attempt}  ${statusColor}${d.status}${C.reset}  ` +
          `assets=[${d.assetIds.join(",")}]  events=${d.eventCount}  supertypes=[${supertypes}]`,
      );
    }
  }

  console.log(`\n${"=".repeat(70)}\n`);
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

server.listen(PORT, () => {
  console.log(`\n${"=".repeat(70)}`);
  console.log(`${C.bold}  Webhook Retry Test Server - Multi-Project Edition${C.reset}`);
  console.log("=".repeat(70));
  console.log(`  Listening on:        ${C.cyan}http://0.0.0.0:${PORT}${C.reset}`);
  console.log(`  Default fail count:  ${C.yellow}${CLI_DEFAULTS.failForever ? "Forever" : CLI_DEFAULTS.failCount}${C.reset}`);
  console.log(`  Default fail status: ${C.red}${CLI_DEFAULTS.failStatus}${C.reset}`);
  if (CLI_DEFAULTS.timeoutMs > 0)
    console.log(`  Default timeout:     ${C.yellow}${CLI_DEFAULTS.timeoutMs}ms${C.reset}`);
  if (CLI_DEFAULTS.delayMs > 0)
    console.log(`  Default delay:       ${C.yellow}${CLI_DEFAULTS.delayMs}ms${C.reset}`);
  console.log("-".repeat(70));
  console.log(`  ${C.dim}POST /:project              Webhook endpoint${C.reset}`);
  console.log(`  ${C.dim}GET  /:project/status       Live status dashboard${C.reset}`);
  console.log(`  ${C.dim}GET  /:project/api          JSON summary${C.reset}`);
  console.log(`  ${C.dim}GET  /:project/reset        Reset project state${C.reset}`);
  console.log(`  ${C.dim}GET  /assets                Unified asset view${C.reset}`);
  console.log(`  ${C.dim}GET  /assets/api            Unified asset JSON${C.reset}`);
  console.log(`  ${C.dim}GET  /health                Server health${C.reset}`);
  console.log(`  ${C.dim}GET  /                      Project index${C.reset}`);
  console.log("-".repeat(70));
  console.log(`  ${C.dim}Query params: ?failCount=3&failStatus=503&timeout=0&delay=0&failForever=false${C.reset}`);
  console.log(`  ${C.dim}Ctrl+C to stop and print summary${C.reset}`);
  console.log(`${"=".repeat(70)}`);
  console.log(`\n  Waiting for webhook deliveries...\n`);
});

// Print summary on exit
process.on("SIGINT", () => {
  printSummary();
  process.exit(0);
});

process.on("SIGTERM", () => {
  printSummary();
  process.exit(0);
});
