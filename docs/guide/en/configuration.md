---
title: Configuration reference
description: Meanings and defaults for every setting in .env. Most users only need to set the encryption key and time zone.
section: Manage
order: 14
---

FengSui reads `.env` (`/app/.env` inside the container) and environment variables at startup. For a complete template, see [`.env.example`](../../../.env.example) in the repository.

Most users only need to set three items: `DATA_ENCRYPTION_KEY`, `TZ`, and `PUID` / `PGID` when using Docker. Router connections, console passwords, and tokens are managed directly in the web console and stored encrypted in `data/settings.json`.

After editing `.env`, apply it with `docker compose up -d --force-recreate` (why: [Docker Compose file](docker-compose.md#apply)). That page also explains each entry of `docker-compose.yml` itself.

## Basics

| Setting | Default | Description |
| :--- | :--- | :--- |
| `DATA_ENCRYPTION_KEY` | None (required) | Master key that encrypts all files in `data/`. Generate one with `openssl rand -hex 32` and back it up separately; if you lose it, your data cannot be recovered. To change it, use `rekey` (see [Backup and restore](backup.md)) |
| `TZ` | `UTC` | Time zone, such as `Asia/Shanghai`. Sent SMS messages are timestamped using this time zone, so match the router's physical location |
| `DEFAULT_LOCALE` | `zh-CN` | Default language for the interface and notifications (`zh-CN` or `en`) |
| `PUID` / `PGID` | `1000` / `1000` | For Docker Compose only: user under which the container runs. Set to the owner of `data/` and `.env` |

## Router

These settings are imported only on the **first startup**. After that, values in the console under "Settings → Router" take precedence, so you can leave them blank here.

| Setting | Default | Description |
| :--- | :--- | :--- |
| `CPE_URL` | `http://192.168.8.1` | Router management URL. Only accepts local network addresses |
| `CPE_USERNAME` | `admin` | Administrator username |
| `CPE_PASSWORD` | Empty | Administrator password. If it begins or ends with a space or contains ` #`, put it in single quotes (`CPE_PASSWORD='…'`): without quotes, spaces at either end are removed and everything after ` #` is read as a comment. A password entered in the console is kept exactly as typed |
| `CPE_REQUIRE_ECC_SIGNATURE` | `true` | Once the router has signed the encryption key it hands over at login, FengSui requires that signature from then on: a login whose key is unsigned (the answer may have been altered on the way) is ended and logged out, and the key is not used. Routers that never signed are not affected. Set to `false` if a firmware update really made the router stop signing |
| `CPE_ALLOW_LEGACY_LOGIN_AFTER_SCRAM` | `false` | Set to `true` temporarily when switching to a router that only supports legacy login. Switch back to `false` after testing and saving the new router. The recommended approach is to redeploy with a new, empty `data/` directory |
| `RESPECT_BROWSER_SESSION` | `true` | Automatically step aside when someone logs in to the router's own web page. Strongly recommended to keep enabled |
| `REQUEST_TIMEOUT_MS` | `15000` | Timeout for a single request to the router (in milliseconds) |
| `POLL_INTERVAL_MS` | `5000` | Interval for reading signal and data rate metrics |
| `NEIGHBOR_SCAN_INTERVAL_MS` | `60000` | Interval for scanning neighbor cells |

## Web, login, and tokens

| Setting | Default | Description |
| :--- | :--- | :--- |
| `WEB_ENABLED` | `true` | Whether to start the web console, API, and MCP. When set to `false`, FengSui only polls metrics, syncs SMS, and sends notifications |
| `WEB_HOST` / `WEB_PORT` | `0.0.0.0` / `18384` | Listen address and port. Under Docker, `WEB_PORT` determines the host port |
| `ALLOWED_HOSTS` | Empty | Additional permitted hostnames, such as `cpe.example.com`. Local network IPs, `localhost`, `*.local`, `*.lan`, `*.internal`, and `*.ts.net` are always allowed |
| `TRUSTED_PROXIES` | `127.0.0.1,::1` | Reverse proxy IP addresses or subnets. FengSui trusts `X-Forwarded-For` and `X-Forwarded-Proto` only for requests from these addresses (see [Security and privacy](security.md#access-behind-a-reverse-proxy)) |
| `SESSION_TTL_MS` | `86400000` | Console login session duration (24 hours) |
| `RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX_AUTH_FAILURES` | `60000` / `8` | Login failure rate limiting: maximum of 8 failed attempts per minute |
| `API_TOKEN` | Empty | Imported on the first startup only: becomes the console login password and a full-control token. Managed in the console afterward, so you can leave it blank |
| `API_TOKEN_READONLY` | Empty | Imported on the first startup only as a read-only token. Generate new tokens under "Settings → Tokens" |
| `STATIC_DIR` | Build output | Directory for console static files. Typically left unchanged |
| `SSE_HEARTBEAT_MS` / `SSE_MAX_CLIENTS` | `15000` / `32` | Heartbeat interval and maximum client connections for the real-time event stream |
| `METRICS_ENABLED` | `false` | Enables `GET /metrics` (Prometheus format, requires any token). The toggle under "Settings → Security" in the console takes precedence |

## AI agents (MCP)

| Setting | Default | Description |
| :--- | :--- | :--- |
| `MCP_HTTP_ENABLED` | `true` | Whether to expose `POST /mcp` |
| `MCP_ALLOW_MUTATIONS` | `false` | Whether to allow agents to call tools that modify the router. Read-only by default |
| `MCP_ALLOW_ACCESS_CONTROL` | `false` | Whether to allow agents to block internet access, modify Wi-Fi blocklists/allowlists, and change access schedules (also requires `MCP_ALLOW_MUTATIONS=true`) |
| `MCP_SMS_ACCESS` | `read` | Agent SMS permissions: `none`, `read`, or `full` |
| `MCP_SMS_SEND_POLICY` | `known` | `known`: only allows sending to saved contacts or numbers you have messaged before; `any`: no restrictions |
| `MCP_SMS_SEND_LIMIT_PER_HOUR` | `10` | Maximum messages an agent can send per hour (`0` disables sending) |
| `MCP_DAEMON_URL` | Derived automatically | `/mcp` URL forwarded by the stdio bridge; only accepts local network addresses |
| `REDACT_SENSITIVE_IN_API` | `true` | Redacts sensitive data (IMEI, IMSI, phone numbers, MAC addresses, WAN addresses, cell identifiers) in token-authenticated API, real-time events, and MCP endpoints. The web console is unaffected |

## SMS

| Setting | Default | Description |
| :--- | :--- | :--- |
| `SMS_ENABLED` | `true` | Whether to enable SMS |
| `DEFAULT_COUNTRY_CODE` | Empty (derived from SIM card) | Country calling code to prepend to local numbers without a leading `+`, such as `+86`. When left blank, FengSui infers the country from the router's SIM card. If it cannot infer the country, you must enter the full number or select a country |
| `SMS_AUTO_MARK_READ` | `false` | Automatically mark new SMS messages as read on the router after pushing them |
| `SMS_SEED_EXISTING_ON_START` | `true` | On initial sync, treat existing messages on the router as history and do not push them |
| `SMS_FULL_SYNC_INTERVAL_MS` | `1800000` | Interval for full synchronization checks (30 minutes) |
| `SMS_SEND_STATUS_TIMEOUT_MS` | `45000` | Maximum time to wait for the router to report the send result after sending |
| `SMS_FILE` / `CONTACTS_FILE` | Under `data/` | Encrypted SMS mirror and contact list files |

## Notifications and alerts

| Setting | Default | Description |
| :--- | :--- | :--- |
| `TELEGRAM_BOT_TOKEN` | Empty | Telegram bot token (created with `@BotFather`) |
| `TELEGRAM_CHAT_IDS` | Empty | Pre-authorized chat IDs (comma-separated). You typically pair chats using pairing codes, so you can leave this blank |
| `TELEGRAM_API_BASE` | `https://api.telegram.org` | Custom Bot API address if self-hosting |
| `TELEGRAM_STATE_FILE` | `data/telegram.json` | Encrypted Telegram state file |
| `WEBHOOK_URL` / `WEBHOOK_SECRET` | Empty | Endpoint URL for pushing new SMS messages and alerts, and signature secret |
| `ALERTS_ENABLED` | `true` | Whether to enable alerts |
| `ALERT_NOTIFY_MIN_SEVERITY` | `warning` | Minimum severity level to push: `info`, `warning`, or `critical` |
| `ALERT_RSRP_THRESHOLD_DBM` / `ALERT_SINR_THRESHOLD_DB` | `-110` / `0` | Thresholds for degraded signal alerts |

## Self-healing (disabled by default)

| Setting | Default | Description |
| :--- | :--- | :--- |
| `LOCK_ROLLBACK_AFTER_MIN` | `0` (disabled) | Number of minutes WAN remains disconnected after locking before automatically releasing all locks (`3` to `1440`) |
| `WAN_AUTO_RECONNECT_AFTER_MIN` | `0` (disabled) | Number of minutes WAN remains disconnected before automatically reconnecting (`1` to `1440`). Maximum of 4 times in 24 hours; never reboots the router |

See [Band and cell locking](locking.md#rollback).

## Data and storage

| Setting | Default | Description |
| :--- | :--- | :--- |
| `STATE_FILE` | `./data/state.json` | Encrypted runtime state (cache, history series, alerts). Inside the container, this is `/app/data/state.json` |
| `HISTORY_RETENTION_HOURS` | `168` | How long history series are retained (7 days) |
| `STATE_FLUSH_INTERVAL_MS` | `1800000` | How often state is flushed to disk (30 minutes; always flushed on shutdown). If your NAS has disk hibernation enabled and no other writes occur, you can increase this to several hours to avoid waking disks repeatedly |

## Multi-instance and development

| Setting | Default | Description |
| :--- | :--- | :--- |
| `PEER_DISCOVERY_ENABLED` / `PEER_DISCOVERY_PORT` | `false` / `18385` | Discovers other FengSui instances across multiple machines to prevent two instances from managing the same router at once. Requires host networking. The beacon key is derived from the router password saved in Settings → Router, allowing devices on the local network to guess weak passwords offline, so it is disabled by default |
| `CPE_HAR_PATH` | Empty | Used only by read-only probe scripts for development; do not commit to repository |
