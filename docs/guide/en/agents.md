---
title: AI agents (MCP)
description: Allow AI agents like Claude and Cursor to inspect signal metrics and SMS, control the router with your permission, and use the REST API and real-time events.
section: Use FengSui
order: 11
---

FengSui includes an embedded [MCP](https://modelcontextprotocol.io) server hosted at `/mcp`. AI agents can use it to inspect signal metrics, history, and SMS messages to help diagnose network problems.

By default, agents are **read-only**. To let one change anything, turn on the matching switch, give its token the matching permission, and have it pass a confirmation on every call; see [Turning on writes](#writes).

## Connect quickly

The bot icon in the console header (or "AI agents" at the bottom of the screen on mobile) opens the connection guide:

1. Go to "Settings → Tokens & AI" and generate a token (you can also generate one directly inside the guide: it can read the router's data and SMS, and change nothing).
2. Paste the token into the guide. It generates a ready-to-copy Claude Code command, a JSON configuration snippet, and a system prompt.
3. Copy them into your agent.

The token is used only inside this page and is never saved or uploaded.

## Configure manually

### Clients with remote MCP support

Clients such as Claude Code, Cursor, and VS Code can connect directly over HTTP:

```json
{
  "mcpServers": {
    "fengsui": {
      "type": "http",
      "url": "http://<NAS IP>:18384/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

For Claude Code, you can also run a single command:

```bash
claude mcp add --transport http fengsui http://<NAS IP>:18384/mcp --header "Authorization: Bearer <token>"
```

### Clients with local (stdio) support only

Clients like Claude Desktop can connect through the bridge inside the container, provided the client and the container run on the same machine. Replace `<token>` with a token you created (best one that can change nothing):

```json
{
  "mcpServers": {
    "fengsui": {
      "command": "docker",
      "args": ["exec", "-i", "-e", "API_TOKEN=<token>", "cpe-dash", "node", "dist/cli.js", "mcp"]
    }
  }
}
```

The bridge itself does not connect to the router. It forwards requests to the daemon, avoiding extra router login sessions.

## Tools

| Group | Tools |
| :--- | :--- |
| Read (always available) | `get_cpe_telemetry`, `query_telemetry_history`, `list_neighbor_cells`, `get_cpe_session_status`, `list_terminal_topology`, `get_router_settings`, `get_access_control`, `get_device_report` |
| Router control (requires "Let agents change the router") | `lock_band`†, `lock_cell`†, `unlock_rf_locks`†, `set_security_switches`†, `set_wifi_and_antenna`†, `reconnect_cellular`†, `reboot_cpe`† |
| Device access management (also requires "Let agents manage devices' internet access") | `set_device_internet_access`†, `set_wifi_mac_filter`†, `manage_internet_time_rule`† |
| SMS ("Agents' SMS access" set to Read, the default) | `list_sms_threads`, `get_sms_thread`, `get_sms_status`, `search_contacts`, `preview_sms`, `sync_sms` |
| SMS writes (SMS access set to Read and write, also requires "Let agents change the router") | `send_sms`†, `mark_sms_read`†, `delete_sms`†, `upsert_contact`† |
| Testing this router (requires "Let AI agents test this router" under Settings → Device; see [below](#testing)) | `probe_router_endpoints`, `set_experimental_write`† (on models FengSui was not verified on only) |

† Must be called with `{ "confirm": true }`; without it the call is refused before anything reaches the router. Every write tool works this way.

`get_device_report` returns the desensitized device report that compatibility reports share: model, firmware, which endpoints answered, the state of each write feature on this router, and the recent experimental write results.

<a id="writes"></a>

## Turning on writes

Agents can only read by default. For an agent to change anything, all three conditions below must hold; if one is missing, the call is refused and nothing reaches the router.

### The matching switch

Turn it on under Settings → Tokens & AI; it applies at once. You can also set it in `.env`: a switch you never changed in the console follows `.env`, one you changed there wins, and "Follow .env" hands it back.

| What the agent should be able to do | Turn on in the console | Or set in `.env` |
| :--- | :--- | :--- |
| Lock bands or cells, unlock, router switches, Wi-Fi and antenna, reconnect, reboot | "Let agents change the router" | `MCP_ALLOW_MUTATIONS=true` |
| Block or restore devices, Wi-Fi blocklist or allowlist, access schedules | The above, plus "Let agents manage devices' internet access" | The above, plus `MCP_ALLOW_ACCESS_CONTROL=true` |
| Send SMS, mark SMS as read, delete SMS, edit contacts | The first, plus "Agents' SMS access" set to Read and write | The first, plus `MCP_SMS_ACCESS=full` |

If you edit `.env`, apply it with `docker compose up -d --force-recreate` (why: [Docker Compose file](docker-compose.md#apply)).

### The matching token permission

Every token can read the router's data. What else it may do, you tick when you create it under Settings → Tokens & AI, or later with "Permissions" on an existing one: "Read SMS and codes", "Change the router", "Manage devices' internet access", "Send and delete SMS, edit contacts".

A token sees only the tools it may use. Calling another one by name is refused: `TOKEN_NOT_PERMITTED` (naming the missing permission), or `READ_ONLY_TOKEN` when the token may change nothing at all. For an agent that only reads, use a token with no permission ticked.

### `{ "confirm": true }` on every call

A write call without it is refused (`CONFIRMATION_REQUIRED`). The prompt in the connection guide tells the agent to pass it only after you asked for that exact action.

On models FengSui was not verified on, each write must also be turned on under Settings → Device first; see [Other models and brands](other-routers.md).

<a id="testing"></a>

## Letting agents test this router

Turn on "Let AI agents test this router" under Settings → Device (or set `MCP_ALLOW_EXPERIMENTAL=true` in `.env`), and agents gain two abilities:

- **Finding, read-only, the endpoints FengSui does not use yet** (`probe_router_endpoints`, any model): an agent names up to 12 endpoint paths per call, and FengSui sends a `GET` for each inside its own session. It answers whether this router has the endpoint, whether FengSui already uses it, and the structure of the answer: tag names and value types, never a value. The agent never logs in to the router itself, because the router allows one admin session at a time and wrong passwords lock it. Session endpoints such as login and tokens, and paths that change the router on some firmware (a network scan, reboot, reset, send, delete…), are refused without being sent; calls are at least 10 s apart, and each one goes into the audit log.
- **Turning experimental writes on or off** (`set_experimental_write`, on models FengSui was not verified on only): the same rules as in the console, with the router's model typed to turn one on; it also needs "Let agents change the router", the token's "Change the router" permission and `confirm: true`.

After an agent locks bands, if the WAN stays down 3 minutes, FengSui writes back the band setting it read right before the lock, whether self-healing is on or not; if the WAN comes back and stays up 2 minutes, the lock is kept.

On a model FengSui was not verified on, Settings → Device has a ready-made prompt. Choose "Copy prompt and start test" and confirm once: FengSui turns on everything the test uses (this switch, "Let agents change the router", the experimental writes for band lock, redial and reboot, and the "Change the router" permission for the agent's token; SMS too unless you untick it in the confirmation, which turns on the experimental SMS write and sets the agents' SMS access to read and write and their sending to any number) and copies the prompt. Give it to your agent: it tests step by step, finds the endpoints FengSui does not use with `probe_router_endpoints`, and writes a desensitized report for you to check and post as an issue. You may keep whatever passed; "End test" puts everything back, and while the test is on FengSui reminds you (`AGENT_TEST_STILL_ON`). See [Other Huawei models](other-routers.md#ai).

## Security safeguards

- **Token permissions**: A token sees only the tools it may use. Give an agent a token with no permission ticked, and write tools will neither appear nor run.
- **Read-only probing**: `probe_router_endpoints` sends only `GET`s and returns only structure; paths that would change the router and session endpoints are refused.
- **Redacted by default**: In data returned to agents, only the first 6 digits of the IMEI are kept, only the carrier code of the IMSI is kept, only the first two octets of the WAN address are kept, and cell identifiers and device names are hidden (`REDACT_SENSITIVE_IN_API=true`, default). This lets you send data to cloud models with peace of mind.
- **Parameter validation**: Band locking only accepts bands supported by the router, and `lock_cell` only locks cells that have already been observed, preventing the model from hallucinating parameters that drop your connection.
- **SMS content is untrusted**: SMS bodies and sender names are marked as third-party data to remind the model not to execute instructions inside them. `send_sms` can only send to one recipient at a time, defaults to contacts you have saved or numbers you have messaged before, and enforces an hourly cap. `delete_sms` does not delete unread messages by default, and what it deletes goes to your Recently deleted, which an agent can neither restore from nor empty (see [SMS](sms.md#trash)).
- **Yielding and the breaker**: When someone logs in to the router's own web page, tools return `BROWSER_SESSION_YIELDED`. When the router password is incorrect, tools return `CIRCUIT_BREAKER_OPEN`, prompting you to correct it in "Settings → Router".

## REST API and real-time events

Scripts and dashboards can use the same tokens to call the REST API:

```bash
curl -H "Authorization: Bearer <token>" http://<NAS IP>:18384/api/telemetry
```

- Read endpoints return the latest data from memory directly without logging in to the router again.
- `GET /api/events` is a Server-Sent Events stream for real-time updates (rates, signal, alerts, new messages, etc.).
- State-changing requests must include `X-Requested-With: XMLHttpRequest` and `Content-Type: application/json`.
- `GET /metrics` provides Prometheus metrics (enable under "Settings → Security").

For full endpoints, events, and error codes, see the [backend contract](../../PHASE2_BACKEND_CONTRACT.md).
