# cpe-dash · 烽燧 (FengSui)

<p align="center">
  <strong>华为 5G CPE Ultra 6 (H168-383) 私有化高阶射频遥测 · 3CA 载波聚合观测 · 邻区扫描 · 锁频锁站 · 短信与 Telegram · MCP 智能体网管平台</strong>
</p>

<p align="center">
  <strong>简体中文</strong> | <a href="README_EN.md">English</a>
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

**「烽燧」(FengSui / `cpe-dash`)** 是专为 **华为 5G CPE Ultra 6 (`H168-383`，固件 `4.4.0.1`)** 打造的私有化 5G 射频遥测、3CA 载波聚合分析、4G/5G 邻区扫描、锁频段/锁小区控制、双周期流量审计、局域网终端拓扑与 **Model Context Protocol (MCP)** 智能体网管平台，并内置**短信收发**（加密镜像、通讯录、Telegram 双向机器人、签名 Webhook）与**自动告警**。短信与遥测共用唯一的管理员会话调度器，不再与独立短信服务争抢路由器后台。

项目针对 **群晖 Synology DS923+ (AMD Ryzen R1600 / 32GB RAM)** 等家庭私有内网环境设计，采用 **100% 严格 TypeScript (`strict: true`)** 独立闭环编写，**生产运行时零外部 npm 依赖**（100% 基于 Node.js 原生内置模块），默认监听独立高位端口 `:18384`。

---

## 目录

- [🏛️ 系统拓扑与单会话避让架构图](#️-系统拓扑与单会话避让架构图)
- [✨ 核心工程与协议特性](#-核心工程与协议特性)
- [📡《H168-383 硬件能力全景表》（真机实测验证）](#-h168-383-硬件能力全景表真机实测验证)
- [🏗️ 仓库架构与模块划分](#️-仓库架构与模块划分)
- [🚀 快速启动（守护进程、MCP Server 与真机探针）](#-快速启动守护进程mcp-server-与真机探针)
- [✉️ 短信、Telegram 机器人与告警](#️-短信telegram-机器人与告警)
- [🔌 REST API、毫秒级 SSE 与 MCP 工具概览](#-rest-api毫秒级-sse-与-mcp-工具概览)
- [⚙️ `.env` 配置参考](#️-env-配置参考)
- [🛡️ 七大安全与 TDD 质量门禁](#️-七大安全与-tdd-质量门禁)
- [📚 权威技术文档索引](#-权威技术文档索引)
- [⚠️ 免责声明与开源许可](#️-免责声明与开源许可)

---

## 🏛️ 系统拓扑与单会话避让架构图

### 1. 群晖 DS923+ 私有部署与多端协同拓扑

```mermaid
flowchart LR
  subgraph Clients["局域网 / Tailscale 终端与智能体"]
    Browser["Web 控制台 (离线 SPA)"]
    AgentHttp["内网 AI Agent (HTTP MCP)"]
    AgentStdio["本地 AI Agent (stdio)"]
    Bridge["cpe-dash mcp\n零状态 stdio→HTTP 桥接"]
    HumanWeb["真人管理员浏览器"]
    TgUser["Telegram（手机）"]
    Hook["Webhook 接收端（Home Assistant / n8n）"]
  end

  subgraph NAS["Synology DS923+ (Node.js >= 22.6 零外部依赖)"]
    HttpSrv["FengSuiHttpServer (:18384)\nHost 白名单 + Strict CSRF + /64 限流"]
    SseBus["SseEventBus (/api/events)\n<1ms 首帧快照 + 15s 心跳"]
    McpSrv["FengSuiMcpServer\n13 + 10 短信 Tools"]
    Sms["SmsService\n计数捎带同步 + 加密镜像 + 通讯录"]
    Notify["NotificationHub + AlertEngine\nTelegram 机器人 / 签名 Webhook"]
    Core["CpeMonitor（采集/缓存）+ CpeControlService（控制写）"]
    Sched["MutexSessionScheduler\n唯一会话出口：优先级队列 + 双层避让 + 熔断"]
    Ring["TimeSeriesRingBuffer\n5s 细粒度环 + 60s 归档环 (7d)"]
    Store["EncryptedStateStore\nAES-256-GCM 0600 异步原子落盘"]
    Client["HuaweiCpeClient\nSCRAM + Curve25519 + 108006 熔断器"]
  end

  subgraph Router["华为 5G CPE Ultra 6 (H168-383 / 192.168.8.1)"]
    CpeApi["单管理员排他 Web API (固件 4.4.0.1)"]
  end

  Browser -- "Cookie + X-Requested-With" --> HttpSrv
  HttpSrv -- "SSE 实时帧" --> SseBus
  SseBus --> Browser
  AgentHttp -- "POST /mcp (Bearer Token)" --> HttpSrv
  HttpSrv --> McpSrv
  AgentStdio -- "NDJSON stdio" --> Bridge
  Bridge -- "POST /mcp (Bearer Token)" --> HttpSrv
  HttpSrv --> Core
  McpSrv --> Core
  Core --> Sched
  HttpSrv --> Sms
  McpSrv --> Sms
  Sms --> Sched
  Sms -- "sms:new" --> Notify
  Sched -- "alert / telemetry" --> Notify
  Notify -- "Bot API 长轮询" --> TgUser
  Notify -- "HMAC 签名 POST" --> Hook
  Sched --> Ring
  Sched --> Store
  Sched --> Client
  Client -- "~26ms-260ms 瞬时会话 + finally logout" --> CpeApi
  HumanWeb -. "直接登录 http://192.168.8.1 (最高优先级)" .-> CpeApi
```

### 2. 单管理员排他协议：瞬时短连与双层真人主动避让时序

```mermaid
sequenceDiagram
  autonumber
  participant UI as Web 控制台 / SSE
  participant Sched as MutexSessionScheduler
  participant Client as HuaweiCpeClient
  participant CPE as H168-383 (192.168.8.1)
  participant Human as 真人管理员浏览器

  Note over Sched,CPE: 场景 A：无人登录后台（~26ms-260ms 极速瞬时采集）
  Sched->>Client: withSessionDetailed(fetchGlobalTelemetry)
  Client->>CPE: GET /api/user/state-login
  CPE-->>Client: <State>-1</State> (空闲)
  Client->>CPE: SCRAM-SHA256 + Curve25519 登录握手
  Client->>CPE: 并发拉取 3CA 射频 / 流量 / 设备状态（12 个只读接口）
  Client->>CPE: POST /api/user/logout (finally 块强制释放)
  Sched-->>UI: SSE 推送 speed + telemetry + 写入双层环形时序
  Note over Sched,CPE: 邻区与终端拓扑不在 5s 采集内：每 60s 各自独立短连采集（login → GET → logout）

  Note over Human,CPE: 场景 B：真人登录 http://192.168.8.1（双层礼貌挂起让位）
  Human->>CPE: 登录官方管理后台
  Sched->>Client: 下一次定时轮询或写指令预检
  Client->>CPE: GET /api/user/state-login (Layer 1) / challenge_login (Layer 2: 108003)
  CPE-->>Client: State != -1 或错误码 108003
  Client-->>Sched: status = "yielded" (零抢占静默退出 + 指数退避防抖)
  Sched-->>UI: SSE 广播 event: session:avoidance (active: true)
  Note over Sched,UI: 若此时发起锁频/重启写请求 -> 立即返回 409 Conflict 绝不盲目排队偷改！
```

---

## ✨ 核心工程与协议特性

- **⚡ `~26 ms` 极速瞬时短连与双层真人在线避让（含 Layer-2 指数退避防抖）**
  - H168-383 硬件限制同一时刻仅允许 1 个管理员在线。[`HuaweiCpeClient`](src/cpe-client.ts) 与 [`MutexSessionScheduler`](src/scheduler.ts) 将每次鉴权操作严格串行收敛为瞬时短连，并在 `finally` 块无条件调用 `POST /api/user/logout`（带 3s 硬超时兜底）。
  - **双层主动避让**：第 1 层通过 `GET /api/user/state-login` 零开销预检；第 2 层针对跨局域网终端占用返回 `108003`/`108009` 实施 `45s → 300s` 指数静默退避，彻底杜绝频繁敲击 `challenge_login`，并通过 SSE 实时广播避让横幅。
- **🛑 跨重启持久化的 `108006` / `108007` 防爆破熔断断路器**
  - 华为固件连续输错 3 次管理密码即锁定账户。内置断路器捕获 `108006`/`108007` 后立即熔断并将密码指纹写入加密状态库，即便守护进程重启也不会重复试错锁死路由器。因密码错误（`108006`/`108002`/`108001`）熔断时，必须先修正 `.env` 中的 `CPE_PASSWORD`，再调用 `POST /api/session/reset-breaker` 或重启服务；密码未变时重置请求会被拒绝（`400`）。`108007` 硬件锁定在锁定期结束后可直接通过 reset-breaker 解除。
- **📈 双层定长环形时序数据库 (`TimeSeriesRingBuffer`)**
  - 内存占用恒定 `< 6 MB`：`Tier 1` 维护 `3 小时 / 5 秒` 高频槽位，`Tier 2` 维护 `7 天 / 60 秒` 归档槽位；支持 `1h`、`6h`、`12h`、`24h` 与自定义 `[fromMs, toMs]` 无缝跨层拼接聚合，NSA 5G 空闲与未开放传感器保持精确 `null`（绝不拉偏均值至 `0`），配合 `EncryptedStateStore` 异步 `30 分钟` 批量刷盘保护群晖硬盘休眠。
- **✉️ 短信与遥测同源调度（零额外会话的变化检测）**
  - 短信计数捎带在 5s 遥测会话内读取，只有计数变化才触发增量或全量同步；发送、已读、删除走同一调度器的控制写队列，真人在线时同样礼貌让位。短信镜像、通讯录与 Telegram 状态全部 AES-256-GCM 加密落盘；守护进程独占数据目录（`state.json.lock`），未配置密钥时拒绝启动，绝不明文落盘。
- **📲 Telegram 双向机器人、签名 Webhook 与自动告警**
  - 来信卡片（验证码、回复即发送、已读 / 会话 / 删除确认按钮）、引导式发短信、会话与通讯录查询、告警推送与静音；Webhook 以 `HMAC-SHA256` 签名。告警引擎覆盖离线、WAN 断开、信号劣化、载波聚合丢失、重启、短信存储与流量阈值，带持续窗口与恢复迟滞。
- **🤖 原生 MCP Server（Streamable HTTP `/mcp` + 零状态 `stdio` 桥接）**
  - 零外部依赖完整实现 JSON-RPC 2.0 MCP 服务端（[`FengSuiMcpServer`](src/mcp-server.ts)，协议 `2025-11-25` / `2025-06-18` / `2025-03-26` / `2024-11-05`），挂载在守护进程 `/mcp`；`cpe-dash mcp` 只是把 stdio 转发到该端点的零状态桥接，**整个系统只有守护进程一个 CPE 会话出口**。向 Claude Desktop、Antigravity、Cursor 及内网自动化 Agent 暴露 **13 项核心工具**与**最多 10 项短信工具**（按 `MCP_SMS_ACCESS` 分级）。
  - 工具 `inputSchema` 在服务端强制校验（未知键、缺失、类型、范围），`reboot_cpe`、`reconnect_cellular`、`send_sms`、`delete_sms` 强制 `{ confirm: true }`；锁频段只接受 H168-383 支持的 LTE 频段与 3GPP NR 频段，锁小区的 ARFCN 必须落在该频段范围内，且 `lock_cell` 只能锁定已观测到的小区（服务小区、聚合载波或最近一次邻区扫描），防止智能体幻觉参数断网；短信正文按不可信数据处理，发送默认仅限已知号码并按小时限额，防范提示词注入。
- **🛡️ 现代 Web 纵深防御体系**
  - 内置 `Host` 白名单防 DNS Rebinding (`421`)、`SameSite=Strict; HttpOnly` 会话隔离、`X-Requested-With` + `Origin` 双重防 CSRF、`net.BlockList` 可信反代 CIDR 校验 + IPv6 `/64` 速率限制桶、无原型字典防 Prototype Pollution、线性扫描防 ReDoS 以及 `normalizeCpeUrl` 私网源防 SSRF。

---

## 📡《H168-383 硬件能力全景表》（真机实测验证）

| 能力模块 | 核心协议端点 | 真机实测验证指标与结构特征 | 状态 |
| :--- | :--- | :--- | :---: |
| **3CA 三载波聚合** | `GET /api/device/signal`<br/>`GET /api/device/seccellinfo` | 实测激活 **`B1(20MHz) + B3(20MHz) + N78(100MHz)`** 共 **`140 MHz`** EN-DC 三载波聚合；次载波以 8 列分号 CSV 暴露独立 `EARFCN, Band, BW, PCI, RSRP, RSRQ, RSSI, SINR` | ✅ 已验证 |
| **高阶调制与 MIMO** | `GET /api/device/signal`<br/>`GET /api/device/ri` | 实测暴露 4G/5G 上下行 **`256QAM` / `64QAM`** 码字级 MCS 索引、`TM[4]` 闭环空间复用、4G `RI=2` / 5G `nrrank` 流数及双码字 `CQI0/CQI1` | ✅ 已验证 |
| **物理层发射功率** | `GET /api/device/signal` | 独立暴露 4G `<txpower>` 与 5G `<nrtxpower>` 四通道功率：`PPusch`、`PPucch`、`PSrs`、`PPrach` (dBm) | ✅ 已验证 |
| **基站与跟踪区定位** | `GET /api/device/signal`<br/>`GET /api/net/cell-info` | 十进制 `<cell_id>` / `<tac>` 与十六进制 `<cellinfo>` / `<lac>` 100% 数学恒等；支持 28-bit ECI (`eNodeB = ECI >>> 8`) 与 36-bit NCI 精确拆分 | ✅ 已验证 |
| **4G / 5G 邻区扫描** | `GET /api/device/nbrcellinfo` | 原生输出 `<nbrcell_ltelist>` 与 `<nbrcell_nrlist>` 7 列分号 CSV（`EARFCN, Band, PCI, RSRP, RSRQ, RSSI, SINR`），支持一键映射锁小区参数 | ✅ 已验证 |
| **4G / 5G 锁频段与锁小区** | `GET/POST /api/net/net-mode`<br/>`POST /api/net/lock-freq` | 硬件开放 `select_band_switch=1` 与 `lock_freq_switch=3`；支持 4G `LTEBand` 位掩码、5G NR 锁频段 (`lock_mode=3`)、锁频点 (`lock_mode=1`) 与锁 `PCI+ARFCN` 小区 (`lock_mode=2`) | ✅ 已验证 |
| **当日 vs 当月流量审计** | `GET /api/monitoring/month_statistics`<br/>`GET /api/monitoring/traffic-statistics` | 原生支持**当日累计流量 (`<CurrentDayUsed>`)**、**当月上下行分项累计流量**、结算日 (`<StartDay>`) 与实时上下行字节速率 (`CurrentDownloadRate * 8`) | ✅ 已验证 |
| **终端拓扑与双栈租期** | `GET /api/system/HostInfo` (JSON)<br/>`GET /api/system/topology` (JSON) | 精确区分 **`LAN 1000M`** 千兆有线、`2.4GHz` 与 `5GHz` 无线终端，暴露协商 PHY 速率 (Mbps)、RSSI、IPv4/IPv6 双栈地址与剩余 DHCP 租期秒数 | ✅ 已验证 |
| **Wi-Fi 7 (802.11be) MLO** | `GET/POST /api/wlan/wlandbho`<br/>`GET /api/wlan/multi-security-settings-ex` | 原生支持三射频架构（`b/g/n/ax/be` + `a/n/ac/ax/be`）、**MLO 多链路聚合 (`MloEnable`)**、双频优选 (`DbhoEnable`)、EasyMesh 与自动信道优化 | ✅ 已验证 |
| **天线切换、静态 DHCP 与双栈 APN** | `/api/device/antenna_set_type`<br/>`/api/dhcp/static-addr-info`<br/>`/api/dialup/profiles` | 支持自动/内置/外置天线切换与插入状态检测、静态 MAC-IP 绑定管理、`IPv4/IPv6` (`iptype=2`) 双栈 APN 审计与定时维护重启配置 | ✅ 已验证 |

---

## 🏗️ 仓库架构与模块划分

```text
cpe-dash/
├── AGENTS.md                        # 工程架构、协议排他保护与七大安全/TDD 铁律守则
├── .env.example                     # 纯原生环境变量配置模板（默认端口 WEB_PORT=18384）
├── locales/                         # 零依赖强类型双语词典 (zh-CN.json / en.json)
├── public/                          # 离线静态前端占位目录（Phase 3 优先读取 dist/web/public）
├── docs/
│   ├── PHASE1_PROTOCOL_SPEC.md      # H168-383 完整私有协议、逆向算法与阶段一规范字典
│   ├── PHASE2_ARCHITECTURE_REPORT.md # 后端选型、零依赖安全论证与并发架构设计报告
│   └── PHASE2_BACKEND_CONTRACT.md   # Phase 2 -> Phase 3 完整 REST / SSE / MCP 强类型交接契约
├── src/
│   ├── types.ts                     # 全局严格接口与判别联合类型定义
│   ├── config.ts                    # 原生 .env 加载器、SSRF 私网源校验、BlockList CIDR 反代与 /64 桶
│   ├── i18n.ts                      # 零外部依赖编译期键安全多语言引擎 (zh-CN / en)
│   ├── crypto.ts                    # 非钳位大端 Curve25519、Huawei SCRAM-SHA256、AES-256-GCM
│   ├── xml.ts                       # 防原型链污染与防 ReDoS 的线性 O(N) XML 编解码器
│   ├── sanitize.ts                  # IMEI/IMSI/MAC/IP/TAC/CellID/主机名自动化 RFC 脱敏引擎
│   ├── encrypted-file.ts            # StorageCipher (scrypt + HKDF-SHA256 + AES-256-GCM 0600)
│   ├── band-lock.ts                 # 4G/5G BandMask 位运算、ECI/NCI 拆分与锁频锁站载荷构建器
│   ├── parsers.ts                   # 3CA 射频、MCS、发射功率、邻区、双周期流量与拓扑纯解析器
│   ├── cpe-client.ts                # 瞬时会话客户端、防重入保护、双层避让与 108006 熔断器
│   ├── cpe-domain.ts                # 聚合遥测、邻区扫描、锁频锁站、安全开关与 Wi-Fi 7 MLO 领域服务
│   ├── timeseries.ts                # 双层定长环形时序数据库 (5s 细粒度环 + 60s 7天归档环)
│   ├── state-store.ts               # 异步原子加密持久化与密钥轮换自愈状态库
│   ├── scheduler.ts                 # 唯一 CPE 会话出口：优先级互斥队列、双层避让、Layer-2 退避与熔断告警
│   ├── cpe-monitor.ts               # 后台轮询、单飞刷新、快照缓存与时序写入（读侧）
│   ├── cpe-controls.ts              # 锁频锁站、重启重拨与路由器开关（写侧，入队前校验）
│   ├── core.ts                      # FengSuiCore：scheduler + monitor + controls 装配
│   ├── control-input.ts             # REST 与 MCP 共用的入参校验
│   ├── mcp-schema.ts                # MCP 工具 inputSchema 运行时校验器
│   ├── alert-engine.ts              # 持续窗口 + 迟滞告警引擎（离线 / WAN / 信号 / CA / 重启 / 短信存储 / 流量）
│   ├── sms/                         # 短信协议、号码解析、加密镜像、通讯录、SmsService、REST 路由与 MCP 工具
│   ├── notify/                      # Telegram Bot API 客户端与双向机器人、签名 Webhook、通知中心
│   ├── sse-bus.ts                   # /api/events 毫秒级 SSE 扇出总线、慢消费背压剔除与心跳保活
│   ├── mcp-server.ts                # 原生 JSON-RPC 2.0 MCP Server（挂载于守护进程 /mcp）
│   ├── mcp-stdio-bridge.ts          # cpe-dash mcp：零状态 stdio→HTTP /mcp 桥接（不建 CPE 客户端）
│   ├── http-server.ts               # 纵深加固 HTTP/REST/SSE/MCP 路由服务器 (:18384)
│   ├── http-auth.ts / http-static.ts # Cookie 会话、鉴权限流、CSRF / 离线静态资源
│   ├── cli.ts                       # serve 守护进程（数据目录锁）与 mcp 桥接命令行入口
│   └── index.ts                     # 公共 SDK 模块导出入口
├── scripts/
│   ├── audit-secrets.ts             # 工作区 + 全量 Git 历史零密钥/零硬件指纹/纯 TS 扫描门禁
│   └── probe-*.ts                   # 9 项非破坏性真机协议与硬件能力验证探针（probe-sms 只输出聚合计数）
└── test/                            # 基于 node:test 的全离线高覆盖率测试套件 (> 96%)
```

---

## 🚀 快速启动（守护进程、MCP Server 与真机探针）

### 1. 环境准备

```bash
git clone https://github.com/cky008/cpe-dash.git
cd cpe-dash
npm install

cp .env.example .env
chmod 600 .env
# 编辑 .env 填入真实的 CPE_PASSWORD 与独立的 API_TOKEN（切勿提交 .env）
```

### 2. 启动「烽燧」Web / REST / SSE / HTTP-MCP 守护进程

```bash
# 开发热重载模式（Node.js >= 22.6 原生 TypeScript 直接运行）
npm run dev

# 生产编译与启动（默认监听 http://0.0.0.0:18384）
npm run build
npm start
```

### 3. 接入 AI 智能体 (MCP Server)

- **本地 `stdio` 模式**（Claude Desktop / Antigravity / Cursor）：先启动 `serve` 守护进程，再让智能体运行桥接：
  ```bash
  npm run mcp
  # 或指定配置文件：node --experimental-strip-types src/cli.ts mcp --env /path/to/.env
  # （Node 22.18+ / 23.6+ 可省略该标志；所有 npm 脚本已内置）
  ```
  `cpe-dash mcp` 是**零状态桥接**：它从 `.env` 读取 `API_TOKEN` 与 `MCP_DAEMON_URL`（默认 `http://127.0.0.1:<WEB_PORT>/mcp`），把每行 JSON-RPC 转发给守护进程，自身不创建 CPE 客户端、调度器或任何存储，因此不会与守护进程争抢单管理员会话。守护进程未运行时，每个请求都会收到 JSON-RPC 错误 `-32002`；令牌错误等被拒绝时为 `-32001`。旧的 `--poll` 参数已无作用（仅打印警告）。
- **内网 / Tailscale Streamable HTTP 模式**：
  ```bash
  curl -X POST http://127.0.0.1:18384/mcp \
    -H "Authorization: Bearer $API_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
  ```

### 4. 运行只读真机探针套件

```bash
npm run probe:rf          # 采集 3CA 聚合链、256QAM MCS、MIMO 流数、发射功率与基站恒等校验
npm run probe:neighbors   # 扫描周边 4G/5G 候选邻区表 (EARFCN, Band, PCI, RSRP, RSRQ, RSSI, SINR)
npm run probe:traffic     # 读取瞬时上下行速率、当日累计流量与当月累计流量
npm run probe:topology    # 采集千兆 LAN / 2.4G / 5G 终端拓扑、协商速率与双栈 DHCP 租期
npm run probe:session     # 压测 ~26ms 瞬时短连释放并验证双层真人浏览器避让
npm run probe:sms         # 只读：短信计数、列表通道与全量拉取耗时（只输出计数，不发送、不标记、不删除）
```

---

## ✉️ 短信、Telegram 机器人与告警

### 工作方式
- **同步**：守护进程启动时全量同步一次（CPE 上已有短信视为历史，不推送），之后由 5s 遥测会话捎带的 `sms-count` 计数驱动增量同步，另有 30 分钟兜底全量对账。镜像与 CPE 严格一致：删除会同时删除 CPE 与本地记录。
- **发送**：Web、MCP、Telegram 共用 `POST /api/sms/send` 背后的同一条路径：会话前校验号码与长度（GSM-7 / UCS-2，最多 4 段、5 个收件人），会话内提交、轮询发送状态并回读发件记录。
- **真人优先**：有人登录 `http://192.168.8.1` 时，短信写操作返回 `409`，同步暂停，只用免登录接口探测未读数；对方退出后自动补同步。

### 配置 Telegram 机器人
1. 在 Telegram 中找 `@BotFather` 创建机器人，把令牌写入 `.env` 的 `TELEGRAM_BOT_TOKEN`；
2. 二选一：把自己的聊天 ID 写入 `TELEGRAM_CHAT_IDS`，或启动后向机器人发送 `/auth <API_TOKEN>`（令牌消息会被自动删除；`API_TOKEN` 更换后需重新绑定）；
3. 重启 `npm start`，日志中出现 `telegram=on` 即生效。

| 命令 / 交互 | 作用 |
| :--- | :--- |
| 来信卡片 | 发件人、国旗与联系人名，验证码一键复制；**直接回复卡片即发送短信**；按钮：已读 / 查看会话 / 删除（二次确认） |
| `/new` | 引导式发短信：选国家 → 输入号码或联系人名 → 输入正文（显示编码与分段）→ 确认发送 |
| `/send <号码> <正文>` | 快捷发送（同样需要点击确认） |
| `/inbox`、`/unread`、`/chat <号码>` | 会话列表、未读与会话详情（读取本地镜像，不开路由器会话） |
| `/contacts [关键字]`、`/contact <号码> <姓名>`、发送 `.vcf` 文件 | 查询、添加与批量导入联系人 |
| `/status`、`/alerts`、`/sync` | 设备与短信状态、最近告警、立即同步 |
| `/mute 30m\|2h\|1d\|off` | 暂停或恢复告警推送 |

### Webhook
设置 `WEBHOOK_URL` 后，新短信（`sms.received`）与告警（`alert`）以 JSON `POST` 推送。设置 `WEBHOOK_SECRET` 后，接收端可按如下方式校验签名：

```ts
import crypto from "node:crypto";
const expected = "sha256=" + crypto.createHmac("sha256", secret).update(`${req.headers["x-fengsui-timestamp"]}.${rawBody}`).digest("hex");
// 常量时间比较 expected 与 req.headers["x-fengsui-signature"]，并拒绝时间戳偏差过大的请求
```

### 告警
`CPE_UNREACHABLE`、`WAN_DOWN`、`SIGNAL_DEGRADED`（RSRP < `ALERT_RSRP_THRESHOLD_DBM` 或 SINR < `ALERT_SINR_THRESHOLD_DB` 持续 5 分钟）、`CA_DROPPED`、`REBOOT_DETECTED`、`SMS_STORAGE_HIGH` / `SMS_STORAGE_FULL`、`DATA_THRESHOLD` 以及熔断告警，均记录在 `GET /api/alerts` 与 SSE `alert`。级别不低于 `ALERT_NOTIFY_MIN_SEVERITY` 的告警会推送到 Telegram / Webhook。

> **加密密钥提示**：`DATA_ENCRYPTION_KEY` 留空时等于 `CPE_PASSWORD`，而通讯录无法从路由器重新同步。建议设置独立密钥；更换密钥或路由器密码时，先修改 `.env` 并调用 `POST /api/session/reset-breaker`（立即用新密钥重写所有加密文件），再重启。

---

## 🔌 REST API、毫秒级 SSE 与 MCP 工具概览

| 通道类型 | 核心端点 / 工具名 | 功能说明 |
| :--- | :--- | :--- |
| **认证与字典** | `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/i18n/:locale` | `SameSite=Strict; HttpOnly` 会话签发/销毁、离线中英词典拉取 |
| **只读遥测与时序** | `GET /api/telemetry`, `GET /api/timeseries`, `GET /api/neighbors`, `GET /api/topology`, `GET /api/settings` | 零 CPE 开销读取内存最新快照与 `1h/6h/12h/24h/custom` 速率/射频曲线 |
| **主动刷新与扫描** | `POST /api/telemetry/refresh`, `POST /api/neighbors/scan`, `POST /api/topology/refresh`, `POST /api/settings/refresh` | 单飞合并触发一次 `~150ms` 礼貌瞬时采样 |
| **射频与系统控制** | `POST /api/control/band-lock`, `cell-lock`, `unlock`, `reboot`, `reconnect`, `security`, `wifi7`, `antenna`, `mobile-data` | 动态锁 4G/5G 频段与 `PCI+ARFCN` 小区、开关安全/MLO/天线/移动数据（真人在线时礼貌返回 `409`） |
| **会话与熔断器** | `GET /api/session/status`, `POST /api/session/reset-breaker` | 查询调度器/避让/熔断状态；重新读取 `.env` 并重置熔断器 |
| **短信与通讯录** | `GET /api/sms/status`, `threads`, `thread`, `contacts`, `countries`; `POST /api/sms/preview`, `send`, `read`, `delete`, `sync`, `contacts/upsert`, `contacts/delete`, `contacts/import-vcf` | 读接口直读加密镜像（零 CPE 会话）；写接口走控制队列（真人在线时返回 `409`） |
| **告警与通知** | `GET /api/alerts` | 最近 100 条告警与 Telegram / Webhook 投递统计 |
| **实时 SSE 总线** | `GET /api/events` | 实时推送 `hello`（含短信状态）, `speed`, `telemetry`, `neighbors`, `topology`, `settings`, `session:avoidance`, `control:applied`, `alert`, `sms:new`, `sms:sent`, `sms:updated`, `sms:sync`, `sms:status`, `contacts:updated` 及 `: heartbeat` |
| **MCP 智能体工具** | `get_cpe_telemetry`, `query_telemetry_history`, `list_neighbor_cells`, `get_cpe_session_status`, `lock_band`, `lock_cell`, `unlock_rf_locks`, `reboot_cpe` 等 13 项 | 供内网 AI 助手实时诊断 5G 信号、对比邻区、执行锁频锁站与二次确认重启 |
| **MCP 短信工具** | `list_sms_threads`, `get_sms_thread`, `get_sms_status`, `search_contacts`, `preview_sms`, `sync_sms`；`full` 权限追加 `send_sms`, `mark_sms_read`, `delete_sms`, `upsert_contact` | 默认只读；发送需 `confirm: true`、单收件人、默认仅限已知号码并按小时限额 |

完整 TypeScript 请求/响应契约请参阅 👉 **[`docs/PHASE2_BACKEND_CONTRACT.md`](docs/PHASE2_BACKEND_CONTRACT.md)**。

---

## ⚙️ `.env` 配置参考

| 变量名 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `CPE_URL` | `http://192.168.8.1` | CPE 局域网管理地址（严格限制私网单源 Origin，拦截跨网 SSRF） |
| `CPE_USERNAME` | `admin` | H168-383 管理员账号 |
| `CPE_PASSWORD` | *(必填)* | CPE 管理后台密码（`108006` 错误立即触发跨重启持久化熔断） |
| `DATA_ENCRYPTION_KEY` | *(回退至 `CPE_PASSWORD`)* | 本地 `data/*.json`（状态、短信镜像、通讯录、Telegram 状态）静态加密密钥（`scrypt` + `HKDF-SHA256`）；强烈建议独立设置 |
| `API_TOKEN` | *(回退至 `CPE_PASSWORD`)* | Web 登录口令与 REST / `/mcp` Bearer 令牌（推荐独立设置高熵随机串） |
| `TRUSTED_PROXIES` | `127.0.0.1,::1` | 可信反向代理 IP / CIDR 白名单（`net.BlockList` 精确匹配后才解析 `X-Forwarded-For`） |
| `ALLOWED_HOSTS` | *(空)* | 额外放行的 HTTP `Host`（如反代域名），拦截 DNS Rebinding (`421`)；私网/环回/链路本地 IP、`localhost`、`*.local`/`*.lan`/`*.internal`/`*.ts.net` 与单标签主机名始终放行 |
| `WEB_PORT` | `18384` | Web 控制台、SSE 与 `/mcp` 默认监听端口 |
| `DEFAULT_LOCALE` | `zh-CN` | 默认界面与提示语言（`zh-CN` 或 `en`） |
| `MCP_HTTP_ENABLED` | `true` | 是否启用 `POST /mcp` Streamable HTTP 智能体端点（`cpe-dash mcp` 桥接也依赖它） |
| `MCP_DAEMON_URL` | *(由 `WEB_HOST`/`WEB_PORT` 推导)* | `cpe-dash mcp` 桥接转发的守护进程 `/mcp` 地址；须为局域网/环回主机，不得含凭据、查询串或片段 |
| `TZ` | *(系统时区)* | IANA 时区（如 `Europe/Dublin`）；启动与 `reset-breaker` 重载时写入进程环境，发出短信的 `<Date>` 按此生成；进程环境已设置 `TZ` 时以其为准 |
| `MCP_ALLOW_MUTATIONS` | `true` | 是否允许 MCP 调用写操作工具（设为 `false` 仅暴露只读观测工具） |
| `HISTORY_RETENTION_HOURS` | `168` | 环形时序数据库历史保留时长（默认 168 小时 = 7 天） |
| `POLL_INTERVAL_MS` | `5000` | 常规射频与实时速率采样周期（毫秒） |
| `NEIGHBOR_SCAN_INTERVAL_MS` | `60000` | 4G/5G 邻区扫描低频采样周期（毫秒） |
| `RESPECT_BROWSER_SESSION` | `true` | 真人浏览器在线自动挂起避让开关（强烈建议保持 `true`）。设为 `false` 时跳过让位：后台仍尝试登录，被跨 IP 占用（`108003`）时读请求报错、写请求返回 `502` 而非 `409` |
| `SMS_ENABLED` | `true` | 启用短信同步、REST、SSE 与 MCP 短信工具 |
| `DEFAULT_COUNTRY_CODE` | `+353` | 国内号码的默认国家区号 |
| `SMS_FILE` / `CONTACTS_FILE` | *(与 `STATE_FILE` 同目录)* | 加密短信镜像 `sms.json` 与通讯录 `contacts.json` |
| `SMS_FULL_SYNC_INTERVAL_MS` | `1800000` | 兜底全量对账间隔（最小 `60000`） |
| `SMS_SEED_EXISTING_ON_START` | `true` | 首次同步时把已有短信视为历史（不推送） |
| `SMS_AUTO_MARK_READ` | `false` | 推送新短信后自动在 CPE 上标记已读 |
| `SMS_SEND_STATUS_TIMEOUT_MS` | `45000` | 发送状态轮询上限（`5000..120000`） |
| `TELEGRAM_BOT_TOKEN` | *(空)* | Telegram 机器人令牌（留空不启用） |
| `TELEGRAM_CHAT_IDS` | *(空)* | 预授权聊天 ID，逗号分隔（也可用 `/auth <API_TOKEN>` 绑定） |
| `TELEGRAM_API_BASE` / `TELEGRAM_STATE_FILE` | `https://api.telegram.org` / *(同目录 `telegram.json`)* | 自建 Bot API 地址与加密状态文件 |
| `WEBHOOK_URL` / `WEBHOOK_SECRET` | *(空)* | 新短信与告警的 JSON 推送地址与 HMAC 签名密钥 |
| `ALERTS_ENABLED` | `true` | 启用告警引擎 |
| `ALERT_NOTIFY_MIN_SEVERITY` | `warning` | 推送到 Telegram / Webhook 的最低级别（`info` / `warning` / `critical`） |
| `ALERT_RSRP_THRESHOLD_DBM` / `ALERT_SINR_THRESHOLD_DB` | `-110` / `0` | 信号劣化告警阈值 |
| `MCP_SMS_ACCESS` | `read` | MCP 短信工具权限：`none` / `read` / `full` |
| `MCP_SMS_SEND_POLICY` | `known` | `known` 仅限联系人或曾发过短信的号码；`any` 不限制 |
| `MCP_SMS_SEND_LIMIT_PER_HOUR` | `10` | MCP 每小时发送上限（`0` 禁止） |

---

## 🛡️ 七大安全与 TDD 质量门禁

```bash
npm run check
# 依次执行：
# 1. npm run typecheck      -> tsc -p tsconfig.test.json (100% Strict TS，零隐式 any)
# 2. npm run test:coverage  -> c8 强制门禁 (Statements / Lines / Functions >= 90%，实测 > 96%)
# 3. npm run audit:secrets  -> 扫描工作区与完整 git log -p --all 历史，拦截密钥/PII 与任何 .js 源文件
```

---

## 📚 权威技术文档索引

- [`AGENTS.md`](AGENTS.md) — 工程契约、七大安全铁律与强制 TDD 守则
- [`docs/PHASE1_PROTOCOL_SPEC.md`](docs/PHASE1_PROTOCOL_SPEC.md) — 华为 H168-383 私有协议（含 3.8 节短信接口与加密通道）、逆向算法与真机实测字典
- [`docs/PHASE2_ARCHITECTURE_REPORT.md`](docs/PHASE2_ARCHITECTURE_REPORT.md) — 群晖 DS923+ 零依赖后端选型、安全防线、多语言架构与第 5 节短信融合架构
- [`docs/PHASE2_BACKEND_CONTRACT.md`](docs/PHASE2_BACKEND_CONTRACT.md) — Phase 2 → Phase 3 完整 REST API、SSE 事件流、MCP 工具（含短信）与 `cpe-sms` 视图映射表

---

## ⚠️ 免责声明与开源许可

- 本项目为非官方独立自研网管工具，与华为技术有限公司无任何隶属或背书关系。锁频段与锁小区属于底层基带调优操作，请在充分了解所在运营商频谱规划的前提下谨慎使用。
- 本项目基于 **[PolyForm Noncommercial License 1.0.0](LICENSE)** 开源发布，仅限个人与非商业研究用途。
