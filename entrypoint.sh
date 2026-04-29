#!/bin/sh
set -e

echo "[entrypoint] Starting toolbox apps..."

# Start webhook app in background
echo "[entrypoint] Starting webhook on port 3001..."
PORT=3001 node /app/apps/webhook/dist/index.js &

# Start proxy app in background
echo "[entrypoint] Starting proxy on port 3002..."
PORT=3002 node /app/apps/proxy/dist/index.js &

# Wait a moment for backends to start
sleep 1

# Start gateway (foreground - main process)
echo "[entrypoint] Starting gateway on port ${PORT:-8080}..."
exec node /app/apps/gateway/dist/index.js
