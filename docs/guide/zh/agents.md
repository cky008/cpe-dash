---
title: AI 智能体（MCP）
description: 让 Claude、Cursor 等 AI 智能体读取信号和短信、在你允许时操作路由器，以及 REST API 和实时事件。
section: 使用烽燧
order: 11
---

烽燧内置一个 [MCP](https://modelcontextprotocol.io) 服务器，挂在 `/mcp` 上。AI 智能体可以通过它查看信号、历史和短信，帮你分析网络问题。

默认情况下，智能体**只能读取**。要让它改动东西，得打开对应的开关、给它的令牌勾选相应的权限，而且每次调用都要带上确认，详见[打开写操作](#writes)。

## 最快的接法

控制台页头的机器人图标（手机上在控制台底部的「接入 AI」）会打开接入指南：

1. 在「设置 → 令牌与 AI」生成一个令牌（指南里也能直接生成：它能查看路由器数据和读短信，不能改动任何东西）。
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

Claude Desktop 等客户端可以通过容器里的桥接程序连接，前提是客户端和容器在同一台机器上。把 `<令牌>` 换成你生成的令牌（建议用不能改动东西的令牌）：

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
| 查看（始终可用） | `get_cpe_telemetry`、`query_telemetry_history`、`list_neighbor_cells`、`get_cpe_session_status`、`list_terminal_topology`、`get_router_settings`、`get_access_control`、`get_device_report` |
| 路由器控制（需打开「允许智能体改动路由器」） | `lock_band`†、`lock_cell`†、`unlock_rf_locks`†、`set_security_switches`†、`set_wifi_and_antenna`†、`reconnect_cellular`†、`reboot_cpe`† |
| 设备上网管理（另需「允许智能体管理设备上网」） | `set_device_internet_access`†、`set_wifi_mac_filter`†、`manage_internet_time_rule`† |
| 短信（「智能体的短信权限」为「只读」，默认） | `list_sms_threads`、`get_sms_thread`、`get_sms_status`、`search_contacts`、`preview_sms`、`sync_sms` |
| 短信写操作（短信权限为「读写」，另需「允许智能体改动路由器」） | `send_sms`†、`mark_sms_read`†、`delete_sms`†、`upsert_contact`† |
| 测试这台路由器（需在「设置 → 设备」打开「允许 AI 智能体测试这台路由器」，见[下文](#testing)） | `probe_router_endpoints`、`set_experimental_write`†（只在未验证的型号上） |

† 调用时必须传 `{ "confirm": true }`，否则在碰路由器之前就被拒绝。所有写工具都是这样。

`get_device_report` 返回分享兼容性报告时用的那份脱敏设备报告：型号、固件、哪些接口有应答、每个写功能在这台路由器上的状态，以及最近的实验性写入结果。

<a id="writes"></a>

## 打开写操作

默认情况下智能体只能读取。要让它改动东西，下面三个条件要**同时**满足；缺一个，调用就会被拒绝，路由器也收不到任何请求。

### 打开对应的开关

在「设置 → 令牌与 AI」里打开，立即生效。也可以写在 `.env` 里：控制台里没改过的开关跟随 `.env`，改过的以控制台为准，选「跟随 .env」就恢复。

| 想让智能体做的事 | 控制台里打开 | 或在 `.env` 里设 |
| :--- | :--- | :--- |
| 锁频段、锁小区、解锁、安全开关、Wi-Fi 与天线、重拨、重启 | 「允许智能体改动路由器」 | `MCP_ALLOW_MUTATIONS=true` |
| 断网 / 恢复设备、Wi-Fi 黑白名单、上网时段 | 上一项，加「允许智能体管理设备上网」 | 上一项，加 `MCP_ALLOW_ACCESS_CONTROL=true` |
| 发短信、标记已读、删短信、改通讯录 | 第一项，加「智能体的短信权限」选「读写」 | 第一项，加 `MCP_SMS_ACCESS=full` |

改了 `.env` 的话，运行 `docker compose up -d --force-recreate` 让它生效（原因见 [Docker Compose 配置](docker-compose.md#apply)）。

### 给令牌勾选权限

每个令牌都能查看路由器数据。它还能做什么，在「设置 → 令牌与 AI」生成令牌时勾选，已有的令牌点「权限」修改：「读短信和验证码」「改动路由器」「管理设备上网」「发短信、删短信、改通讯录」。

令牌只看得到自己能用的工具。按名字直接调用没有权限的工具会被拒绝：缺某项权限返回 `TOKEN_NOT_PERMITTED`（附缺少的权限），什么都不能改的令牌调用写工具返回 `READ_ONLY_TOKEN`。只看数据的智能体，就给它不勾任何权限的令牌。

### 每次调用都带上 `{ "confirm": true }`

没带就会被拒绝（`CONFIRMATION_REQUIRED`）。接入指南里的提示词会要求智能体只在你明确要求了这一具体操作时才带上它。

在未验证的型号上，智能体能用的写工具是烽燧在这个型号上实现了、你没有关闭的那些（「设置 → 设备」），每个都标明「没有在真机上验证过」；被关闭的写操作返回 `DEVICE_WRITE_DISABLED`，烽燧没有实现的返回 `DEVICE_UNVERIFIED_READ_ONLY`。见[其他型号与品牌](other-routers.md#writes)。

<a id="testing"></a>

## 让智能体测试这台路由器

在「设置 → 设备」打开「允许 AI 智能体测试这台路由器」（或在 `.env` 里设 `MCP_ALLOW_EXPERIMENTAL=true`）后，智能体多了两种能力：

- **只读地查找烽燧还没用到的接口**（`probe_router_endpoints`，任何型号）：智能体每次给出最多 12 个接口路径，烽燧在自己的会话里逐个 `GET`，告诉它这台路由器有没有这个接口、烽燧是不是已经在用，以及应答的结构：标签名和值的类型，不含任何值。智能体不自己登录路由器，因为路由器同一时间只允许一个管理员会话，输错密码还会锁住。登录、令牌这类会话接口，以及在某些固件上会改动路由器的路径（搜网、重启、复位、发送、删除等）直接拒绝，不会发出；两次调用至少隔 10 秒，每次调用都记入审计日志。
- **关闭或恢复实验性写入**（`set_experimental_write`，只在未验证的型号上）：这些写操作默认开着，这个工具把其中一项关掉（之后谁都不能再做这项写入），或者重新打开。规则和控制台一样：只有烽燧在这台路由器上实现了的写操作有开关；另外还需要「允许智能体改动路由器」、令牌的「改动路由器」权限和 `confirm: true`。

在未验证的型号上，不管是谁锁的频段或小区，如果 WAN 断开 3 分钟还没恢复，烽燧都会自动回退：锁频段写回锁频前读到的频段设置，锁小区解除锁定，不管自愈有没有打开；WAN 恢复并保持 2 分钟，就保留这次锁定。

未验证型号的「设置 → 设备」里有一段现成的提示词。点「复制提示词并开始测试」，确认一次，烽燧就把测试要用的设置全部打开：上面这个开关、「允许智能体改动路由器」，以及给智能体的令牌加上「改动路由器」权限（写操作本来就开着，不用另外打开）；短信默认也测（可以在确认框里取消），会把智能体的短信权限改成「读写」、发短信改成「任何号码」，然后复制提示词。把它交给智能体，它会按步骤测试，用 `probe_router_endpoints` 找出烽燧还没用到的接口，再生成一份脱敏报告，由你检查后提交 issue。测完点「结束测试」恢复这些设置，测试还开着的话烽燧会提醒你（`AGENT_TEST_STILL_ON`）。详见[用 AI 智能体测试](other-routers.md#ai)。

## 安全措施

- **令牌权限**：令牌只看得到自己能用的工具。给智能体一个不勾任何权限的令牌，写工具既不会出现，也无法调用。
- **只读探查**：`probe_router_endpoints` 只发 `GET`，只返回结构；会改动路由器的路径和会话接口直接拒绝。
- **默认脱敏**：智能体拿到的数据里，IMEI 只留前 6 位，IMSI 只留运营商代码，WAN 地址只留前两段，小区标识和设备名称被隐去（`REDACT_SENSITIVE_IN_API=true`，默认）。这样把数据交给云端模型更放心。
- **参数校验**：锁频段只接受路由器支持的频段，`lock_cell` 只能锁已经观测到的小区，防止模型编造参数导致断网。
- **短信是不可信内容**：这几条对所有品牌的路由器都一样。短信正文和发件人名称会被标为第三方数据，提醒模型不要执行其中的指令。`send_sms` 一次只能发给一个人，默认只能发给你保存过的联系人或发过短信的号码，并有每小时上限；`delete_sms` 默认不删未读短信，删掉的短信进你的「最近删除」，智能体不能恢复，也不能彻底删除（见[短信](sms.md#trash)）。
- **让位与熔断**：有人登录官方网页时，工具返回 `BROWSER_SESSION_YIELDED`；路由器密码错误时返回 `CIRCUIT_BREAKER_OPEN`，提示到「设置 → 路由器」改正。

## REST API 和实时事件

脚本和仪表盘可以用同样的令牌调用 REST API、订阅实时事件（`GET /api/events`）和读取 Prometheus 指标（`GET /metrics`）。REST API 只看令牌的权限，不受上面这些智能体开关影响。怎么认证、有哪些接口、返回什么，见 [API 参考](api.md)。
