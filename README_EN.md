# cpe-dash · FengSui (烽燧)

<p align="center">
  <strong>Self-Hosted 5G RF Telemetry · 3CA Carrier Aggregation · Neighbor Cell Scanner · Band & Cell Locking · SMS & Telegram · MCP Agent Platform for Huawei 5G CPE Ultra 6 (H168-383)</strong>
</p>

<p align="center">
  <a href="README.md">简体中文</a> | <strong>English</strong>
</p>

<p align="center">
  <a href="https://nodejs.org/">
    <img src="https://img.shields.io/badge/Node.js-%3E%3D22.6.0-339933?logo=node.js&logoColor=white" alt="Node.js >= 22.6.0" />
  </a>
  <a href="https://www.typescriptlang.org/">
    <img src="https://img.shields.io/badge/TypeScript-7.0_Strict-3178C6?logo=typescript&logoColor=white" alt="TypeScript 7.0 Strict" />
  </a>
  <a href="package.json">
    <img src="https://img.shields.io/badge/dependencies-0%20runtime-black" alt="Zero Runtime Dependencies" />
  </a>
  <a href="test/">
    <img src="https://img.shields.io/badge/coverage-%3E96%25-brightgreen" alt="Coverage > 96%" />
  </a>
  <a href="AGENTS.md">
    <img src="https://img.shields.io/badge/security-AES--256--GCM-0052CC?logo=vault&logoColor=white" alt="AES-256-GCM Security" />
  </a>
  <a href=".env.example">
    <img src="https://img.shields.io/badge/WEB__PORT-18384-6E56CF" alt="Default Port 18384" />
  </a>
  <a href="docs/PHASE2_BACKEND_CONTRACT.md">
    <img src="https://img.shields.io/badge/MCP-2025--06--18-8A2BE2" alt="Model Context Protocol" />
  </a>
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/License-PolyForm_Noncommercial_1.0.0-orange.svg" alt="License" />
  </a>
</p>

---

**FengSui (烽燧 / `cpe-dash`)** is a self-hosted 5G RF telemetry, 3CA carrier aggregation analyzer, 4G/5G neighbor cell scanner, band/cell lock controller, dual-period traffic auditor, LAN terminal topology, and **Model Context Protocol (MCP)** AI agent platform built specifically for the **Huawei 5G CPE Ultra 6 (`H168-383`, firmware `4.4.0.1`)**, with built-in **SMS** (encrypted mirror, contact book, two-way Telegram bot, signed webhooks) and **automatic alerts**. SMS and telemetry share one admin-session scheduler, so no separate SMS service competes for the router's single admin slot.

Engineered for private NAS environments such as **Synology DS923+ (AMD Ryzen R1600 / 32GB RAM)**, `cpe-dash` is written in **100% Strict TypeScript (`strict: true`)** as a self-contained repository with **zero production runtime npm dependencies** (powered solely by Node.js built-in modules) and listens on isolated port `:18384` by default.

---

## Table of Contents

- [🏛️ System Architecture & Single-Session Avoidance Diagrams](#️-system-architecture--single-session-avoidance-diagrams)
- [✨ Core Engineering & Protocol Highlights](#-core-engineering--protocol-highlights)
- [📡 H168-383 Hardware Capability Panorama (Live-Verified)](#-h168-383-hardware-capability-panorama-live-verified)
- [🏗️ Repository Architecture](#️-repository-architecture)
- [🚀 Quick Start (Daemon, MCP Server & Hardware Probes)](#-quick-start-daemon-mcp-server--hardware-probes)
- [✉️ SMS, Telegram Bot & Alerts](#️-sms-telegram-bot--alerts)
- [🔌 REST API, Real-Time SSE & MCP Tools Overview](#-rest-api-real-time-sse--mcp-tools-overview)
- [⚙️ `.env` Configuration Reference](#️-env-configuration-reference)
- [🛡️ Security Invariants & TDD Quality Gates](#️-security-invariants--tdd-quality-gates)
- [📚 Authoritative Documentation Index](#-authoritative-documentation-index)
- [⚠️ Disclaimer & License](#️-disclaimer--license)

---

## 🏛️ System Architecture & Single-Session Avoidance Diagrams

### 1. Synology DS923+ Private LAN / Tailscale Deployment Topology

```mermaid
flowchart LR
  subgraph Clients["LAN / Tailscale Clients & AI Agents"]
    Browser["Web Console (Offline SPA)"]
    AgentHttp["LAN AI Agent (HTTP MCP)"]
    AgentStdio["Local AI Agent (stdio MCP)"]
    HumanWeb["Human Admin Browser"]
    TgUser["Telegram (phone)"]
    Hook["Webhook receiver (Home Assistant / n8n)"]
  end

  subgraph NAS["Synology DS923+ (Node.js >= 22.6 Zero Runtime Deps)"]
    HttpSrv["FengSuiHttpServer (:18384)\nHost Guard + Strict CSRF + /64 Rate Limit"]
    SseBus["SseEventBus (/api/events)\n<1ms Hello Snapshot + 15s Heartbeat"]
    McpSrv["FengSuiMcpServer\n13 + 10 SMS Tools"]
    Sms["SmsService\nPiggybacked Sync + Encrypted Mirror + Contacts"]
    Notify["NotificationHub + AlertEngine\nTelegram Bot / Signed Webhooks"]
    Sched["MutexSessionScheduler\nPriority Queue + Coalescer + Avoidance"]
    Ring["TimeSeriesRingBuffer\n5s Fine Ring + 60s Rollup Ring (7d)"]
    Store["EncryptedStateStore\nAES-256-GCM 0600 Async Atomic Flush"]
    Client["HuaweiCpeClient\nSCRAM + Curve25519 + 108006 Breaker"]
  end

  subgraph Router["Huawei 5G CPE Ultra 6 (H168-383 / 192.168.8.1)"]
    CpeApi["Single-Admin Web API (Firmware 4.4.0.1)"]
  end

  Browser -- "Cookie + X-Requested-With" --> HttpSrv
  HttpSrv -- "SSE Live Frames" --> SseBus
  SseBus --> Browser
  AgentHttp -- "POST /mcp (Bearer Token)" --> HttpSrv
  HttpSrv --> McpSrv
  AgentStdio -- "NDJSON stdio" --> McpSrv
  HttpSrv --> Sched
  McpSrv --> Sched
  HttpSrv --> Sms
  McpSrv --> Sms
  Sms --> Sched
  Sms -- "sms:new" --> Notify
  Sched -- "alert / telemetry" --> Notify
  Notify -- "Bot API long polling" --> TgUser
  Notify -- "HMAC-signed POST" --> Hook
  Sched --> Ring
  Sched --> Store
  Sched --> Client
  Client -- "~26ms-260ms Ephemeral Session + finally logout" --> CpeApi
  HumanWeb -. "Direct Login to http://192.168.8.1 (Highest Priority)" .-> CpeApi
```

### 2. Single-Admin Session Mutex & Dual-Layer Human Avoidance Sequence

```mermaid
sequenceDiagram
  autonumber
  participant UI as Web Console / SSE
  participant Sched as MutexSessionScheduler
  participant Client as HuaweiCpeClient
  participant CPE as H168-383 (192.168.8.1)
  participant Human as Human Admin Browser

  Note over Sched,CPE: Case A: Router Idle (~26ms-260ms Ephemeral Poll)
  Sched->>Client: withSessionDetailed(fetchGlobalTelemetry)
  Client->>CPE: GET /api/user/state-login
  CPE-->>Client: <State>-1</State> (Idle)
  Client->>CPE: SCRAM-SHA256 + Curve25519 Handshake
  Client->>CPE: Parallel 3CA RF / Traffic / Device Status Fetch (12 read-only APIs)
  Client->>CPE: POST /api/user/logout (Guaranteed in finally)
  Sched-->>UI: SSE Push speed + telemetry + Append to Ring Buffer
  Note over Sched,CPE: Neighbors and topology are not part of the 5s poll, each runs in its own 60s session (login → GET → logout)

  Note over Human,CPE: Case B: Human Logs into http://192.168.8.1 (Polite Yielding)
  Human->>CPE: Logs into Official CPE WebUI
  Sched->>Client: Next Poll or Control Pre-check
  Client->>CPE: GET /api/user/state-login (Layer 1) / challenge_login (Layer 2: 108003)
  CPE-->>Client: State != -1 or Error 108003
  Client-->>Sched: status = "yielded" (Silent Yield + Exponential Backoff)
  Sched-->>UI: SSE Broadcast event: session:avoidance (active: true)
  Note over Sched,UI: Mutating requests (Band Lock / Reboot) return 409 Conflict immediately!
```

---

## ✨ Core Engineering & Protocol Highlights

- **⚡ `~26 ms` Ephemeral Sessions & Anti-Flapping Dual-Layer Browser Avoidance**
  - The H168-383 strictly permits 1 active admin session. [`HuaweiCpeClient`](src/cpe-client.ts) and [`MutexSessionScheduler`](src/scheduler.ts) serialize all authenticated transactions into short-lived windows and unconditionally invoke `POST /api/user/logout` (with a hard 3s timeout cap) inside `finally`.
  - **Dual-Layer Avoidance**: Layer 1 checks `GET /api/user/state-login` before SCRAM; Layer 2 catches cross-IP `108003` / `108009` occupied responses and enters an exponential quiet cooldown (`45s → 300s`) so `challenge_login` is never hammered while a human uses the WebUI.
- **🛑 Persistent `108006` / `108007` Anti-Brute-Force Circuit Breaker**
  - Three wrong password attempts lock the router's admin account. Our `CircuitBreaker` latches immediately upon `108006` / `108007` and persists the credential fingerprint inside `EncryptedStateStore`, preventing restart loops from locking out the router. A wrong-password latch (`108006` / `108002` / `108001`) clears only after `CPE_PASSWORD` is corrected in `.env`, followed by `POST /api/session/reset-breaker` or a restart; a reset with the password unchanged is refused (`400`). A `108007` hardware lockout can be cleared with reset-breaker once the lockout period has passed.
- **📈 Dual-Tier Fixed-Memory Circular Time-Series (`TimeSeriesRingBuffer`)**
  - Bounded `< 6 MB` footprint: `Tier 1` stores `3h` at `5s` resolution while `Tier 2` stores `7d` at `60s` roll-ups, joined seamlessly for `1h`, `6h`, `12h`, `24h`, and custom `[fromMs, toMs]` queries. Intermittent NSA 5G and unsupported temperature channels remain `null` (never skewed toward `0`), backed by `30m` batched async flushes to preserve Synology HDD hibernation.
- **✉️ SMS Scheduled Through the Same Session Broker (Change Detection at Zero Extra Sessions)**
  - SMS counters ride along in the 5s telemetry session, and only a counter change triggers an incremental or full sync. Send, mark-read and delete go through the scheduler's control queue and yield to a human admin like every other write. The SMS mirror, contact book and Telegram state are AES-256-GCM encrypted at rest and owned by a single process (`sms.json.lock`).
- **📲 Two-Way Telegram Bot, Signed Webhooks & Automatic Alerts**
  - Incoming SMS cards (one-tap OTP, reply-to-send, read / thread / delete-with-confirmation buttons), a guided send wizard, conversation and contact lookups, alert delivery and muting; webhooks are signed with `HMAC-SHA256`. The alert engine covers CPE offline, WAN down, signal degradation, carrier-aggregation loss, reboots, SMS storage and data thresholds, with sustain windows and recovery hysteresis.
- **🤖 Native Dual-Transport MCP Server (`stdio` + Streamable HTTP `/mcp`)**
  - Zero-dependency JSON-RPC 2.0 MCP server ([`FengSuiMcpServer`](src/mcp-server.ts)) exposing **13 core tools** and **up to 10 SMS tools** (tiered by `MCP_SMS_ACCESS`) to Claude Desktop, Antigravity, Cursor, and LAN agents. `reboot_cpe`, `reconnect_cellular`, `send_sms` and `delete_sms` require `{ confirm: true }`; SMS bodies are treated as untrusted data, and sends default to known recipients with an hourly budget to resist prompt injection.
- **🛡️ Defense-in-Depth Web Security**
  - Enforces DNS-rebinding `Host` allowlists (`421`), `SameSite=Strict; HttpOnly` session cookies, `X-Requested-With` + `Origin` CSRF validation, `net.BlockList` CIDR proxy trust + IPv6 `/64` rate-limit buckets, null-prototype parsers, linear O(N) XML scanning, and private-origin SSRF guards.

---

## 📡 H168-383 Hardware Capability Panorama (Live-Verified)

| Capability Domain | Verified Endpoints | Live-Measured Telemetry & Protocol Structure | Status |
| :--- | :--- | :--- | :---: |
| **3CA Carrier Aggregation** | `GET /api/device/signal`<br/>`GET /api/device/seccellinfo` | Live **`B1(20MHz) + B3(20MHz) + N78(100MHz)`** (**`140 MHz`** EN-DC 3CA); secondary carriers exposed via 8-column CSV (`EARFCN, Band, BW, PCI, RSRP, RSRQ, RSSI, SINR`) | ✅ Verified |
| **256QAM MCS & MIMO** | `GET /api/device/signal`<br/>`GET /api/device/ri` | Exposes 4G/5G UL & DL **`256QAM` / `64QAM`** codeword MCS indices, `TM[4]` spatial multiplexing, LTE `RI=2` / NR `nrrank` layers, and `CQI0/CQI1` | ✅ Verified |
| **PHY Transmit Power** | `GET /api/device/signal` | Separate 4G `<txpower>` and 5G `<nrtxpower>` reporting `PPusch`, `PPucch`, `PSrs`, and `PPrach` in dBm | ✅ Verified |
| **Tower & TAC Identity** | `GET /api/device/signal`<br/>`GET /api/net/cell-info` | Decimal `<cell_id>` / `<tac>` proven mathematically identical to hex `<cellinfo>` / `<lac>`; 28-bit ECI (`eNodeB = ECI >>> 8`) & 36-bit NCI bitwise decomposition | ✅ Verified |
| **4G / 5G Neighbor Scan** | `GET /api/device/nbrcellinfo` | Native `<nbrcell_ltelist>` & `<nbrcell_nrlist>` 7-column CSV (`EARFCN, Band, PCI, RSRP, RSRQ, RSSI, SINR`) directly mappable to cell-lock payloads | ✅ Verified |
| **Band & Cell Locking** | `GET/POST /api/net/net-mode`<br/>`POST /api/net/lock-freq` | Hardware exposes `select_band_switch=1` & `lock_freq_switch=3`; supports 4G `LTEBand` hex masks, 5G NR band lock (`lock_mode=3`), freq lock (`1`), and `PCI+ARFCN` cell lock (`2`) | ✅ Verified |
| **Today vs Monthly Traffic** | `GET /api/monitoring/month_statistics`<br/>`GET /api/monitoring/traffic-statistics` | Native **Today's cumulative bytes (`<CurrentDayUsed>`)**, **Monthly UL+DL bytes**, billing rollover `<StartDay>`, and live byte/bit rates (`CurrentDownloadRate * 8`) | ✅ Verified |
| **Terminal Topology & Leases** | `GET /api/system/HostInfo` (JSON)<br/>`GET /api/system/topology` (JSON) | Classifies **`LAN 1000M`** Gigabit Ethernet vs `2.4GHz` / `5GHz` Wi-Fi clients with PHY rate (Mbps), RSSI, dual-stack IPv4/IPv6, and remaining DHCP lease seconds | ✅ Verified |
| **Wi-Fi 7 (802.11be) MLO** | `GET/POST /api/wlan/wlandbho`<br/>`GET /api/wlan/multi-security-settings-ex` | Tri-radio `802.11be` (`b/g/n/ax/be` + `a/n/ac/ax/be`), **MLO (`MloEnable`)**, Dual-Band Handover (`DbhoEnable`), EasyMesh, and channel auto-optimization | ✅ Verified |
| **Antenna, Static DHCP & APN** | `/api/device/antenna_set_type`<br/>`/api/dhcp/static-addr-info`<br/>`/api/dialup/profiles` | Auto/Internal/External antenna mode & physical insertion telemetry, static MAC-IP reservations, `IPv4/IPv6` (`iptype=2`) dual-stack APN profiles, and scheduled reboot | ✅ Verified |

---

## 🏗️ Repository Architecture

```text
cpe-dash/
├── AGENTS.md                        # Mandatory architecture, session safety & 7 security/TDD invariants
├── .env.example                     # Pure native .env template (default WEB_PORT=18384)
├── locales/                         # Zero-dep strongly-typed bilingual catalogs (zh-CN.json / en.json)
├── public/                          # Offline static placeholder (Phase 3 prioritizes dist/web/public)
├── docs/
│   ├── PHASE1_PROTOCOL_SPEC.md      # Complete H168-383 API dictionary, reversed formulas & Phase 1 spec
│   ├── PHASE2_ARCHITECTURE_REPORT.md # Backend & i18n architectural evaluation & security hardening report
│   └── PHASE2_BACKEND_CONTRACT.md   # Phase 2 -> Phase 3 REST / SSE / MCP TypeScript handoff contract
├── src/
│   ├── types.ts                     # Strict TypeScript domain interfaces & discriminated unions
│   ├── config.ts                    # Zero-dep .env parser, SSRF validator, CIDR proxy trust & /64 buckets
│   ├── i18n.ts                      # Zero-dep compile-time key-safe i18n engine (zh-CN / en)
│   ├── crypto.ts                    # Unclamped big-endian Curve25519, Huawei SCRAM-SHA256, AES-256-GCM
│   ├── xml.ts                       # Linear O(N) ReDoS-safe & prototype-pollution-safe XML codec
│   ├── sanitize.ts                  # Automated RFC redaction engine for IMEI/IMSI/MAC/IP/TAC/CellID
│   ├── encrypted-file.ts            # StorageCipher (scrypt + HKDF-SHA256 + AES-256-GCM 0600)
│   ├── band-lock.ts                 # 4G/5G BandMask bitwise codec, ECI/NCI splitter & lock XML builders
│   ├── parsers.ts                   # Pure parsers for 3CA RF, MCS, TxPower, neighbors, traffic & topology
│   ├── cpe-client.ts                # Ephemeral session client, reentrancy guard, avoidance & 108006 breaker
│   ├── cpe-domain.ts                # Aggregated telemetry, neighbor scan, locking, security & Wi-Fi 7 MLO
│   ├── timeseries.ts                # Dual-tier circular ring buffer (5s fine ring + 60s 7-day rollup ring)
│   ├── state-store.ts               # Async atomic encrypted state persistence with key-rotation recovery
│   ├── scheduler.ts                 # Single-instance mutex scheduler, single-flight coalescer & backoff
│   ├── alert-engine.ts              # Sustain-window + hysteresis alerts (offline / WAN / signal / CA / reboot / SMS storage / data)
│   ├── sms/                         # SMS protocol, number parsing, encrypted mirror, contacts, SmsService, REST routes & MCP tools
│   ├── notify/                      # Telegram Bot API client & two-way bot, signed webhooks, notification hub
│   ├── sse-bus.ts                   # /api/events sub-ms SSE fan-out bus, backpressure eviction & heartbeat
│   ├── mcp-server.ts                # Native JSON-RPC 2.0 MCP Server (stdio NDJSON + Streamable HTTP)
│   ├── http-server.ts               # Hardened HTTP/REST/SSE/MCP & static asset server (:18384)
│   ├── cli.ts                       # Unified daemon (serve) & MCP (mcp) CLI entrypoint
│   └── index.ts                     # Public SDK exports
├── scripts/
│   ├── audit-secrets.ts             # Working-tree + full git-history Zero-Secret/Zero-PII & Pure-TS gate
│   └── probe-*.ts                   # 9 read-only live hardware & protocol verification probes (probe-sms prints aggregate counts only)
└── test/                            # Offline deterministic simulation test suite (> 96% coverage)
```

---

## 🚀 Quick Start (Daemon, MCP Server & Hardware Probes)

### 1. Setup

```bash
git clone https://github.com/cky008/cpe-dash.git
cd cpe-dash
npm install

cp .env.example .env
chmod 600 .env
# Edit .env and set CPE_PASSWORD and a strong API_TOKEN (never commit .env)
```

### 2. Start the FengSui Web / REST / SSE / HTTP-MCP Daemon

```bash
# Development watch mode (Node.js >= 22.6 native TypeScript execution)
npm run dev

# Production build & start (listens on http://0.0.0.0:18384 by default)
npm run build
npm start
```

### 3. Connect AI Agents (MCP Server)

- **Local `stdio` Transport** (Claude Desktop / Antigravity / Cursor):
  ```bash
  npm run mcp
  # Or pass explicit .env path: node --experimental-strip-types src/cli.ts mcp --env /path/to/.env
  # (the flag is optional on Node 22.18+ / 23.6+; every npm script already passes it)
  ```
  A stdio process runs its own scheduler. If the `serve` daemon already runs on the same data directory, the stdio process offers no SMS tools (the daemon owns the SMS store); point the agent at the daemon's HTTP `/mcp` instead.
- **LAN / Tailscale Streamable HTTP Transport**:
  ```bash
  curl -X POST http://127.0.0.1:18384/mcp \
    -H "Authorization: Bearer $API_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
  ```

### 4. Run Non-Destructive Hardware Probes

```bash
npm run probe:rf          # Query 3CA chain, 256QAM MCS, MIMO rank, TxPower & hex/dec tower proof
npm run probe:neighbors   # Scan 4G/5G candidate neighbor cells (EARFCN, Band, PCI, RSRP, RSRQ, RSSI, SINR)
npm run probe:traffic     # Query live UL/DL bps rates, Today's bytes & Monthly UL+DL bytes
npm run probe:topology    # Classify LAN 1000M / 2.4G / 5G terminals, PHY speeds & dual-stack leases
npm run probe:session     # Benchmark ~26ms session release & verify dual-layer browser avoidance
npm run probe:sms         # Read-only: SMS counters, listing path & full-fetch cost (counts only; never sends, marks or deletes)
```

---

## ✉️ SMS, Telegram Bot & Alerts

### How it works
- **Sync**: the daemon runs one full sync at startup (messages already on the CPE count as history and are not announced). After that, `sms-count` counters piggybacked on the 5s telemetry session drive incremental syncs, with a 30-minute safety-net full reconcile. The mirror tracks the CPE exactly: deleting removes a message from both the router and the mirror.
- **Sending**: Web, MCP and Telegram share one path behind `POST /api/sms/send`. Recipients and length are validated before any session (GSM-7 / UCS-2, at most 4 segments and 5 recipients); inside the session the message is submitted, its status polled and the sent copy read back.
- **Humans first**: while someone is logged in at `http://192.168.8.1`, SMS writes return `409`, syncs pause and only the unauthenticated unread probe runs; a catch-up sync follows once they log out.

### Setting up the Telegram bot
1. Create a bot with `@BotFather` and put its token in `TELEGRAM_BOT_TOKEN`;
2. Either list your chat ID in `TELEGRAM_CHAT_IDS`, or send `/auth <API_TOKEN>` to the bot once it runs (the token message is deleted automatically; rotating `API_TOKEN` unlinks such chats);
3. Restart with `npm start`; the log line shows `telegram=on`.

| Command / interaction | What it does |
| :--- | :--- |
| Incoming SMS card | Sender, flag and contact name, one-tap OTP; **reply to the card to text back**; buttons: read / open thread / delete (with confirmation) |
| `/new` | Guided send: pick a country → enter a number or contact name → type the text (encoding and segments shown) → confirm |
| `/send <number> <text>` | Quick send (still asks for a confirmation tap) |
| `/inbox`, `/unread`, `/chat <number>` | Conversations, unread and thread detail (served from the local mirror, no router session) |
| `/contacts [query]`, `/contact <number> <name>`, send a `.vcf` file | Search, add and bulk-import contacts |
| `/status`, `/alerts`, `/sync` | Device and SMS status, recent alerts, sync now |
| `/mute 30m\|2h\|1d\|off` | Pause or resume alert delivery |

### Webhooks
With `WEBHOOK_URL` set, new SMS (`sms.received`) and alerts (`alert`) are POSTed as JSON. With `WEBHOOK_SECRET` set, receivers can verify the signature:

```ts
import crypto from "node:crypto";
const expected = "sha256=" + crypto.createHmac("sha256", secret).update(`${req.headers["x-fengsui-timestamp"]}.${rawBody}`).digest("hex");
// compare expected with req.headers["x-fengsui-signature"] in constant time and reject stale timestamps
```

### Alerts
`CPE_UNREACHABLE`, `WAN_DOWN`, `SIGNAL_DEGRADED` (RSRP < `ALERT_RSRP_THRESHOLD_DBM` or SINR < `ALERT_SINR_THRESHOLD_DB` for 5 minutes), `CA_DROPPED`, `REBOOT_DETECTED`, `SMS_STORAGE_HIGH` / `SMS_STORAGE_FULL`, `DATA_THRESHOLD` and circuit-breaker alerts are all recorded in `GET /api/alerts` and the SSE `alert` event. Alerts at or above `ALERT_NOTIFY_MIN_SEVERITY` are also pushed to Telegram / webhooks.

> **Encryption key**: an empty `DATA_ENCRYPTION_KEY` falls back to `CPE_PASSWORD`, and the contact book cannot be re-synced from the router. Set a dedicated key. To change the key or the router password, edit `.env` and call `POST /api/session/reset-breaker` first (it rewrites every encrypted file under the new key right away), then restart.

---

## 🔌 REST API, Real-Time SSE & MCP Tools Overview

| Channel | Core Endpoints / Tool Names | Purpose |
| :--- | :--- | :--- |
| **Auth & i18n** | `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/i18n/:locale` | `SameSite=Strict; HttpOnly` session lifecycle & offline `zh-CN`/`en` dictionaries |
| **Cached Reads** | `GET /api/telemetry`, `GET /api/timeseries`, `GET /api/neighbors`, `GET /api/topology`, `GET /api/settings` | `< 1ms` side-effect-free reads from memory & `1h/6h/12h/24h/custom` ring buffer |
| **On-Demand Polls** | `POST /api/telemetry/refresh`, `POST /api/neighbors/scan`, `POST /api/topology/refresh`, `POST /api/settings/refresh` | Single-flight coalesced `~150ms` polite ephemeral CPE polls |
| **RF & Router Control** | `POST /api/control/band-lock`, `cell-lock`, `unlock`, `reboot`, `reconnect`, `security`, `wifi7`, `antenna`, `mobile-data` | Dynamic 4G/5G band & `PCI+ARFCN` cell locks, security/MLO/antenna/mobile-data switches & reboot (`409` on human yield) |
| **Session & Breaker** | `GET /api/session/status`, `POST /api/session/reset-breaker` | Scheduler, avoidance and breaker status; reload `.env` and reset the circuit breaker |
| **SMS & Contacts** | `GET /api/sms/status`, `threads`, `thread`, `contacts`, `countries`; `POST /api/sms/preview`, `send`, `read`, `delete`, `sync`, `contacts/upsert`, `contacts/delete`, `contacts/import-vcf` | Reads come straight from the encrypted mirror (zero CPE sessions); writes use the control queue (`409` while a human is logged in) |
| **Alerts & Notifications** | `GET /api/alerts` | Last 100 alerts plus Telegram / webhook delivery stats |
| **Real-Time SSE** | `GET /api/events` | Pushes `hello` (with SMS status), `speed`, `telemetry`, `neighbors`, `topology`, `settings`, `session:avoidance`, `control:applied`, `alert`, `sms:new`, `sms:sent`, `sms:updated`, `sms:sync`, `sms:status`, `contacts:updated`, `: heartbeat` |
| **MCP Agent Tools** | `get_cpe_telemetry`, `query_telemetry_history`, `list_neighbor_cells`, `get_cpe_session_status`, `lock_band`, `lock_cell`, `unlock_rf_locks`, `reboot_cpe` (13 tools) | Enables AI agents to inspect 5G RF, compare neighbor towers, lock bands/cells, and reboot safely |
| **MCP SMS Tools** | `list_sms_threads`, `get_sms_thread`, `get_sms_status`, `search_contacts`, `preview_sms`, `sync_sms`; `full` access adds `send_sms`, `mark_sms_read`, `delete_sms`, `upsert_contact` | Read-only by default; sending needs `confirm: true`, one recipient, known numbers by default and an hourly budget |

See **[`docs/PHASE2_BACKEND_CONTRACT.md`](docs/PHASE2_BACKEND_CONTRACT.md)** for complete TypeScript request/response schemas.

---

## ⚙️ `.env` Configuration Reference

| Variable | Default | Description |
| :--- | :--- | :--- |
| `CPE_URL` | `http://192.168.8.1` | CPE LAN origin URL (strictly validated against private/LAN ranges to prevent SSRF) |
| `CPE_USERNAME` | `admin` | H168-383 administrator username |
| `CPE_PASSWORD` | *(Required)* | CPE admin password (`108006` latches persistent CircuitBreaker immediately) |
| `DATA_ENCRYPTION_KEY` | *(Falls back to `CPE_PASSWORD`)* | Master secret for `data/*.json` encryption at rest — state, SMS mirror, contacts, Telegram state (`scrypt` + `HKDF-SHA256`); set a dedicated key |
| `API_TOKEN` | *(Falls back to `CPE_PASSWORD`)* | Web login & REST / `/mcp` Bearer secret (use an independent high-entropy token) |
| `TRUSTED_PROXIES` | `127.0.0.1,::1` | Trusted reverse-proxy peer IPs/CIDRs (`net.BlockList` verified before reading `X-Forwarded-For`) |
| `ALLOWED_HOSTS` | *(empty)* | Extra HTTP `Host` values to accept (e.g. a reverse-proxy domain) on top of the DNS-rebinding guard (`421`); private/loopback/link-local IPs, `localhost`, `*.local` / `*.lan` / `*.internal` / `*.ts.net` and single-label hostnames are always accepted |
| `WEB_PORT` | `18384` | Default Web console, SSE & `/mcp` listening port |
| `DEFAULT_LOCALE` | `zh-CN` | Default UI & message locale (`zh-CN` or `en`) |
| `MCP_HTTP_ENABLED` | `true` | Enable `POST /mcp` Streamable HTTP MCP endpoint |
| `MCP_ALLOW_MUTATIONS` | `true` | Allow mutating MCP tools (`false` restricts MCP to read-only tools) |
| `HISTORY_RETENTION_HOURS` | `168` | Circular time-series retention window in hours (`168` = 7 days) |
| `POLL_INTERVAL_MS` | `5000` | Standard RF & throughput polling interval (ms) |
| `NEIGHBOR_SCAN_INTERVAL_MS` | `60000` | Low-frequency 4G/5G neighbor cell scan interval (ms) |
| `RESPECT_BROWSER_SESSION` | `true` | Automatically yield whenever a human admin session is active on the router (keep `true`). With `false` the daemon skips yielding and still tries to log in: a cross-IP `108003` makes reads fail and writes return `502` instead of `409` |
| `SMS_ENABLED` | `true` | Enable SMS sync, REST, SSE and MCP SMS tools |
| `DEFAULT_COUNTRY_CODE` | `+353` | Country code for national-format numbers |
| `SMS_FILE` / `CONTACTS_FILE` | *(next to `STATE_FILE`)* | Encrypted SMS mirror `sms.json` and contact book `contacts.json` |
| `SMS_FULL_SYNC_INTERVAL_MS` | `1800000` | Safety-net full reconcile interval (minimum `60000`) |
| `SMS_SEED_EXISTING_ON_START` | `true` | Treat messages present at the first sync as history (not announced) |
| `SMS_AUTO_MARK_READ` | `false` | Mark announced messages as read on the CPE |
| `SMS_SEND_STATUS_TIMEOUT_MS` | `45000` | Upper bound for send-status polling (`5000..120000`) |
| `TELEGRAM_BOT_TOKEN` | *(empty)* | Telegram bot token (bot disabled when empty) |
| `TELEGRAM_CHAT_IDS` | *(empty)* | Pre-authorized chat IDs, comma-separated (or link a chat with `/auth <API_TOKEN>`) |
| `TELEGRAM_API_BASE` / `TELEGRAM_STATE_FILE` | `https://api.telegram.org` / *(`telegram.json` next to `STATE_FILE`)* | Self-hosted Bot API server and encrypted bot state |
| `WEBHOOK_URL` / `WEBHOOK_SECRET` | *(empty)* | JSON push target for new SMS and alerts, and its HMAC signing secret |
| `ALERTS_ENABLED` | `true` | Run the alert engine |
| `ALERT_NOTIFY_MIN_SEVERITY` | `warning` | Lowest severity pushed to Telegram / webhooks (`info` / `warning` / `critical`) |
| `ALERT_RSRP_THRESHOLD_DBM` / `ALERT_SINR_THRESHOLD_DB` | `-110` / `0` | Signal degradation thresholds |
| `MCP_SMS_ACCESS` | `read` | MCP SMS tool access: `none` / `read` / `full` |
| `MCP_SMS_SEND_POLICY` | `known` | `known` restricts MCP sends to contacts or numbers texted before; `any` lifts the restriction |
| `MCP_SMS_SEND_LIMIT_PER_HOUR` | `10` | MCP send budget per hour (`0` disables MCP sending) |

---

## 🛡️ Security Invariants & TDD Quality Gates

```bash
npm run check
# Runs in sequence:
# 1. npm run typecheck      -> tsc -p tsconfig.test.json (100% Strict TS, zero implicit any)
# 2. npm run test:coverage  -> c8 >= 90% threshold (currently > 96% Statements / Lines / Functions)
# 3. npm run audit:secrets  -> Scans working tree & full git log -p --all for secrets, PII & .js files
```

---

## 📚 Authoritative Documentation Index

- [`AGENTS.md`](AGENTS.md) — Engineering constitution, 7 security invariants & mandatory TDD rules
- [`docs/PHASE1_PROTOCOL_SPEC.md`](docs/PHASE1_PROTOCOL_SPEC.md) — Huawei H168-383 protocol dictionary (SMS APIs and the encrypted channel in §3.8), reversed formulas & live measurements
- [`docs/PHASE2_ARCHITECTURE_REPORT.md`](docs/PHASE2_ARCHITECTURE_REPORT.md) — Synology DS923+ zero-dependency backend, i18n architecture and the SMS fusion architecture (§5)
- [`docs/PHASE2_BACKEND_CONTRACT.md`](docs/PHASE2_BACKEND_CONTRACT.md) — Phase 2 → Phase 3 REST API, SSE stream, MCP tools (incl. SMS) and the `cpe-sms` view mapping table

---

## ⚠️ Disclaimer & License

- This project is an independent, unofficial management platform and is not affiliated with or endorsed by Huawei Technologies Co., Ltd. Band and cell locking modify cellular modem radio behavior — use responsibly in accordance with your carrier's network policies.
- Licensed under the **[PolyForm Noncommercial License 1.0.0](LICENSE)** for personal and non-commercial research use only.
