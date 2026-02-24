#!/usr/bin/env node

/**
 * Webhook Retry Test Tool
 *
 * Simulates a flaky webhook endpoint to verify that the
 * luma-dam-events-webhook scheduler retries failed deliveries
 * with the correct assets.
 *
 * Usage:
 *   node index.js [options]
 *
 * Options:
 *   --port, -p          Port to listen on (default: 8888)
 *   --fail-count, -f    Number of times to return failure before succeeding (default: 3)
 *   --fail-status, -s   HTTP status code to return on failure (default: 503)
 *   --fail-forever      Never succeed, always return fail-status
 *   --timeout, -t       Respond after this many ms to simulate timeout (default: 0 = disabled)
 *   --delay, -d         Artificial response delay in ms (default: 0)
 *   --quiet, -q         Only print summary, not each request
 */

const http = require("http");

// ---------------------------------------------------------------------------
// CLI argument parsing (zero dependencies)
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);

function flag(name) {
  return args.includes(`--${name}`);
}

function opt(long, short) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === `--${long}` || args[i] === `-${short}`) {
      return args[i + 1];
    }
  }
  return undefined;
}

if (flag("help") || flag("h")) {
  console.log(`
Webhook Retry Test Tool

Simulates a flaky webhook endpoint to confirm that the webhook scheduler
retries failed deliveries with the correct assets.

Usage:
  node index.js [options]

Options:
  --port, -p          Port to listen on              (default: 8888)
  --fail-count, -f    Failures before first success   (default: 3)
  --fail-status, -s   HTTP status on failure           (default: 503)
  --fail-forever      Never succeed
  --timeout, -t       Delay response to trigger caller timeout (ms)
  --delay, -d         Artificial response delay (ms)   (default: 0)
  --quiet, -q         Suppress per-request output

Scenarios:
  npm run test:fail-3       Fail 3 times with 503, then succeed
  npm run test:fail-forever Always fail with 500 (test dead-letter eviction)
  npm run test:timeout      Fail 2 times via timeout (35s > 30s server timeout)
  npm run test:4xx          Fail once with 400 (non-retryable, should NOT retry)
  `);
  process.exit(0);
}

const PORT = parseInt(opt("port", "p") || "8888", 10);
const FAIL_COUNT = parseInt(opt("fail-count", "f") || "3", 10);
const FAIL_STATUS = parseInt(opt("fail-status", "s") || "503", 10);
const FAIL_FOREVER = flag("fail-forever");
const TIMEOUT_MS = parseInt(opt("timeout", "t") || "0", 10);
const DELAY_MS = parseInt(opt("delay", "d") || "0", 10);
const QUIET = flag("quiet") || flag("q");

// ---------------------------------------------------------------------------
// State tracking
// ---------------------------------------------------------------------------

// Global request counter
let totalRequests = 0;

// Per-asset tracking: assetId -> [{ attempt, timestamp, status, eventType }]
const assetHistory = new Map();

// Per-delivery tracking (each POST is a "delivery")
const deliveries = [];

// Track when each asset was first and last seen
const assetFirstSeen = new Map();
const assetLastSeen = new Map();

const startTime = Date.now();

function elapsed() {
  return ((Date.now() - startTime) / 1000).toFixed(1);
}

// ANSI colors
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

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", requests: totalRequests }));
    return;
  }

  if (req.method === "GET" && req.url === "/summary") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(buildSummary(), null, 2));
    return;
  }

  if (req.method === "GET" && req.url === "/reset") {
    totalRequests = 0;
    assetHistory.clear();
    deliveries.length = 0;
    assetFirstSeen.clear();
    assetLastSeen.clear();
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("State reset\n");
    log(`${C.yellow}State reset${C.reset}`);
    return;
  }

  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "text/plain" });
    res.end("Method Not Allowed\n");
    return;
  }

  // Collect body
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => handleWebhook(req, res, body));
});

function handleWebhook(req, res, rawBody) {
  totalRequests++;
  const now = new Date();

  // Parse payload
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    log(`${C.red}[${elapsed()}s] #${totalRequests} Invalid JSON payload${C.reset}`);
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("Invalid JSON\n");
    return;
  }

  const events = payload.events || [];
  const count = payload.count || events.length;
  const assetIds = events.map((e) => e.assetId);
  const uniqueAssetIds = [...new Set(assetIds)];

  // Track per-asset history
  for (const event of events) {
    const id = event.assetId;
    if (!assetHistory.has(id)) {
      assetHistory.set(id, []);
    }
    assetHistory.get(id).push({
      attempt: totalRequests,
      timestamp: now.toISOString(),
      status: null, // filled below
      eventType: event.eventType,
      eventId: event.eventId,
    });

    if (!assetFirstSeen.has(id)) assetFirstSeen.set(id, now);
    assetLastSeen.set(id, now);
  }

  // Decide response: fail or succeed
  const shouldFail = FAIL_FOREVER || totalRequests <= FAIL_COUNT;
  const statusCode = shouldFail ? FAIL_STATUS : 200;

  // Update status in per-asset history
  for (const event of events) {
    const history = assetHistory.get(event.assetId);
    if (history.length > 0) {
      history[history.length - 1].status = statusCode;
    }
  }

  // Record delivery
  const delivery = {
    attempt: totalRequests,
    timestamp: now.toISOString(),
    status: statusCode,
    assetIds: uniqueAssetIds,
    eventCount: count,
    events: events.map((e) => ({
      assetId: e.assetId,
      eventType: e.eventType,
      eventId: e.eventId,
    })),
    headers: {
      "content-type": req.headers["content-type"],
      "x-api-key": req.headers["x-api-key"] || null,
      ...extractCustomHeaders(req.headers),
    },
    path: req.url,
  };
  deliveries.push(delivery);

  // Log request
  if (!QUIET) {
    const statusColor = shouldFail ? C.red : C.green;
    const statusLabel = shouldFail ? "FAIL" : "OK";

    log(
      `${C.bold}[${elapsed()}s]${C.reset} ` +
        `#${totalRequests} ${statusColor}${statusCode} ${statusLabel}${C.reset} | ` +
        `${count} event(s) | ` +
        `assets: [${uniqueAssetIds.join(", ")}] | ` +
        `types: [${events.map((e) => e.eventType).join(", ")}]`
    );

    if (req.headers["x-api-key"]) {
      log(
        `  ${C.dim}API key: ${req.headers["x-api-key"].substring(0, 8)}...${C.reset}`
      );
    }
  }

  // Respond (with optional delay/timeout simulation)
  const respondDelay = TIMEOUT_MS > 0 && shouldFail ? TIMEOUT_MS : DELAY_MS;

  if (respondDelay > 0) {
    if (!QUIET) {
      log(
        `  ${C.dim}Delaying response by ${respondDelay}ms${shouldFail && TIMEOUT_MS > 0 ? " (simulating timeout)" : ""}${C.reset}`
      );
    }
    setTimeout(() => sendResponse(res, statusCode, shouldFail), respondDelay);
  } else {
    sendResponse(res, statusCode, shouldFail);
  }
}

function sendResponse(res, statusCode, shouldFail) {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      received: true,
      status: shouldFail ? "rejected" : "accepted",
    })
  );
}

function extractCustomHeaders(headers) {
  const custom = {};
  for (const [key, value] of Object.entries(headers)) {
    if (
      key.startsWith("x-") &&
      key !== "x-api-key" &&
      key !== "x-forwarded-for"
    ) {
      custom[key] = value;
    }
  }
  return custom;
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

function buildSummary() {
  const assets = {};
  for (const [assetId, history] of assetHistory) {
    const attempts = history.length;
    const successes = history.filter((h) => h.status >= 200 && h.status < 300);
    const failures = history.filter((h) => h.status >= 300 || h.status < 200);
    const firstSeen = assetFirstSeen.get(assetId);
    const lastSeen = assetLastSeen.get(assetId);
    const retryDuration = lastSeen && firstSeen ? lastSeen - firstSeen : 0;

    assets[assetId] = {
      totalAttempts: attempts,
      successCount: successes.length,
      failureCount: failures.length,
      retried: attempts > 1,
      eventTypes: [...new Set(history.map((h) => h.eventType))],
      retryDurationMs: retryDuration,
      timeline: history.map((h) => ({
        attempt: h.attempt,
        status: h.status,
        timestamp: h.timestamp,
      })),
    };
  }

  return {
    totalRequests,
    totalUniqueAssets: assetHistory.size,
    config: {
      failCount: FAIL_FOREVER ? "forever" : FAIL_COUNT,
      failStatus: FAIL_STATUS,
      timeoutMs: TIMEOUT_MS,
      delayMs: DELAY_MS,
    },
    assets,
    deliveries,
  };
}

function printSummary() {
  const summary = buildSummary();

  console.log("\n" + "=".repeat(70));
  console.log(`${C.bold}  WEBHOOK RETRY TEST SUMMARY${C.reset}`);
  console.log("=".repeat(70));
  console.log(
    `  Total requests received: ${C.bold}${summary.totalRequests}${C.reset}`
  );
  console.log(
    `  Unique assets seen:      ${C.bold}${summary.totalUniqueAssets}${C.reset}`
  );
  console.log(
    `  Config: fail ${FAIL_FOREVER ? "forever" : `first ${FAIL_COUNT}`} with ${FAIL_STATUS}`
  );
  console.log("-".repeat(70));

  if (summary.totalUniqueAssets === 0) {
    console.log(`  ${C.dim}No webhook deliveries received.${C.reset}`);
    console.log("=".repeat(70) + "\n");
    return;
  }

  // Per-asset table
  console.log(
    `\n  ${C.bold}Per-Asset Retry Analysis:${C.reset}\n`
  );
  console.log(
    `  ${"Asset ID".padEnd(12)} ${"Attempts".padEnd(10)} ${"Failures".padEnd(10)} ${"Success".padEnd(10)} ${"Retried".padEnd(10)} ${"Duration".padEnd(12)} Event Types`
  );
  console.log("  " + "-".repeat(80));

  for (const [assetId, data] of Object.entries(summary.assets)) {
    const retriedLabel = data.retried
      ? `${C.green}YES${C.reset}`
      : `${C.yellow}NO${C.reset}`;
    const duration =
      data.retryDurationMs > 0
        ? `${(data.retryDurationMs / 1000).toFixed(1)}s`
        : "-";

    console.log(
      `  ${String(assetId).padEnd(12)} ${String(data.totalAttempts).padEnd(10)} ${String(data.failureCount).padEnd(10)} ${String(data.successCount).padEnd(10)} ${(retriedLabel + C.reset).padEnd(19)} ${duration.padEnd(12)} ${data.eventTypes.join(", ")}`
    );
  }

  // Delivery timeline
  console.log(
    `\n  ${C.bold}Delivery Timeline:${C.reset}\n`
  );
  for (const d of summary.deliveries) {
    const statusColor = d.status >= 200 && d.status < 300 ? C.green : C.red;
    const ts = new Date(d.timestamp).toLocaleTimeString();
    console.log(
      `  ${C.dim}${ts}${C.reset}  #${d.attempt}  ${statusColor}${d.status}${C.reset}  ` +
        `assets=[${d.assetIds.join(",")}]  events=${d.eventCount}`
    );
  }

  // Validation checks
  console.log(
    `\n  ${C.bold}Validation:${C.reset}\n`
  );

  let allPassed = true;

  // Check 1: Assets were retried after failure
  if (!FAIL_FOREVER) {
    const retriedAssets = Object.values(summary.assets).filter(
      (a) => a.retried
    );
    const check1 =
      retriedAssets.length > 0 || summary.totalRequests <= FAIL_COUNT;
    printCheck(
      check1,
      `Assets retried after failure (${retriedAssets.length} retried assets)`
    );
    allPassed = allPassed && check1;
  }

  // Check 2: Eventually succeeded (if not fail-forever mode)
  if (!FAIL_FOREVER) {
    const allSucceeded = Object.values(summary.assets).every(
      (a) => a.successCount > 0
    );
    printCheck(
      allSucceeded,
      "All assets eventually delivered successfully"
    );
    allPassed = allPassed && allSucceeded;
  }

  // Check 3: Same assets in retry attempts
  if (summary.deliveries.length >= 2) {
    const firstAssets = new Set(summary.deliveries[0].assetIds);
    const retryDeliveries = summary.deliveries.slice(1);
    const sameAssets = retryDeliveries.some((d) =>
      d.assetIds.some((id) => firstAssets.has(id))
    );
    printCheck(
      sameAssets,
      "Retry attempts contain same assets as original delivery"
    );
    allPassed = allPassed && sameAssets;
  }

  // Check 4: 4xx should not be retried
  if (FAIL_STATUS >= 400 && FAIL_STATUS < 500 && !FAIL_FOREVER) {
    const shouldNotRetry = summary.totalRequests <= FAIL_COUNT + 1;
    printCheck(
      shouldNotRetry,
      `4xx errors (${FAIL_STATUS}) should not trigger retries ` +
        `(got ${summary.totalRequests} requests, expected <= ${FAIL_COUNT + 1})`
    );
    allPassed = allPassed && shouldNotRetry;
  }

  console.log(
    `\n  ${allPassed ? C.green + "ALL CHECKS PASSED" : C.red + "SOME CHECKS FAILED"}${C.reset}`
  );
  console.log("=".repeat(70) + "\n");
}

function printCheck(passed, message) {
  const icon = passed ? `${C.green}[PASS]` : `${C.red}[FAIL]`;
  console.log(`  ${icon}${C.reset} ${message}`);
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

function log(msg) {
  console.log(msg);
}

server.listen(PORT, () => {
  console.log("\n" + "=".repeat(70));
  console.log(`${C.bold}  Webhook Retry Test Server${C.reset}`);
  console.log("=".repeat(70));
  console.log(`  Listening on:    ${C.cyan}http://0.0.0.0:${PORT}${C.reset}`);
  console.log(
    `  Failure mode:    ${C.yellow}${FAIL_FOREVER ? "Always fail" : `Fail first ${FAIL_COUNT} request(s)`}${C.reset}`
  );
  console.log(`  Failure status:  ${C.red}${FAIL_STATUS}${C.reset}`);
  if (TIMEOUT_MS > 0)
    console.log(
      `  Timeout sim:     ${C.yellow}${TIMEOUT_MS}ms delay on failures${C.reset}`
    );
  if (DELAY_MS > 0)
    console.log(
      `  Response delay:  ${C.yellow}${DELAY_MS}ms${C.reset}`
    );
  console.log("-".repeat(70));
  console.log(
    `  ${C.dim}POST any path     - webhook endpoint (fails then succeeds)${C.reset}`
  );
  console.log(
    `  ${C.dim}GET  /health      - server health check${C.reset}`
  );
  console.log(
    `  ${C.dim}GET  /summary     - JSON summary of all requests${C.reset}`
  );
  console.log(
    `  ${C.dim}GET  /reset       - reset all state${C.reset}`
  );
  console.log(
    `  ${C.dim}Ctrl+C            - stop and print summary${C.reset}`
  );
  console.log("=".repeat(70));
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
