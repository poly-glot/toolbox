# ============================================================
# Toolbox - Multi-app monorepo in a single container
# ============================================================
# Architecture: Gateway (port 8080) reverse-proxies to apps
#   /webhook/* -> webhook app (port 3001)
#   /next-app/* -> next app (port 3002) ... etc.
#
# Build: docker build --platform linux/arm64 -t toolbox .
# Run:   docker run -p 8080:8080 toolbox
# ============================================================

# ── Stage 1: Install dependencies ──────────────────────────
FROM node:22-alpine AS deps

WORKDIR /app

# Copy root package files for workspace resolution
COPY package.json package-lock.json* ./

# Copy all workspace package.json files
COPY apps/gateway/package.json apps/gateway/package.json
COPY apps/webhook/package.json apps/webhook/package.json
COPY apps/proxy/package.json apps/proxy/package.json

# Install all workspace dependencies
RUN npm ci --ignore-scripts

# ── Stage 2: Build all apps ────────────────────────────────
FROM deps AS builder

WORKDIR /app

# Copy source code
COPY apps/ apps/

# Build all workspaces
RUN npm run build

# ── Stage 3: Production image ──────────────────────────────
FROM node:22-alpine AS production

RUN addgroup -S appuser && adduser -S appuser -G appuser

WORKDIR /app

# Copy root package files
COPY package.json package-lock.json* ./

# Copy workspace package.json files
COPY apps/gateway/package.json apps/gateway/package.json
COPY apps/webhook/package.json apps/webhook/package.json
COPY apps/proxy/package.json apps/proxy/package.json

# Install production dependencies only
RUN npm ci --omit=dev --ignore-scripts

# Copy built output from builder
COPY --from=builder /app/apps/gateway/dist apps/gateway/dist
COPY --from=builder /app/apps/webhook/dist apps/webhook/dist
COPY --from=builder /app/apps/proxy/dist apps/proxy/dist

# Copy entrypoint
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

RUN chown -R appuser:appuser /app
USER appuser

EXPOSE 8080

# Environment defaults
ENV PORT=8080
ENV APP_ROUTES=webhook:3001,proxy:3002

ENTRYPOINT ["/app/entrypoint.sh"]
