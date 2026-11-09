---
title: AI agents (MCP)
description: Allow AI agents like Claude and Cursor to inspect signal metrics and SMS, control the router with your permission, and use the REST API and real-time events.
section: Use FengSui
order: 10
---

FengSui includes an embedded [MCP](https://modelcontextprotocol.io) server hosted at `/mcp`. AI agents can use it to inspect signal metrics, history, and SMS messages to help diagnose network problems.

By default, agents are **read-only**. To let one change anything, turn on the matching switch in `.env`, give it a full-access token, and have it pass a confirmation on every call; see [Turning on writes](#writes).

## Connect quickly

The bot icon in the console header (or "AI agents" at the bottom of the screen on mobile) opens the connection guide:

1. Go to "Settings → Tokens" and generate a **read-only** token (you can also generate one directly inside the guide).
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

Clients like Claude Desktop can connect through the bridge inside the container, provided the client and the container run on the same machine. Replace `<token>` with a token you created (a read-only one is best):

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
| Read (always available) | `get_cpe_telemetry`, `query_telemetry_history`, `list_neighbor_cells`, `get_cpe_session_status`, `list_terminal_topology`, `get_router_settings`, `get_access_control` |
| Router control (requires `MCP_ALLOW_MUTATIONS=true`) | `lock_band`†, `lock_cell`†, `unlock_rf_locks`†, `set_security_switches`†, `set_wifi_and_antenna`†, `reconnect_cellular`†, `reboot_cpe`† |
| Device access management (also requires `MCP_ALLOW_ACCESS_CONTROL=true`) | `set_device_internet_access`†, `set_wifi_mac_filter`†, `manage_internet_time_rule`† |
| SMS (`MCP_SMS_ACCESS=read`, default) | `list_sms_threads`, `get_sms_thread`, `get_sms_status`, `search_contacts`, `preview_sms`, `sync_sms` |
| SMS writes (`MCP_SMS_ACCESS=full`, also requires `MCP_ALLOW_MUTATIONS=true`) | `send_sms`†, `mark_sms_read`†, `delete_sms`†, `upsert_contact`† |

† Must be called with `{ "confirm": true }`; without it the call is refused before anything reaches the router. Every write tool works this way.

<a id="writes"></a>

## Turning on writes

Agents can only read by default. For an agent to change anything, all three conditions below must hold; if one is missing, the call is refused and nothing reaches the router.

### Switches in `.env`

| What the agent should be able to do | Set in `.env` |
| :--- | :--- |
| Lock bands or cells, unlock, router switches, Wi-Fi and antenna, reconnect, reboot | `MCP_ALLOW_MUTATIONS=true` |
| Block or restore devices, Wi-Fi blocklist or allowlist, access schedules | `MCP_ALLOW_MUTATIONS=true` and `MCP_ALLOW_ACCESS_CONTROL=true` |
| Send SMS, mark SMS as read, delete SMS, edit contacts | `MCP_ALLOW_MUTATIONS=true` and `MCP_SMS_ACCESS=full` |

After editing `.env`, apply it with `docker compose up -d --force-recreate` (why: [Docker Compose file](docker-compose.md#apply)).

### A full-access token

A read-only token sees no write tools, and calling one by name is refused (`READ_ONLY_TOKEN`). Create a token with the "Full access" scope under Settings → Tokens and give it only to agents that need to make changes; keep read-only tokens for agents that only read.

### `{ "confirm": true }` on every call

A write call without it is refused (`CONFIRMATION_REQUIRED`). The prompt in the connection guide tells the agent to pass it only after you asked for that exact action.

On models FengSui was not verified on, each write must also be turned on under Settings → Device first; see [Other Huawei models](other-routers.md).

## Security safeguards

- **Read-only tokens**: Give a read-only token to an agent, and write tools will neither appear nor run.
- **Redacted by default**: In data returned to agents, only the first 6 digits of the IMEI are kept, only the carrier code of the IMSI is kept, only the first two octets of the WAN address are kept, and cell identifiers and device names are hidden (`REDACT_SENSITIVE_IN_API=true`, default). This lets you send data to cloud models with peace of mind.
- **Parameter validation**: Band locking only accepts bands supported by the router, and `lock_cell` only locks cells that have already been observed, preventing the model from hallucinating parameters that drop your connection.
- **SMS content is untrusted**: SMS bodies and sender names are marked as third-party data to remind the model not to execute instructions inside them. `send_sms` can only send to one recipient at a time, defaults to contacts you have saved or numbers you have messaged before, and enforces an hourly cap. `delete_sms` does not delete unread messages by default.
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
