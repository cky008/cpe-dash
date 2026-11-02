# Changelog

All notable changes to 烽燧 FengSui (`cpe-dash`). Versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed
- **New logo: 月白 · 回声** (a high arc and its lower echo). It replaces the beacon seal in the header, on the sign-in page and as the favicon. In the console both arcs take the theme's colours: the main arc is the primary hue muted toward the ink, the echo leans toward the page, so every theme and custom accent gets a matching two-tone mark. The favicon follows the system's light or dark setting.
- `docker-compose.yml` no longer sets `pids_limit`: Synology DSM kernels have no pids cgroup, so Docker dropped it with a warning ("Your kernel does not support PIDs limit capabilities…") on every start. The line stays as a comment for other Linux hosts; `mem_limit` still applies. A deployment that added `pids_limit` to its own compose file by hand can delete it.

### Added
- **The daemon identifies the router it talks to** (groundwork for other Huawei models; it only records and changes nothing: the H168-383's login, polling and writes stay exactly as they were). Once after the daemon starts and whenever the console tests or saves a connection, one read session sends ten fixed GETs (`docs/PHASE1_PROTOCOL_SPEC.md` appendix A.7), giving each at most 5 s so a router that leaves an unknown endpoint hanging cannot hold the admin slot long, and records the model, firmware and WebUI version, the login (`password_type`, SCRAM, ECC, token source), the LTE bands from `net-mode-list` and, per endpoint, supported / unsupported (`100002`) / restricted (`100003`, which is not unsupported) / unknown. It never runs in the 5 s poll, yields to a person on the router's page and never logs in past an open breaker. `GET /api/device/profile` serves it to any signed-in caller with the verification status: verified, a new build of a verified model (still only a warning, ADR-007), or an unverified model. The client also counts the router's error codes per endpoint.
- **Settings → Device** in the console shows the identified model, firmware, WebUI version, login, encryption, verification state, features and the endpoint probe, and creates the device report (download JSON or copy) with a reminder that it holds no identifier and that sharing it is your choice. The static demo shows the demo router the same way.
- **A desensitized device report** (`GET /api/console/device-report`, console session only; tokens get `403 CONSOLE_ONLY`), for owners of other models to attach to a compatibility issue if they choose. It holds structure, not values: for each probed endpoint its state, error code, tag paths and value shapes (`int`, `hex(18)`, `text(12)`…), plus the router error codes counted since start. Values appear only for an allowlist (model, firmware and WebUI version, `password_type`, small switch numbers, LTE band numbers), and a second pass through `src/sanitize.ts` replaces anything that still looks like a MAC, an IP address, an IMEI / IMSI / ICCID or a phone number. Nothing is uploaded.
- **Notes on other Huawei models** (`docs/PHASE1_PROTOCOL_SPEC.md`, appendix A), the groundwork for supporting more than the H168-383: identification and capability endpoints, the token and login flows, error codes and the models the reference project lists, each with its source and marked unverified. Login-free reads on the H168-383 showed that `device/basic_information` (model only) and `user/state-login` answer before login, while the firmware and WebUI versions need a session. The facts come from [Salamek/huawei-lte-api](https://github.com/Salamek/huawei-lte-api), now thanked in both READMEs; FengSui contains none of its code and does not depend on it.
- **The logo has a single source**, `web/brand/logo.svg`. The build turns it into the console's icon and ships it as the favicon; tests keep all three in step. `npm run brand:trace -- concept.png` turns a flat logo concept (a light / dark side-by-side is fine) into that file, tracing the outlines to within 0.6 px. `docs/BRAND.md` describes the contract and how to change the logo next time.

## [1.5.0] — 2026-11-02

### Added
- **Settings in the web console** (the gear in the header): Router, Password, Tokens, Telegram, Security and Audit. After an upgrade the guide tests the imported router settings at once and only asks you to confirm them, then points at the password still taken from `.env`. The sign-in page gains a setup-code mode and "Forgot password?", and the agent guide can create a read-only token (90 days) straight into its snippets.
- **The console manages the router connection, its own password and the API tokens** (encrypted `data/settings.json`); `.env` keeps only startup parameters. A fresh install needs just `DATA_ENCRYPTION_KEY`: the daemon logs a one-time setup code, the sign-in page uses it to set the console password, and a guide asks for the router's address, user and password, tries them with one login and saves them only if they work. Nothing logs in to the router before that.
- **A router connection is tested before it is saved.** One queued session with a throwaway client, never retried, yielding to a person on the router's web page; the answer names the cause (wrong password with the attempts left, locked, someone logged in, unreachable, not a private address, router error). Saving switches the live client over and clears the breaker. With one attempt left, another try needs `lastAttempt: true` (a checkbox in the console), so typos cannot lock the router.
- **Tokens with scopes, lifetimes and revocation.** Full-access or read-only, valid 1 / 7 / 30 / 90 / 365 days or forever, shown once (`fsk_…`, only a SHA-256 is kept), last use recorded; revoking one closes its SSE streams. No token can reach `/api/console/*` (`403 CONSOLE_ONLY`).
- **Password change and recovery.** Changing the console password needs the current one and signs the other sessions out. A forgotten password is reset with a 15-minute one-time code from `cpe-dash reset-login` (run on the daemon's host; the request comes from loopback and is signed with the data key) or from `/reset` in a linked private Telegram chat, which can be turned off in the console.
- **Telegram pairing codes**: `/auth` takes a one-time code (10 minutes) created in the console, or a full-access token; all `/auth` chats can be unlinked from the console.
- **Audit log** (`GET /api/audit`, encrypted `audit.json`, last 500): every write that reached the router queue, console sign-ins and settings changes, with who (console, a named token, MCP, Telegram, self-healing), the outcome and a masked summary; Bearer readers get the addresses in it masked under `REDACT_SENSITIVE_IN_API`. The caller travels with `AsyncLocalStorage` from the adapter to the scheduler.
- **`GET /metrics`** for Prometheus / Grafana (off by default; `METRICS_ENABLED` or the console's switch): scheduler, breaker, sessions, signal, carriers, throughput, traffic and SMS gauges from the cached snapshots, any token, no identifiers.
- The README gallery shows the settings dialog (a router test and the token list); every screenshot was retaken for this version.

### Changed
- `reset-breaker` no longer rotates tokens or unlinks Telegram chats when `API_TOKEN` changes in `.env`, and takes the router password from the console; `doctor`, `backup`, `restore` and `rekey` cover `settings.json` and `audit.json`.
- After a wrong router password the breaker banner opens Settings → Router, whose tested save clears the breaker; the docs and messages no longer send you to `.env` for it. `.env.example` leaves `CPE_PASSWORD` empty, so a copied placeholder can never cost a login attempt.
- On phones the language switch lives in Appearance, making room for the settings button in the header.

### Upgrading
- The first start imports `CPE_URL` / `CPE_USERNAME` / `CPE_PASSWORD` and `API_TOKEN` / `API_TOKEN_READONLY` once: sign in with your old `API_TOKEN`, confirm the prefilled router settings in the guide and change the console password. The old tokens keep working as `API_TOKEN (.env)` / `API_TOKEN_READONLY (.env)` until you revoke them. Later edits of those `.env` keys have no effect.
- Keep `DATA_ENCRYPTION_KEY` (or `CPE_PASSWORD`, if that was your data key) in `.env`: it now also encrypts the console settings. The read-only probes still read the router password from `.env`.

## [1.4.2] — 2026-11-02

### Added
- **`npm run screenshots` regenerates the README images.** It starts the offline demo (mock router, placeholder data), backfills two hours of chart history, and drives a local headless Chrome over the DevTools protocol (no npm dependency) through each view: dashboards in several themes, SMS, the controls drawer, the cell lock, appearance and access dialogs, the phone layout and the avoidance and breaker banners. Run before a release so the pictures ship in the signed release commit; all fourteen were retaken for this version.
- **`cpe-dash doctor`, `backup`, `restore` and `rekey`.** `doctor` checks the configuration, the data directory's permissions, the daemon (its health when it runs, the port when it does not) and whether every store opens with the current key, with a hint for each problem; it never contacts the router. `backup` copies the encrypted stores with a SHA-256 manifest while the daemon runs. `restore` (daemon stopped) checks the manifest and the current key before writing and keeps the files it replaces. `rekey` (daemon stopped) re-encrypts the stores under a new `DATA_ENCRYPTION_KEY` and brings back data moved aside as `*.unreadable-*` after a key mismatch; the old key comes from `FENGSUI_OLD_DATA_KEY` or stdin, never the command line.
- **GitHub releases with notes.** A tag now also publishes a GitHub release titled with the tag's subject line, whose notes are that version's section of this changelog (`scripts/release-notes.ts`), plus the image tag; earlier releases were backfilled the same way.

### Security
- **Release images are attested and built from a pinned base.** `node:26-alpine` is pinned by digest in both Dockerfile stages, so a tag repointed upstream cannot change what is built (Dependabot proposes digest updates), and every image pushed to GHCR carries signed build provenance (`mode=max`) and an SBOM listing its packages.

### Changed
- **A shorter footer**: the brand, GitHub, sponsor and AI agent links, and a plain © line linking to the author's site; the slogan is gone.
- **`docker-compose.yml` bounds the container**: `mem_limit: 1g` and `pids_limit: 256`, far above normal use, so a runaway process cannot starve the NAS. An existing deployment that keeps its own compose file needs the two lines added by hand.
- **The logo follows the theme.** The brand seal in the header and the small markers before card titles were cinnabar in every theme; they now use the theme's primary colour, or the accent you picked, with the matching content colour for the mark.
- **Recoveries and carrier drops reach Telegram and webhooks.** Only alerts at or above `ALERT_NOTIFY_MIN_SEVERITY` (default `warning`) were pushed, and every recovery is `info`, so a pushed `WAN_DOWN` was never followed by its `WAN_UP`, and `CA_DROPPED` stayed in the console. A recovery is now routed with its problem's severity (`WAN_UP`, `SIGNAL_RECOVERED`, `LOCK_REALIGNED` as warnings; `CPE_RECOVERED`, `DUPLICATE_DAEMON_CLEARED` as critical) and `CA_DROPPED` as a warning. The alert history keeps their own severity.

### Fixed
- **Data written by a newer FengSui is never overwritten.** Each encrypted store (state, SMS mirror, contacts, Telegram links) ignored a format number it did not know, started empty and overwrote the file on the next save, so running an older version after a future format change would silently lose that data. Such a file now stops startup with a message that names it; the file is left as it was.

### Documentation
- **The docs are checked against the code.** `test/contract-manifest.test.ts` reads what the daemon exposes from the code itself (every MCP tool with all providers enabled, every raised alert code, SSE event, REST route and setting) and fails when the contract, `.env.example` or either README misses one. It found five settings no doc mentioned (`STATE_FLUSH_INTERVAL_MS`, `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX_AUTH_FAILURES`, `SESSION_TTL_MS`, `STATIC_DIR`), now documented.
- **`POST /api/session/reset-breaker` states its order.** It applies the reloaded `.env` (redaction, time zone, data key, token rotation) before it looks at the breaker, so the `400` it returns while a wrong-password latch still has the old password comes after those changes took effect; the contract now says so, and that calling it with an unchanged `.env` has no other effect.

### Upgrading
- No `.env` change and no data migration. Telegram now also receives recoveries (`WAN_UP`, `CPE_RECOVERED`, …) and `CA_DROPPED`.
- A deployment with its own `docker-compose.yml` (for example one switched to `network_mode: host`) keeps it on upgrade: add `mem_limit: 1g` and `pids_limit: 256` under the service by hand.
- New maintenance commands: `sudo docker exec cpe-dash node dist/cli.js doctor` (or `backup`); `restore` and `rekey` run with the daemon stopped, see the README.

## [1.4.1] — 2026-11-02

### Security
- **Router-reported text can no longer write into the firmware review prompt.** The model and the firmware and WebUI versions in `FIRMWARE_UNVERIFIED` and in the prompt Telegram offers for Claude Code came verbatim from the router's HTTP replies, so a device on the LAN that tampers with them could add instructions to a prompt you hand to an agent with access to your repository. They are now reduced to a version's alphabet (letters, digits, `.`, `_`, `-`, parentheses; anything else becomes `?`, no spaces or newlines, at most 40 characters), and the prompt says they are data.

## [1.4.0] — 2026-11-02

### Added
- **A guide to connect an AI agent, in the console.** The robot icon in the header ("AI agents" at the bottom of the dashboard on phones) shows the MCP endpoint for the address in use and builds, from a token you paste (`API_TOKEN_READONLY` recommended), a prompt to hand to Claude Code, Codex or another coding agent (it sets the server up, checks it, and keeps router writes behind your explicit request), the `claude mcp add` command and the `mcpServers` JSON. The token stays in the page, masked on screen; the shell command quotes it so no character in it can run as shell syntax. Over plain HTTP the copy buttons fall back to a selection copy.
- **Sponsor links**: a heart in the console header and footer opens GitHub Sponsors, and the repository has a `FUNDING.yml` (GitHub Sponsors, Buy Me a Coffee), as in cpe-sms.
- **A warning when the router runs a firmware build FengSui was not verified on.** Huawei updates the H168-383 on its own, and the private API that locks, access control and SMS rely on may change with it. When the router reports a model or firmware build (service pack included) outside `VERIFIED_FIRMWARE` (`H168-383 4.4.0.1(H1006SP19C00)`), a `FIRMWARE_UNVERIFIED` warning is raised once per build and remembered across restarts; writes are not blocked. On Telegram it is followed by a ready-made prompt to hand to Claude Code in the repository: it names the build, keeps the agent read-only on the real router (no writes, no `.env`, no login retries, probes run by you one at a time) and ends with adding the build to the list once it checks out.
- **Optional WAN self-healing, off by default** (both write to the router without anyone asking). `LOCK_ROLLBACK_AFTER_MIN` clears every band and cell lock once when the WAN is still down that many minutes after a lock (it must come back and stay up for 2 minutes to keep the lock), so a lock to a band without coverage no longer leaves the house offline until someone on the LAN undoes it. `WAN_AUTO_RECONNECT_AFTER_MIN` redials a WAN down that long, then after 10, 30 and 60 minutes, at most 4 times in 24 hours, and never reboots. Both act on fresh telemetry only, queue like any control (yielding to a human on the WebUI, no login while the breaker is open), re-read the WAN state and the mobile-data switch in the same session before writing, and raise `LOCK_ROLLED_BACK` / `LOCK_ROLLBACK_FAILED` / `WAN_AUTO_RECONNECT` / `WAN_RECONNECT_EXHAUSTED`.
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
- **Telegram notifications raised while the WAN is down are no longer lost.** The NAS reaches Telegram through the router's own cellular link, so `WAN_DOWN`, the alerts raised during an outage and SMS that arrived meanwhile all failed to send and were only logged. Notifications that fail on a network error (or a `429` / `5xx`) are now kept in memory (up to 50, for 24 hours) and delivered in their original order as soon as Telegram answers again; new ones queue behind them, and a delayed SMS card still routes replies to its sender. Errors Telegram means for good (a blocked bot) are not retried.
- **The Telegram poller honours `429 retry_after`.** It retried after its own 1.5 s backoff, which only prolongs Telegram's rate limit; it now waits at least as long as Telegram asks (capped at an hour) and stays interruptible by shutdown.
- **Data that cannot be decrypted at startup is reported.** A store whose file no longer decrypts (typically `CPE_PASSWORD` changed while `DATA_ENCRYPTION_KEY` was unset) moved the file aside and started empty without a word, so contacts or Telegram links seemed to vanish. The daemon now logs each such file with the way back and raises a critical `DATA_QUARANTINED` alert.
- **Long Telegram replies are delivered.** Replies over Telegram's length limit were cut at a fixed character count, which could land inside a tag or an entity; Telegram then rejected the whole message, so `/chat` on a thread of long messages answered nothing. Cuts now stop before a tag or entity and close the tags left open.
- **A band lock that names one RAT keeps the other RAT's lock in the record.** The router keeps what a command does not write (the LTE mask goes through net-mode, NR bands and cell locks through lock-freq), but the recorded lock state reset the omitted RAT: locking NR after an LTE lock reported LTE unlocked and raised a false `LOCK_DRIFT` alert, locking LTE after an NR lock forgot the NR lock, and an LTE-only band lock hid a cell lock that was still in force. The omitted part is now carried over.
- **Every write in the controls drawer asks first.** UPnP, DMZ, the firewall switches, MLO / DBHO and the antenna buttons wrote on a single tap, although the drawer promised confirmation. Each now shows what the change does first, in amber when it weakens protection or can drop the connection (firewall or a filter off, UPnP or DMZ on, the firewall MAC list on, the external antenna with nothing plugged in). Enabling DMZ with an empty address is refused like an invalid one.
- **Access-control pickers respect privacy masking**: a device without a name is shown by its masked MAC, not the full one. List separators and the overnight marker now come from the dictionaries, so English no longer shows Chinese punctuation.
- **A stop during startup is clean.** The SIGTERM / SIGINT handlers were installed only after startup finished, and a stop that did arrive (for example `docker stop` right after `docker start`) let startup carry on: polling began and the HTTP port was bound after shutdown. Handlers are now installed first, and startup checks for a stop after each wait, so nothing starts after it.
- **Importing a large vCard no longer freezes the daemon.** The contact index was rebuilt after every card, so a 5000-card export took seconds of blocked event loop (SSE, REST and an open router session all stalled; about 5 s on a desktop CPU, longer on a NAS). Cards are now indexed as they are added, with one rebuild at the end: the same import takes tens of milliseconds.
- **An old Telegram confirmation card can no longer send a newer draft.** Every "Send now" button carried the same callback data, so tapping it on an earlier card sent whatever draft was current. Each card's button is now bound to its own draft; a stale one answers that the flow expired.
- **MCP `manage_internet_time_rule` can update and delete rules again.** Its `id` was capped at 16 characters, but the H168-383 names rules by TR-069 path (`InternetGatewayDevice.X_FireWall.TimeRule.1.`), so every update or delete through MCP failed with `VALIDATION_ERROR`. The limit is now 128.

### Upgrading
- Upgrade every host that runs a FengSui daemon at the same time: the duplicate-daemon beacon moved to v2, and v1 and v2 daemons do not see each other.
- Group chats linked earlier with `/auth` stay linked. To unlink them, rotate `API_TOKEN` (every `/auth` link is revoked); keep a group on purpose by listing its ID in `TELEGRAM_CHAT_IDS`.
- If startup now prints the `API_TOKEN` notice, set a dedicated random `API_TOKEN` and update your MCP clients and Telegram link with it.
- Lock rollback and WAN redial stay off until `LOCK_ROLLBACK_AFTER_MIN` / `WAN_AUTO_RECONNECT_AFTER_MIN` are set. `.env` is bind-mounted as a single file, so recreate the container after editing it (`docker compose up -d --force-recreate`); a plain restart keeps the old file.
- A router on another firmware build than `4.4.0.1(H1006SP19C00)` raises `FIRMWARE_UNVERIFIED` once after the upgrade. `data/` needs no migration: the state file only gains the firmware notice.
- For AI agents, set `API_TOKEN_READONLY` and hand that token out (the console's agent guide uses it); keep `API_TOKEN` for yourself.

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
