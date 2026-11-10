# 支持与潜在支持设备列表 (Supported & Potentially Supported Devices)

> **怎么读这份表**：这是各品牌路由器管理接口资料里的型号汇总，不是实测结果。烽燧只在华为 H168-383（固件 4.4.0.1）上做过真机验证。其余每一行的两列都来自接口资料：前一列是资料记载该型号具备的功能，后一列是资料里也标为待验证的部分，两列都没有人用烽燧在真机上确认过。
>
> 烽燧在每个品牌上实际实现了什么，以[支持的设备](docs/guide/zh/supported-devices.md)为准（那一页的表由代码生成）。其他品牌目前实现的是信号、附近的基站、锁频段、锁小区和重启；资料里提到的电池、SIM 卡切换、短信、流量明细、天线等，烽燧还没有在这些品牌上实现。写操作在所有未验证的路由器上默认关闭，要在控制台逐项打开。
>
> 手里有表中的路由器？点那一行的「提交实测报告」，会打开一个标题已写好型号的兼容性报告表单。

---

## 1. 华为及智选同源生态 (Huawei / HiLink & HarmonyOS Connect)

> 烽燧里对应的品牌：**华为（HiLink）**。H168-383 是唯一验证过的型号；其他型号的读取与实验性写入见[支持的设备](docs/guide/zh/supported-devices.md)。

涵盖搭载海思巴龙（Balong 5000 / 5100 / 765 / 750 / 722 / 711）基带的华为 5G/5G-A/4G 室内外 CPE、随行 WiFi 及采用同源 HiLink WebUI 协议栈的智选终端。支持新版 `SCRAM-SHA-256` / `Type-4` 双重 SHA-256 鉴权协议族（`huawei-hilink-scram`）与传统 XML 会话令牌协议族（`huawei-hilink-legacy`）自动探测分流。

### 1.1 新版 HiLink SCRAM / Type-4 协议族（5G / 5G-A CPE 与随行 WiFi）

| 型号 | 资料记载的功能（未实测） | 资料标注待验证的功能 | 实测反馈 |
| :--- | :--- | :--- | :--- |
| **Huawei H168-383** (5G CPE Ultra 6 / Wi-Fi 7) | **已在真机验证（固件 4.4.0.1）**：登录、信号与载波聚合、附近的基站、流量、已连接设备、短信、锁频段、锁小区、路由器开关、访问控制、重拨与重启 | — | — |
| **Huawei H165-383** (5G CPE 6) | SCRAM / Type-4 登录鉴权、5G NR / 4G LTE 实时信号监控、网络制式切换、4G/5G 频段锁定、流量与连接时长统计、设备重启 | 载波聚合分量监控、NR/LTE 小区锁定、外置/内置天线模式切换 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Huawei+H165-383) |
| **Huawei H158-381** (5G CPE Pro 5) | 已基于同系海思 Balong 5100 平台验证基础鉴权与信号监控协议兼容性 | 5G 3CC (300MHz) 载波聚合状态、4G/5G 频段锁定、网络模式切换（SA/NSA/4G）、流量统计、终端列表、远程重启 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Huawei+H158-381) |
| **Huawei H155-381** (5G CPE 5 国行版) | SCRAM / Type-4 登录鉴权、5G/4G 主服务小区射频参数（RSRP/RSRQ/SINR/PCI/CellID/EARFCN/NR-ARFCN）、网络模式切换、4G/5G 频段锁定、流量统计、设备重启 | 载波聚合（SCC）详细分量指标、上下行 MCS/MIMO 阶数、锁定指定频点/PCI（取决于固件是否开放 `/api/net/cell-lock`） | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Huawei+H155-381) |
| **Huawei H155-382** (5G CPE 5 海外版) | SCRAM / Type-4 登录鉴权、5G/4G 信号与频段状态监控、网络制式切换、4G/5G 频段锁定、流量统计、设备重启 | 海外版固件扩展锁小区接口（`/api/net/cell-lock`）、外置天线切换、APN 配置读取 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Huawei+H155-382) |
| **Huawei H155-383** (5G CPE 5 运营商定制版) | 兼容 HiLink SCRAM / Type-4 登录鉴权与 5G/4G 射频参数监控 | 运营商定制固件下的频段锁定权限、小区锁定、流量统计与远程重启 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Huawei+H155-383) |
| **Huawei H153-381** (5G CPE 5s) | SCRAM / Type-4 登录鉴权、5G/4G 实时射频信号监控、网络制式切换、4G/5G 频段锁定、月度/总流量统计、设备重启 | 2CC 载波聚合状态检测、小区频点锁定、接入终端速率明细 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Huawei+H153-381) |
| **Huawei H138-380** (5G CPE Pro 3) | 兼容 HiLink SCRAM 鉴权与标准 `/api/device/signal` 射频遥测接口 | 5G/4G 全量射频指标、载波聚合状态、4G/5G 频段锁定、网络模式切换、流量统计、远程重启 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Huawei+H138-380) |
| **Huawei H122-373** (5G CPE Pro 2) | SCRAM / 旧版双栈登录鉴权、5G NR / 4G LTE 射频参数监控、网络模式切换（SA/NSA/4G）、4G/5G 频段锁定、流量统计、设备重启 | 5G 2CC 载波聚合指标、LTE/NR 物理小区锁定（部分海外版固件支持）、天线切换 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Huawei+H122-373) |
| **Huawei H112-373** (5G CPE Pro 海外运营商版) | SCRAM / Session-Token 双栈鉴权、5G/4G 射频参数监控、网络模式切换、4G/5G 频段锁定、流量统计、设备重启 | 海外频段（n78/B20/B28）组合锁频、外置天线模式切换、LTE 频点锁定 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Huawei+H112-373) |
| **Huawei H112-372** (5G CPE Pro 全球版) | SCRAM / Session-Token 双栈鉴权、5G/4G 射频参数监控（RSRP/RSRQ/SINR/PCI/CellID/频点/带宽）、网络模式切换、4G/5G 频段锁定、流量统计、设备重启 | 外置天线模式切换（`/api/device/antenna_set_type`）、LTE 频点锁定 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Huawei+H112-372) |
| **Huawei H112-370** (5G CPE Pro 国行版) | 兼容 HiLink SCRAM / Session-Token 鉴权与 5G/4G 信号读取 | NSA/SA 网络制式切换、4G/5G 频段掩码锁定、流量与在线终端监控、远程重启 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Huawei+H112-370) |
| **Huawei H352-381** (5G CPE Max 5 室外型 ODU) | 兼容 HiLink SCRAM 鉴权与室外型 PoE 网关信号状态查询 | 5G/4G 高增益射频指标监控、频段锁定、定向安装对星信号高频刷新、桥接模式状态检测、远程重启 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Huawei+H352-381) |
| **Huawei H312-371** (5G CPE Win 室外型 ODU) | 兼容 HiLink SCRAM 鉴权与 `/api/device/signal` 信号监控 | 5G/4G 射频参数监控、4G/5G 频段锁定、路由/桥接状态读取、流量统计、远程重启 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Huawei+H312-371) |
| **Huawei E6888-982** (5G 随行 WiFi Pro 5) | SCRAM / Type-4 登录鉴权、5G/4G 信号监控、电池电量与充电状态读取、网络模式切换、4G/5G 频段锁定、流量统计、设备重启 | 随身路由省电休眠策略状态、载波聚合分量监控、Wi-Fi 频段切换 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Huawei+E6888-982) |
| **TD Tech / Brovi H155-380** (智选 5G CPE 5 同源版) | 兼容 HiLink SCRAM / Type-4 握手与标准 XML 监控端点 | 5G/4G 实时射频监控、频段锁定（BandMask）、网络制式切换、流量统计、设备重启 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+TD+Tech+%2F+Brovi+H155-380) |

### 1.2 传统 HiLink Session/Token XML 协议族（早期 5G 随行 WiFi 与 4G Cat.4~Cat.19 全系）

| 型号 | 资料记载的功能（未实测） | 资料标注待验证的功能 | 实测反馈 |
| :--- | :--- | :--- | :--- |
| **Huawei E6878-370** (5G 随行 WiFi Pro) | Session/Token 登录鉴权、5G/4G 射频参数监控、电池电量与充放电状态、网络制式切换、4G/5G 频段锁定、流量统计、设备重启 | SCRAM 固件升级分支自动切换、高负载机身温度监控 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Huawei+E6878-370) |
| **Huawei E6878-870** (5G 随行 WiFi 标准版) | Session/Token 登录鉴权、5G/4G 射频参数监控、电池电量读取、网络制式切换、4G/5G 频段锁定、流量统计、设备重启 | 固件升级后 SCRAM 双栈平滑兼容、接入客户端列表 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Huawei+E6878-870) |
| **Huawei B818-263** (4G Router Prime Cat.19) | 兼容 HiLink XML / SCRAM 双栈信号监控与 LTE BandMask 位运算锁频 | 4G 5CC 载波聚合状态、4x4/8x8 MIMO 指示、LTE 组合频段锁定、外置天线切换、桥接模式状态、流量统计 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Huawei+B818-263) |
| **Huawei B715s-23c** (4G CPE Cat.9) | 兼容传统 HiLink `SesTokInfo` 鉴权与 4G 射频遥测 | LTE 3CC 载波聚合监控、LTE 频段锁定（`LTEBand` 十六进制掩码）、外置天线控制、流量统计、设备重启 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Huawei+B715s-23c) |
| **Huawei B618s-22d** (4G CPE Cat.11 欧洲/全球版) | 兼容传统 HiLink `SesTokInfo` 鉴权与 4G 射频遥测 | LTE 3CC 载波聚合与 4x4 MIMO 状态、LTE 频段锁定、流量统计、设备重启 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Huawei+B618s-22d) |
| **Huawei B618s-65d** (4G CPE Cat.11 亚太/全频段版) | 兼容传统 HiLink `SesTokInfo` 鉴权与 4G 射频遥测 | B28 700MHz 频段锁定、LTE 3CC 载波聚合监控、流量统计、设备重启 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Huawei+B618s-65d) |
| **Huawei B535-836** (华为 4G 路由 3 Pro 国行版 Cat.7) | Session/Token 鉴权、4G LTE 射频参数监控（RSRP/RSRQ/SINR/RSSI/PCI/CellID/EARFCN/Band）、2CC CA 状态、LTE 频段锁定、流量统计、设备重启 | 外置天线模式切换、改进版固件 LTE 频点/PCI 锁定 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Huawei+B535-836) |
| **Huawei B535-232** (华为 4G Router 3 Pro 海外版 Cat.7) | Session/Token 鉴权、4G LTE 射频参数监控、2CC CA 状态、LTE 频段锁定、流量统计、设备重启 | B20/B28 频段掩码组合锁定、外置 SMA 天线切换、桥接模式状态检测 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Huawei+B535-232) |
| **Huawei B525s-23a** (4G CPE Cat.6 欧洲版) | 兼容传统 HiLink XML 鉴权与 `/api/device/signal` 监控 | LTE 2CC 载波聚合监控、LTE 频段锁定、网络模式（4G/3G）切换、流量统计、远程重启 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Huawei+B525s-23a) |
| **Huawei B525s-65a** (4G CPE Cat.6 亚太全频段版) | 兼容传统 HiLink XML 鉴权与 `/api/device/signal` 监控 | LTE 2CC 载波聚合监控、B28/B40/B41 频段锁定、流量统计、远程重启 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Huawei+B525s-65a) |
| **Huawei B316-855** (华为 4G 路由 2 Pro) | Session/Token 鉴权、4G LTE 实时信号监控（RSRP/RSRQ/SINR/PCI/CellID/EARFCN/Band）、LTE 频段锁定、流量统计、设备重启 | 外置天线检测与切换、接入终端列表监控 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Huawei+B316-855) |
| **Huawei B311-521** (华为 4G 路由 2) | Session/Token 鉴权、4G LTE 实时信号监控、网络模式切换、LTE 频段锁定、流量统计、设备重启 | 外置 SMA 天线切换、APN 状态读取 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Huawei+B311-521) |
| **Huawei B311As-853** (华为 4G 路由 2 增强版) | Session/Token 鉴权、4G LTE 实时信号监控、网络模式切换、LTE 频段锁定、流量统计、设备重启 | 外置天线状态检测、客户端列表与月流量统计 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Huawei+B311As-853) |
| **Huawei B315s-936** (4G CPE Cat.4) | 兼容传统 HiLink `SesTokInfo` 双令牌登录与 4G 信号查询 | LTE 射频参数监控、LTE 频段锁定、流量统计、设备重启 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Huawei+B315s-936) |
| **Huawei B310s-927** (4G CPE Cat.4) | 兼容传统 HiLink `SesTokInfo` 双令牌登录与 4G 信号查询 | LTE 射频参数监控、LTE 频段锁定、流量统计、设备重启 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Huawei+B310s-927) |

### 1.3 第二份资料补充的 HiLink 型号

| 型号 | 资料记载的功能（未实测） | 资料标注待验证的功能 | 实测反馈 |
| :--- | :--- | :--- | :--- |
| **B628-265 (4G CPE Pro 3)** | HiLink XML SCRAM / Type-4 登录、4G LTE Cat.12 信号监控、PCI/TAC/CellID/EARFCN/Band 解析、LTE 频段锁定、流量统计、终端列表、瞬时登出 | 4G 2CC/3CC 载波聚合识别、TS-9 外置天线切换 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B628-265) |
| **B628-350 (4G CPE Pro 3)** | HiLink XML SCRAM / Type-4 登录、4G LTE Cat.12 信号监控、PCI/TAC/CellID/EARFCN/Band 解析、LTE 频段锁定、流量统计、终端列表、瞬时登出 | 4G 2CC/3CC 载波聚合识别、TS-9 外置天线切换 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B628-350) |
| **B535-333 (4G CPE 3 Pro)** | HiLink XML SCRAM / Type-4 登录、4G LTE Cat.7 信号监控、PCI/TAC/CellID/EARFCN/Band 解析、LTE 频段锁定、流量统计、终端列表、瞬时登出 | 上下行 2CC 载波聚合状态、SMA 天线接口切换 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B535-333) |
| **B311-221 (4G 路由器 2)** | HiLink XML SCRAM / Type-4 登录、4G LTE Cat.4 信号监控、PCI/TAC/CellID/EARFCN/Band 解析、LTE 频段锁定、流量统计、终端列表、瞬时登出 | 外置天线切换与 Wi-Fi 信道自动优选控制 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B311-221) |
| **B311B-853 (4G 路由器 2 新版)** | HiLink XML / HarmonyOS WebUI 鉴权、4G LTE Cat.4 信号监控、PCI/TAC/CellID/EARFCN/Band 解析、LTE 频段锁定、流量统计、终端列表、瞬时登出 | HarmonyOS `/api/system/user_login_nonce` JSON 协议自动回退验证 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B311B-853) |
| **E5785-320 (随行 WiFi 2 Pro)** | HiLink XML SCRAM / Type-4 登录、4G LTE Cat.6 信号监控、PCI/TAC/CellID/EARFCN/Band 解析、LTE 频段锁定、电池电量监控、流量统计 | Wi-Fi Extender 中继状态监控、省电自动关机策略配置 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E5785-320) |
| **E5885Ls-93a (随行 WiFi 2 Pro 充电宝版)** | HiLink XML SCRAM / Type-4 登录、4G LTE Cat.6 信号监控、PCI/TAC/CellID/EARFCN/Band 解析、LTE 频段锁定、6400mAh 电池电量监控、流量统计 | RJ45 网口模式状态与 2CC 载波聚合识别 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E5885Ls-93a) |
| **E5576-855 (随行 WiFi 3)** | HiLink XML SCRAM / Type-4 登录、4G LTE Cat.4 信号监控、PCI/TAC/CellID/EARFCN/Band 解析、LTE 频段锁定、电池电量监控、流量统计 | 极简固件下 `Cell_id` / `rsrp` 字段回退解析 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E5576-855) |
| **E5577Cs-321 (随行 WiFi Plus)** | HiLink XML SCRAM / Type-4 登录、4G LTE Cat.4 信号监控、PCI/TAC/CellID/EARFCN/Band 解析、LTE 频段锁定、电池电量监控、流量统计 | TS-9 双外置天线状态与 Wi-Fi 中继状态 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E5577Cs-321) |
| **E8372h-153 (4G USB WiFi 翼卡)** | HiLink XML 免密或 Type-4 登录、4G LTE USB 网卡信号监控、PCI/TAC/CellID/EARFCN/Band 解析、LTE 频段锁定、流量统计 | 无密码固件下直接 Token 写操作兼容性 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E8372h-153) |
| **E8372h-608 (4G USB WiFi 亚太版)** | HiLink XML 免密或 Type-4 登录、4G LTE USB 网卡信号监控、PCI/TAC/CellID/EARFCN/Band 解析、LTE 频段锁定、流量统计 | B28 700MHz 频段掩码锁定验证 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E8372h-608) |
| **E3372h-153 (4G USB Stick HiLink 版)** | HiLink XML 免密或 Type-4 登录、4G LTE USB 网卡信号监控、PCI/TAC/CellID/EARFCN/Band 解析、LTE 频段锁定、流量统计 | HiLink NCM/RNDIS 网关模式 `192.168.8.1` 自动探测 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E3372h-153) |
| **Brovi H151-370 (5G CPE)** | HiLink XML SCRAM / Type-4 登录、4G/5G 信号监控、PCI/TAC/CellID/ARFCN/Band 解析、网络制式切换、4G/5G 频段锁定、流量统计、终端列表、瞬时登出 | EN-DC 与 SA 载波聚合分量监控、小区锁定扩展接口验证 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Brovi+H151-370) |
| **Soyealink B535-932 (4G CPE 3)** | HiLink XML SCRAM / Type-4 登录、4G LTE Cat.7 信号监控、PCI/TAC/CellID/EARFCN/Band 解析、LTE 频段锁定、流量统计、终端列表、瞬时登出 | 2CC 载波聚合分量显示、外置天线切换 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Soyealink+B535-932) |
| **Soyealink B628-540 (4G CPE Pro 3)** | HiLink XML SCRAM / Type-4 登录、4G LTE Cat.12 信号监控、PCI/TAC/CellID/EARFCN/Band 解析、LTE 频段锁定、流量统计、终端列表、瞬时登出 | 3CC 载波聚合分量显示、TS-9 外置天线切换 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Soyealink+B628-540) |
| **Soyealink SLT869-A51 (5G CPE)** | HiLink XML / HarmonyOS 鉴权、4G/5G 信号监控、PCI/TAC/CellID/ARFCN/Band 解析、网络制式切换、4G/5G 频段锁定、流量统计、终端列表、瞬时登出 | NSA/SA 频段掩码兼容性、工业 APN 策略切换 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Soyealink+SLT869-A51) |
| **TD Tech MT5710-CN (鼎桥 5G 工业 CPE)** | HiLink XML SCRAM / Type-4 登录、4G/5G 信号监控、PCI/TAC/CellID/ARFCN/Band 解析、网络制式切换、4G/5G 频段锁定、流量统计、瞬时登出 | 工业看门狗状态、双 SIM 卡切换、700MHz (`n28`) 与专网频段锁定 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+TD+Tech+MT5710-CN) |
| **TD Tech MH5000-31 (鼎桥 5G 模组网关)** | HiLink XML 网关模式信号监控、PCI/TAC/CellID/ARFCN/Band 解析、4G/5G 频段锁定 | USB ECM/RNDIS 网关模式与 AT 串口双通道并发兼容性 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+TD+Tech+MH5000-31) |
| **TD Tech MH5000-82M (鼎桥 5G 工业模组网关)** | HiLink XML 网关模式信号监控、PCI/TAC/CellID/ARFCN/Band 解析、4G/5G 频段锁定 | 工业以太网网关透传模式下管理 IP 探测 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+TD+Tech+MH5000-82M) |

---

## 2. 中兴通讯 (ZTE)

> 烽燧里对应的品牌：**中兴（zWRT 接口）**与**中兴（goform 网页接口）**。已实现：信号、附近的基站（goform）、锁频段、锁小区、重启。

全面覆盖中兴两代核心管理总线：新一代基于 OpenWrt `ubus` (`rpcd`) JSON-RPC 2.0 架构的 `zte-zwrt-ubus` 协议族（Wi-Fi 7 / 5G-A 系列），以及经典 `/goform/*` CGI 配合 `RD`/`LD` 动态 `AD` 签名的 `zte-goform-web` 协议族（细分为标准分支、`888` 扩展分支、`8020` 分支与 `U60Pro/MC8512/3351` 兼容分支）。

### 2.1 新一代 zWRT OpenWrt ubus JSON-RPC 协议族（Wi-Fi 7 / 5G-A 系列）

| 型号 | 资料记载的功能（未实测） | 资料标注待验证的功能 | 实测反馈 |
| :--- | :--- | :--- | :--- |
| **ZTE U60 Pro (MU5250)** (5G-A 随身 WiFi 7 旗舰 / 骁龙 X75) | `zte_web_sault` 盐值鉴权、5G NR / 4G LTE 射频参数、5G-A 3CC / LTE CA 载波聚合明细、电池电量与快充状态、物理 SIM 与内置卡切换、4G/5G 独立频段锁定、NR/LTE 小区锁定、流量统计、重启 | 邻区扫描列表、毫米波/Sub-6G 聚合扩展字段、Wi-Fi 7 MLO 状态监控 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+ZTE+U60+Pro) |
| **ZTE G5 Ultra (MC8530)** (5G-A 室内 Wi-Fi 7 旗舰 CPE / 骁龙 X75) | 兼容 `zWRT ubus` JSON-RPC 2.0 鉴权与射频监控总线 | 5G-A 3CC 载波聚合监控、4G/5G 独立频段锁定、NR SA/LTE 小区频点+PCI 锁定、AI 波束天线增益状态、多传感器温度、流量统计、远程重启 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+ZTE+G5+Ultra) |
| **ZTE G5 Ultra (MC8531)** (5G-A 室内 Wi-Fi 7 渠道/海外版 CPE / 骁龙 X75) | 兼容 `zWRT ubus` JSON-RPC 2.0 鉴权与射频监控总线 | 全球频段锁频掩码、5G-A 3CC 载波聚合监控、NR SA/LTE 小区锁定、流量统计、远程重启 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+ZTE+G5+Ultra) |
| **ZTE G5 Pro (MC8512)** (5G 室内 Wi-Fi 7 CPE / 联发科 T830) | 支持 `zWRT ubus` 原生接口与 `MC8512` Goform 兼容层双路径识别、5G/4G 信号与 CA 载波聚合监控 | 联发科 T830 平台 4G/5G 频段锁定、NR SA 小区锁定、CPU/基带温度监控、物理 SIM 与内置卡切换、流量统计、远程重启 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+ZTE+G5+Pro) |
| **ZTE G5TS (MC8520)** (5G 室内千兆 CPE / 联发科 T750) | 兼容 `zWRT ubus` 鉴权与 5G/4G 实时射频遥测 | 4G/5G 载波聚合（`lteca`/`nrca`）、4G/5G 独立频段锁定、物理小区锁定、SIM 卡槽切换、流量统计、远程重启 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+ZTE+G5TS) |
| **ZTE G5F** (5G 室内高速双频 CPE / 骁龙 X62) | 兼容 `zWRT ubus`（及部分批次 Goform）自动探测与信号读取 | 5G/4G 射频参数与 CA 聚合监控、频段锁定、小区锁定、网络制式切换、流量统计、远程重启 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+ZTE+G5F) |
| **ZTE MC888D** (5G 室内 AX3000 CPE / 骁龙 X62 zWRT 分支) | 兼容 `zWRT ubus` 与 Goform 双协议栈自动探测识别 | 5G/4G 射频参数监控、CA 载波聚合列表、频段锁定、小区锁定、远程重启 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+ZTE+MC888D) |
| **ZTE U50 Pro (MU5120)** (5G 随身 WiFi 6E / 骁龙 X62) | 兼容 `zWRT ubus` 鉴权、5G/4G 射频监控、电池电量与充放电倒计时查询 | 4G/5G 频段锁定、小区锁定、实体 SIM 与内置 eSIM 切换、流量统计、远程重启 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+ZTE+U50+Pro) |

### 2.2 经典 Goform Web CGI 与 AD 动态签名协议族（MC / MU / F / MF 系列）

| 型号 | 资料记载的功能（未实测） | 资料标注待验证的功能 | 实测反馈 |
| :--- | :--- | :--- | :--- |
| **ZTE MC801A** (5G 室内 CPE / 骁龙 X55) | SHA-256/MD5 双模登录与 `AD` 动态签名、5G/4G 全量射频指标、EN-DC / NR CA 载波聚合明细、邻区扫描、基带温度、网络模式切换、4G/5G 频段锁定、LTE/NR 小区锁定、流量统计、重启 | 部分海外运营商定制版固件锁小区参数细微差异验证 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+ZTE+MC801A) |
| **ZTE MC801A1** (5G 室内 CPE 批次演进版 / 骁龙 X55) | 兼容标准 Goform `Type 1` 登录鉴权、`AD` 动态签名与 5G/4G 全量射频监控 | EN-DC / NR CA 载波聚合明细、4G/5G 频段锁定、LTE/NR 小区锁定、流量统计、远程重启 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+ZTE+MC801A1) |
| **ZTE MC801** (初代 5G 室内 CPE / 骁龙 X50) | 兼容标准 Goform `Type 1` 查询与 `AD` 签名控制指令 | NSA 5G/4G 信号监控、LTE/NR 频段锁定、流量统计、远程重启 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+ZTE+MC801) |
| **ZTE MC8020** (5G 室内高增益 CPE / 骁龙 X55) | 支持 SHA-256 `LD`/`RD` 双挑战握手、5G/4G 全量射频与 CA 载波聚合监控、`8020` 专用分支 4G/5G 频段锁定与小区锁定、温度监控、流量统计、重启 | NFC 一碰连状态与特殊运营商定制固件版本兼容性 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+ZTE+MC8020) |
| **ZTE MC7010** (5G 室外防水 PoE ODU / 骁龙 X55) | Goform 登录与 `AD` 签名、5G/4G 射频参数与 CA 载波聚合监控、邻区扫描、4G/5G 频段锁定、LTE/NR 频点+PCI 小区锁定、流量统计、远程重启 | 室外高低温环境多热敏传感器读数、桥接/路由模式切换状态回读 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+ZTE+MC7010) |
| **ZTE MC7010D** (5G 室外防水 PoE ODU 政企/海外版 / 骁龙 X55) | 兼容标准 Goform `Type 1` 登录鉴权、5G/4G 射频监控与锁频锁小区指令 | PoE 供电与桥接 VLAN 状态、室外温控传感器读数、远程重启 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+ZTE+MC7010D) |
| **ZTE MU5001** (5G 随身 WiFi Pro 国行版 / 骁龙 X55) | Goform 登录与 `AD` 签名、5G/4G 全量信号与 CA 监控、电池电量与充电状态、基带温度、4G/5G 频段锁定、LTE/NR 小区锁定、流量统计、远程重启 | 有线 USB RNDIS 网络共享模式下的网关地址自适应探测 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+ZTE+MU5001) |
| **ZTE MU5001U** (5G 随身 WiFi Pro 公开/无锁版 / 骁龙 X55) | Goform 登录与 `AD` 签名、5G/4G 全量信号与 CA 监控、电池电量、基带温度、4G/5G 频段锁定、LTE/NR 小区锁定、流量统计、远程重启 | 多 APN 切换与漫游状态回读 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+ZTE+MU5001U) |
| **ZTE MU5002** (5G 随身 WiFi Pro 海外版 / 骁龙 X55) | 兼容标准 Goform `Type 1` 鉴权与射频遥测总线 | 全球频段（含 n28/n78/B20）锁频掩码、小区锁定、电池与温度监控、流量统计 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+ZTE+MU5002) |
| **ZTE MC888** (5G 室内 Wi-Fi 6 CPE / 骁龙 X62) | 已内置 `888` 专用控制分支、支持 5G/4G 信号与 CA 监控 | `888` 分支 4G/5G 频段锁定、NR/LTE 小区锁定、邻区扫描、温度与流量统计、远程重启 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+ZTE+MC888) |
| **ZTE MC888 Pro** (5G 室内 AX5400 旗舰 CPE / 骁龙 X62) | 已内置 `888` 专用控制分支、支持 5G/4G 射频与 CA 载波聚合监控 | `888` 分支 4G/5G 频段锁定、NR/LTE 物理小区锁定、温控读数与流量统计、远程重启 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+ZTE+MC888+Pro) |
| **ZTE MC888S** (5G 室内 Wi-Fi 6 CPE / 展锐 V510) | 兼容 Goform Web 登录与展锐 V510 基带射频状态查询 | 展锐基带下的频段锁定、小区锁定、载波状态、温度监控与流量统计 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+ZTE+MC888S) |
| **ZTE MC889** (5G 室外高增益 ODU / 骁龙 X62) | 兼容 Goform `888` 分支鉴权与高阶射频遥测接口 | 5G NR 2CC CA 监控、室外定向安装信号刷新、4G/5G 频段锁定、NR/LTE 小区锁定、远程重启 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+ZTE+MC889) |
| **ZTE MC889 Pro** (5G 室外旗舰高增益 ODU / 骁龙 X65) | 兼容 Goform `888` / `zWRT` 双栈自动识别与射频状态采集 | 5G NR 3CC 载波聚合监控、4G/5G 频段锁定、NR/LTE 小区锁定、桥接状态与远程重启 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+ZTE+MC889+Pro) |
| **ZTE MC8830** (5G 车规/行业网关 / 骁龙 X62) | 已内置 `MC8830` 专属型号识别分支、支持 Goform 射频信号与网络状态监控 | `MC8830` 分支 4G/5G 频段锁定、小区锁定、多传感器温度与车载供电状态、远程重启 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+ZTE+MC8830) |
| **ZTE U50** (5G 便携随身 WiFi 国行版) | 兼容 Goform 登录鉴权与 5G/4G 基础射频信号查询 | 电池状态监控、网络制式切换、频段锁定、流量统计、远程重启 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+ZTE+U50) |
| **ZTE MU510** (5G 便携随身 WiFi 行业/海外版) | 兼容 Goform 登录鉴权与 5G/4G 射频参数查询 | 电池电量监控、4G/5G 频段锁定、小区锁定、流量统计、远程重启 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+ZTE+MU510) |
| **ZTE F50** (5G 随身便携卡托路由 / 展锐 T760 `3351` 分支) | 已内置 `3351` 硬件分支适配、支持 Goform 登录、5G/4G 信号监控、核心温控读数与流量统计 | `3351` 分支 5G/4G 频段锁定、小区频点锁定、内置存储/SIM 状态、远程重启 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+ZTE+F50) |
| **ZTE F50 Pro** (5G 随身便携 Wi-Fi 6 卡托路由 / 展锐 T760 `3351` 分支) | 兼容 `3351` 硬件分支 Goform 登录、5G/4G 实时射频监控、温控读数与流量统计 | `3351` 分支 5G/4G 频段锁定、小区锁定、双频 Wi-Fi 状态、远程重启 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+ZTE+F50+Pro) |
| **ZTE MF79U** (4G LTE USB 随身便携卡托 / `3351` 同源分支) | 兼容 Goform `goform_get_cmd_process` 4G 信号与流量监控 | LTE 频段锁定、网络模式切换、接入客户端监控、远程重启 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+ZTE+MF79U) |
| **ZTE MF286 / MF286R** (4G LTE Cat.6 桌面无线路由器) | 兼容传统 Goform `goform_get_cmd_process` 4G 信号与流量监控 | LTE 2CC 载波聚合状态、LTE 频段锁定、网络模式切换、远程重启 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+ZTE+MF286+%2F+MF286R) |
| **ZTE MF297D** (4G LTE Cat.12 三频聚合桌面 CPE) | 兼容传统 Goform 鉴权、4G 射频参数与流量监控 | LTE 3CC 载波聚合状态、LTE 频段锁定、物理小区锁定、远程重启 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+ZTE+MF297D) |

### 2.3 第二份资料补充的中兴型号

| 型号 | 资料记载的功能（未实测） | 资料标注待验证的功能 | 实测反馈 |
| :--- | :--- | :--- | :--- |
| **MC888 Ultra (5G CPE 旗舰版)** | SHA256 大写登录与动态 `AD` 签名、4G/5G 信号监控、PCI/TAC/CellID/ARFCN/Band 解析、3GPP R16 载波聚合监控、温度监控、网络模式切换、4G/5G 频段锁定、4G/5G 小区锁定、流量统计、终端列表、瞬时登出 | Wi-Fi 6E 6GHz 频段状态监控、双 2.5G 网口状态监控 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MC888+Ultra) |
| **MC8510 (5G-A Wi-Fi 7 旗舰 CPE)** | SHA256 大写登录与动态 `AD` 签名、5G-A / 4G 信号监控、PCI/TAC/CellID/ARFCN/Band 解析、3CC 载波聚合监控、温度监控、网络模式切换、4G/5G 频段锁定、4G/5G 小区锁定、流量统计、终端列表、瞬时登出 | Wi-Fi 7 MLO 与 4K-QAM 状态监控、高通 SDX72/SDX75 新增射频字段映射 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MC8510) |
| **G5C (5G CPE G5 畅享版)** | SHA256 大写登录与动态 `AD` 签名、4G/5G 信号监控、PCI/TAC/CellID/ARFCN/Band 解析、温度监控、网络模式切换、4G/5G 频段锁定、4G/5G 小区锁定、流量统计、终端列表、瞬时登出 | 展锐平台下邻区扫描与锁小区参数验证 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+G5C) |
| **G5B (5G CPE G5 专网版)** | SHA256 大写登录与动态 `AD` 签名、4G/5G 信号监控、PCI/TAC/CellID/ARFCN/Band 解析、温度监控、网络模式切换、4G/5G 频段锁定、4G/5G 小区锁定、流量统计、终端列表、瞬时登出 | 企业 VPN 与 APN 专网配置状态读取 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+G5B) |
| **MU5120 (5G Wi-Fi 6E 随身 Wi-Fi 旗舰版)** | SHA256 大写登录与动态 `AD` 签名、4G/5G 信号监控、PCI/TAC/CellID/ARFCN/Band 解析、载波聚合监控、温度与 10000mAh 电池状态监控、网络模式切换、4G/5G 频段锁定、4G/5G 小区锁定、流量统计、瞬时登出 | 充电保护开关控制、NFC 一碰连与 6GHz 频段状态读取 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MU5120) |
| **U30 Air (5G 双网随身 Wi-Fi)** | SHA256/MD5 登录与动态 `AD` 签名、4G/5G 信号监控、PCI/TAC/CellID/ARFCN/Band 解析、温度与电池监控、网络模式切换、4G/5G 频段锁定、4G/5G 小区锁定、流量统计、瞬时登出 | 双网 eSIM 切卡接口与实体卡槽切换兼容性 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+U30+Air) |
| **U10S Pro (4G 随身 Wi-Fi)** | MD5/SHA256 登录与 `AD` 签名、4G LTE 信号监控、PCI/TAC/CellID/EARFCN/Band 解析、电池电量监控、LTE 频段锁定、流量统计、瞬时登出 | B1/B3/B5/B8/B41 频段掩码锁定验证 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+U10S+Pro) |
| **MF286 (4G+ Cat.6 CPE)** | MD5/SHA256 登录与动态 `AD` 签名、4G LTE 信号监控、PCI/TAC/CellID/EARFCN/Band 解析、4G 2CC 载波聚合监控 (`lte_multi_ca_scell_info`)、LTE 频段锁定 (`SET_LTE_BAND_LOCK`)、4G 小区锁定 (`LOCKEARFCN`)、流量统计、终端列表、瞬时登出 | 内置 3000mAh 锂电池仓电量读取、RJ11 语音状态监控 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MF286) |
| **MF286C (4G+ Cat.6 CPE)** | MD5/SHA256 登录与动态 `AD` 签名、4G LTE 信号监控、PCI/TAC/CellID/EARFCN/Band 解析、4G 2CC 载波聚合监控、LTE 频段锁定、4G 小区锁定、流量统计、终端列表、瞬时登出 | 展锐/高通分支下辅载波带宽显示 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MF286C) |
| **MF286R (4G+ Cat.6 CPE)** | MD5/SHA256 登录与动态 `AD` 签名、4G LTE 信号监控、PCI/TAC/CellID/EARFCN/Band 解析、4G 2CC 载波聚合监控、LTE 频段锁定、4G 小区锁定、流量统计、终端列表、瞬时登出 | 展锐/高通分支下辅载波带宽显示 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MF286R) |
| **MF286D (4G+ Cat.12 3CC CPE)** | MD5/SHA256 登录与动态 `AD` 签名、4G LTE Cat.12 信号监控、PCI/TAC/CellID/EARFCN/Band 解析、4G 3CC 载波聚合监控、LTE 频段锁定、4G 小区锁定、流量统计、终端列表、瞬时登出 | 高通 X16 基带 3CC 辅载波信号详情解析 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MF286D) |
| **MF289F (4G+ Cat.20 CPE)** | SHA256/MD5 登录与动态 `AD` 签名、4G LTE Cat.20 信号监控、PCI/TAC/CellID/EARFCN/Band 解析、4G 多载波聚合监控、LTE 频段锁定、4G 小区锁定、流量统计、终端列表、瞬时登出 | 4G 4x4 MIMO 与 256QAM 调制阶数显示、外置 TS-9 天线开关 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MF289F) |
| **MF253S (4G LTE Cat.4 CPE)** | MD5 小写登录与 `AD` 签名、4G LTE 信号监控、PCI/TAC/CellID/EARFCN/Band 解析、LTE 频段锁定、流量统计、终端列表、瞬时登出 | 早期固件无 `RD0`/`RD1` 时免 `AD` 降级提交兼容性 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MF253S) |
| **MF283+ (4G LTE Cat.4 CPE)** | MD5 小写登录与 `AD` 签名、4G LTE 信号监控、PCI/TAC/CellID/EARFCN/Band 解析、LTE 频段锁定、流量统计、终端列表、瞬时登出 | 早期固件无 `RD0`/`RD1` 时免 `AD` 降级提交兼容性 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MF283%2B) |
| **MF283U (4G LTE Cat.4 CPE)** | MD5 小写登录与 `AD` 签名、4G LTE 信号监控、PCI/TAC/CellID/EARFCN/Band 解析、LTE 频段锁定、流量统计、终端列表、瞬时登出 | 早期固件无 `RD0`/`RD1` 时免 `AD` 降级提交兼容性 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MF283U) |
| **MF920U (4G 随身 Wi-Fi)** | MD5/SHA256 登录与 `AD` 签名、4G LTE 信号监控、PCI/TAC/CellID/EARFCN/Band 解析、电池电量监控、LTE 频段锁定、流量统计、瞬时登出 | 轻量化 WebUI 字段裁剪版回退适配 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MF920U) |
| **MF971R (4G 随身 Wi-Fi)** | MD5/SHA256 登录与 `AD` 签名、4G LTE 信号监控、PCI/TAC/CellID/EARFCN/Band 解析、电池电量监控、LTE 频段锁定、流量统计、瞬时登出 | 轻量化 WebUI 字段裁剪版回退适配 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MF971R) |
| **MF935 (4G 随身 Wi-Fi)** | MD5/SHA256 登录与 `AD` 签名、4G LTE 信号监控、PCI/TAC/CellID/EARFCN/Band 解析、电池电量监控、LTE 频段锁定、流量统计、瞬时登出 | 轻量化 WebUI 字段裁剪版回退适配 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MF935) |

---

## 3. 烽火通信 (FiberHome)

> 烽燧里对应的品牌：**烽火**。已实现：信号、附近的基站、锁频段、锁小区、重启。

适用于采用 `/api/tmp/FHNCAPIS` 与 `/api/tmp/FHTOOLAPIS` 动态单次令牌轮换架构的烽火 5G CPE 系列（`fiberhome-ajax`）。驱动内置固件主版本号校验（推荐 `RP0109` 及以上版本），并按 `modelName` 自动分流单小区锁定（`LG6121F`）与多小区列表锁定（`LG6151M`）。

### 3.1 FHTOOLAPIS 动态令牌协议族

| 型号 | 资料记载的功能（未实测） | 资料标注待验证的功能 | 实测反馈 |
| :--- | :--- | :--- | :--- |
| **FiberHome LG6121F** (5G 室内双频 Wi-Fi 6 CPE) | 动态 `sessionid` 轮换与登录鉴权、管理员在线避让、5G/4G 实时射频信号（RSRP/RSRQ/SINR/PCI/ARFCN/Band）、网络制式切换、4G/5G 频段锁定、`app_set_lockcell` 单小区锁定、流量统计、重启 | 低于 `RP0109` 早期批次固件锁频回读兼容性、邻区列表与设备内部温度扩展字段 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+FiberHome+LG6121F) |
| **FiberHome LG6151M** (5G 室内外高速千兆 CPE) | 已内置 `LG6151M` 专属 `app_get_cell_list` / `app_set_cell_list` 多小区数组锁小区逻辑及完整 `FHTOOLAPIS` 射频遥测支持 | `lock_cell` 多小区轮询锁定真机行为、载波聚合分量指标、4G/5G 频段锁定、流量统计、远程重启 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+FiberHome+LG6151M) |
| **FiberHome LG6121** (5G 室内千兆 CPE Pro) | 兼容 `FHNCAPIS` / `FHTOOLAPIS` 探测与基础射频信号读取 | 4G/5G 频段锁定、单频点小区锁定、网络模式切换、流量统计、远程重启 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+FiberHome+LG6121) |
| **FiberHome LG522** (运营商定制 5G Box 宽带网关) | 若固件开放 `/api/tmp/FHTOOLAPIS` 接口即可自动探测接入 | 5G/4G 射频参数监控、锁频与锁小区权限验证（视运营商定制固件裁剪情况而定）、设备重启 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+FiberHome+LG522) |

---

## 4. 品速科技及展锐公版生态 (Pinsu / UNISOC V510 MGDB)

> 烽燧里对应的品牌：**品速**。已实现：信号、锁频段、锁小区、重启。

适用于采用 `/goform/sync`、`/goform/set_login_in`（挑战码 `HMAC-MD5` 鉴权）以及 `/action/get_mgdb_params` 键值数据库总线的品速 5G CPE、随身 WiFi 及同源紫光展锐春藤 V510 公版网关（`pinsu-mgdb`）。

### 4.1 Goform + `mgdb` 键值总线协议族

| 型号 | 资料记载的功能（未实测） | 资料标注待验证的功能 | 实测反馈 |
| :--- | :--- | :--- | :--- |
| **Pinsu R200C** (5G 室内双频 Wi-Fi 6 千兆 CPE) | `HMAC-MD5` 挑战响应登录鉴权、会话熔断保护、5G NR / 4G LTE 射频参数（RSRP/RSRQ/SINR/PCI/CellID/ARFCN/Band）、网络模式切换、4G/5G 频段锁定、NR/LTE 频点+PCI 小区锁定、温度与流量统计、重启 | 多载波聚合扩展键名、跨子版本固件邻区扫描字段验证 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Pinsu+R200C) |
| **Pinsu R200** (5G 室内双频千兆 CPE) | 兼容品速 `/goform/*` + `/action/get_mgdb_params` 标准协议栈 | 5G/4G 射频参数监控、网络模式切换、4G/5G 频段锁定、小区锁定、温度与流量统计、远程重启 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Pinsu+R200) |
| **Pinsu R200P** (5G 室内高增益增强版 CPE) | 兼容品速 `HMAC-MD5` 登录与 `mnet_*` 射频键值遥测总线 | 高增益天线切换状态、4G/5G 频段锁定、NR/LTE 小区锁定、流量统计、远程重启 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Pinsu+R200P) |
| **Pinsu R100** (5G 紧凑型室内 CPE) | 兼容品速 `/goform/sync` 自动探测与射频状态查询 | 5G/4G 信号监控、网络制式切换、频段锁定、小区锁定、流量统计、远程重启 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Pinsu+R100) |
| **Pinsu U200** (5G 便携式随身 WiFi) | 兼容品速 `mgdb` 协议栈及电池供电状态查询 | 5G/4G 射频信号监控、电池电量与温度监控、4G/5G 频段锁定、小区锁定、流量统计 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Pinsu+U200) |
| **Pinsu M1** (5G 触屏旗舰随身 WiFi) | 兼容品速 `mgdb` 协议栈探测与信号监控 | 5G/4G 实时射频监控、触屏端与 Web 会话共存礼让、频段锁定、小区锁定、电池与流量统计 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Pinsu+M1) |
| **Pinsu F10** (5G/4G 便携卡托随身路由) | 若固件搭载 `/goform/sync` 与 `/action/get_mgdb_params` 总线即可自动接入 | 5G/4G 信号指标读取、频段锁定、温控读数、流量统计、远程重启 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Pinsu+F10) |
| **UNISOC V510 `mgdb` 公版 OEM 5G CPE** (通用展锐春藤 V510 方案) | 支持通过 `POST /goform/sync` + `POST /goform/get_login_info` 无损识别同源公版固件 | 5G/4G 射频遥测（`mnet_*` 键值）、网络制式切换、4G/5G 频段锁定、物理小区锁定、远程重启 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+UNISOC+V510+%60mgdb%60+%E5%85%AC%E7%89%88+OEM+5G+CPE) |

### 4.2 第二份资料补充的品速型号

| 型号 | 资料记载的功能（未实测） | 资料标注待验证的功能 | 实测反馈 |
| :--- | :--- | :--- | :--- |
| **PINSU M200 (5G 随身 Wi-Fi 6)** | PINSU `HMAC-MD5` (`key="0123456789"`) 鉴权、4G/5G 信号监控 (RSRP/RSRQ/SINR/RSSI)、PCI/TAC/CellID/ARFCN/Band 解析、网络制式切换、4G/5G 频段锁定、4G/5G 小区锁定、电池与温度监控、流量统计 | `AES-128-ECB` 加密载荷分支固件自动识别、USB 网卡直连模式免密轮询 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+PINSU+M200) |
| **PINSU M200 Pro (5G 随身 Wi-Fi 6 增强版)** | PINSU `HMAC-MD5` 鉴权、4G/5G 信号监控、PCI/TAC/CellID/ARFCN/Band 解析、网络制式切换、4G/5G 频段锁定、4G/5G 小区锁定、电池与温度监控、流量统计 | 高通/展锐不同批次硬件下邻区扫描列表 (`neighbor_cells`) 完整度验证 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+PINSU+M200+Pro) |

---

## 5. 通则康威 (Tozed Kangwei / ZLT)

> 烽燧里对应的品牌：**通则康威 / ZLT**。已实现：信号、附近的基站、锁频段、锁小区、重启；接口加了加密的运营商定制固件连不上。

适用于采用单一路由 `POST /cgi-bin/http.cgi` 配合整数命令号（`cmd: 232` 挑战令牌、`cmd: 100` 登录、`cmd: 205` 射频状态、`cmd: 165/166` 锁频锁小区）及可选 `AES-128-ECB` 传输层自动加解密的通则康威 ZLT 全系列及运营商定制型号（`tozed-http-cgi`）。

### 5.1 ZLT `/cgi-bin/http.cgi` 命令分发与可选 AES-128-ECB 协议族

| 型号 | 资料记载的功能（未实测） | 资料标注待验证的功能 | 实测反馈 |
| :--- | :--- | :--- | :--- |
| **Tozed VN007+** (联通定制 5G 室内双频 CPE / 展锐 V510) | `cmd: 232/100` 挑战摘要登录、可选 `AES-128-ECB` 报文自动识别加解密、5G/4G 全量射频指标（含 MCS/MIMO Rank/SNR）、CPU 温度、网络制式切换、4G/5G 频段锁定、NR/LTE 锁小区、流量统计、重启 | 不同高权限/普通 `admin` 账户在定制高版本固件下的锁频权限表现核验 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Tozed+VN007%2B) |
| **Tozed VN007** (联通定制初代 5G 室内 CPE / 展锐 V510) | 兼容通则 `/cgi-bin/http.cgi` 挑战登录与 `cmd: 205/207` 射频及主板状态查询 | 4G/5G 频段锁定、NR/LTE 频点+PCI 锁定、温度监控、流量统计、远程重启 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Tozed+VN007) |
| **Tozed VN009** (运营商定制 5G Wi-Fi 6 室内 CPE) | 兼容 `/cgi-bin/http.cgi` 自动探测与加密/明文自适应通信 | 5G/4G 信号与载波聚合监控、频段锁定、小区锁定、温度与流量统计、远程重启 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Tozed+VN009) |
| **Tozed ZLT X20** (5G 室内双频千兆 CPE) | 兼容 ZLT `http.cgi` 标准命令集与射频遥测解析 | 5G/4G 射频参数监控、4G/5G 频段锁定、NR/LTE 小区锁定、邻区扫描、流量统计、远程重启 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Tozed+ZLT+X20) |
| **Tozed ZLT X21** (5G 室内 Wi-Fi 6 千兆 CPE) | 兼容 ZLT `http.cgi` 标准命令集（含海外 `192.168.254.254` 网关批次） | 5G/4G 实时射频与 MCS/MIMO 监控、4G/5G 频段锁定、小区锁定、AES 加密开关批次自适应、远程重启 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Tozed+ZLT+X21) |
| **Tozed ZLT X25** (5G 室内高增益 Wi-Fi 6 CPE) | 兼容 ZLT `http.cgi` 标准命令集探测与射频读取 | 5G/4G 信号监控、载波聚合状态、频段锁定、小区锁定、温度与流量统计、远程重启 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Tozed+ZLT+X25) |
| **Tozed ZLT X28** (5G AX3000 2.5G 网口 CPE / 联发科 T750) | 兼容 ZLT `http.cgi` 鉴权（含 `AES-128-ECB` 传输加密固件）与射频监控 | 联发科 T750 平台 2CC CA 监控、4G/5G 频段锁定、NR/LTE 小区锁定、邻区扫描、外置天线切换、远程重启 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Tozed+ZLT+X28) |
| **Tozed ZLT X28 Pro** (5G AX5400 2.5G 旗舰 CPE) | 兼容 ZLT `http.cgi` 协议探测与高阶射频字段映射 | 5G/4G 载波聚合明细、频段锁定、小区锁定、多热敏区温度监控、流量统计、远程重启 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Tozed+ZLT+X28+Pro) |
| **Tozed ZLT X100** (5G R16 高性能 CPE / 联发科 T830 & 骁龙 X62) | 若固件保留 ZLT `http.cgi` 总线则支持自动探测与信号采集 | 5G R16 3CC 载波聚合、n79/n28 扩展频段锁定、NR SA 小区锁定、流量统计、远程重启 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Tozed+ZLT+X100) |
| **Tozed ZLT X300M** (5G-A Wi-Fi 7 室内旗舰 CPE) | 支持 ZLT `http.cgi` 检查（部分新版 OpenWrt 固件待确认路由路径） | 5G-A 射频与多载波聚合监控、Wi-Fi 7 状态、频段锁定、小区锁定、远程重启 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Tozed+ZLT+X300M) |
| **Tozed ZLT X11** (5G 室外防水 PoE ODU) | 兼容 ZLT `http.cgi` 室外单元状态与射频监控 | 室外高增益射频信号高频刷新、4G/5G 频段锁定、定向锁小区、PoE 桥接状态、远程重启 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Tozed+ZLT+X11) |
| **Tozed ZLT P11** (5G 室外定向高增益 ODU) | 兼容 ZLT `http.cgi` 协议探测与信号监控 | 5G/4G 射频指标、频段锁定、物理小区锁定、设备温度监控、远程重启 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Tozed+ZLT+P11) |
| **Tozed ZLT P28** (5G 室外高增益防水 PoE ODU / 联发科 T750) | 兼容 ZLT `http.cgi` 鉴权（含可选 `AES-128-ECB`）与射频遥测 | 室外对星高频信号监控、4G/5G 频段锁定、NR/LTE 小区锁定、桥接状态、远程重启 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Tozed+ZLT+P28) |
| **Tozed ZLT T20** (5G 工业/商企桌面网关) | 兼容 ZLT `http.cgi` 协议探测与射频监控 | 5G/4G 射频参数监控、4G/5G 频段锁定、小区锁定、流量统计、远程重启 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Tozed+ZLT+T20) |
| **Tozed ZLT T30** (5G 工业/室外宽温 CPE) | 兼容 ZLT `http.cgi` 协议探测与信号监控 | 双卡/看门狗状态、4G/5G 频段锁定、小区锁定、宽温传感器监控、远程重启 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Tozed+ZLT+T30) |
| **Tozed ZLT M30S** (5G 便携式随身 WiFi) | 兼容 ZLT `http.cgi` 协议探测与 5G/4G 射频参数读取 | 电池电量与充电状态字段、4G/5G 频段锁定、流量统计、远程重启 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Tozed+ZLT+M30S) |
| **Tozed ZLT M60** (5G 触屏便携随身 WiFi) | 兼容 ZLT `http.cgi` 协议探测与 5G/4G 射频参数读取 | 电池与充电状态监控、4G/5G 频段锁定、小区锁定、流量统计、远程重启 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Tozed+ZLT+M60) |
| **Tozed MP510** (5G 工业导轨网关 / 展锐 V510) | 兼容 ZLT `http.cgi` 协议探测与基础网络遥测 | 5G/4G 射频监控、频段锁定、小区锁定、工业端口状态、远程重启 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Tozed+MP510) |
| **Tozed LT500** (5G 双频桌面无线宽带网关) | 兼容 ZLT `http.cgi` 协议探测与基础网络遥测 | 5G/4G 射频监控、频段锁定、小区锁定、流量统计、远程重启 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Tozed+LT500) |
| **Tozed ZLT S12 Pro** (4G LTE Cat.6 双频千兆无线宽带路由) | 兼容 ZLT `http.cgi` 4G 射频遥测、挑战摘要登录与可选 `AES-128-ECB` 解密 | 4G LTE 2CC CA 监控、LTE 频段锁定、EARFCN+PCI 锁小区、流量统计、远程重启 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Tozed+ZLT+S12+Pro) |
| **Tozed ZLT S10 / S10G** (4G LTE Cat.4 入门无线宽带路由) | 兼容 ZLT `http.cgi` 4G 射频信号查询与挑战摘要登录 | LTE 频段锁定、EARFCN+PCI 物理小区锁定、流量统计、远程重启 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Tozed+ZLT+S10+%2F+S10G) |
| **Tozed ZLT S25** (4G LTE Cat.6 无线宽带 CPE) | 兼容 ZLT `http.cgi` 4G 射频遥测与挑战摘要登录 | LTE 2CC 载波聚合状态、LTE 频段锁定、锁小区、流量统计、远程重启 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Tozed+ZLT+S25) |
| **Tozed ZLT S50** (4G LTE Cat.12 高速聚合无线路由) | 兼容 ZLT `http.cgi` 4G 射频遥测与挑战摘要登录 | LTE 多载波聚合监控、LTE 频段锁定、锁小区、流量统计、远程重启 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Tozed+ZLT+S50) |

### 5.2 第二份资料补充的通则康威 / 联通定制型号

| 型号 | 资料记载的功能（未实测） | 资料标注待验证的功能 | 实测反馈 |
| :--- | :--- | :--- | :--- |
| **ZLT X30 (5G AX3000 Pro CPE)** | ZLT `/cgi-bin/http.cgi` 鉴权、4G/5G 信号监控、PCI/TAC/CellID/ARFCN/Band 解析、载波聚合监控、网络制式切换、4G/5G 频段锁定、4G/5G 小区锁定、温度与流量统计 | 3GPP R16 多载波聚合分量提取 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+ZLT+X30) |
| **ZLT S10G (4G LTE Cat.4 CPE)** | ZLT CGI / `goform` 鉴权、4G LTE 信号监控、PCI/TAC/CellID/EARFCN/Band 解析、LTE 频段锁定、4G 小区锁定、流量统计、终端列表 | 不同地区定制版默认管理网关自动探测 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+ZLT+S10G) |

---

## 6. 鲲鹏无限 (NRadio)

> 烽燧里对应的品牌：**鲲鹏无限（NRadio）**。已实现：信号、附近的基站、锁频段、锁小区、重启。

适用于搭载鲲鹏 **NROS**（基于 OpenWrt `LuCI` 增强分支 `/cgi-bin/luci/nradio/*` 与 `/cgi-bin/luci/nradioadv/*`，默认网关 `192.168.66.1`，默认隐式账号 `root`）并桥接海思/鼎桥/移远/广和通/高通/联发科 5G 模组的桌面、便携及工业级 CPE 全系列（`nradio-kunpeng`）。

### 6.1 NROS (OpenWrt LuCI 增强分支 + 模组 XML 桥接) 协议族

| 型号 | 资料记载的功能（未实测） | 资料标注待验证的功能 | 实测反馈 |
| :--- | :--- | :--- | :--- |
| **NRadio C8-668GL** (5G 双 2.5G 高性能 M.2 桌面 CPE / MT7981B) | LuCI `sysauth` 登录与 请求 `token` 提取、5G/4G 实时射频信号（`modem_Update`）、流量与系统概览监控（原厂 NROS 固件） | 不同内置 M.2 模组（RM520N-GL / FM350-GL / MT5700M）下的频段锁定、小区锁定、邻区扫描与温度回读（注：刷入社区主线纯 OpenWrt 后需改用标准 OpenWrt 协议） | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+NRadio+C8-668GL) |
| **NRadio C2000 Max** (5G-A Wi-Fi 7 铝合金便携 Mini CPE / 鼎桥 MT5700M-CN) | NROS 登录鉴权、5G-A / 4G 实时射频信号监控、SIM/eSIM 状态与系统信息读取、模组 XML 桥接层兼容性 | 海思/鼎桥模组 5G-A 3CC 载波聚合、n79/n28 频段掩码锁定、小区锁定、机身温度与流量统计、远程重启 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+NRadio+C2000+Max) |
| **NRadio C2000 Ultra** (5G-A 四核 Wi-Fi 7 旗舰便携/桌面 CPE) | 兼容 NROS `/cgi-bin/luci/nradio/*` 鉴权与实时射频监控接口 | 5G-A 多载波聚合指标、4G/5G 频段锁定、物理小区锁定、双卡切换状态、温度与流量统计、远程重启 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+NRadio+C2000+Ultra) |
| **NRadio C2000 Pro** (5G/4G 双频千兆紧凑型 CPE) | 兼容 NROS 登录鉴权、`overview` 硬件识别与 `modem_Update` 信号遥测 | 4G/5G 频段锁定、网络制式切换、小区锁定、流量统计、远程重启 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+NRadio+C2000+Pro) |
| **NRadio C2000** (4G LTE 双网口便携宽带路由器) | 兼容 NROS 登录鉴权与 4G LTE 射频参数监控 | LTE 频段锁定、锁小区支持性、流量统计、远程重启 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+NRadio+C2000) |
| **NRadio C5800-500** (5G Wi-Fi 6 商用多千兆 CPE / 海思 MH5000-82M) | NROS 登录鉴权、海思巴龙模组射频参数监控、XML 控制桥接端点兼容性 | 4G/5G 频段锁定（`net-mode` 掩码）、网络模式切换、载波聚合监控、流量统计、远程重启 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+NRadio+C5800-500) |
| **NRadio C8-660** (5G 室内高增益多网口 CPE) | NROS 登录鉴权与 `nradioadv/Advance_Cell` / `modem_Update` 射频状态采集 | 高通/联发科/展锐模组批次下的频段锁定、小区锁定、邻区列表与温度监控、远程重启 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+NRadio+C8-660) |
| **NRadio C8-620** (5G 室内双频千兆 CPE) | 兼容 NROS 登录鉴权与 5G/4G 射频指标采集 | 网络制式切换、4G/5G 频段锁定、小区锁定、流量统计、远程重启 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+NRadio+C8-620) |
| **NRadio C8-520** (5G 室内 Wi-Fi 6 多千兆 CPE) | NROS 登录鉴权、5G/4G 主小区射频指标（RSRP/RSRQ/SINR/PCI/ARFCN/Band）与系统信息监控 | 4G/5G 频段锁定、小区频点锁定、接入客户端与流量统计、远程重启 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+NRadio+C8-520) |
| **NRadio C8-500** (5G 室内入门千兆 CPE) | 兼容 NROS 登录鉴权与 5G/4G 射频指标采集 | 4G/5G 频段锁定、网络模式切换、流量统计、远程重启 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+NRadio+C8-500) |
| **NRadio C3000** (5G 工业级双卡导轨网关) | 兼容 NROS 工业分支登录鉴权与蜂窝射频监控 | 双 SIM 卡状态回读、4G/5G 频段锁定、小区锁定、工业看门狗与温度监控、远程重启 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+NRadio+C3000) |
| **NRadio C5000** (5G 工业级多网口防掉线路由器) | 兼容 NROS 工业分支登录鉴权与蜂窝射频监控 | 双卡冗余切换状态、4G/5G 频段锁定、小区锁定、温度监控、远程重启 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+NRadio+C5000) |
| **NRadio C5200** (5G 高性能企业/工业多千兆网关) | 兼容 NROS 登录鉴权与 5G/4G 射频参数监控 | 载波聚合状态、4G/5G 频段锁定、物理小区锁定、流量统计、远程重启 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+NRadio+C5200) |
| **NRadio C9100** (5G 室外防水高增益 PoE ODU) | 兼容 NROS 登录鉴权与室外单元射频信号高频刷新 | 定向安装信号辅助对星、4G/5G 频段锁定、物理小区锁定、桥接状态监控、远程重启 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+NRadio+C9100) |

---

## 7. OpenWrt 5G 模组网关生态 (Quectel 移远 & Fibocom 广和通 ubus/AT)

> 烽燧里对应的品牌：**OpenWrt + 移远 / 广和通模组**（通过路由器的 ubus 接口向模组发 AT 指令）。已实现：信号、附近的基站、锁频段、锁小区、重启模组。

适用于搭载移远（Quectel）与广和通（Fibocom）5G M.2 / LGA 通信模组、运行 OpenWrt `rpcd` / `ubus` JSON-RPC 2.0 架构的 DIY 及工业级 5G CPE 网关（`openwrt-at-ubus`）。

### 7.1 按通信模组系列划分的 OpenWrt 网关支持矩阵

| 型号 | 资料记载的功能（未实测） | 资料标注待验证的功能 | 实测反馈 |
| :--- | :--- | :--- | :--- |
| **Quectel RM520N-GL / RM530N-GL** (Snapdragon X62 5G OpenWrt CPE) | OpenWrt `ubus` 会话鉴权、`AT+QENG="servingcell"` 主小区 5G/4G 信号监控、`AT+QCAINFO` 载波聚合解析、`AT+QTEMP` 基带温度监控、`AT+QNWPREFCFG` 4G/5G 锁频段与网络制式切换、`AT+QNWLOCK` 物理小区锁定 | 5G 2CC 载波聚合上下行速率分流监控、双 SIM 卡切换、eSIM Profile 状态回读 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Quectel+RM520N-GL+%2F+RM530N-GL) |
| **Quectel RG500Q-EA / RM500Q-GL / RM500U-CN** (Snapdragon X55 / 展锐 V510 OpenWrt CPE) | OpenWrt `ubus` 会话鉴权、`AT+QENG="servingcell"` 与 `AT+QENG="neighbourcell"` 主/邻区射频监控、`AT+QNWPREFCFG` 频段锁定与制式切换 | RM500U-CN 展锐分支扩展 AT 锁小区指令参数格式核验、内置散热风扇 PWM 联动状态 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Quectel+RG500Q-EA+%2F+RM500Q-GL+%2F+RM500U-CN) |
| **Fibocom FM160-CN / FM150-AE** (Snapdragon X62 / X55 OpenWrt CPE) | OpenWrt `ubus` 会话鉴权、`AT+GTCCINFO?` 服务小区与邻区十六进制 ARFCN/PCI/RSRP/SINR 映射、`AT+GTACT` 4G/5G 频段与制式锁定、`AT+GTCELLLOCK` 物理小区锁定 | `AT+GTCAINFO?` 多载波聚合分量明细、模组温度读取 (`AT+MTSM=1`) | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Fibocom+FM160-CN+%2F+FM150-AE) |
| **Fibocom FM350-GL / FG370** (MediaTek T750 / T830 OpenWrt CPE) | OpenWrt `ubus` 会话鉴权、MTK T750/T830 5G NR / 4G LTE 射频参数采集、网络制式切换与频段掩码控制 | 5G 3CC 载波聚合状态回读、PCI/NR-ARFCN 频点锁定指令兼容性验证 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Fibocom+FM350-GL+%2F+FG370) |

### 7.2 第二份资料补充的 OpenWrt 模组与整机

| 型号 | 资料记载的功能（未实测） | 资料标注待验证的功能 | 实测反馈 |
| :--- | :--- | :--- | :--- |
| **Quectel RM520N-GL (高通 SDX62 5G R16 模组网关)** | OpenWrt `ubus` JSON-RPC 2.0 鉴权、`AT+QENG="servingcell"` 4G/5G 信号与 CQI/MCS/MIMO/TxPower 解析、`AT+QCAINFO` 载波聚合解析、`AT+QENG="neighbourcell"` 邻区扫描、`AT+QTEMP` 温度监控、`AT+QNWPREFCFG` 网络模式与 4G/5G 频段锁定、`AT+QNWLOCK` 4G/5G 小区锁定 | 2CC/3CC 载波聚合下各分量 UL/DL 调制阶数显示、eSIM Profile 切换状态 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Quectel+RM520N-GL) |
| **Quectel RM530N-GL (高通 SDX62 毫米波+Sub-6G 模组网关)** | OpenWrt `ubus` 鉴权、`AT+QENG="servingcell"` 信号解析、`AT+QCAINFO` 载波聚合解析、`AT+QENG="neighbourcell"` 邻区扫描、`AT+QTEMP` 温度监控、`AT+QNWPREFCFG` 频段锁定、`AT+QNWLOCK` 小区锁定 | FR2 毫米波频段状态与多载波聚合显示 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Quectel+RM530N-GL) |
| **Quectel RM500Q-GL (高通 SDX55 5G 模组网关)** | OpenWrt `ubus` 鉴权、`AT+QENG="servingcell"` 4G/5G 信号解析、`AT+QCAINFO` 载波聚合解析、`AT+QENG="neighbourcell"` 邻区扫描、`AT+QTEMP` 温度监控、`AT+QNWPREFCFG` 频段锁定、`AT+QNWLOCK="common/4g"` & `"common/5g"` 小区锁定 | 早期 RM500Q 固件下 `AT+QNWLOCK="common/5g"` 子载波间隔 (SCS `15`/`30` kHz) 自适应 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Quectel+RM500Q-GL) |
| **RM500Q-AE (高通 SDX55 5G 模组网关)** | OpenWrt `ubus` 鉴权、`AT+QENG="servingcell"` 4G/5G 信号解析、`AT+QCAINFO` 载波聚合解析、`AT+QENG="neighbourcell"` 邻区扫描、`AT+QTEMP` 温度监控、`AT+QNWPREFCFG` 频段锁定、`AT+QNWLOCK="common/4g"` & `"common/5g"` 小区锁定 | 早期 RM500Q 固件下 `AT+QNWLOCK="common/5g"` 子载波间隔 (SCS `15`/`30` kHz) 自适应 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+RM500Q-AE) |
| **Quectel RM502Q-AE (高通 SDX55 Sub-6G R15 增强模组网关)** | OpenWrt `ubus` 鉴权、`AT+QENG="servingcell"` 信号解析、`AT+QCAINFO` 载波聚合解析、`AT+QENG="neighbourcell"` 邻区扫描、`AT+QTEMP` 温度监控、`AT+QNWPREFCFG` 频段锁定、`AT+QNWLOCK` 小区锁定 | LTE Cat.20 与 EN-DC 多分量聚合显示 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Quectel+RM502Q-AE) |
| **Quectel RG500Q-EA (LGA 封装 SDX55 5G 模组 CPE)** | OpenWrt `ubus` 鉴权、`AT+QENG="servingcell"` 信号监控、`AT+QCAINFO` 载波聚合、`AT+QENG="neighbourcell"` 邻区扫描、`AT+QTEMP` 温度监控、`AT+QNWPREFCFG` 频段锁定、`AT+QNWLOCK` 小区锁定 | PCIe RC/EP 直连模式与 USB 3.0 模式下 AT 虚拟串口号自动发现 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Quectel+RG500Q-EA) |
| **RG500Q-CN (LGA 封装 SDX55 5G 模组 CPE)** | OpenWrt `ubus` 鉴权、`AT+QENG="servingcell"` 信号监控、`AT+QCAINFO` 载波聚合、`AT+QENG="neighbourcell"` 邻区扫描、`AT+QTEMP` 温度监控、`AT+QNWPREFCFG` 频段锁定、`AT+QNWLOCK` 小区锁定 | PCIe RC/EP 直连模式与 USB 3.0 模式下 AT 虚拟串口号自动发现 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+RG500Q-CN) |
| **Quectel RG520N-EU (LGA 封装 SDX62 5G 模组 CPE)** | OpenWrt `ubus` 鉴权、`AT+QENG="servingcell"` 信号监控、`AT+QCAINFO` 载波聚合、`AT+QENG="neighbourcell"` 邻区扫描、`AT+QTEMP` 温度监控、`AT+QNWPREFCFG` 频段锁定、`AT+QNWLOCK` 小区锁定 | R16 NR CA 双载波聚合与超级上行状态解析 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Quectel+RG520N-EU) |
| **RG520N-CN (LGA 封装 SDX62 5G 模组 CPE)** | OpenWrt `ubus` 鉴权、`AT+QENG="servingcell"` 信号监控、`AT+QCAINFO` 载波聚合、`AT+QENG="neighbourcell"` 邻区扫描、`AT+QTEMP` 温度监控、`AT+QNWPREFCFG` 频段锁定、`AT+QNWLOCK` 小区锁定 | R16 NR CA 双载波聚合与超级上行状态解析 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+RG520N-CN) |
| **Quectel RM551E-GL (高通 SDX75 5G-A R17/R18 模组网关)** | OpenWrt `ubus` 鉴权、`AT+QENG="servingcell"` 5G-A 信号监控、`AT+QCAINFO` 多载波聚合、`AT+QENG="neighbourcell"` 邻区扫描、`AT+QTEMP` 温度监控、`AT+QNWPREFCFG` 频段锁定、`AT+QNWLOCK` 小区锁定 | 5G-A 3CC/4CC 载波聚合与下行 1024QAM 指标提取 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Quectel+RM551E-GL) |
| **RG650E (高通 SDX75 5G-A R17/R18 模组网关)** | OpenWrt `ubus` 鉴权、`AT+QENG="servingcell"` 5G-A 信号监控、`AT+QCAINFO` 多载波聚合、`AT+QENG="neighbourcell"` 邻区扫描、`AT+QTEMP` 温度监控、`AT+QNWPREFCFG` 频段锁定、`AT+QNWLOCK` 小区锁定 | 5G-A 3CC/4CC 载波聚合与下行 1024QAM 指标提取 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+RG650E) |
| **Quectel RM500U-CN (展锐 V510 5G 模组网关)** | OpenWrt `ubus` 鉴权、`AT+QENG="servingcell"` 信号监控、`AT+QENG="neighbourcell"` 邻区扫描、`AT+QTEMP` 温度监控、`AT+QNWPREFCFG` 频段锁定、`AT+QNWLOCK="common/4g"` & `"nr5g"` 小区锁定 | 展锐基带分支下 `AT+QCAINFO` 返回格式与高通分支差异兼容验证 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Quectel+RM500U-CN) |
| **RG500U-CN (展锐 V510 5G 模组网关)** | OpenWrt `ubus` 鉴权、`AT+QENG="servingcell"` 信号监控、`AT+QENG="neighbourcell"` 邻区扫描、`AT+QTEMP` 温度监控、`AT+QNWPREFCFG` 频段锁定、`AT+QNWLOCK="common/4g"` & `"nr5g"` 小区锁定 | 展锐基带分支下 `AT+QCAINFO` 返回格式与高通分支差异兼容验证 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+RG500U-CN) |
| **RG200U-CN (展锐 V510 5G 模组网关)** | OpenWrt `ubus` 鉴权、`AT+QENG="servingcell"` 信号监控、`AT+QENG="neighbourcell"` 邻区扫描、`AT+QTEMP` 温度监控、`AT+QNWPREFCFG` 频段锁定、`AT+QNWLOCK="common/4g"` & `"nr5g"` 小区锁定 | 展锐基带分支下 `AT+QCAINFO` 返回格式与高通分支差异兼容验证 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+RG200U-CN) |
| **GL.iNet GL-X3000 (Spitz AX 5G Wi-Fi 6 CPE)** | OpenWrt `ubus` / GL.iNet API 鉴权、RM520N-GL 全量 4G/5G 信号与 CA 监控、邻区扫描、温度监控、4G/5G 频段锁定、4G/5G 小区锁定、双 SIM 卡切换、流量统计、终端列表 | GL.iNet 4.x 固件原生接口与标准 `ubus` 双通道无缝协作 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+GL.iNet+GL-X3000) |
| **GL.iNet GL-XE3000 (Puli AX 5G 电池版便携 CPE)** | OpenWrt `ubus` / GL.iNet API 鉴权、RM520N-GL 4G/5G 信号与 CA 监控、邻区扫描、温度与 6400mAh 电池电量监控、4G/5G 频段锁定、4G/5G 小区锁定、流量统计、终端列表 | 便携电池放电功率与休眠唤醒策略状态读取 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+GL.iNet+GL-XE3000) |
| **GL.iNet GL-X750V2 (Spitz) / GL-XE300 (Puli)** | OpenWrt `ubus` 鉴权、Quectel EC25 / EP06 模组信号监控、PCI/TAC/CellID/EARFCN/Band 解析、频段锁定、小区锁定、流量统计 | EC25/EP06 Cat.4/Cat.6 模组 `AT+QCFG="band"` 十六进制频段掩码回退适配 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+GL.iNet+GL-X750V2) |
| **智联 (Zhilian) / 昆仑 (Kunlun) / 创凌 (Trend-Link) OpenWrt 5G CPE** | OpenWrt `ubus` (`modem_ctrl` / `QModem`) 鉴权、4G/5G 信号与 CA 监控、邻区扫描、温度监控、网络模式切换、4G/5G 频段锁定、4G/5G 小区锁定、流量统计、终端列表 | 定制固件中 `QModem` / `3ginfo` 守护进程自定义 `ubus` 对象名探测 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+%E6%99%BA%E8%81%94) |
| **Fibocom FM650-CN (展锐 V510 5G 模组 CPE / 翼联 / 混血 CPE)** | OpenWrt `ubus` 鉴权、`AT+GTCCINFO?` 主服务小区与邻区完整解析 (RSRP/RSRQ/SINR/RSSI/PCI/TAC/CellID/ARFCN/Band/BW)、`AT+GTCAINFO?` 载波聚合解析、`AT+MTSM=1` 温度监控、`AT+GTACT` 网络制式与 4G/5G 频段锁定 (含 `+500` NR 频段偏移规则)、`AT+GTCELLLOCK` 4G/5G 小区锁定 | 不同固件版本下 `AT+GTCELLLOCK` 对 NSA 辅载波与 SA 主载波锁定的生效行为验证 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Fibocom+FM650-CN) |
| **Fibocom FM150-AE (高通 SDX55 5G 模组网关)** | OpenWrt `ubus` 鉴权、`AT+GTCCINFO?` 主/邻区信号解析、`AT+GTCAINFO?` 载波聚合解析、`AT+MTSM=1` 温度监控、`AT+GTACT` 频段锁定、`AT+GTCELLLOCK` 小区锁定 | 高通平台下 `AT+GTCAINFO?` 多分量 SCC 带宽编码 (`100`/`200`/`400`) 映射验证 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Fibocom+FM150-AE) |
| **FG150-AE (高通 SDX55 5G 模组网关)** | OpenWrt `ubus` 鉴权、`AT+GTCCINFO?` 主/邻区信号解析、`AT+GTCAINFO?` 载波聚合解析、`AT+MTSM=1` 温度监控、`AT+GTACT` 频段锁定、`AT+GTCELLLOCK` 小区锁定 | 高通平台下 `AT+GTCAINFO?` 多分量 SCC 带宽编码 (`100`/`200`/`400`) 映射验证 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+FG150-AE) |
| **Fibocom FM160-EAU (高通 SDX62 5G R16 模组网关)** | OpenWrt `ubus` 鉴权、`AT+GTCCINFO?` 主/邻区信号解析、`AT+GTCAINFO?` R16 载波聚合解析、`AT+MTSM=1` 温度监控、`AT+GTACT` 频段锁定、`AT+GTCELLLOCK` 小区锁定 | NR 2CC/3CC 聚合状态与 UL MIMO 状态解析 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Fibocom+FM160-EAU) |
| **FG160-EAU (高通 SDX62 5G R16 模组网关)** | OpenWrt `ubus` 鉴权、`AT+GTCCINFO?` 主/邻区信号解析、`AT+GTCAINFO?` R16 载波聚合解析、`AT+MTSM=1` 温度监控、`AT+GTACT` 频段锁定、`AT+GTCELLLOCK` 小区锁定 | NR 2CC/3CC 聚合状态与 UL MIMO 状态解析 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+FG160-EAU) |
| **FM160-CN (高通 SDX62 5G R16 模组网关)** | OpenWrt `ubus` 鉴权、`AT+GTCCINFO?` 主/邻区信号解析、`AT+GTCAINFO?` R16 载波聚合解析、`AT+MTSM=1` 温度监控、`AT+GTACT` 频段锁定、`AT+GTCELLLOCK` 小区锁定 | NR 2CC/3CC 聚合状态与 UL MIMO 状态解析 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+FM160-CN) |
| **Fibocom FG370-NA (联发科 T830 / T750 5G 模组网关)** | OpenWrt `ubus` 鉴权、`AT+GTCCINFO?` 信号监控、PCI/TAC/CellID/ARFCN/Band 解析、频段锁定、小区锁定 | 联发科 T750/T830 平台 AT 指令集与标准 `GT*` 指令集扩展字段对照验证 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Fibocom+FG370-NA) |
| **FM350-GL (联发科 T830 / T750 5G 模组网关)** | OpenWrt `ubus` 鉴权、`AT+GTCCINFO?` 信号监控、PCI/TAC/CellID/ARFCN/Band 解析、频段锁定、小区锁定 | 联发科 T750/T830 平台 AT 指令集与标准 `GT*` 指令集扩展字段对照验证 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+FM350-GL) |

---

## 8. D-Link 与 TP-Link（LuCI RPC / Web JSON 接口）

> **烽燧还没有这类路由器的实现。** 下面只是第二份资料里的型号汇总：在「设置 → 路由器」里选不到对应的品牌，自动识别也认不出它们。列在这里是为了收集实测报告，等有了可靠的接口资料再实现。

资料记载这些路由器使用 OpenWrt `luci-mod-rpc`（`/cgi-bin/luci/rpc/auth`、`/cgi-bin/luci/rpc/uci`）或厂商自己的 Web JSON 接口，与烽燧已有的 OpenWrt 实现（ubus + AT 指令）不是同一套。

| 型号 | 资料记载的功能（未实测） | 资料标注待验证的功能 | 实测反馈 |
| :--- | :--- | :--- | :--- |
| **D-Link DWR-2000M (5G Wi-Fi 6 CPE)** | LuCI JSON-RPC (`/cgi-bin/luci/rpc/auth`) 鉴权、4G/5G 信号监控、PCI/TAC/CellID/ARFCN/Band 解析、无线配置读取 (`/cgi-bin/luci/rpc/uci`)、流量统计、终端列表 | 基于内置模组的 4G/5G 频段锁定与小区锁定指令适配 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+D-Link+DWR-2000M) |
| **D-Link DWR-2101 (5G Wi-Fi 6 触屏随身路由)** | LuCI JSON-RPC / Web 鉴权、4G/5G 信号监控、PCI/TAC/CellID/ARFCN/Band 解析、电池状态监控、流量统计 | 内置模组频段锁定接口验证 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+D-Link+DWR-2101) |
| **D-Link DWR-953V2 (4G LTE 路由器)** | LuCI JSON-RPC 鉴权、4G LTE 信号监控、PCI/TAC/CellID/EARFCN/Band 解析、无线与 WAN 状态监控、流量统计 | 不同硬件修订版 (Rev A / Rev B) 下 LTE 频段锁定 UCI 配置项名称验证 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+D-Link+DWR-953V2) |
| **DWR-960 (4G LTE 路由器)** | LuCI JSON-RPC 鉴权、4G LTE 信号监控、PCI/TAC/CellID/EARFCN/Band 解析、无线与 WAN 状态监控、流量统计 | 不同硬件修订版 (Rev A / Rev B) 下 LTE 频段锁定 UCI 配置项名称验证 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+DWR-960) |
| **DWR-921 (4G LTE 路由器)** | LuCI JSON-RPC 鉴权、4G LTE 信号监控、PCI/TAC/CellID/EARFCN/Band 解析、无线与 WAN 状态监控、流量统计 | 不同硬件修订版 (Rev A / Rev B) 下 LTE 频段锁定 UCI 配置项名称验证 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+DWR-921) |
| **TP-Link Archer NX200 (5G AX1800 / AX3000 CPE)** | Web 鉴权与基础蜂窝状态监控、4G/5G 信号指标 (RSRP/RSRQ/SINR)、Band/ARFCN/PCI 读取、流量统计、终端列表 | TP-Link 新版固件 RSA+AES 混合签名下手动锁频段 (`band_list`) 与锁小区 (`cell_lock`) 接口验证 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+TP-Link+Archer+NX200) |
| **NX510v (5G AX1800 / AX3000 CPE)** | Web 鉴权与基础蜂窝状态监控、4G/5G 信号指标 (RSRP/RSRQ/SINR)、Band/ARFCN/PCI 读取、流量统计、终端列表 | TP-Link 新版固件 RSA+AES 混合签名下手动锁频段 (`band_list`) 与锁小区 (`cell_lock`) 接口验证 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+NX510v) |
| **TP-Link Deco X50-5G (5G AX3000 Whole Home Mesh CPE)** | Web 鉴权与基础蜂窝状态监控、4G/5G 信号指标、Band/ARFCN/PCI 读取、Mesh 节点与终端列表、流量统计 | 外置天线开关与手动频段锁定扩展参数验证 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+TP-Link+Deco+X50-5G) |
| **TP-Link TL-TR961 5G** | Web 鉴权与蜂窝状态监控、4G/5G 信号指标、PCI/EARFCN/Band 解析、载波聚合状态 (MR600 Cat.6 2CC)、流量统计 | 国内版与国际版固件频段选择接口差异验证 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+TP-Link+TL-TR961+5G) |
| **TL-XDR3020 5G 定制版** | Web 鉴权与蜂窝状态监控、4G/5G 信号指标、PCI/EARFCN/Band 解析、载波聚合状态 (MR600 Cat.6 2CC)、流量统计 | 国内版与国际版固件频段选择接口差异验证 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+TL-XDR3020+5G+%E5%AE%9A%E5%88%B6%E7%89%88) |
| **Archer MR600** | Web 鉴权与蜂窝状态监控、4G/5G 信号指标、PCI/EARFCN/Band 解析、载波聚合状态 (MR600 Cat.6 2CC)、流量统计 | 国内版与国际版固件频段选择接口差异验证 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Archer+MR600) |

---

## 附：通用芯片公版与社区新机型适配反馈指引

若您手中的 5G/4G CPE（例如搭载移远 Quectel `RG500Q`/`RM520N`/`RG650V`、广和通 Fibocom `FM150`/`FM160`/`FM350`、高通 `SDX62`/`SDX75` 或联发科 `T750`/`T830` 公版 OpenWrt / WebUI 方案的其他品牌设备）未在上方表格单独列出：

1. 在「设置 → 路由器」把品牌留在「自动识别」。测试或保存连接时，烽燧会先用不需要登录的请求比对鲲鹏无限、中兴（zWRT、goform）、烽火、通则康威（ZLT）、品速、OpenWrt（ubus）和华为 HiLink 各自的特征接口，认出品牌之后才发送密码；同一方案的代工机型通常也能认出来。烽燧不会在后台自己重新识别。
2. 认不出来时，可以手动选一个最接近的品牌试试（只读，密码输错有次数限制，请先确认密码）；仍然连不上，欢迎[提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+)，写明型号和管理页面的登录地址，方便以后补上这个品牌。
