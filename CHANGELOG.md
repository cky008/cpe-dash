# Changelog

All notable changes to 烽燧 FengSui (`cpe-dash`). Versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- **Read-only Bearer token `API_TOKEN_READONLY`** (optional, off by default). It reads every REST route and SSE and may trigger read sessions (refresh, scan, SMS preview and sync); on `/mcp` it sees and may call only read-only tools. Any write (controls, SMS send / read / delete, contacts, `reset-breaker`) answers `403 READ_ONLY_TOKEN`. Give it to dashboards, scripts and AI agents that should never change the router; it must differ from `API_TOKEN` and `CPE_PASSWORD`. The stdio bridge uses whatever `API_TOKEN` its own `.env` holds, so a read-only agent gets the read-only value there.

### Security
- **`npm run audit:secrets` closes two gaps.** Tracked Wireshark `.pcapng` (and compressed `.pcap.*`) captures, Fiddler `.saz` sessions and `.vcf` contact exports now fail the gate like `.har` and `.pcap`, and explicit `any` is caught as a type argument (`Record<string, any>`), in tuples, return types and unions, not only after a colon. The rules are exported and covered by `test/audit-gate.test.ts`.
- **CI and release workflows pin every GitHub Action to a full commit SHA** (the version stays in a comment for Dependabot), so a moved tag in an action's repository cannot change what runs in the job that pushes images. Releases now run one at a time. `test/ci-config.test.ts` keeps both in place.
- **Startup warns when `API_TOKEN` falls back to the router password.** Unset, the router's admin password is also the web login, the Bearer token in every REST and MCP client config and the secret sent to Telegram with `/auth`. Startup now says so next to the existing `DATA_ENCRYPTION_KEY` notice.
- **Telegram `/auth` works only in a private chat with the bot.** Sent in a group, it linked the whole group, so every member could read SMS and one-time codes, send and delete messages and see alerts, and the token message could stay visible where the bot may not delete messages. Groups are refused with a warning to delete the token; a group can still be pre-authorized with `TELEGRAM_CHAT_IDS`.
- **The duplicate-daemon beacon no longer hands the LAN a fast oracle for the router password.** Every 15 s each daemon broadcast a beacon signed with a key that was one HKDF of `CPE_PASSWORD`, so any device on the LAN could test password guesses offline at billions per second, out of reach of the router's 3-attempt lockout. The key is now derived with memory-hard scrypt (beacon v2). A weak router password is still guessable, only far slower: use a strong one, or set `PEER_DISCOVERY_ENABLED=false` when only one daemon ever runs. Upgrade every host at once: v1 and v2 daemons do not see each other.
- **Access control fails closed.** If the router's host list could not be parsed, came back empty or did not mark the machine running FengSui (`IsLocalDevice`), every protected device silently dropped out of the check, so a block, whitelist, list edit or time rule could cut off the daemon's host. Such changes are now refused with `400` before anything is written; changes that only let devices back on (unblock, filter off, deleting a time rule) still work.
- **MCP agents can no longer widen the SMS recipient policy themselves.** With `MCP_SMS_ACCESS=full` and `MCP_SMS_SEND_POLICY=known`, a prompt-injected agent could file any number with `upsert_contact` and then `send_sms` to it. Contacts an agent creates are now stored as `source: "mcp"` and do not count as known for MCP sends until you save the number yourself (web console, Telegram or a vCard import); an agent renaming one of your contacts leaves it yours.

### Fixed
- **Data that cannot be decrypted at startup is reported.** A store whose file no longer decrypts (typically `CPE_PASSWORD` changed while `DATA_ENCRYPTION_KEY` was unset) moved the file aside and started empty without a word, so contacts or Telegram links seemed to vanish. The daemon now logs each such file with the way back and raises a critical `DATA_QUARANTINED` alert.
- **Long Telegram replies are delivered.** Replies over Telegram's length limit were cut at a fixed character count, which could land inside a tag or an entity; Telegram then rejected the whole message, so `/chat` on a thread of long messages answered nothing. Cuts now stop before a tag or entity and close the tags left open.
- **A band lock that names one RAT keeps the other RAT's lock in the record.** The router keeps what a command does not write (the LTE mask goes through net-mode, NR bands and cell locks through lock-freq), but the recorded lock state reset the omitted RAT: locking NR after an LTE lock reported LTE unlocked and raised a false `LOCK_DRIFT` alert, locking LTE after an NR lock forgot the NR lock, and an LTE-only band lock hid a cell lock that was still in force. The omitted part is now carried over.
- **Every write in the controls drawer asks first.** UPnP, DMZ, the firewall switches, MLO / DBHO and the antenna buttons wrote on a single tap, although the drawer promised confirmation. Each now shows what the change does first, in amber when it weakens protection or can drop the connection (firewall or a filter off, UPnP or DMZ on, the firewall MAC list on, the external antenna with nothing plugged in). Enabling DMZ with an empty address is refused like an invalid one.
- **Access-control pickers respect privacy masking**: a device without a name is shown by its masked MAC, not the full one. List separators and the overnight marker now come from the dictionaries, so English no longer shows Chinese punctuation.
- **A stop during startup is clean.** The SIGTERM / SIGINT handlers were installed only after startup finished, and a stop that did arrive (for example `docker stop` right after `docker start`) let startup carry on: polling began and the HTTP port was bound after shutdown. Handlers are now installed first, and startup checks for a stop after each wait, so nothing starts after it.
- **Importing a large vCard no longer freezes the daemon.** The contact index was rebuilt after every card, so a 5000-card export took seconds of blocked event loop (SSE, REST and an open router session all stalled; about 5 s on a desktop CPU, longer on a NAS). Cards are now indexed as they are added, with one rebuild at the end: the same import takes tens of milliseconds.
- **An old Telegram confirmation card can no longer send a newer draft.** Every "Send now" button carried the same callback data, so tapping it on an earlier card sent whatever draft was current. Each card's button is now bound to its own draft; a stale one answers that the flow expired.
- **MCP `manage_internet_time_rule` can update and delete rules again.** Its `id` was capped at 16 characters, but the H168-383 names rules by TR-069 path (`InternetGatewayDevice.X_FireWall.TimeRule.1.`), so every update or delete through MCP failed with `VALIDATION_ERROR`. The limit is now 128.

## [1.3.0] — 2026-11-01

### Added
- **14 themes, 7 light and 7 dark.** New: cpe-sms's own **Sujian** and **Sujian Night** (now the default day and night themes), the Chinese traditional colours **Moon White (月白)**, **Celadon (天青)** and **Indigo Ink (黛蓝)**, and the Japanese traditional colours **Sakura (桜)**, **Wakatake (若竹)**, **Sumi (墨)**, **Konruri (紺瑠璃)** and **Yozakura (夜桜)**. Paper, Dawn, Polar Night and Violet Abyss stay.
- **Separate day and night themes** while following the system; or one fixed theme.
- **Custom theme**: pick light or dark plus a background, text and primary colour; the rest is mixed from them, button text picks black or white for contrast, and low text contrast is flagged.
- **Accents**: Lake, Sakura and Asagi join the presets (Indigo is now called 群青 in Chinese), plus a custom accent colour.

### Changed
- Themes are plain CSS variables in two layers (a light / dark scheme layer and a palette layer) instead of daisyUI theme blocks; dark-only styling follows `data-scheme`, so new palettes need no other CSS. The appearance dialog's strings load with the dialog.
- Contrast fixes found by the new palette tests: Polar Night's secondary colour (the SMS unread badge) is darker so white text reads (2.9:1 → 4.5:1+), and the dark Cinnabar accent likewise.

## [1.2.0] — 2026-10-31

### Added
- **Live demo on GitHub Pages** (`https://cky008.github.io/fengsui-demo/`): the complete web console running in the browser against an in-page backend, with fictional placeholder data. Locks, reboots, Wi-Fi blocking, internet time windows, SMS and contacts all work inside the page and reset on reload; a day of history, live 5 s telemetry and an occasional incoming code keep it moving.
  - The starting data is recorded from the real daemon on the mock router at build time (`npm run build:demo`, `scripts/capture-demo-seed.ts`), and every timestamp is moved to the visitor's clock.
  - The in-page backend uses the daemon's own validation and planning code. `test/demo-backend.test.ts` runs both side by side: same response shapes on every read route, identical lock, Wi-Fi filter and time-rule states after each write, and word-for-word identical errors for 25 invalid requests.
  - `.github/workflows/demo-pages.yml` publishes the build to the public `cky008/fengsui-demo` repository on every release tag, with a deploy key scoped to that repository; the custom domain comes from an Actions variable, not the source tree.

### Changed
- Logic the demo shares with the daemon moved into dependency-free modules, re-exported from the old places: `src/control-error.ts`, `src/control-input.ts` (no `node:net`; now also parses `POST /api/control/security`), `src/units.ts`, `src/sms/otp.ts`, `src/sms/vcard.ts`, `src/sms/thread-view.ts`. No behaviour change.
- `scripts/demo-server.ts` now builds on `scripts/demo-router.ts`, shared with the seed capture and the contract test.

## [1.1.2] — 2026-10-31

### Fixed
- **Phone layout.** Card headers wrap instead of squeezing (the neighbor card no longer breaks its title, stacks the cell count vertically or overlaps its filter buttons); on phones the neighbor and topology tables keep only the columns needed to act, so "Lock to this cell" and "Block / Restore" stay on screen; the header bar no longer covers the seal on narrow phones. Fits without sideways scrolling at 360, 393 and 430 px.

## [1.1.1] — 2026-10-31

### Fixed
- **Creating an internet time rule no longer reports a false failure.** The H168-383 reads a rule back with a TR-069 path as its ID and repeats the device's MAC after `</DevicesMACs>`; the parser counted the device twice, so the create's read-back check answered `502 … did not apply` although the router had stored the rule. MACs are now read only inside `<DevicesMACs>`. Verified on the real router: create, update and delete, each read back and verified.

## [1.1.0] — 2026-10-31

### Added
- **Device access control**, built on the router's own Wi-Fi MAC filter and parental-control time rules (protocol verified against a WebInspector capture, a read-only session and a real-device block / restore of a 5 GHz phone):
  - Topology: one-click **Block / Restore** for Wi-Fi clients; blocked devices stay listed while offline.
  - Access control drawer: Wi-Fi MAC filter off / blacklist / whitelist, add and remove entries, the router's capacity (64), and a picker for the devices to keep when enabling the whitelist.
  - **Internet time** windows per device (weekdays, 15-minute steps, overnight windows, enable / pause), with overlap conflicts shown before saving; a device with windows can only go online inside them.
- Safety: the machine running FengSui (recognized from the router's `IsLocalDevice` mark) and the device sending the request can never be blocked, removed from a whitelist or given time windows; an enforced whitelist can never be empty. Enforced server-side, previewed in the browser with the same planner (`src/access-plan.ts`). Every write needs `confirm: true`, runs as one queued control session and is read back and verified.
- REST: `GET /api/access-control`, `POST /api/access-control/refresh`, `POST /api/control/wifi-access`, `/api/control/wifi-mac-filter`, `/api/control/time-rule`; SSE event `access-control`.
- MCP: `get_access_control` (read-only); `set_device_internet_access`, `set_wifi_mac_filter`, `manage_internet_time_rule` only with the new `MCP_ALLOW_ACCESS_CONTROL=true` (default `false`).

### Not possible on this router
- Per-device rate limiting (instant or scheduled): the firmware exposes no QoS / bandwidth-limit API.

## [1.0.1] — 2026-10-31

### Fixed
- **The reveal buttons now reveal.** `REDACT_SENSITIVE_IN_API` (on by default) masked snapshots when they were captured, so the web console never received the real IMEI, IMSI, own number, WAN addresses, MAC or cell fingerprints and its eye buttons changed nothing. The daemon now keeps the plain values (still encrypted at rest) and applies the switch per caller: the logged-in web console always receives the real values and masks them on screen until revealed; Bearer REST and SSE clients and MCP tools and resources receive redacted copies.
- **No more look-alike values.** Redaction no longer substitutes plausible placeholders (a private WAN address rewritten into `192.168.8.x`, DNS shown as `198.51.100.42`, LAN clients renamed `lan-client-NN` with documentation MACs and `fe80::1`). Every redacted value now reads as a mask: a kept prefix plus `*`, or `<REDACTED>`. LAN IPv4 addresses stay readable.

### Changed
- `POST /api/session/reset-breaker` applies a changed `REDACT_SENSITIVE_IN_API` to REST, SSE and MCP without a restart.
- Telemetry and topology a v1.0.0 daemon cached already masked are discarded on the first start after the upgrade; the next poll (seconds) replaces them.
- The web console's "Redacted by server" badge is gone, since the console no longer receives redacted data.

### Upgrading
- No `.env` change is needed. If you set `REDACT_SENSITIVE_IN_API=false` only to make the reveal buttons work, you can set it back to `true`: it now affects Bearer API and MCP clients only.

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

[1.3.0]: https://github.com/cky008/cpe-dash/releases/tag/v1.3.0
[1.2.0]: https://github.com/cky008/cpe-dash/releases/tag/v1.2.0
[1.1.2]: https://github.com/cky008/cpe-dash/releases/tag/v1.1.2
[1.1.1]: https://github.com/cky008/cpe-dash/releases/tag/v1.1.1
[1.1.0]: https://github.com/cky008/cpe-dash/releases/tag/v1.1.0
[1.0.1]: https://github.com/cky008/cpe-dash/releases/tag/v1.0.1
[1.0.0]: https://github.com/cky008/cpe-dash/releases/tag/v1.0.0
