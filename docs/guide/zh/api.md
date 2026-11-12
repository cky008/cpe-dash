---
title: API 参考
description: 用令牌从脚本、仪表盘或智能家居系统调用烽燧：怎么认证、有哪些接口、返回什么，以及实时事件和 Prometheus 指标。
section: 管理
order: 16
---

烽燧的网页控制台用的就是这套 REST API。脚本、仪表盘和智能家居系统可以用令牌调用同样的接口：读取信号和历史、马上刷新、锁频、收发短信，或者订阅实时事件。

AI 智能体请用 [MCP](agents.md)：它在这套接口之上多了开关、确认和更严格的限制。

## 准备令牌

在控制台「设置 → 令牌与 AI」生成令牌。令牌只显示一次，请马上复制保存；可以设有效期（1 到 365 天或永不过期），随时可以撤销（见[安全与隐私](security.md)）。

每个令牌都能读取路由器的数据，并能让烽燧马上刷新一次。其他事情要在生成时勾选权限，已有的令牌在「设置 → 令牌与 AI」点「权限」修改：

| 权限 | 允许 |
| :--- | :--- |
| 不勾任何权限 | 读取信号、历史、附近的基站、已连接设备、路由器设置、告警和审计日志；马上刷新这些数据 |
| 读短信和验证码 | 读取短信会话、通讯录和「最近删除」，同步和预览短信；实时事件里包括短信事件 |
| 改动路由器 | 锁频段、锁小区、解锁、UPnP / DMZ / 防火墙、Wi-Fi 7、天线、移动数据、重拨、重启、解除熔断 |
| 管理设备上网 | 断开或恢复设备的 Wi-Fi、Wi-Fi 黑白名单、上网时段 |
| 发短信、删短信、改通讯录 | 发送、标为已读、删除、恢复短信，修改和导入通讯录 |

> [!NOTE]
> 控制台里「允许智能体改动路由器」这类开关只管 MCP。REST API 只看令牌的权限。

令牌不能修改控制台设置（登录密码、令牌、路由器连接、各种开关），也不能彻底删除「最近删除」里的短信，这些只能在登录后的控制台里做（`403 CONSOLE_ONLY`）。控制台自己用的接口（`/api/auth/*`、`/api/setup/*`、`/api/console/*`）不对令牌开放，下面不列。

## 发请求

把令牌放在 `Authorization` 头里：

```bash
# 读取
curl -H "Authorization: Bearer <令牌>" http://<NAS 的 IP>:18384/api/telemetry

# 改动：POST，请求体是 JSON
curl -X POST \
  -H "Authorization: Bearer <令牌>" \
  -H "Content-Type: application/json" \
  -d '{"mode":"auto"}' \
  http://<NAS 的 IP>:18384/api/control/antenna
```

- **每个 `POST` 都要带 `Content-Type: application/json`**，没有参数时发 `{}`。请求体最大 64 KiB（导入通讯录 4 MiB）。
- **读取不会登录路由器。** `GET` 接口直接返回烽燧内存里的最新数据，可以频繁调用。烽燧默认每 5 秒读一次信号（`POLL_INTERVAL_MS`），每 60 秒扫描一次附近的基站和已连接设备（`NEIGHBOR_SCAN_INTERVAL_MS`），见[配置参考](configuration.md)。
- **刷新和改动会登录路由器。** 路由器同一时间只允许一个管理员会话，烽燧把所有请求排队，一次一个。请不要高频调用刷新接口。
- **有人登录路由器自己的管理页时，烽燧会让开**：这期间的刷新和改动返回 `409 BROWSER_SESSION_YIELDED`，什么都不做。
- **用域名访问**（例如经过反向代理）时，把域名加进 `ALLOWED_HOSTS`，否则返回 `421 MISDIRECTED_HOST`（见[安全与隐私](security.md#reverse-proxy)）。
- **令牌请求不需要 `X-Requested-With`。** 只有浏览器里用控制台的登录 Cookie 调用时才需要它，那是防跨站请求伪造（CSRF）的检查。
- **默认打码。** 用令牌拿到的数据里，IMEI 只留前 6 位，IMSI 只留运营商代码，号码、MAC 和 WAN 地址只留一部分，小区标识和设备名称隐去（`REDACT_SENSITIVE_IN_API=true`）。登录后的控制台看到原值。

<a id="errors"></a>

## 返回和错误

成功时返回 `200`，JSON 里 `ok` 为 `true`，数据在同一层的字段里。例如锁频段返回（节选）：

```json
{ "ok": true, "lockState": { "mode": "band_lock", "lteBands": [1, 3], "nrBands": [] } }
```

失败时返回对应的 HTTP 状态码，JSON 里 `ok` 为 `false`：

```json
{ "ok": false, "errorCode": "VALIDATION_ERROR", "message": "…" }
```

脚本请按 `errorCode` 判断，不要按 `message`：`message` 可能是中文或英文，措辞也会改。脚本会遇到的错误码：

<!-- api-errors:begin -->
| 状态码 | `errorCode` | 意思 |
| :--- | :--- | :--- |
| 400 / 413 / 415 | `BAD_PAYLOAD` | 请求体不是 JSON 对象、超过上限，或没有 `Content-Type: application/json` |
| 400 | `VALIDATION_ERROR` | 参数不对：比如频段不在路由器支持的列表里、缺少 `confirm: true` |
| 401 | `UNAUTHORIZED` | 没带令牌，或令牌错误、已过期、已撤销 |
| 403 | `READ_ONLY_TOKEN` | 这个令牌不能做任何改动 |
| 403 | `TOKEN_NOT_PERMITTED` | 令牌缺少这项权限，`permission` 字段写着缺哪一项 |
| 403 | `CONSOLE_ONLY` | 只能在登录的控制台里做 |
| 404 | `NOT_FOUND` | 没有这个接口（`/metrics` 没打开时也是这个） |
| 404 | `SMS_DISABLED` | 短信功能关着（`SMS_ENABLED=false`） |
| 405 | `METHOD_NOT_ALLOWED` | 方法不对，比如该用 `POST` 的用了 `GET` |
| 409 | `BROWSER_SESSION_YIELDED` | 有人正登录路由器自己的管理页，烽燧让位，什么都没做 |
| 409 | `PEER_DAEMON_ACTIVE` | 另一台机器上的烽燧在管理这台路由器，这一个在待机 |
| 409 | `CPE_NOT_CONFIGURED` | 还没在控制台连上路由器 |
| 409 | `DEVICE_UNVERIFIED_READ_ONLY` | 烽燧在这台路由器上没有实现这项写入，什么都没发 |
| 409 | `DEVICE_WRITE_DISABLED` | 这项写入在「设置 → 设备」里关掉了，什么都没发 |
| 409 | `DEVICE_NOT_IDENTIFIED` | 还没认出路由器的型号，写入没有执行 |
| 421 | `MISDIRECTED_HOST` | 访问用的主机名不在允许范围内，把它加进 `ALLOWED_HOSTS` |
| 423 | `CIRCUIT_BREAKER_OPEN` | 路由器密码错误或账户被锁，烽燧停止登录；到「设置 → 路由器」改正 |
| 429 | `RATE_LIMITED` | 认证失败太多次，`retryAfterSec` 秒后再试 |
| 429 | `SSE_LIMIT_REACHED` | 实时事件的连接太多 |
| 500 | `INTERNAL_ERROR` | 烽燧内部出错 |
| 502 | `CPE_UPSTREAM_ERROR` | 路由器没有应答，或返回了错误 |
| 502 | `SMS_SEND_FAILED` | 路由器收下了短信，但报告发送失败 |
| 503 | `QUEUE_FULL` | 排队的请求太多，或烽燧正在停止 |
<!-- api-errors:end -->

<a id="endpoints"></a>

## 接口

「需要的权限」一栏是令牌除了读取之外还要勾选的权限。每个接口的请求和返回字段见开发者文档的[接口契约](../../dev/api.md)。

<!-- api-routes:begin -->
### 读取

| 方法 | 路径 | 需要的权限 | 说明 |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/telemetry` | 任何令牌 | 最新的信号、载波、速率、流量和 WAN 状态，以及锁定状态和最近的告警 |
| `GET` | `/api/timeseries` | 任何令牌 | 历史：速率、RSRP、SINR。`?preset=1h`（或 `6h`、`12h`、`24h`），或 `?preset=custom&fromMs=…&toMs=…` |
| `GET` | `/api/neighbors` | 任何令牌 | 附近的基站（上一次扫描的结果） |
| `GET` | `/api/topology` | 任何令牌 | 已连接设备 |
| `GET` | `/api/settings` | 任何令牌 | 路由器设置：UPnP、DMZ、防火墙、Wi-Fi 7、天线、移动数据 |
| `GET` | `/api/access-control` | 任何令牌 | Wi-Fi 黑白名单和上网时段 |
| `GET` | `/api/cellular` | 任何令牌 | 蜂窝设置（上一次读到的）：网络制式和路由器提供的选项、可切换的 SIM 卡槽、运营商怎么选、接入点（APN）、路由器自己的流量上限 |
| `GET` | `/api/session/status` | 任何令牌 | 烽燧和路由器之间的状态：是否在让位、是否熔断、自愈在做什么 |
| `GET` | `/api/device/profile` | 任何令牌 | 识别到的型号、固件和能力，以及它在「支持的设备」表里的那一行（不含设备标识） |
| `GET` | `/api/alerts` | 任何令牌 | 最近 100 条告警，以及每个通知渠道的发送统计 |
| `GET` | `/api/audit` | 任何令牌 | 审计日志：谁在什么时候改了什么（`?limit=`，最多 500 条） |

### 刷新

| 方法 | 路径 | 需要的权限 | 说明 |
| :--- | :--- | :--- | :--- |
| `POST` | `/api/telemetry/refresh` | 任何令牌 | 马上读一次信号 |
| `POST` | `/api/neighbors/scan` | 任何令牌 | 马上扫描附近的基站 |
| `POST` | `/api/topology/refresh` | 任何令牌 | 马上读一次已连接设备 |
| `POST` | `/api/settings/refresh` | 任何令牌 | 马上读一次路由器设置 |
| `POST` | `/api/access-control/refresh` | 任何令牌 | 马上读一次黑白名单和上网时段 |
| `POST` | `/api/cellular/refresh` | 任何令牌 | 马上读一次蜂窝设置 |

### 路由器控制

| 方法 | 路径 | 需要的权限 | 说明 | 请求体示例 |
| :--- | :--- | :--- | :--- | :--- |
| `POST` | `/api/control/band-lock` | 改动路由器 | 锁频段（`lteBands`、`nrBands`，`"all"` 为全部频段；只给一种制式时另一种不变） | `{"lteBands":["B1","B3"]}` |
| `POST` | `/api/control/cell-lock` | 改动路由器 | 锁小区；不给 `pci` 时只锁频点 | `{"rat":"NR","band":"N78","arfcn":650000,"pci":211}` |
| `POST` | `/api/control/unlock` | 改动路由器 | 解除锁频段和锁小区 |  |
| `POST` | `/api/control/reboot` | 改动路由器 | 重启路由器 | `{"confirm":true}` |
| `POST` | `/api/control/reconnect` | 改动路由器 | 重拨移动网络（不重启路由器） | `{"confirm":true}` |
| `POST` | `/api/control/security` | 改动路由器 | UPnP、DMZ、防火墙（`upnpEnabled`、`dmz`、`firewall`，只给要改的） | `{"upnpEnabled":false}` |
| `POST` | `/api/control/wifi7` | 改动路由器 | Wi-Fi 7 多链路（`mloEnable`）和双频优选（`dbhoEnable`） | `{"mloEnable":true}` |
| `POST` | `/api/control/antenna` | 改动路由器 | 天线：`auto`、`internal`、`external` | `{"mode":"auto"}` |
| `POST` | `/api/control/mobile-data` | 改动路由器 | 打开或关闭移动数据 | `{"enabled":true}` |
| `POST` | `/api/control/network-mode` | 改动路由器 | 网络制式：`auto`、`nr_sa`、`nr_nsa`、`nr_lte`、`lte`、`lte_wcdma`、`wcdma`、`gsm` 中路由器提供的（见 `GET /api/cellular`）。断网 3 分钟没恢复，烽燧自动改回 | `{"mode":"auto","confirm":true}` |
| `POST` | `/api/control/operator-scan` | 改动路由器 | 搜索附近的运营商网络：最长一分钟，期间可能断网 | `{"confirm":true}` |
| `POST` | `/api/control/operator` | 改动路由器 | 选运营商：`auto` 交回路由器自己选，`manual` 加 `plmn`（和可选的 `rat`）固定到一个网络。断网 3 分钟没恢复，烽燧自动改回 | `{"mode":"auto","confirm":true}` |
| `POST` | `/api/control/sim-slot` | 改动路由器 | 切换 SIM 卡槽：`physical`（实体卡）或 `embedded`（内置卡，`index` 是第几张）。断网 3 分钟没恢复，烽燧自动切回 | `{"kind":"physical","confirm":true}` |
| `POST` | `/api/control/sim-pin` | 改动路由器 | SIM 卡 PIN：`enter` 输入 PIN，`lock` / `unlock` 开关「开机要 PIN」。只发一次；路由器没有报告剩余次数、或只剩一次时不发。`accepted: false` 表示卡没有接受 | `{"action":"enter","pin":"1234","confirm":true}` |
| `POST` | `/api/control/airplane-mode` | 改动路由器 | 飞行模式：打开后路由器断开移动网络，烽燧不会自己关掉它 | `{"enabled":false,"confirm":true}` |
| `POST` | `/api/control/roaming` | 改动路由器 | 数据漫游：漫游时用不用流量 | `{"enabled":false,"confirm":true}` |
| `POST` | `/api/control/apn` | 改动路由器 | 接入点（APN）：`auto` 由路由器按 SIM 卡选，`manual` 加 `apn`（和可选的 `ipType`、`auth`、`username`、`password`）。断网 3 分钟没恢复，烽燧自动换回 | `{"mode":"auto","confirm":true}` |
| `POST` | `/api/control/data-limit` | 改动路由器 | 路由器自己的流量上限：`enabled`、`bytes`、`alertPercent`（到多少比例时提醒） | `{"enabled":false,"confirm":true}` |
| `POST` | `/api/control/traffic-reset` | 改动路由器 | 清零路由器自己记的流量统计 | `{"confirm":true}` |
| `POST` | `/api/control/ussd` | 改动路由器 | USSD：发送一条指令（`code`），`action` 为 `reply` 时回复运营商的提问，为 `cancel` 时结束会话。应答是运营商写的文字 | `{"code":"*100#","confirm":true}` |
| `POST` | `/api/session/reset-breaker` | 改动路由器 | 解除路由器账户被锁（错误码 108007）引起的熔断，并重新读取 `.env`；密码错误引起的熔断请在「设置 → 路由器」改正密码 |  |

### 设备上网管理

| 方法 | 路径 | 需要的权限 | 说明 | 请求体示例 |
| :--- | :--- | :--- | :--- | :--- |
| `POST` | `/api/control/wifi-access` | 管理设备上网 | 断开或恢复一台设备的 Wi-Fi（`block`、`unblock`） | `{"action":"unblock","macAddress":"02:00:5E:10:00:01","confirm":true}` |
| `POST` | `/api/control/wifi-mac-filter` | 管理设备上网 | Wi-Fi 黑白名单：`off`、`deny`、`allow`，或增删名单里的设备 | `{"mode":"off","confirm":true}` |
| `POST` | `/api/control/time-rule` | 管理设备上网 | 上网时段：新建、修改、删除（`create`、`update`、`delete`） | `{"action":"delete","id":"1","confirm":true}` |

### 短信

| 方法 | 路径 | 需要的权限 | 说明 | 请求体示例 |
| :--- | :--- | :--- | :--- | :--- |
| `GET` | `/api/sms/status` | 读短信和验证码 | 短信数量和同步状态 |  |
| `GET` | `/api/sms/countries` | 读短信和验证码 | 国家和地区的电话区号 |  |
| `GET` | `/api/sms/threads` | 读短信和验证码 | 会话列表（`?filter=all`、`unread`、`otp`，`&search=`） |  |
| `GET` | `/api/sms/thread` | 读短信和验证码 | 一个会话的全部短信（`?key=` 号码或会话标识） |  |
| `GET` | `/api/sms/contacts` | 读短信和验证码 | 通讯录（`?search=`） |  |
| `GET` | `/api/sms/trash` | 读短信和验证码 | 「最近删除」里的短信 |  |
| `POST` | `/api/sms/preview` | 读短信和验证码 | 预览一条短信：分几段、用什么编码，不发送 | `{"phone":"+353830000001","content":"Hello"}` |
| `POST` | `/api/sms/sync` | 读短信和验证码 | 马上同步短信（`full` 或 `incremental`） | `{"mode":"incremental"}` |
| `POST` | `/api/sms/send` | 发短信、删短信、改通讯录 | 发短信（`phone`，或 `phones` 最多 5 个）；只发一次，失败不重发 | `{"phone":"+353830000001","content":"Hello"}` |
| `POST` | `/api/sms/read` | 发短信、删短信、改通讯录 | 标为已读（`uids` 或 `threadKey`） | `{"threadKey":"+353830000001"}` |
| `POST` | `/api/sms/delete` | 发短信、删短信、改通讯录 | 删除短信，放进「最近删除」 | `{"uids":["<uid>"]}` |
| `POST` | `/api/sms/trash/restore` | 发短信、删短信、改通讯录 | 从「最近删除」放回原来的会话 | `{"uids":["<uid>"]}` |
| `POST` | `/api/sms/trash/purge` | 只能在控制台 | 彻底删除「最近删除」里的短信 |  |
| `POST` | `/api/sms/contacts/upsert` | 发短信、删短信、改通讯录 | 新建或修改联系人 | `{"phone":"+353830000001","name":"Example"}` |
| `POST` | `/api/sms/contacts/delete` | 发短信、删短信、改通讯录 | 删除联系人 | `{"id":"<id>"}` |
| `POST` | `/api/sms/contacts/import-vcf` | 发短信、删短信、改通讯录 | 导入 vCard（`.vcf` 文件的内容） | `{"vcf":"BEGIN:VCARD…"}` |

### 其他

| 方法 | 路径 | 需要的权限 | 说明 |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/health` | 不需要令牌 | 存活检查：版本和运行时长 |
| `GET` | `/api/events` | 任何令牌 | 实时事件流（见[实时事件](#events)） |
| `GET` | `/metrics` | 任何令牌 | Prometheus 指标（打开后才有，见 [Prometheus 指标](#metrics)） |
<!-- api-routes:end -->

改动路由器的接口遵守和控制台一样的规则：在没有验证过的路由器上，烽燧没有实现的写入返回 `409 DEVICE_UNVERIFIED_READ_ONLY`，你在「设置 → 设备」关掉的返回 `409 DEVICE_WRITE_DISABLED`，两种情况都不会给路由器发任何请求（见[其他型号与品牌](other-routers.md#writes)）。

<a id="events"></a>

## 实时事件

`GET /api/events` 是 [Server-Sent Events](https://html.spec.whatwg.org/multipage/server-sent-events.html) 流。连上后先收到一条 `hello`（当前的状态），之后数据一变就推送：

```bash
curl -N -H "Authorization: Bearer <令牌>" http://<NAS 的 IP>:18384/api/events
```

每条消息有 `event:`（事件名）和 `data:`（一行 JSON）。另外每 15 秒有一行以 `:` 开头的心跳（`SSE_HEARTBEAT_MS`），客户端忽略它即可。断线重连后会重新收到 `hello`；烽燧不补发断线期间的事件。

<!-- api-events:begin -->
| 事件 | 什么时候发 |
| :--- | :--- |
| `hello` | 连上时先发一次：当前的状态、信号、锁定和短信计数 |
| `speed` | 每次读到信号（默认每 5 秒）：上下行速率 |
| `telemetry` | 紧跟 `speed`：完整的信号和状态，与 `GET /api/telemetry` 的 `telemetry` 相同 |
| `neighbors` | 附近的基站扫描完成（默认每 60 秒） |
| `topology` | 已连接设备读完（默认每 60 秒） |
| `settings` | 路由器设置读完或改动之后（没有定时推送） |
| `access-control` | 黑白名单和上网时段读完或改动之后 |
| `session:avoidance` | 有人登录或退出路由器自己的管理页，烽燧开始或结束让位 |
| `control:applied` | 一项写操作完成（任何入口：控制台、令牌、智能体、自愈） |
| `alert` | 一条新告警 |
| `sms:new` | 收到一条新短信（每条一次）（要「读短信和验证码」） |
| `sms:sent` | 一条短信发完（任何入口）（要「读短信和验证码」） |
| `sms:updated` | 短信被标为已读、删除、恢复或彻底删除（要「读短信和验证码」） |
| `sms:sync` | 一次短信同步完成（要「读短信和验证码」） |
| `sms:status` | 短信计数或同步状态变了（要「读短信和验证码」） |
| `contacts:updated` | 通讯录变了（要「读短信和验证码」） |
<!-- api-events:end -->

- 连接数有上限：总共 `SSE_MAX_CLIENTS` 条（默认 32），每个地址 6 条，超出返回 `429 SSE_LIMIT_REACHED`。
- 令牌被撤销或到期时，用它打开的连接立即断开。

<a id="metrics"></a>

## Prometheus 指标

在控制台「设置 → 安全」打开（或在 `.env` 里设 `METRICS_ENABLED=true`）后，`GET /metrics` 返回 [Prometheus](https://prometheus.io/docs/instrumenting/exposition_formats/) 文本格式的指标：信号（RSRP、RSRQ、SINR）、载波和带宽、速率、流量、WAN 状态、短信数量、路由器自己报告的状态（电量与是否在充电、SIM 卡是否在等 PIN、飞行模式、漫游、CPU 与内存、各类温度传感器），会话和排队情况，以及烽燧自己的内存、CPU 和事件循环延迟。指标里没有任何设备标识。没打开时返回 `404`。

任何令牌都能读取指标，不需要勾选权限。Prometheus 的抓取配置：

```yaml
scrape_configs:
  - job_name: fengsui
    metrics_path: /metrics
    authorization:
      credentials: <令牌>
    static_configs:
      - targets: ["<NAS 的 IP>:18384"]
```

## 存活检查

`GET /api/health` 不需要令牌，返回版本和运行时长，适合存活监控工具。Docker 镜像自带的健康检查用的也是它。
