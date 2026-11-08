---
title: AI 智能体（MCP）
description: 让 Claude、Cursor 等 AI 智能体读取信号和短信、在你允许时操作路由器，以及 REST API 和实时事件。
section: 使用烽燧
order: 10
---

烽燧内置一个 [MCP](https://modelcontextprotocol.io) 服务器，挂在 `/mcp` 上。AI 智能体可以通过它查看信号、历史和短信，帮你分析网络问题。

默认情况下，智能体**只能读取**。会改动路由器的工具要你在 `.env` 里打开，而且每次都要带上确认。

## 最快的接法

控制台页头的机器人图标（手机上在控制台底部的「接入 AI」）会打开接入指南：

1. 在「设置 → 令牌」生成一个**只读**令牌（指南里也能直接生成）。
2. 把令牌粘贴进指南，它会生成可以直接复制的 Claude Code 命令、JSON 配置和一段提示词。
3. 复制到你的智能体里。

令牌只在这个页面里使用，不保存、不上传。

## 手动配置

### 支持远程 MCP 的客户端

Claude Code、Cursor、VS Code 等可以直接连 HTTP 地址：

```json
{
  "mcpServers": {
    "fengsui": {
      "type": "http",
      "url": "http://<NAS 的 IP>:18384/mcp",
      "headers": { "Authorization": "Bearer <令牌>" }
    }
  }
}
```

Claude Code 也可以用一条命令：

```bash
claude mcp add --transport http fengsui http://<NAS 的 IP>:18384/mcp --header "Authorization: Bearer <令牌>"
```

### 只支持本地（stdio）的客户端

Claude Desktop 等客户端可以通过容器里的桥接程序连接，前提是客户端和容器在同一台机器上。把 `<令牌>` 换成你生成的令牌（建议只读令牌）：

```json
{
  "mcpServers": {
    "fengsui": {
      "command": "docker",
      "args": ["exec", "-i", "-e", "API_TOKEN=<令牌>", "cpe-dash", "node", "dist/cli.js", "mcp"]
    }
  }
}
```

桥接程序本身不连路由器，只是把请求转给守护进程，所以不会多出一个路由器会话。

## 工具

| 分组 | 工具 |
| :--- | :--- |
| 查看（始终可用） | `get_cpe_telemetry`、`query_telemetry_history`、`list_neighbor_cells`、`get_cpe_session_status`、`list_terminal_topology`、`get_router_settings`、`get_access_control` |
| 路由器控制（需 `MCP_ALLOW_MUTATIONS=true`） | `lock_band`、`lock_cell`、`unlock_rf_locks`、`set_security_switches`、`set_wifi_and_antenna`、`reconnect_cellular`†、`reboot_cpe`† |
| 设备上网管理（另需 `MCP_ALLOW_ACCESS_CONTROL=true`） | `set_device_internet_access`†、`set_wifi_mac_filter`†、`manage_internet_time_rule`† |
| 短信（`MCP_SMS_ACCESS=read`，默认） | `list_sms_threads`、`get_sms_thread`、`get_sms_status`、`search_contacts`、`preview_sms`、`sync_sms` |
| 短信（`MCP_SMS_ACCESS=full`） | `send_sms`†、`mark_sms_read`、`delete_sms`†、`upsert_contact` |

† 调用时必须传 `{ "confirm": true }`。

## 安全措施

- **只读令牌**：把只读令牌交给智能体，写工具既不会出现，也无法调用。
- **默认脱敏**：智能体拿到的数据里，IMEI 只留前 6 位，IMSI 只留运营商代码，WAN 地址只留前两段，小区标识和设备名称被隐去（`REDACT_SENSITIVE_IN_API=true`，默认）。这样把数据交给云端模型更放心。
- **参数校验**：锁频段只接受路由器支持的频段，`lock_cell` 只能锁已经观测到的小区，防止模型编造参数导致断网。
- **短信是不可信内容**：短信正文和发件人名称会被标为第三方数据，提醒模型不要执行其中的指令。`send_sms` 一次只能发给一个人，默认只能发给你保存过的联系人或发过短信的号码，并有每小时上限；`delete_sms` 默认不删未读短信。
- **让位与熔断**：有人登录官方网页时，工具返回 `BROWSER_SESSION_YIELDED`；路由器密码错误时返回 `CIRCUIT_BREAKER_OPEN`，提示到「设置 → 路由器」改正。

## REST API 和实时事件

脚本和仪表盘可以用同样的令牌调用 REST API：

```bash
curl -H "Authorization: Bearer <令牌>" http://<NAS 的 IP>:18384/api/telemetry
```

- 读取接口直接返回内存里的最新数据，不会额外登录路由器。
- `GET /api/events` 是 Server-Sent Events 实时流（速率、信号、告警、新短信等）。
- 改动状态的请求要带 `X-Requested-With: XMLHttpRequest` 和 `Content-Type: application/json`。
- `GET /metrics` 提供 Prometheus 格式的指标（在「设置 → 安全」打开）。

完整的接口、事件和错误码见[后端契约](../../PHASE2_BACKEND_CONTRACT.md)。
