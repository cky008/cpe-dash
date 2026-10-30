# AGENTS.md — 「烽燧」(FengSui / cpe-dash) 工程、协议安全与 TDD 铁律守则

本文档定义华为 5G CPE Ultra 6 (`H168-383`, 固件 `4.4.0.1`) 私有化射频监控与网管平台 **「烽燧」(FengSui / `cpe-dash`)** 的强制架构契约、类型安全铁律、协议排他避让机制、高危漏洞防御准则及 TDD 质量门禁。所有 AI 编码代理与人类贡献者均须无条件遵守。

---

## 1. 项目定位与独立自包含架构契约

- **项目代号**：「烽燧」(FengSui / `cpe-dash`) —— 面向群晖 Synology DS923+ (AMD Ryzen R1600 / 32GB RAM) 局域网 (`192.168.8.1`) 与私有内网场景打造的 5G 高阶射频监控、3CA 载波聚合观测、4G/5G 邻区扫描、锁频段/锁小区控制、分周期流量审计与终端拓扑管理平台（明确排除短信业务）。
- **100% 独立闭环原则**：`cpe-dash` 必须是完全独立闭环的开源仓库，**严禁对任何外部兄弟目录（如 `cpe-sms`）产生跨目录相对路径引用、`file:` 依赖或软链接**。
- **零运行时外部依赖**：生产运行时仅依赖 Node.js (`>= 22.6.0`) 原生内置模块（`node:crypto`、`node:http`、`node:fs`、`node:net`、全局 `fetch`），彻底杜绝第三方供应链投毒面。
- **默认高位端口隔离**：Web 控制台与统一 API 默认监听 `WEB_PORT=18384`，避开 NAS 常用 `8080` 及兄弟项目端口（如 `18383`）。

```text
cpe-dash/
├── src/
│   ├── types.ts            # 全局严格接口与判别联合类型定义
│   ├── config.ts           # 纯原生 .env 解析器、SSRF Origin 校验与强类型配置加载
│   ├── crypto.ts           # 非钳位大端 Curve25519、Huawei SCRAM-SHA256、AES-256-GCM 双向加解密
│   ├── xml.ts              # 防原型链污染与防 ReDoS 的线性安全 XML 编解码器
│   ├── sanitize.ts         # 敏感标识符（IMEI/IMSI/MAC/IP/TAC/CellID/口令）自动化脱敏引擎
│   ├── encrypted-file.ts   # StorageCipher: scrypt + HKDF-SHA256 + AES-256-GCM (0600) 落盘加密
│   ├── band-lock.ts        # 4G LTE / 5G NR BandMask 精确位运算与锁小区载荷构建器
│   ├── cpe-client.ts       # H168-383 瞬时会话客户端、CSRF 动态令牌池、108006 防爆破断路器
│   └── index.ts            # 公共模块导出入口
├── scripts/
│   ├── audit-secrets.ts    # 工作区 + 全量 Git 历史零密钥/零敏感硬件指纹/纯 TS 门禁扫描器
│   └── probe-*.ts          # 阶段一独立协议与真机硬件能力验证探针集（统一读取 .env 并默认脱敏）
├── test/                   # 基于 node:test + node:assert/strict 的高覆盖率仿真测试集
└── docs/
    └── PHASE1_PROTOCOL_SPEC.md  # H168-383 完整私有协议、逆向算法与阶段交接规范字典
```

---

## 2. 七大工程与安全铁律（Mandatory Invariants）

### 铁律一：100% 严格 TypeScript，绝对禁绝纯 `.js` 源码
- 仓库内所有源码、探针脚本（`scripts/*.ts`）、测试套件（`test/*.test.ts`）与前后端模块**必须 100% 采用严格 TypeScript**，严禁编写、提交或混用任何手写 `.js` / `.mjs` / `.cjs` 源文件（由 [`scripts/audit-secrets.ts`](scripts/audit-secrets.ts) 自动拦截）。
- `tsconfig.json` 强制开启 `"strict": true`、`"noImplicitAny": true`、`"noUncheckedIndexedAccess": true`、`"noUnusedLocals": true`、`"noUnusedParameters": true`、`"erasableSyntaxOnly": true`、`"verbatimModuleSyntax": true` 与 `"rewriteRelativeImportExtensions": true`。
- 严禁使用显式或隐式 `any`；对所有网络 I/O、XML 解析与 `catch (err: unknown)` 必须执行显式类型收窄。

### 铁律二：零密钥与零硬件隐私泄露 (Zero-Secret & Zero-PII Git Hygiene)
- **严禁泄露清单**：在源码、测试夹具、探针终端输出、文档样本及 Git Commit 记录中，**绝对禁止出现**真实管理密码、API Token、真实公网 IPv4/IPv6、真实 Tailscale 节点 IP、个人公网域名、**IMEI**、**IMSI**、**ICCID**、**手机号 (MSISDN)**、**设备序列号 (SN)**、**真实终端 MAC 地址**、**Wi-Fi 真实 SSID/密码** 以及 **真实基站位置指纹（TAC 跟踪区代码、CellID、gNodeB/eNodeB ID）**。
- **RFC 占位测试夹具规范**：
  - CPE 局域网网关：`192.168.8.1`；模拟公网 IPv4：RFC 5737 测试网段（`198.51.100.42` / `203.0.113.10`）；模拟公网 IPv6：RFC 3849（`2001:db8::42`）；
  - 模拟域名：`cpe.example.com`；模拟 MAC：`02:00:5E:10:00:01` / `00:00:5E:00:53:01`（RFC 7042 文档保留地址）；
  - 模拟蜂窝身份：`IMEI=860000000000000`、`IMSI=272010000000000`、`ICCID=8935301000000000000`、`MSISDN=+353830000000`、`TAC=10001`、`CellID=268435457`。
- **物理隔离**：本地 `.env`、`data/*`、`.probe-cache/`、`*.har`、`*.pcap*`、`*.apk*`、`*.dll` 必须写入 [`.gitignore`](.gitignore) 严格隔离；每次提交前必须通过 `npm run audit:secrets` 对工作区与完整 `git log -p --all` 历史进行双向扫描。

### 铁律三：纯原生 `.env` 配置规范
- 所有运行凭证与环境调优参数必须统一通过 [`src/config.ts`](src/config.ts) 从项目根目录 `.env`（及环境变量覆盖）加载，严禁在任何业务逻辑或探针脚本中硬编码密码、IP 或路径，且不引入第三方 `dotenv` 包。

### 铁律四：华为单管理员会话排他保护与真人在线避让
- H168-383 固件严格限制**同一时刻仅允许 1 个管理员会话在线**。若后台守护进程持久霸占会话，用户在浏览器打开 `http://192.168.8.1` 登录时将被迫报错或发生会话抢占。
- **强制瞬时短连 (`withSession`)**：任何需要鉴权的读写操作必须包裹在串行互斥的 `HuaweiCpeClient.withSession()` 中，并在 `finally` 块内无条件调用 `POST /api/user/logout`（实测单次会话占用窗口控制在 `~150ms–250ms` 量级）。
- **真人在线主动避让 (`state-login` 预检)**：每次发起登录前，必须先以免登录方式请求 `GET /api/user/state-login`。当 `respectBrowserSession: true`（后台轮询与探针默认开启）且返回 `<State>` 不为 `"-1"`（例如 `<State>0</State>` 表示真人管理员已在线）时，客户端必须**立即静默挂起让位（返回 `null`）**，严禁强行发起 `challenge_login`。

### 铁律五：`108006` / `108007` 防爆破熔断断路器 (Circuit Breaker)
- H168-383 连续输错 3 次管理密码即触发硬件级账户锁定（`<error><code>108007</code></error>` 或 `<lockstatus>1</lockstatus>`）。
- 当登录握手返回错误码 `108006`（密码错误）、`108002`、`108001` 或检测到 `108007` / `lockstatus === "1"` 时，客户端内置断路器（`CircuitBreaker`）必须**立即熔断锁死**，绝对禁止自动重试，并在后续调用中直接短路抛出熔断异常，直至人工修正 `.env` 并显式重置后方可恢复。

### 铁律六：现代 Web 高危漏洞纵深防御
1. **CSRF 防御**：所有会话 Cookie 强制设置 `HttpOnly; SameSite=Strict`（在受信任 HTTPS 反代下追加 `Secure`）；所有状态变更请求（`POST`/`PUT`/`DELETE`）强制校验自定义请求头（`X-Requested-With: XMLHttpRequest`）与常量时间比对（`crypto.timingSafeEqual`）的鉴权令牌。
2. **防伪造反代头绕过限流**：速率限制器与审计日志默认提取底层 Socket 直连地址 `req.socket.remoteAddress`；仅当直连对端精确命中 `.env` 中 `TRUSTED_PROXIES` 白名单时，才允许解析 `X-Forwarded-For` / `X-Forwarded-Proto`。
3. **防原型链污染 (Prototype Pollution)**：解析外部 JSON、URL Query 或 XML 键值映射时统一使用无原型字典（`Object.create(null)`）或 `Map`，并显式拦截过滤 `__proto__`、`constructor`、`prototype` 危险键名。
4. **防正则回溯拒绝服务 (ReDoS)**：对 HTTP 请求体、XML 报文及正则输入施加上限截断（如单报文上限校验），采用确定性边界扫描提取标签，严禁在未受信输入上运行含嵌套量词的回溯正则。
5. **防服务端请求伪造 (SSRF)**：[`normalizeCpeUrl()`](src/config.ts) 严格校验协议仅限 `http:` / `https:`、禁止内嵌 `username:password@`、禁止查询串与片段注入，并强制校验目标主机属于合法局域网/私网地址空间（RFC 1918 / RFC 6598 / Loopback / 本地单节点），请求全程启用 `redirect: "error"` 阻断跨源重定向逃逸。

### 铁律七：强制 TDD（红-绿-重构）与 >= 90% 覆盖率质量门禁
1. **Red（先写失败测试）**：新功能、逆向算法（如 `BandMask` 位运算、锁小区载荷）或异常边界修复前，先在 `test/*.test.ts` 编写基于 `node:test` 与注入式 `fetchImpl` 替身的自动化仿真测试（**单元测试严禁访问真实 `192.168.8.1` 硬件**）。
2. **Green（最小干净实现）**：编写严格类型的 TypeScript 实现使测试通过。
3. **Refactor & Gate（全量门禁校验）**：每次 Git Commit 前必须跑通 `npm run check` 且退出码为 `0`：
   - `npm run typecheck`：全仓 `src/` + `scripts/` + `test/` 零类型错误；
   - `npm run test:coverage`：`c8` 语句覆盖率 `>= 90%`、行覆盖率 `>= 90%`、函数覆盖率 `>= 90%`；
   - `npm run audit:secrets`：工作区与全量 Git 历史零密钥、零敏感指纹、零 `.js` 混入。

---

## 3. Git 提交规范 (Conventional Commits)

- 每完成一个独立里程碑、规范定义或探针实测验证，必须立即执行原子化提交：
  `<type>(<scope>): <concise imperative summary>`（`type` 限 `feat` | `fix` | `refactor` | `security` | `test` | `docs` | `chore`）。
- 提交前必须确认 `npm run check` 全绿，且暂存区不包含任何未脱敏抓包或临时产物。
