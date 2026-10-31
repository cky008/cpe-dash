# Changelog

All notable changes to 烽燧 FengSui (`cpe-dash`). Versions follow [Semantic Versioning](https://semver.org/).

## [1.0.0] — 2026-10-31

First production release: one container that monitors a Huawei 5G CPE Ultra 6 (H168-383, firmware 4.4.0.1), serves the web console and runs the SMS gateway through a single router admin session.

### Web console
- Dashboard: carrier-aggregation capsule, per-carrier RF readings (RSRP / RSRQ / SINR rings, MCS, MIMO, transmit power), health, daily and monthly traffic rings with thresholds, live and historical throughput / signal charts with brush zoom, neighbor cells with "Lock to this cell", LAN / 2.4G / 5G client topology with lease countdowns.
- Messages: threads, search, long SMS, one-tap OTP copy, compose with GSM-7 / UCS-2 segment count, read / delete with confirmation, contacts with vCard import; an accepted send whose status poll timed out shows as "Submitted · unconfirmed", never as failed.
- Controls drawer: LTE / NR band lock, unlock, security switches, cellular reconnect and reboot with confirmation.
- Distinct states for polite yielding (`409`), the anti-lockout breaker (`423`), daemon restarts (`503`) and expired sessions; privacy masking of IMEI, IMSI, phone numbers, WAN addresses and SMS content.
- Four themes (Paper, Dawn, Polar Night, Violet Abyss), six accents, Chinese / English; no CDN, strict CSP, 59.8 KiB gzip first paint.

### Daemon
- `MutexSessionScheduler` as the only path to the router: ephemeral sessions (~26–260 ms) with a guaranteed logout, two-layer yielding to a human admin, a persistent `108006` / `108007` circuit breaker, a duplicate-daemon guard and graceful `SIGTERM` shutdown.
- Telemetry, neighbor scans, topology and settings with a two-tier time-series ring (5 s for 3 h, 60 s for 7 days); alert engine with sustain windows and hysteresis.
- SMS mirror, contacts and Telegram state encrypted at rest (AES-256-GCM); Telegram two-way bot; HMAC-signed webhooks.
- REST, SSE and a zero-dependency MCP server on `/mcp` (13 core tools, up to 10 SMS tools) plus the stateless `cpe-dash mcp` stdio bridge.

### Container and CI
- Multi-stage `Dockerfile` (`node:26-alpine`, non-root, no `node_modules`, `HEALTHCHECK`), hardened `docker-compose.yml` for Synology DS923+, CI on Node 22.x and 26.x with a container smoke test, and a tag-triggered release of `linux/amd64` + `linux/arm64` images to GHCR.

### Fixed in this release
- A session waiting only on its hold deadline no longer lets the event loop exit early (found by the first CI run on Node 22).
- Web console: a `2xx` response with a stalled or truncated body is an error instead of `null`; history-chart gradients, brush listeners and duplicate renders no longer accumulate in a tab left open for weeks.

### Known limitations
See [`docs/PHASE2_ARCHITECTURE_REPORT.md` §7.4](docs/PHASE2_ARCHITECTURE_REPORT.md#74-已知限制phase-3) and §6.8.

[1.0.0]: https://github.com/cky008/cpe-dash/releases/tag/v1.0.0
