# AGENTS.md — 「烽燧」(FengSui / cpe-dash) 工程、协议安全与 TDD 铁律守则

本文档定义私有化射频监控与网管平台 **「烽燧」(FengSui / `cpe-dash`)** 的强制架构契约（已验证型号：华为 5G CPE Ultra 6 `H168-383`，固件 `4.4.0.1`；其他华为型号只读兼容，未验证）、类型安全铁律、协议排他避让机制、高危漏洞防御准则及 TDD 质量门禁。所有 AI 编码代理与人类贡献者均须无条件遵守。

---

## 1. 项目定位与独立自包含架构契约

- **项目代号**：「烽燧」(FengSui / `cpe-dash`) —— 面向群晖 Synology DS923+ (AMD Ryzen R1600 / 32GB RAM) 局域网 (`192.168.8.1`) 与私有内网场景打造的 5G 高阶射频监控、3CA 载波聚合观测、4G/5G 邻区扫描、锁频段/锁小区控制、分周期流量审计、终端拓扑管理，以及短信收发（加密镜像、通讯录、Telegram 双向机器人、签名 Webhook 与告警推送）一体化平台。
- **兼容范围**：**已验证型号 H168-383（固件 `4.4.0.1`），其他华为型号只读兼容（未验证）。** 写闸门在服务端（`src/device-access.ts` + 调度器 `executeControl`）：未验证型号的写操作默认被拒绝（`409 DEVICE_UNVERIFIED_READ_ONLY`），只有用户在控制台为该型号逐项知情同意的实验性写入（通用实现、写后回读核对，协议附录 A.11）放行，REST、MCP、Telegram 与自愈都绕不过去；读取按路由器实际提供的项目宽容进行（协议附录 A.10）。对外只说「仅在 H168-383 上验证过」。本守则的铁律对所有型号一视同仁，不因兼容其他型号而放松。
- **短信与遥测同源调度**：短信不再由独立进程（如旧 `cpe-sms`）登录 CPE，而是与遥测共用唯一的 `MutexSessionScheduler`，从根本上消除单管理员会话争抢。
- **100% 独立闭环原则**：`cpe-dash` 必须是完全独立闭环的开源仓库，**严禁对任何外部兄弟目录（如 `cpe-sms`）产生跨目录相对路径引用、`file:` 依赖或软链接**。
- **零运行时外部依赖**：生产运行时仅依赖 Node.js (`>= 22.6.0`) 原生内置模块（`node:crypto`、`node:http`、`node:fs`、`node:net`、全局 `fetch`），彻底杜绝第三方供应链投毒面。
- **默认高位端口隔离**：Web 控制台与统一 API 默认监听 `WEB_PORT=18384`，避开 NAS 常用 `8080` 及兄弟项目端口（如 `18383`）。

```text
cpe-dash/
├── src/
│   ├── types.ts            # 全局严格接口与判别联合类型定义（含 AppConfig）
│   ├── config.ts           # 纯原生 .env 解析器、SSRF Origin 校验与强类型配置加载
│   ├── crypto.ts           # 非钳位大端 Curve25519、Huawei SCRAM-SHA256、AES-256-GCM 双向加解密
│   ├── xml.ts              # 防原型链污染与防 ReDoS 的线性安全 XML 编解码器（含 PreEscapedXmlText）
│   ├── sanitize.ts         # 敏感标识符（IMEI/IMSI/MAC/IP/TAC/CellID/口令/手机号）自动化脱敏引擎（探针输出与抓包审计）
│   ├── redact.ts           # REDACT_SENSITIVE_IN_API 输出边界：Bearer API / SSE / MCP 拿脱敏副本，Web 控制台拿原值
│   ├── encrypted-file.ts   # StorageCipher: scrypt + HKDF-SHA256 + AES-256-GCM (0600) 落盘加密、原子写入与单进程文件锁
│   ├── state-store.ts · timeseries.ts  # 加密运行时状态（熔断锁存、锁定状态、缓存快照、告警）与双层环形时序（5s / 60s）
│   ├── band-lock.ts        # 4G LTE / 5G NR BandMask 精确位运算与锁小区载荷构建器
│   ├── parsers.ts          # 3CA 射频、邻区、双周期流量与终端拓扑纯函数解析器
│   ├── cpe-client.ts       # H168-383 瞬时会话客户端、双层真人避让与 108006 防爆破断路器
│   ├── cpe-auth.ts         # 登录方式选择（提交密码前定：password_type → SCRAM 挑战探测 → 旧式 SHA-256 / base64）与 SesTokInfo 令牌解析
│   ├── cpe-domain.ts       # 遥测/邻区/拓扑/设置采集与控制写操作（含 sms-count 捎带）
│   ├── scheduler.ts        # MutexSessionScheduler：唯一 CPE 会话调度器（优先级队列、避让、熔断）
│   ├── cpe-monitor.ts      # 读侧：后台轮询、单飞刷新、快照缓存与时序写入；启动后识别路由器一次（当时连不上则在第一次读成功后补上；不进入轮询）
│   ├── cpe-controls.ts     # 写侧：锁频锁站、重启重拨、路由器开关、设备访问控制（入队前校验）
│   ├── generic-writes.ts   # 未验证型号的实验性写入（附录 A.11 的 HiLink 格式）：LTE 锁频、重启、重拨、移动数据，同一会话回读核对，绝不重试（明文短信写入在 sms/protocol.ts）
│   ├── access-state.ts · access-plan.ts  # 零依赖：Wi-Fi MAC 过滤状态与访问控制规划（受保护设备、名单、上网时段冲突；前后端同一实现）
│   ├── access-control.ts   # Wi-Fi MAC 过滤与上网时段的报文解析、读写与回读核对（一个控制会话内完成）
│   ├── core.ts             # FengSuiCore 装配（scheduler + monitor + controls）
│   ├── alert-engine.ts     # 持续窗口 + 迟滞告警引擎（离线、WAN、信号、CA、重启、短信容量、流量阈值）
│   ├── self-heal.ts        # 可选 WAN 自愈（默认关闭）：锁定后 WAN 不恢复则自动解锁、WAN 掉线限次重拨（从不重启）；监视与重拨额度存于 state.json，重启后接着算
│   ├── firmware.ts         # 零依赖：已验证的型号 / 固件版本清单、验证状态（已验证 / 已验证型号的新固件 / 未验证型号）与固件核对提示词（未验证版本只告警，不阻止写操作；控制台与在线演示共用）
│   ├── device-profile.ts   # 零依赖：型号识别与能力探测（固定的只读 GET 清单，未验证型号另加实验性写入回读要读的 3 个；四种接口状态；实验性写入的能力依据）、路由器错误码计数与只含结构的脱敏设备报告（守护进程、控制台与在线演示同一实现）
│   ├── device-access.ts    # 零依赖：写闸门（未验证型号只读，逐项同意的实验性写入除外；只相信本次运行看到的型号，否则写操作先在自己的会话里确认）、每个写操作所属的功能与它在这台路由器上的状态、写入记录与回读结果的类型，以及未验证型号各读取项可用与否
│   ├── feedback.ts         # 零依赖：兼容性反馈入口（cky008/cpe-dash 新 issue 的地址，只带模板与标题，绝不带报告内容）
│   ├── console-settings.ts # 控制台管理的加密设置：路由器连接、登录密码（scrypt）、令牌（SHA-256，可过期 / 撤销）、一次性设置 / 重置 / 绑定码、实验性写入的同意（按型号 + 功能）；首次启动从 .env 导入一次
│   ├── http-settings.ts    # /api/console/*：先测后存的路由器连接、改密码、令牌、Telegram 绑定码、开关（只接受控制台 Cookie 会话）
│   ├── audit-log.ts        # 加密审计日志与 AsyncLocalStorage 调用方上下文（网页 / 令牌 / MCP / Telegram / 自愈）
│   ├── metrics.ts          # GET /metrics：Prometheus 文本格式，只读缓存快照与守护进程自身的内存 / CPU / 事件循环延迟（RuntimeSampler），不含任何设备标识
│   ├── sms/                # 短信：编解码、号码解析、协议、加密镜像、通讯录、应用服务、REST 路由与 MCP 工具
│   ├── notify/             # Telegram Bot API 客户端与双向机器人、签名 Webhook、通知中心
│   ├── http-server.ts      # REST / SSE / Streamable HTTP MCP 路由（Host 白名单）；http-auth.ts 会话与限流、http-static.ts 静态资源
│   ├── control-input.ts    # REST、MCP 与在线演示共用的入参校验（零依赖；control-error.ts 为其错误类）；mcp-schema.ts 工具 inputSchema 运行时校验
│   ├── sse-bus.ts          # /api/events SSE 总线
│   ├── mcp-server.ts       # 零依赖 JSON-RPC MCP Server（可插拔工具提供者，挂载于 /mcp；mcp-core-tools.ts 核心 13 项工具、mcp-access-tools.ts 访问控制工具、mcp-tool-provider.ts 提供者契约、mcp-headers.ts 2026-07-28 路由头）
│   ├── mcp-stdio-bridge.ts # cpe-dash mcp：零状态 stdio→HTTP /mcp 桥接（不连接 CPE）
│   ├── cli.ts              # serve 守护进程（数据目录锁、运行时装配与有序启停）与 mcp 桥接入口
│   ├── maintenance.ts      # cpe-dash doctor / backup / restore / rekey：离线自检、加密备份与恢复、换密钥与找回被隔离的数据（不连接 CPE）
│   ├── peer-guard.ts       # 跨主机重复守护进程保护：scrypt 派生密钥签名的 UDP 广播信标，较晚启动者待机
│   ├── json-safe.ts · http-body.ts · text-sanitize.ts · i18n.ts · version.ts  # 无原型 JSON 解析、有界读取响应体、控制字符清理、后端中英词典（locales/*.json）、版本号
│   ├── api-contract.ts     # REST / SSE 载荷类型（服务端以 satisfies 校验，Web 前端直接复用）
│   ├── rf-bounds.ts · privacy-mask.ts · units.ts · console-policy.ts · self-heal-status.ts · sms/{text-mode,otp,vcard,thread-view}.ts  # 零依赖共享模块：锁定边界、脱敏规则、流量单位、控制台密码与令牌规则、短信分段 / 验证码 / vCard / 会话列表（守护进程、控制台与在线演示同一实现）
│   └── index.ts            # 公共模块导出入口
├── web/                    # 「烽燧」Web 控制台：100% 严格 TS（tsconfig.web.json）+ Tailwind v4 / daisyUI v5，离线构建到 dist/web/public
│   ├── index.html · styles.css · brand/logo.svg（标志唯一来源：构建生成页面图标与 favicon.svg）
│   ├── site/main.ts        # 文档站唯一的脚本（主题、复制、搜索、目录高亮），无导入、无外部请求
│   └── src/                # core/（无 DOM、node:test 覆盖率门禁；core/help.ts 为术语帮助：每个专业名词的一句话解释与文档站锚点，ui/help.ts 画「?」，「设置 → 外观」可关）· ui/（视图）· i18n/（类型化中英词典）· demo/（在线演示的页面内后端，纳入覆盖率门禁）· boot.ts · main.ts
├── scripts/
│   ├── audit-secrets.ts    # 工作区 + 全量 Git 历史零密钥/零敏感硬件指纹/纯 TS 门禁扫描器（覆盖 src/ scripts/ test/ web/）
│   ├── build-web.ts        # esbuild 代码分割 + Tailwind CLI，内容哈希资源与 gzip 体积预算（--demo 构建 GitHub Pages 在线演示）
│   ├── demo-router.ts      # 演示世界：严格 Mock 路由器 + 家庭场景 + 真实守护进程启动（demo-server、种子采集与契约测试共用）
│   ├── demo-server.ts      # npm run demo：真实守护进程栈 + 进程内严格 Mock 路由器（不读 .env、不联网）
│   ├── capture-demo-seed.ts # npm run build:demo：从真守护进程录制在线演示的初始数据（只含占位值）
│   ├── screenshots.ts      # npm run screenshots：本机无头 Chrome（DevTools 协议，零依赖）从演示环境重拍 docs/screenshots/，发版前运行
│   ├── cdp.ts              # 零依赖 DevTools 驱动（Node 自带 WebSocket）：启动无头 Chrome、打开页面、求值、等待、点击、截图；screenshots 与浏览器测试共用
│   ├── brand.ts · trace-logo.ts  # 标志：检查 web/brand/logo.svg 并生成页面 <symbol>（构建时）；npm run brand:trace 把 PNG 概念图描成源文件（见 docs/BRAND.md）
│   ├── build-docs.ts · markdown.ts · site-home.ts  # npm run build:docs：零依赖 Markdown 渲染 + 文档站（主页、用户指南、⌘K 搜索、SEO；域名只来自 DOCS_SITE_URL），输出 dist/site
│   ├── release-notes.ts    # 从 CHANGELOG.md 对应版本段落生成 GitHub Release 说明：欢迎语、升级须知、`### Highlights` 亮点、按类分组只列每项首句（release.yml 的 notes 任务调用，标题只用版本号）
│   └── probe-*.ts          # 只读真机探针集（统一读取 .env 并默认脱敏；probe-sms 只输出聚合计数）
├── test/                   # 基于 node:test + node:assert/strict 的高覆盖率仿真测试集（helpers/ 内含加密 Mock 路由器；ci-config 守护 Action 的 SHA 固定，audit-gate 覆盖 audit:secrets 规则；ui/ 为 npm run test:ui 的浏览器测试：无头 Chrome 对着真实守护进程与演示路由器，不在 npm run check 里，CI 运行）
├── Dockerfile · docker-compose.yml · .dockerignore   # 非 root、只读根文件系统、HEALTHCHECK 的生产镜像与群晖编排
├── LICENSE · THIRD_PARTY_NOTICES.md                # PolyForm Noncommercial 1.0.0；构建产物所含 Tailwind CSS / daisyUI / Lucide 的许可声明（构建放到控制台旁，镜像放在 /app）
├── .github/workflows/      # ci-docker.yml（门禁 + amd64 镜像冒烟）· release.yml（打 tag 推送 GHCR 多架构镜像）· demo-pages.yml（打 tag 发布在线演示到公开仓库 fengsui-demo）· docs-pages.yml（文档站发布到本仓库 Pages，仓库变量 DOCS_PAGES_ENABLED 打开后才运行）
├── .github/ISSUE_TEMPLATE/ # device-report.yml：其他型号的兼容性报告表单（型号、固件、能用 / 不能用、报告、隐私确认）；bug-report.yml、feature-request.yml；config.yml 把安全问题引到私密报告
├── .github/pull_request_template.md · SECURITY.md · CONTRIBUTING.md · CODE_OF_CONDUCT.md  # PR 隐私自检、漏洞私密报告与范围、贡献规则（TDD、占位值、零运行时依赖）、行为准则（Contributor Covenant 2.1）
└── docs/
    ├── PHASE1_PROTOCOL_SPEC.md       # H168-383 完整私有协议（含短信接口）、逆向算法与阶段交接规范字典
    ├── PHASE2_ARCHITECTURE_REPORT.md # 架构选型、调度器、时序引擎与短信融合架构
    ├── PHASE2_BACKEND_CONTRACT.md    # REST / SSE / MCP 权威契约（含短信、告警与 cpe-sms 视图映射）
    ├── BRAND.md                      # 标志：唯一来源、颜色如何跟随主题、怎么换标志
    ├── guide/{zh,en}/*.md            # 用户指南（快速开始、安装、功能、Docker Compose 配置、配置参考、安全、备份、其他型号、排障、FAQ）：文档站与 README 的来源，中英文逐页对应；配置参考与智能体页由 contract-manifest 测试保证覆盖每个设置与工具
    └── site/site.css                 # 文档站样式（Tailwind v4，浅色 / 深色）
```

---

## 2. 七大工程与安全铁律（Mandatory Invariants）

### 铁律一：100% 严格 TypeScript，绝对禁绝纯 `.js` 源码
- 仓库内所有源码、探针脚本（`scripts/*.ts`）、测试套件（`test/*.test.ts`）与前后端模块**必须 100% 采用严格 TypeScript**，严禁编写、提交或混用任何手写 `.js` / `.mjs` / `.cjs` 源文件（由 [`scripts/audit-secrets.ts`](scripts/audit-secrets.ts) 自动拦截）。
- `tsconfig.json` 强制开启 `"strict": true`、`"noImplicitAny": true`、`"noUncheckedIndexedAccess": true`、`"noUnusedLocals": true`、`"noUnusedParameters": true`、`"erasableSyntaxOnly": true`、`"verbatimModuleSyntax": true` 与 `"rewriteRelativeImportExtensions": true`。
- 严禁使用显式或隐式 `any`；对所有网络 I/O、XML 解析与 `catch (err: unknown)` 必须执行显式类型收窄。

### 铁律二：零密钥与零硬件隐私泄露 (Zero-Secret & Zero-PII Git Hygiene)
- **严禁泄露清单**：在源码、测试夹具、探针终端输出、文档样本及 Git Commit 记录中，**绝对禁止出现**真实管理密码、API Token、真实公网 IPv4/IPv6、真实 Tailscale 节点 IP、个人公网域名（例外只有两个：作者主页链接 `https://iocky.com/`（控制台与文档站的页脚、文档站的常见问题），以及项目文档站 `https://fengsui.iocky.com/`（README、发布说明、docker-compose.yml 与控制台术语帮助的链接）；NAS 反代主机名等其他任何子域名仍然禁止）、**IMEI**、**IMSI**、**ICCID**、**手机号 (MSISDN)**、**设备序列号 (SN)**、**真实终端 MAC 地址**、**Wi-Fi 真实 SSID/密码** 以及 **真实基站位置指纹（TAC 跟踪区代码、CellID、gNodeB/eNodeB ID，以及服务小区与邻区的 PCI + 频点组合：同一运营商的频点加上几个 PCI 就能在公开基站数据库里定位到具体站点）**。
- **RFC 占位测试夹具规范**：
  - CPE 局域网网关：`192.168.8.1`；模拟公网 IPv4：RFC 5737 测试网段（`198.51.100.42` / `203.0.113.10`）；模拟公网 IPv6：RFC 3849（`2001:db8::42`）；
  - 模拟域名：`cpe.example.com`；模拟 MAC：`02:00:5E:10:00:01` / `00:00:5E:00:53:01`（RFC 7042 文档保留地址）；
  - 模拟蜂窝身份：`IMEI=860000000000000`、`IMSI=272010000000000`、`ICCID=8935301000000000000`、`MSISDN=+353830000000`、`TAC=10001`、`CellID=134217758`。
  - 模拟小区（演示世界、测试夹具与协议样本统一使用）：LTE PCC `B1 / EARFCN 300`、SCC `B3 / EARFCN 1850`、NR `N78 / NR-ARFCN 650000`，PCI `211` / `142`；绝不从真机抓包或探针输出复制 PCI 与频点。
- **物理隔离**：本地 `.env`、`data/*`、`.probe-cache/`、`*.har`、`*.pcap*`、`*.apk*`、`*.dll` 必须写入 [`.gitignore`](.gitignore) 严格隔离；每次提交前必须通过 `npm run audit:secrets` 对工作区与完整 `git log -p --all` 历史进行双向扫描。
- **短信与通知隐私铁律**：
  - 严禁在源码、测试夹具、文档、Issue、探针输出与 Commit 中出现**真实手机号、短信正文、验证码 (OTP)、联系人姓名/备注、Telegram Bot Token、真实 Telegram 聊天 ID、Webhook 地址与签名密钥**；`audit-secrets` 会把 `.env` 中的 `TELEGRAM_BOT_TOKEN`、`TELEGRAM_CHAT_IDS`、`WEBHOOK_URL`、`WEBHOOK_SECRET` 视为字面量密钥扫描。
  - 测试号码与文档示例只用保留号段：爱尔兰 `+3538300000xx`、英国 Ofcom 影视号段 `+447700900xxx`、中国 `+8613000000000`（`audit:secrets` 拦截工作区里其他完整国际号码，只报文件与行号）；字母发件人用 `DemoBank`、`Three` 等虚构名；Telegram 夹具用短 ID（如 `1001`）。
  - 日志、控制摘要（`control:applied`）与审计输出中的号码一律经 `maskPhoneNumber()` 脱敏，**严禁记录短信正文与验证码**；`probe-sms` 只输出计数、列表通道与会话耗时。
  - 短信镜像、通讯录与 Telegram 状态必须经 `StorageCipher` 加密落盘（`0600`）；消息标识统一使用不含号码的不透明 `uid`（索引 + 时间 + 号码的 SHA-256 截断），不得以号码或会被复用的 CPE 索引充当消息 ID。
  - 测试与探针**严禁向任何真实号码发送短信**；发送、标记已读、删除仅在注入式 Mock 路由器上验证。

### 铁律三：纯原生 `.env` 配置规范
- 所有启动参数与环境调优参数必须统一通过 [`src/config.ts`](src/config.ts) 从项目根目录 `.env`（及环境变量覆盖）加载，严禁在任何业务逻辑或探针脚本中硬编码密码、IP 或路径，且不引入第三方 `dotenv` 包。
- v1.5.0 起，路由器连接、控制台登录密码与 API 令牌由控制台管理，加密保存在 `settings.json`（[`src/console-settings.ts`](src/console-settings.ts)）：`.env` 中的 `CPE_*` / `API_TOKEN*` 只在首次启动时导入一次。密码只存 scrypt 哈希、令牌只存 SHA-256；任何令牌都不能修改控制台设置。探针脚本仍从 `.env` 读取路由器凭据。

### 铁律四：华为单管理员会话排他保护与真人在线避让
- H168-383 固件严格限制**同一时刻仅允许 1 个管理员会话在线**。若后台守护进程持久霸占会话，用户在浏览器打开 `http://192.168.8.1` 登录时将被迫报错或发生会话抢占。
- **强制瞬时短连 (`withSession`)**：任何需要鉴权的读写操作必须包裹在串行互斥的 `HuaweiCpeClient.withSession()` 中，并在 `finally` 块内无条件调用 `POST /api/user/logout`（真机实测单次会话占用窗口仅 `~26ms–260ms`）。
- **短信同样受本铁律约束**：短信同步、发送、标记已读与删除只能经 `SmsService` 进入 `MutexSessionScheduler`（读走 `executeRead`、写走 `executeControl`），短信计数捎带在 5s 遥测会话内，严禁另起轮询或独立登录。只有 `serve` 守护进程连接 CPE：它独占数据目录（`state.json.lock`），第二个守护进程启动即失败；`cpe-dash mcp` 是转发到守护进程 `/mcp` 的零状态 stdio 桥接，严禁在其他进程中实例化 `HuaweiCpeClient` 或调度器。
- **双层真人在线主动避让（`state-login` 预检 + 跨 IP `108003` 让位）**：每次发起登录前先请求 `GET /api/user/state-login`；当 `respectBrowserSession: true`（后台轮询与探针默认开启）时，若 `<State>` 不为 `"-1"`（第 1 层）或跨局域网终端已有浏览器在线返回 `108003`/`108009`（第 2 层），客户端必须**立即静默挂起让位（返回 `null`）**，严禁强行抢占或循环重试干扰真人会话。

### 铁律五：`108006` / `108007` 防爆破熔断断路器 (Circuit Breaker)
- H168-383 连续输错 3 次管理密码即触发硬件级账户锁定（`<error><code>108007</code></error>` 或 `<lockstatus>1</lockstatus>`）。
- 当登录握手返回错误码 `108006`（密码错误）、`108002`、`108001` 或检测到 `108007` / `lockstatus === "1"` 时，客户端内置断路器（`CircuitBreaker`）必须**立即熔断锁死**，绝对禁止自动重试，并在后续调用中直接短路抛出熔断异常，直至人工修正 `.env` 并显式重置后方可恢复。

### 铁律六：现代 Web 高危漏洞纵深防御
1. **CSRF 防御**：所有会话 Cookie 强制设置 `HttpOnly; SameSite=Strict`（在受信任 HTTPS 反代下追加 `Secure`）；所有状态变更请求（`POST`/`PUT`/`DELETE`）强制校验自定义请求头（`X-Requested-With: XMLHttpRequest`）与常量时间比对（`crypto.timingSafeEqual`）的鉴权令牌。
2. **防伪造反代头绕过限流**：速率限制器与审计日志默认提取底层 Socket 直连地址 `req.socket.remoteAddress`；仅当直连对端精确命中 `.env` 中 `TRUSTED_PROXIES` 白名单时，才允许解析 `X-Forwarded-For` / `X-Forwarded-Proto`。
3. **防原型链污染 (Prototype Pollution)**：解析外部 JSON、URL Query 或 XML 键值映射时统一使用无原型字典（`Object.create(null)`）或 `Map`，并显式拦截过滤 `__proto__`、`constructor`、`prototype` 危险键名。
4. **防正则回溯拒绝服务 (ReDoS)**：对 HTTP 请求体、XML 报文及正则输入施加上限截断（如单报文上限校验），采用确定性边界扫描提取标签，严禁在未受信输入上运行含嵌套量词的回溯正则。
5. **MCP 提示词注入防御**：短信正文与发件人名称来自第三方，MCP 工具结果必须附带不可信数据声明；`send_sms` / `delete_sms` 强制 `confirm: true`，`send_sms` 单收件人、默认仅限已知号码 (`MCP_SMS_SEND_POLICY=known`) 且按小时限额，`delete_sms` 默认拒绝删除未读短信。Telegram `/auth` 采用常量时间比对并按聊天与全局双重限流。
6. **防服务端请求伪造 (SSRF)**：[`normalizeCpeUrl()`](src/config.ts) 严格校验协议仅限 `http:` / `https:`、禁止内嵌 `username:password@`、禁止查询串与片段注入，并强制校验目标主机属于合法局域网/私网地址空间（RFC 1918 / RFC 6598 / Loopback / 本地单节点），请求全程启用 `redirect: "error"` 阻断跨源重定向逃逸。

### 铁律七：强制 TDD（红-绿-重构）与 >= 90% 覆盖率质量门禁
1. **Red（先写失败测试）**：新功能、逆向算法（如 `BandMask` 位运算、锁小区载荷）或异常边界修复前，先在 `test/*.test.ts` 编写基于 `node:test` 与注入式 `fetchImpl` 替身的自动化仿真测试（**单元测试严禁访问真实 `192.168.8.1` 硬件**）。
2. **Green（最小干净实现）**：编写严格类型的 TypeScript 实现使测试通过。
3. **Refactor & Gate（全量门禁校验）**：每次 Git Commit 前必须跑通 `npm run check` 且退出码为 `0`：
   - `npm run typecheck`：全仓 `src/` + `scripts/` + `test/` 零类型错误；
   - `npm run build:web`：构建 Web 控制台，首屏与按需加载合计超过 160 KiB gzip 即失败（与 CI、发版和 Docker 构建同一上限）；
   - `npm run test:coverage`：`c8` 语句覆盖率 `>= 90%`、行覆盖率 `>= 90%`、函数覆盖率 `>= 90%`；
   - `npm run audit:secrets`：工作区与全量 Git 历史零密钥、零敏感指纹、零 `.js` 混入。

---

## 3. Git 提交规范 (Conventional Commits)

- 每完成一个独立里程碑、规范定义或探针实测验证，必须立即执行原子化提交：
  `<type>(<scope>): <concise imperative summary>`（`type` 限 `feat` | `fix` | `refactor` | `security` | `test` | `docs` | `chore` | `ci` | `release`；`ci` 用于 Docker / 工作流，`release` 仅用于版本发布提交）。
- 提交前必须确认 `npm run check` 全绿，且暂存区不包含任何未脱敏抓包或临时产物。
