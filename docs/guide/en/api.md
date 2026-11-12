---
title: API reference
description: Call FengSui from scripts, dashboards and home automation with a token: how to authenticate, the endpoints and what they return, live events and Prometheus metrics.
section: Manage
order: 16
---

FengSui's web console runs on this REST API. Scripts, dashboards and home automation can call the same endpoints with a token: read the signal and its history, refresh now, lock bands, send and read SMS, or follow live events.

For AI agents, use [MCP](agents.md) instead: it adds switches, confirmations and tighter limits on top of this API.

## Get a token

Create a token in the console under Settings → Tokens & AI. It is shown once, so copy it right away. You can give it a lifetime (1 to 365 days, or none) and revoke it at any time (see [Security and privacy](security.md)).

Every token can read the router's data and have FengSui refresh it now. Anything else needs a permission, ticked when you create the token or later with "Permissions" on an existing one under Settings → Tokens & AI:

| Permission | Allows |
| :--- | :--- |
| None ticked | Read the signal, history, nearby cells, connected devices, router settings, alerts and the audit log; refresh them now |
| Read SMS and codes | Read threads, contacts and Recently deleted, sync and preview messages; SMS events in the live stream |
| Change the router | Band and cell locks, unlocking, UPnP / DMZ / firewall, Wi-Fi 7, the antenna, mobile data, redial, restart, resetting the breaker |
| Manage devices' internet access | Block or unblock a device's Wi-Fi, the Wi-Fi MAC filter, internet schedules |
| Send and delete SMS, edit contacts | Send, mark read, delete and restore messages; edit and import contacts |

> [!NOTE]
> The console's switches such as "Let agents change the router" apply to MCP only. The REST API goes by the token's permissions.

No token can change the console's settings (the sign-in password, tokens, the router connection, the switches) or delete messages in Recently deleted for good; only a signed-in console can (`403 CONSOLE_ONLY`). The endpoints the console uses for itself (`/api/auth/*`, `/api/setup/*`, `/api/console/*`) are closed to tokens and not listed below.

## Make a request

Put the token in the `Authorization` header:

```bash
# Read
curl -H "Authorization: Bearer <token>" http://<NAS IP>:18384/api/telemetry

# Change something: POST with a JSON body
curl -X POST \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"mode":"auto"}' \
  http://<NAS IP>:18384/api/control/antenna
```

- **Every `POST` needs `Content-Type: application/json`**; send `{}` when there are no parameters. A body may be up to 64 KiB (4 MiB for a contacts import).
- **Reading never signs in to the router.** A `GET` answers from FengSui's latest data in memory, so you can call it often. By default FengSui reads the signal every 5 seconds (`POLL_INTERVAL_MS`) and scans nearby cells and connected devices every 60 seconds (`NEIGHBOR_SCAN_INTERVAL_MS`); see [Configuration](configuration.md).
- **Refreshing and changing sign in to the router.** The router allows one admin session at a time, so FengSui queues every request and runs them one by one. Do not call the refresh endpoints in a tight loop.
- **FengSui steps aside while someone is signed in to the router's own page**: a refresh or change then answers `409 BROWSER_SESSION_YIELDED` and does nothing.
- **When you use a host name** (behind a reverse proxy, say), add it to `ALLOWED_HOSTS`, or requests answer `421 MISDIRECTED_HOST` (see [Security and privacy](security.md#reverse-proxy)).
- **Token requests need no `X-Requested-With`.** Only a browser calling with the console's sign-in cookie needs it, as the cross-site request forgery (CSRF) check.
- **Identifiers are masked by default.** With a token, the IMEI keeps its first 6 digits, the IMSI its operator code, numbers, MACs and WAN addresses only a part, and cell identities and device names are hidden (`REDACT_SENSITIVE_IN_API=true`). The signed-in console sees the real values.

<a id="errors"></a>

## Answers and errors

A success answers `200` with `ok: true` and the data in fields next to it. A band lock, for example, answers (shortened):

```json
{ "ok": true, "lockState": { "mode": "band_lock", "lteBands": [1, 3], "nrBands": [] } }
```

A failure answers with its HTTP status and `ok: false`:

```json
{ "ok": false, "errorCode": "VALIDATION_ERROR", "message": "…" }
```

Have scripts go by `errorCode`, never by `message`: the message may be in Chinese or English, and its wording changes. The error codes a script can meet:

<!-- api-errors:begin -->
| Status | `errorCode` | Meaning |
| :--- | :--- | :--- |
| 400 / 413 / 415 | `BAD_PAYLOAD` | The body is not a JSON object, is too large, or lacks `Content-Type: application/json` |
| 400 | `VALIDATION_ERROR` | A parameter is wrong: a band the router does not support, a missing `confirm: true` |
| 401 | `UNAUTHORIZED` | No token, or a wrong, expired or revoked one |
| 403 | `READ_ONLY_TOKEN` | This token may change nothing |
| 403 | `TOKEN_NOT_PERMITTED` | The token lacks the permission; `permission` names it |
| 403 | `CONSOLE_ONLY` | Only a signed-in console may do this |
| 404 | `NOT_FOUND` | No such endpoint (also `/metrics` while it is off) |
| 404 | `SMS_DISABLED` | SMS is turned off (`SMS_ENABLED=false`) |
| 405 | `METHOD_NOT_ALLOWED` | Wrong method, such as `GET` where `POST` is needed |
| 409 | `BROWSER_SESSION_YIELDED` | Someone is signed in to the router's own page; FengSui stepped aside and did nothing |
| 409 | `PEER_DAEMON_ACTIVE` | FengSui on another machine manages this router; this one stands by |
| 409 | `CPE_NOT_CONFIGURED` | No router connection yet: finish the setup in the console |
| 409 | `DEVICE_UNVERIFIED_READ_ONLY` | FengSui does not implement this write on this router; nothing was sent |
| 409 | `DEVICE_WRITE_DISABLED` | This write is turned off under Settings → Device; nothing was sent |
| 409 | `DEVICE_NOT_IDENTIFIED` | The router's model is not known yet; nothing was written |
| 421 | `MISDIRECTED_HOST` | The host name you used is not allowed; add it to `ALLOWED_HOSTS` |
| 423 | `CIRCUIT_BREAKER_OPEN` | The router password is wrong or its account is locked, so FengSui stopped signing in; fix it under Settings → Router |
| 429 | `RATE_LIMITED` | Too many failed sign-ins; try again after `retryAfterSec` seconds |
| 429 | `SSE_LIMIT_REACHED` | Too many live event connections |
| 500 | `INTERNAL_ERROR` | Something went wrong inside FengSui |
| 502 | `CPE_UPSTREAM_ERROR` | The router did not answer, or answered with an error |
| 502 | `SMS_SEND_FAILED` | The router took the message but reports that sending failed |
| 503 | `QUEUE_FULL` | Too many requests queued, or FengSui is stopping |
<!-- api-errors:end -->

<a id="endpoints"></a>

## Endpoints

The Permission column names what a token needs beyond reading. The request and answer fields of each endpoint are in the developer notes' [API contract](../../dev/api.md) (in Chinese).

<!-- api-routes:begin -->
### Reading

| Method | Path | Permission | What it does |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/telemetry` | Any token | The latest signal, carriers, rates, traffic and WAN state, with the lock state and recent alerts |
| `GET` | `/api/timeseries` | Any token | History: rates, RSRP and SINR. `?preset=1h` (or `6h`, `12h`, `24h`), or `?preset=custom&fromMs=…&toMs=…` |
| `GET` | `/api/neighbors` | Any token | Nearby cells, from the last scan |
| `GET` | `/api/topology` | Any token | Connected devices |
| `GET` | `/api/settings` | Any token | Router settings: UPnP, DMZ, firewall, Wi-Fi 7, antenna, mobile data |
| `GET` | `/api/access-control` | Any token | The Wi-Fi MAC filter and internet schedules |
| `GET` | `/api/session/status` | Any token | How FengSui stands with the router: yielding, breaker, what self-healing is doing |
| `GET` | `/api/device/profile` | Any token | The identified model, firmware and capabilities, and its row of Supported devices (no identifiers) |
| `GET` | `/api/alerts` | Any token | The last 100 alerts, and delivery counts per notification channel |
| `GET` | `/api/audit` | Any token | The audit log: who changed what, and when (`?limit=`, up to 500) |

### Refreshing

| Method | Path | Permission | What it does |
| :--- | :--- | :--- | :--- |
| `POST` | `/api/telemetry/refresh` | Any token | Read the signal now |
| `POST` | `/api/neighbors/scan` | Any token | Scan for nearby cells now |
| `POST` | `/api/topology/refresh` | Any token | Read the connected devices now |
| `POST` | `/api/settings/refresh` | Any token | Read the router settings now |
| `POST` | `/api/access-control/refresh` | Any token | Read the MAC filter and schedules now |

### Router controls

| Method | Path | Permission | What it does | Example body |
| :--- | :--- | :--- | :--- | :--- |
| `POST` | `/api/control/band-lock` | Change the router | Lock bands (`lteBands`, `nrBands`, `"all"` for every band; the type you leave out stays as it is) | `{"lteBands":["B1","B3"]}` |
| `POST` | `/api/control/cell-lock` | Change the router | Lock a cell; without `pci`, lock the channel only | `{"rat":"NR","band":"N78","arfcn":650000,"pci":211}` |
| `POST` | `/api/control/unlock` | Change the router | Clear band and cell locks |  |
| `POST` | `/api/control/reboot` | Change the router | Restart the router | `{"confirm":true}` |
| `POST` | `/api/control/reconnect` | Change the router | Redial the mobile connection (no restart) | `{"confirm":true}` |
| `POST` | `/api/control/security` | Change the router | UPnP, DMZ and firewall (`upnpEnabled`, `dmz`, `firewall`; send only what changes) | `{"upnpEnabled":false}` |
| `POST` | `/api/control/wifi7` | Change the router | Wi-Fi 7 multi-link (`mloEnable`) and dual-band steering (`dbhoEnable`) | `{"mloEnable":true}` |
| `POST` | `/api/control/antenna` | Change the router | Antenna: `auto`, `internal`, `external` | `{"mode":"auto"}` |
| `POST` | `/api/control/mobile-data` | Change the router | Turn mobile data on or off | `{"enabled":true}` |
| `POST` | `/api/session/reset-breaker` | Change the router | Reset a breaker the router's account lock (108007) tripped, and reload `.env`; for a wrong password, correct it under Settings → Router |  |

### Devices' internet access

| Method | Path | Permission | What it does | Example body |
| :--- | :--- | :--- | :--- | :--- |
| `POST` | `/api/control/wifi-access` | Manage devices' internet access | Block or unblock one device's Wi-Fi (`block`, `unblock`) | `{"action":"unblock","macAddress":"02:00:5E:10:00:01","confirm":true}` |
| `POST` | `/api/control/wifi-mac-filter` | Manage devices' internet access | The Wi-Fi MAC filter: `off`, `deny`, `allow`, or add and remove entries | `{"mode":"off","confirm":true}` |
| `POST` | `/api/control/time-rule` | Manage devices' internet access | Internet schedules: create, update, delete | `{"action":"delete","id":"1","confirm":true}` |

### SMS

| Method | Path | Permission | What it does | Example body |
| :--- | :--- | :--- | :--- | :--- |
| `GET` | `/api/sms/status` | Read SMS and codes | Message counts and sync state |  |
| `GET` | `/api/sms/countries` | Read SMS and codes | Country and region calling codes |  |
| `GET` | `/api/sms/threads` | Read SMS and codes | Threads (`?filter=all`, `unread`, `otp`, and `&search=`) |  |
| `GET` | `/api/sms/thread` | Read SMS and codes | Every message of a thread (`?key=` a number or thread key) |  |
| `GET` | `/api/sms/contacts` | Read SMS and codes | Contacts (`?search=`) |  |
| `GET` | `/api/sms/trash` | Read SMS and codes | Messages in Recently deleted |  |
| `POST` | `/api/sms/preview` | Read SMS and codes | Preview a message: segments and encoding; nothing is sent | `{"phone":"+353830000001","content":"Hello"}` |
| `POST` | `/api/sms/sync` | Read SMS and codes | Sync messages now (`full` or `incremental`) | `{"mode":"incremental"}` |
| `POST` | `/api/sms/send` | Send and delete SMS, edit contacts | Send a message (`phone`, or up to 5 `phones`); sent once, never retried | `{"phone":"+353830000001","content":"Hello"}` |
| `POST` | `/api/sms/read` | Send and delete SMS, edit contacts | Mark read (`uids` or `threadKey`) | `{"threadKey":"+353830000001"}` |
| `POST` | `/api/sms/delete` | Send and delete SMS, edit contacts | Delete messages into Recently deleted | `{"uids":["<uid>"]}` |
| `POST` | `/api/sms/trash/restore` | Send and delete SMS, edit contacts | Put messages back from Recently deleted | `{"uids":["<uid>"]}` |
| `POST` | `/api/sms/trash/purge` | Console only | Delete messages in Recently deleted for good |  |
| `POST` | `/api/sms/contacts/upsert` | Send and delete SMS, edit contacts | Add or edit a contact | `{"phone":"+353830000001","name":"Example"}` |
| `POST` | `/api/sms/contacts/delete` | Send and delete SMS, edit contacts | Delete a contact | `{"id":"<id>"}` |
| `POST` | `/api/sms/contacts/import-vcf` | Send and delete SMS, edit contacts | Import vCards (the text of a `.vcf` file) | `{"vcf":"BEGIN:VCARD…"}` |

### Other

| Method | Path | Permission | What it does |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/health` | No token | Liveness check: version and uptime |
| `GET` | `/api/events` | Any token | The live event stream (see [Live events](#events)) |
| `GET` | `/metrics` | Any token | Prometheus metrics (when turned on, see [Prometheus metrics](#metrics)) |
<!-- api-routes:end -->

The endpoints that change the router follow the console's rules: on a router that was not verified, a write FengSui does not implement answers `409 DEVICE_UNVERIFIED_READ_ONLY`, and one you turned off under Settings → Device answers `409 DEVICE_WRITE_DISABLED`; neither sends the router anything (see [Other models and brands](other-routers.md#writes)).

<a id="events"></a>

## Live events

`GET /api/events` is a [Server-Sent Events](https://html.spec.whatwg.org/multipage/server-sent-events.html) stream. It opens with a `hello` (the current state) and then sends whatever changes:

```bash
curl -N -H "Authorization: Bearer <token>" http://<NAS IP>:18384/api/events
```

Each message has an `event:` (the name) and a `data:` line of JSON. Every 15 seconds a heartbeat line starting with `:` keeps the connection open (`SSE_HEARTBEAT_MS`); clients ignore it. After a reconnect you get a new `hello`; FengSui does not replay what was sent while you were away.

<!-- api-events:begin -->
| Event | When it is sent |
| :--- | :--- |
| `hello` | First, on connecting: the current state, signal, locks and SMS counts |
| `speed` | Each signal read (every 5 seconds by default): download and upload rates |
| `telemetry` | Right after `speed`: the full signal and state, as `telemetry` in `GET /api/telemetry` |
| `neighbors` | A scan for nearby cells finished (every 60 seconds by default) |
| `topology` | The connected devices were read (every 60 seconds by default) |
| `settings` | The router settings were read or changed (never on a timer) |
| `access-control` | The MAC filter and schedules were read or changed |
| `session:avoidance` | Someone signed in to or out of the router's own page, so FengSui starts or stops stepping aside |
| `control:applied` | A write finished (from anywhere: the console, a token, an agent, self-healing) |
| `alert` | A new alert |
| `sms:new` | A new message arrived (one event each) (needs "Read SMS and codes") |
| `sms:sent` | A message was sent (from anywhere) (needs "Read SMS and codes") |
| `sms:updated` | Messages were marked read, deleted, restored or deleted for good (needs "Read SMS and codes") |
| `sms:sync` | An SMS sync finished (needs "Read SMS and codes") |
| `sms:status` | The SMS counts or sync state changed (needs "Read SMS and codes") |
| `contacts:updated` | The contacts changed (needs "Read SMS and codes") |
<!-- api-events:end -->

- Connections are limited: `SSE_MAX_CLIENTS` in all (32 by default) and 6 per address; past that, `429 SSE_LIMIT_REACHED`.
- When a token is revoked or expires, the streams it opened close at once.

<a id="metrics"></a>

## Prometheus metrics

Turn them on in the console under Settings → Security (or set `METRICS_ENABLED=true` in `.env`), and `GET /metrics` answers in the [Prometheus](https://prometheus.io/docs/instrumenting/exposition_formats/) text format: the signal (RSRP, RSRQ, SINR), carriers and bandwidth, rates, traffic, the WAN state, SMS counts, what the router reports of itself (battery charge and charging, whether the SIM card waits for its PIN, airplane mode, roaming, its CPU and memory, each kind of temperature sensor), sessions and the queue, and FengSui's own memory, CPU and event-loop delay. The metrics carry no device identifiers. While they are off, `/metrics` answers `404`.

Any token can read the metrics; no permission is needed. A Prometheus scrape configuration:

```yaml
scrape_configs:
  - job_name: fengsui
    metrics_path: /metrics
    authorization:
      credentials: <token>
    static_configs:
      - targets: ["<NAS IP>:18384"]
```

## Liveness check

`GET /api/health` needs no token and answers with the version and uptime, for uptime monitors. The Docker image's own health check uses it too.
