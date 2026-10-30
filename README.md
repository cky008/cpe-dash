# cpe-dash · 烽燧 (FengSui)

<p align="center">
  <strong>华为 5G CPE Ultra 6 (H168-383) 私有化高阶射频遥测 · 3CA 载波聚合观测 · 邻区扫描与锁频锁站网管平台</strong>
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
    <img src="https://img.shields.io/badge/coverage-96.6%25-brightgreen" alt="Coverage 96.6%" />
  </a>
  <a href="AGENTS.md">
    <img src="https://img.shields.io/badge/security-AES--256--GCM-0052CC?logo=vault&logoColor=white" alt="AES-256-GCM Security" />
  </a>
  <a href=".env.example">
    <img src="https://img.shields.io/badge/WEB__PORT-18384-6E56CF" alt="Default Port 18384" />
  </a>
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/License-PolyForm_Noncommercial_1.0.0-orange.svg" alt="License" />
  </a>
</p>

---

**「烽燧」(FengSui / `cpe-dash`)** 是专为 **华为 5G CPE Ultra 6 (`H168-383`，固件 `4.4.0.1`)** 打造的私有化 5G 射频遥测、载波聚合分析、邻区基站扫描、锁频段/锁小区控制、双周期流量审计与局域网终端拓扑网管底座（专注射频与网管，明确排除短信业务）。

项目针对 **群晖 Synology DS923+ (AMD Ryzen R1600 / 32GB RAM)** 等家庭私有内网环境设计，采用 **100% 严格 TypeScript (`strict: true`)** 独立闭环编写，**生产运行时零外部 npm 依赖**（完全基于 Node.js 原生内置模块），默认监听独立高位端口 `:18384`。

---

## 目录

- [✨ 核心工程与协议特性](#-核心工程与协议特性)
- [📡《H168-383 硬件能力全景表》（真机实测验证）](#-h168-383-硬件能力全景表真机实测验证)
- [🏗️ 仓库架构与模块划分](#️-仓库架构与模块划分)
- [🚀 快速上手与探针实测](#-快速上手与探针实测)
- [⚙️ `.env` 配置参考](#️-env-配置参考)
- [🛡️ 七大安全与 TDD 质量门禁](#️-七大安全与-tdd-质量门禁)
- [📚 权威协议交接字典](#-权威协议交接字典)
- [⚠️ 免责声明与开源许可](#️-免责声明与开源许可)

---

## ✨ 核心工程与协议特性

- **⚡ `~26 ms` 极速瞬时短连与双层真人在线避让**
  - H168-383 硬件限制同一时刻仅允许 1 个管理员在线。`HuaweiCpeClient.withSession()` 将每次鉴权采集严格收敛为瞬时短连（真机实测轻量轮询仅需 **`25 ms – 47 ms`**，18 接口全量并发采集仅需 **`130 ms – 260 ms`**），并在 `finally` 块无条件执行 `POST /api/user/logout` 释放槽位。
  - **双层主动避让**：轮询前先检测 `GET /api/user/state-login`（第 1 层，`State != -1` 即零开销让位）；跨局域网终端已有浏览器在线返回 `108003` / `108009` 时立即静默挂起返回 `null`（第 2 层），绝不抢占或踢掉真人网页后台会话。
- **🛑 `108006` / `108007` 硬件防锁死熔断断路器**
  - 华为固件连续输错 3 次管理密码即触发硬件锁定。内置 `CircuitBreaker` 一旦捕获 `108006`（密码错误）或 `108007`（账户已锁定），立即永久熔断并阻断后续一切网络重试，直至人工修正 `.env` 后显式复位。
- **🔐 全链路密码学与本地静态加密**
  - 完整原生实现华为私有 **SCRAM-SHA256** 握手、**非钳位大端 Curve25519 ECDH** 密钥协商与 **`enc-type=1|2|3` AES-256-GCM** 报文加解密；本地持久化状态通过 `StorageCipher`（`scrypt` + `HKDF-SHA256` + `AES-256-GCM`，`0600` 权限原子替换）加密落盘。
- **🎯 精确频段位掩码 (`BandMask`) 与 4G/5G 锁小区引擎**
  - 基于双端二进制逆向与真机交叉校验，精确实现 `Mask(N) = 1n << BigInt(N - 1)` 任意位宽频段编解码（与真机 14 频段掩码 `0x40000007a0880800d5` 逐位吻合）及 `/api/net/lock-freq` (`lock_mode 0..3`) 载荷构建器。

---

## 📡《H168-383 硬件能力全景表》（真机实测验证）

以下能力均已在局域网 `192.168.8.1` 真机（`H168-383` / `WL1H168M` / 固件 `4.4.0.1(H1006SP19C00)`）通过非破坏性探针实测闭环验证：

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
├── docs/
│   └── PHASE1_PROTOCOL_SPEC.md      # H168-383 完整私有协议、逆向算法与阶段交接规范字典
├── src/
│   ├── types.ts                     # 全局严格接口定义
│   ├── config.ts                    # 原生 .env 加载器、SSRF 内网源校验与可信反代 IP 解析
│   ├── crypto.ts                    # 非钳位大端 Curve25519、Huawei SCRAM-SHA256、AES-256-GCM
│   ├── xml.ts                       # 防原型链污染与防 ReDoS 的线性 O(N) XML 编解码器
│   ├── sanitize.ts                  # IMEI/IMSI/MAC/IP/TAC/CellID/主机名自动化 RFC 脱敏引擎
│   ├── encrypted-file.ts            # StorageCipher (scrypt + HKDF-SHA256 + AES-256-GCM 0600)
│   ├── band-lock.ts                 # 4G/5G BandMask 位运算、ECI/NCI 拆分与锁频锁站载荷构建器
│   ├── parsers.ts                   # 3CA 射频、MCS、发射功率、邻区、双周期流量与拓扑纯解析器
│   ├── cpe-client.ts                # 瞬时会话客户端、双层真人避让与 108006/108007 熔断断路器
│   └── index.ts                     # 统一模块导出入口
├── scripts/
│   ├── audit-secrets.ts             # 工作区 + 全量 Git 历史零密钥/零硬件指纹/纯 TS 扫描门禁
│   ├── probe-har-endpoints.ts       # 探针 #1：HAR 抓包流式解构与去重脱敏 API 提取
│   ├── probe-locking-algo.ts        # 探针 #2：BandMask 位掩码与锁小区算法离线+真机核验
│   ├── probe-rf-ca.ts               # 探针 #3：3CA 载波聚合、TAC、256QAM MCS、MIMO 与发射功率
│   ├── probe-neighbor-cells.ts      # 探针 #4：4G/5G 邻区基站扫描与只读锁站载荷预览
│   ├── probe-traffic.ts             # 探针 #5：实时上下行速率与“当日流量 vs 当月流量”双周期统计
│   ├── probe-topology.ts            # 探针 #6：千兆有线/Wi-Fi 终端分类、协商速率与双栈租期
│   ├── probe-session-avoidance.ts   # 探针 #7：~26ms 瞬时会话压测与双层真人登录自动避让验证
│   └── probe-extended-capabilities.ts # 探针 #8：Wi-Fi 7 MLO、天线模式、静态 DHCP 与双栈 APN 探索
└── test/                            # 基于 node:test 的全离线仿真测试套件（覆盖率 96.6%）
```

---

## 🚀 快速上手与探针实测

### 1. 环境准备

- **Node.js `>= 22.6.0`**（原生支持 TypeScript 类型擦除直接执行与全局 `fetch`）
- 与华为 H168-383 (`192.168.8.1`) 处于同一局域网

```bash
git clone https://github.com/cky008/cpe-dash.git
cd cpe-dash
npm install

cp .env.example .env
chmod 600 .env
# 编辑 .env 填入真实的 CPE_PASSWORD（切勿提交 .env）
```

### 2. 运行真机协议探针套件

所有探针均为 **100% 只读非破坏性操作**，终端输出全程经过 RFC 自动脱敏，单次占用路由器会话仅数毫秒至数百毫秒：

```bash
npm run probe:locking     # 验证 BandMask 位运算与真机 14 频段掩码逐位吻合
npm run probe:rf          # 采集 3CA 聚合链、256QAM MCS、MIMO 流数、发射功率与基站恒等校验
npm run probe:neighbors   # 扫描周边 4G/5G 候选邻区表 (EARFCN, Band, PCI, RSRP, RSRQ, RSSI, SINR)
npm run probe:traffic     # 读取瞬时上下行速率、当日累计流量与当月累计流量
npm run probe:topology    # 采集千兆 LAN / 2.4G / 5G 终端拓扑、协商速率与双栈 DHCP 租期
npm run probe:session     # 压测 ~26ms 瞬时短连释放并验证双层真人浏览器避让
npm run probe:extended    # 探索 Wi-Fi 7 MLO、天线切换、静态 DHCP、双栈 APN 与系统维护状态
```

---

## ⚙️ `.env` 配置参考

| 变量名 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `CPE_URL` | `http://192.168.8.1` | CPE 局域网管理地址（严格限制内网单源 Origin，拦截跨网 SSRF） |
| `CPE_USERNAME` | `admin` | H168-383 管理员账号 |
| `CPE_PASSWORD` | *(必填)* | CPE 管理后台密码（密码错误触发 `108006` 将立即锁死断路器防爆破） |
| `DATA_ENCRYPTION_KEY` | *(回退至 `CPE_PASSWORD`)* | 本地 `data/*.json` 静态加密主密钥（`scrypt` + `HKDF-SHA256` 派生） |
| `API_TOKEN` | *(回退至 `CPE_PASSWORD`)* | Web 控制台与统一 API 访问令牌（常量时间比对） |
| `TRUSTED_PROXIES` | `127.0.0.1,::1` | 可信反向代理白名单（仅白名单对端才解析 `X-Forwarded-For`） |
| `WEB_PORT` | `18384` | Web 控制台默认监听端口（避开 `8080` 与兄弟项目 `18383`） |
| `POLL_INTERVAL_MS` | `5000` | 常规射频与流量采样周期（毫秒） |
| `NEIGHBOR_SCAN_INTERVAL_MS` | `60000` | 邻区扫描低频采样周期（毫秒） |
| `RESPECT_BROWSER_SESSION` | `true` | 真人浏览器在线自动挂起避让开关（强烈建议保持 `true`） |

---

## 🛡️ 七大安全与 TDD 质量门禁

每次提交与构建均须通过全量自动化门禁校验：

```bash
npm run check
# 依次执行：
# 1. npm run typecheck      -> tsc -p tsconfig.test.json (100% Strict TS，零隐式 any)
# 2. npm run test:coverage  -> c8 强制门禁 (当前实测 Statements 96.6% / Functions 98.21% / Lines 96.6%)
# 3. npm run audit:secrets  -> 扫描工作区与完整 git log -p --all 历史，拦截密钥/PII 与任何 .js 源文件
```

完整架构与安全守则请参阅 [`AGENTS.md`](AGENTS.md)。

---

## 📚 权威协议交接字典

有关华为 H168-383 完整 API 路由表、脱敏 XML/JSON 样本、`BandMask` 位移速查表、`lock-freq` 四种模式载荷与会话错误码边界，请参阅：
👉 **[`docs/PHASE1_PROTOCOL_SPEC.md`](docs/PHASE1_PROTOCOL_SPEC.md)**

---

## ⚠️ 免责声明与开源许可

- 本项目为非官方独立自研网管工具，与华为技术有限公司无任何隶属或背书关系。锁频段与锁小区属于底层基带调优操作，请在充分了解所在运营商频谱规划的前提下谨慎使用。
- 本项目基于 **[PolyForm Noncommercial License 1.0.0](LICENSE)** 开源发布，仅限个人与非商业研究用途。
