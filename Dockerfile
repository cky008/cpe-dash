# syntax=docker/dockerfile:1.7
# 烽燧 FengSui (cpe-dash) — zero-runtime-dependency daemon + offline web dashboard.
#
# Stage 1 compiles TypeScript and the web bundle on the build platform (its output is plain JS/CSS,
# identical for every architecture); stage 2 is the runtime: Node LTS, dist/ and locales/ only — no
# node_modules, no shell scripts, running as the unprivileged `node` user (uid 1000).

# The base image is pinned by digest (a tag can be repointed upstream); Dependabot proposes updates
FROM --platform=$BUILDPLATFORM node:26-alpine@sha256:c6ad9e9c1d80f6eb607c26b4b0a132ff7a2344fad1c78ea3baa2a7d4c8de6d94 AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json tsconfig.web.json ./
COPY src ./src
COPY web ./web
COPY locales ./locales
COPY scripts/build-web.ts scripts/brand.ts ./scripts/
RUN npm run build

FROM node:26-alpine@sha256:c6ad9e9c1d80f6eb607c26b4b0a132ff7a2344fad1c78ea3baa2a7d4c8de6d94 AS runtime
LABEL org.opencontainers.image.title="cpe-dash (烽燧 FengSui)" \
      org.opencontainers.image.description="Self-hosted 5G RF telemetry, band/cell locking, SMS centre and MCP server for the Huawei 5G CPE Ultra 6 (H168-383)" \
      org.opencontainers.image.source="https://github.com/cky008/cpe-dash" \
      org.opencontainers.image.licenses="PolyForm-Noncommercial-1.0.0"
ENV NODE_ENV=production \
    WEB_HOST=0.0.0.0 \
    WEB_PORT=18384 \
    STATE_FILE=/app/data/state.json
WORKDIR /app
COPY package.json ./
COPY --from=build /src/dist ./dist
COPY locales ./locales
# The data directory holds only AES-256-GCM encrypted files written 0600; keep the directory private too
RUN mkdir -p /app/data && chown node:node /app/data && chmod 0700 /app/data
USER node
EXPOSE 18384
VOLUME ["/app/data"]
# GET /api/health needs no login; busybox wget ships with the Alpine base (no extra package, no JS)
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${WEB_PORT}/api/health" || exit 1
# The daemon handles SIGTERM itself: queued CPE work answers 503, the in-flight session logs out,
# encrypted stores flush — all inside docker stop's 10 s grace.
STOPSIGNAL SIGTERM
CMD ["node", "dist/cli.js", "serve"]
