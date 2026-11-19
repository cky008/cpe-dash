# AGENTS.md — 「烽燧」(FengSui / cpe-dash) 工程、协议安全与 TDD 铁律守则

本文档定义私有化射频监控与网管平台 **「烽燧」(FengSui / `cpe-dash`)** 的强制架构契约（已验证型号：华为 5G CPE Ultra 6 `H168-383`，固件 `4.4.0.1`；其他华为型号与其他品牌的路由器按接口资料兼容，没有在真机上验证过）、类型安全铁律、协议排他避让机制、高危漏洞防御准则及 TDD 质量门禁。所有 AI 编码代理与人类贡献者均须无条件遵守。

---

## 1. 项目定位与独立自包含架构契约

- **项目代号**：「烽燧」(FengSui / `cpe-dash`) —— 面向群晖 Synology DS923+ (AMD Ryzen R1600 / 32GB RAM) 局域网 (`192.168.8.1`) 与私有内网场景打造的 5G 高阶射频监控、3CA 载波聚合观测、4G/5G 邻区扫描、锁频段/锁小区控制、蜂窝设置（网络制式、手动选网、SIM 卡槽与 PIN、飞行模式、漫游、APN、USSD）、分周期流量审计、终端拓扑管理，以及短信收发（加密镜像、通讯录、Telegram 双向机器人、签名 Webhook 与告警推送）一体化平台。
- **兼容范围**：**目前仅在 H168-383（固件 `4.4.0.1`）上验证过；其他华为型号与其他品牌按接口资料兼容，没有在真机上验证过。** 其他品牌（中兴 goform / zWRT、品速、通则康威 ZLT、烽火、鲲鹏无限、D-Link、TP-Link、OpenWrt + 移远 / 广和通模组）各有一份按接口资料写的驱动（`src/drivers/`）。写闸门在服务端（`src/device-access.ts` + 调度器的写路径 `control` / `refuse`），REST、MCP、Telegram 与自愈都绕不过去：在未验证的路由器上，**烽燧已经实现的写入默认开启，用户可以逐项关闭；烽燧没有实现的写入仍然拒绝**。「已经实现」指：其他品牌是该品牌驱动实现的写入（每个品牌一份事实，`src/router-family.ts`；品牌下有另一种接口写法、能做的更少的（如烽火 Pro 系列），按写法另记一份，驱动识别时报告路由器用的是哪一种，闸门按它算）；其他华为 HiLink 型号是通用写入（协议附录 A.11），并且识别探测显示这台路由器具备条件。用户在控制台「设置 → 设备」逐项关闭，关闭清单按型号 + 功能保存：被关闭的写入以 `409 DEVICE_WRITE_DISABLED` 拒绝，没有实现的以 `409 DEVICE_UNVERIFIED_READ_ONLY` 拒绝，两者都不建会话。这些写入统称实验性写入，保护见第 4 节第 2 条。读取按路由器实际提供的项目宽容进行（协议附录 A.10）。对外只说「目前仅在 H168-383 上验证过」。本守则的铁律对所有型号和品牌一视同仁，不因兼容其他路由器而放松。
- **品牌与后端**：路由器的品牌（`RouterFamily`，`src/router-family.ts`）随连接保存（「设置 → 路由器」）；留在「自动识别」时，烽燧只用免登录请求认出品牌（`src/drivers/detect.ts`），认出之后才发送密码，守护进程从不在后台自行识别。读写服务（`CpeMonitor`、`CpeControlService`、`SmsService`）只面向 `RouterBackend`（`src/router-backend.ts`），它只有一个实现 `SessionBackend`：只管排队、闸门、审计与读取记录，不知道品牌；一次会话里发什么由连接所属品牌的会话对象决定（`RouterSession`，`src/router-session.ts`：华为在 `src/drivers/huawei/driver.ts`，其他品牌由 `src/drivers/adapter.ts` 套在各自驱动的 `DriverSession` 上），入队前的检查、哪些读取值得开会话由品牌的 `RouterDriver` 决定；每个入口问的都是这一份检查，REST、MCP、Telegram 都不拿一个品牌或型号的边界去检查另一台路由器。调度器只拿到连接设置（地址、账号、密码、请求怎样发出）和品牌，会话客户端由 `src/drivers/connection.ts` 按品牌建出：华为的 HiLink 客户端和它的登录记忆只在华为的连接里，与其他品牌的客户端对等；同品牌改凭据或地址在原连接上更新（新凭据清掉旧的熔断），换品牌只在两次会话之间换一个连接；连接指向另一台路由器（另一个地址或另一个品牌）时，还在排队的写入不再执行（`409 CONNECTION_CHANGED`），之前那台路由器上的回退看守随即结束。**除调度器与 `router-backend.ts` 外，任何代码都不得打开路由器会话；`router-backend.ts` 不得判断品牌**（`test/router-backend.test.ts` 守着这条线）。给某个品牌增加能力，就在它的会话对象里实现对应的动词。烽燧对路由器的每一项读写都是后端动词：短信（未读数、列表、发送、标为已读、删除）、重拨、移动数据、路由器开关（UPnP、DMZ、防火墙）、Wi-Fi、天线、访问控制（Wi-Fi MAC 过滤、上网时段）、已连接设备，以及蜂窝设置（读取当前设置；网络制式、手动选网、SIM 卡槽、SIM PIN、飞行模式、数据漫游、APN、流量上限、清零流量统计、USSD）。华为的实现在 `src/drivers/huawei/`（会话对象在 `driver.ts`，H168-383 的已验证请求序列在 `requests.ts`、`access-control.ts` 与 `sms.ts`；按接口资料写的通用请求在 `src/protocols/hilink/generic-writes.ts`），其他品牌交给驱动会话上可选的方法（`DriverSession` 的 `sms`、`data`、`hosts`、`setAntennaMode`、`setCellLocks`（一次锁一组候选小区，品牌事实 `multiCellLock` 写明哪种网络能锁）、`cellular`）；资料里没有对应接口的品牌读返回「此型号不提供」、写由闸门拒绝。**服务层不调用调度器的会话方法**（`read`、`control`、`refuse`），也不直接打开任何品牌的会话（`test/router-backend.test.ts` 守着这条线）。用「先断开再连上」实现的重拨，结束时一定再发一次连上，中途出错也一样，两条指令各只发一次；会话在两条指令之间被截断（到了期限、守护进程停止）时，「连上」由会话收尾在注销之前补发（`LanHttp.owe`），驱动里照路由器页面「先断开、改完再连上」的写入（中兴 goform 的选网与接入点、D-Link 的网络制式与接入点）同样处理。
- **分层（每个品牌走同一条路，华为也一样）**：入口（控制台、REST、SSE、MCP、Telegram、自愈）→ 操作登记（`src/operations/`：每个读写操作一条记录，各入口的路由、工具、权限和第一层入参检查都从它来，见第 4 节第 9 条）→ 共用的规则（入参校验、写闸门、审计）→ 不分品牌的服务（监控、控制、短信、蜂窝设置、访问控制、告警、自愈、时序）→ `RouterBackend` 动词 → **一个后端实现**（只管排队、闸门、审计、读取记录与写入记录，不知道品牌）→ **调度器的一条读路径与一条写路径** → **一个会话客户端**（`src/session-client.ts`：互斥、限时、免登录检查与让位、只交一次密码、熔断、`finally` 注销）→ **每个品牌一个驱动**（自己的登录方式、会话里的读写、事实）→ **协议部件**（`src/protocols/`：HiLink、ubus、模组 AT 指令；只管会话与解析，不含只对某个品牌或型号成立的事实，供驱动组合；驱动与部件都要用的传输、取值清洗和读数形状也在这里）。依赖只有一个方向：驱动引用协议部件，协议部件不引用 `src/drivers/`（`test/router-backend.test.ts` 守着这条线）。新品牌只加驱动和事实；新能力先加动词，再在有记录的品牌的驱动里实现。不为了「不碰已验证的代码」保留平行的旧路径：H168-383 的约束是发给路由器的请求逐字节不变，由请求序列比对证明，与代码怎样组织无关。
- **在线演示跑同一套服务**：GitHub Pages 上的在线演示在浏览器里装配守护进程的服务（`src/services.ts`），登录之后的分派也是守护进程的（`src/http-api.ts`），只把传输换成页面里的、把路由器换成测试用的模拟路由器（演示世界 `web/src/demo/worlds.ts`）；守护进程用到的 Node 内置模块由只进演示包的替身（`web/src/demo/node/`，与 Node 逐字节对照测试）提供。演示不另写任何读写、闸门、存储或处理函数：给烽燧加一项能力，只要模拟路由器支持它（测试本来就要），演示就有。
- **短信与遥测同源调度**：短信不再由独立进程（如旧 `cpe-sms`）登录 CPE，而是与遥测共用唯一的 `MutexSessionScheduler`，从根本上消除单管理员会话争抢。
- **Claude Desktop 扩展只装 stdio 桥接**：扩展（MCP Bundle，`dist/fengsui-<版本>.mcpb`，由 `npm run build:mcpb` 打出，发版时附到 GitHub Release，再登记到官方 MCP Registry：名字 `io.github.cky008/fengsui`，登记文件 `dist/server.json` 与扩展一起生成，写明 Release 上这个文件的下载地址和 SHA-256；`release.yml` 在文件附上之后凭 GitHub OIDC 登记，仓库里不存任何密钥）里只有桥接（`src/desktop-extension.ts` + `src/mcp-stdio-bridge.ts`，测试保证包里没有守护进程的模块），由 Claude Desktop 自带的 Node 运行。它和 `cpe-dash mcp` 一样是零状态桥接：只把请求转发到守护进程的 `/mcp`，不开路由器会话，不存任何状态。地址和令牌是扩展的设置，只从 Desktop 传入的环境变量读，扩展不读任何 `.env`；地址照 `MCP_DAEMON_URL` 的规则校验（`https://` 任何主机都行，公网域名也一样；明文 `http://` 只接受局域网、私网与 Tailscale 的主机，令牌不以明文离开家里的网络；不带凭据、查询串和片段），令牌在 manifest 里标为敏感项，由 Desktop 存在系统钥匙串里，不写进任何文件、日志或报错。
- **100% 独立闭环原则**：`cpe-dash` 必须是完全独立闭环的开源仓库，**严禁对任何外部兄弟目录（如 `cpe-sms`）产生跨目录相对路径引用、`file:` 依赖或软链接**。
- **零运行时外部依赖**：生产运行时仅依赖 Node.js (`>= 22.6.0`) 原生内置模块（`node:crypto`、`node:http`、`node:fs`、`node:net`、全局 `fetch`），彻底杜绝第三方供应链投毒面。
- **默认高位端口隔离**：Web 控制台与统一 API 默认监听 `WEB_PORT=18384`，避开 NAS 常用 `8080` 及兄弟项目端口（如 `18383`）。

```text
cpe-dash/
├── src/
│   ├── types.ts            # 全局严格接口与判别联合类型定义（含 AppConfig）
│   ├── config.ts           # 纯原生 .env 解析器、SSRF Origin 校验与强类型配置加载
│   ├── sanitize.ts         # 敏感标识符（IMEI/IMSI/MAC/IP/TAC/CellID/口令/手机号）自动化脱敏引擎（探针输出与抓包审计）
│   ├── redact.ts           # REDACT_SENSITIVE_IN_API 输出边界：Bearer API / SSE / MCP 拿脱敏副本，Web 控制台拿原值
│   ├── encrypted-file.ts   # StorageCipher: scrypt + HKDF-SHA256 + AES-256-GCM (0600) 落盘加密、原子写入与单进程文件锁
│   ├── state-store.ts · timeseries.ts  # 加密运行时状态（熔断锁存、锁定状态、缓存快照、告警）与双层环形时序（5s / 60s）
│   ├── session-client.ts   # 所有品牌共用的会话客户端：互斥、限时、免登录检查后让位（第 1 层）与登录应答让位（第 2 层）、只交一次密码、108006 / 108007 熔断（重启后接着锁）、finally 注销（会话被截断时先限时等它的工作收尾，注销的请求发出时这次会话的工作已经停下）；各品牌只提供自己的检查、登录与注销（SessionProtocol）
│   ├── router-trust.ts · pinned-fetch.ts  # 管理页只能用 HTTPS、证书由路由器自己签发时的信任：router-trust.ts 零依赖，是证书指纹（SHA-256，64 位十六进制）的规整与显示、证书摘要的形状，以及守护进程按来源记下「信任哪一张」的 CertificateTrust（正在用的路由器一张，测试连接期间另有候选的一张）；pinned-fetch.ts 只在守护进程里（node:tls）：对有信任指纹的来源先完成握手、核对证书指纹，一致才发请求（createRouterFetch），以及只握手不发请求地读出路由器出示的证书（peekCertificate）；其余请求照旧走全局 fetch。由 cli.ts 放进连接设置，在线演示没有
│   ├── session-errors.ts   # 所有品牌的会话都可能遇到的错误：路由器错误码（CpeApiError，用 HiLink 的编号）、登录应答无法判断时记的代码（LOGIN_UNCONFIRMED_CODE）、请求没有应答、应答读不懂、会话没有加密通道、会话超时与重入、登录方式定不下来（LoginMethodError：密码没有发出；各品牌的登录都抛它，调度器只认这一个）
│   ├── cpe-domain.ts       # 各品牌共用的快照与指令：遥测、射频与载波、附近的基站、已连接设备、路由器设置、锁定状态与锁定指令的类型，锁定核对（verifyLockState）、目标小区是否见过、「此型号不提供」怎样判断；不发任何请求（遥测快照的 `status` 是路由器状态，见 router-status.ts）
│   ├── router-status.ts    # 零依赖：路由器状态（电池、SIM 卡、飞行模式、漫游、路由器自己的负载与运行时间、固件更新、Wi-Fi 开关、按名字分开的温度传感器）的类型与共用规则（电量低、SIM 卡锁住）；各品牌的后端填同一个形状，路由器没报告的留 `null`；守护进程、控制台与在线演示共用
│   ├── scheduler.ts        # MutexSessionScheduler：唯一的会话调度器（优先级队列、避让、熔断、写闸门）；拿到的是连接设置（地址、账号、密码、请求怎样发出）加品牌，当前连接（品牌的 RouterDriver、会话客户端、打开 RouterSession 的方式）由 drivers/connection.ts 按品牌建出；同品牌改凭据或地址在原连接上更新，换品牌在队列里换一个连接；所有品牌只有一条读路径（read）与一条写路径（control、refuse）
│   ├── connection-pause.ts # 零依赖：暂停连接（「设置 → 路由器」）的上限、可选时长、状态与存盘记录的形状和校验；暂停本身在调度器里：到期前不开任何会话、不发任何请求（守护进程、控制台与在线演示共用）
│   ├── cpe-monitor.ts      # 读侧（只面向 RouterBackend）：后台轮询、单飞刷新、快照缓存与时序写入；启动后识别路由器一次（当时连不上则在第一次读成功后补上；不进入轮询）
│   ├── cpe-controls.ts     # 写侧：锁频锁站、解锁、自动回滚、重启、重拨、移动数据、路由器开关、Wi-Fi、天线、访问控制与蜂窝设置，全部经 RouterBackend（不分品牌，入队前校验）
│   ├── cellular.ts         # 零依赖：蜂窝设置的类型与入参校验（网络制式、SIM 卡槽、APN、运营商选择、流量上限、PIN 与 USSD 的格式）、PIN 什么时候不发及其说明文字、卡槽在摘要里的叫法（守护进程、控制台与在线演示同一实现）
│   ├── access-state.ts · access-plan.ts  # 零依赖：Wi-Fi MAC 过滤状态与访问控制规划（受保护设备、名单、上网时段冲突；前后端同一实现）
│   ├── access-control.ts   # 访问控制里各品牌共用的部分：快照与请求上下文的类型、由已连接设备算出一次改动不能拦的设备（运行烽燧的那台、发起请求的那台）
│   ├── core.ts             # FengSuiCore 装配（scheduler + monitor + controls）
│   ├── router-family.ts    # 零依赖：路由器品牌（RouterFamily）、各品牌的常见地址 / 默认账号 / 读哪些功能、实现了哪些写入（都只用 features.ts 登记过的名字）、华为的通用写入在未验证型号上要识别探测先看到什么（`probe`）、短信的已读状态由路由器还是烽燧保管的事实（每个品牌一份；品牌下另一种接口写法能读写的另记一份，`variants`）、接口里不报告型号的品牌用什么名字代替型号（`unnamedModel`：品速，写闸门、设备报告和「设置 → 设备」都按这个名字）、控制台显示的名字、「自动识别」这个选项与识别的先后顺序（DETECTION_ORDER）
│   ├── router-backend.ts   # RouterBackend：烽燧对一台路由器的全部读写动词（识别、信号、附近的基站、已连接设备、设置、访问控制、短信列表与免登录未读数、蜂窝设置；锁频、锁小区、解锁、自动回滚、重启、重拨与自愈重拨、移动数据、路由器开关、Wi-Fi、天线、Wi-Fi MAC 过滤、上网时段、发短信、标为已读、删除短信；网络制式、搜索与选择运营商、SIM 卡槽、输入 PIN 与开关 PIN、飞行模式、数据漫游、APN、流量上限、清零流量统计、USSD，以及断网后把这些设置改回去的回退；智能体的只读接口探查）与它唯一的实现 SessionBackend（排队、闸门、审计、读取记录，不知道品牌）
│   ├── router-session.ts   # RouterSession：一次会话里对路由器的全部读写（每个品牌一个实现）；RouterDriver：品牌在会话之外的事实（实现了哪些写入、哪些读取值得开会话、入队前的检查、免登录的未读数）
│   ├── drivers/            # 每个品牌的驱动：huawei/（华为：driver.ts 是 HiLink 的会话对象与 RouterDriver，H168-383 走已验证序列、其他 HiLink 型号走通用写入；requests.ts 是 H168-383 的已验证请求序列（遥测、附近的基站、已连接设备、设置、锁频与锁小区、路由器开关、Wi-Fi、天线、移动数据、重启、重拨）与它们在未验证型号上的宽容读法，遥测快照的 `status` 只从已经在读的应答里取，例如 `monitoring/status` 的电量；band-lock.ts 是 H168-383 的频段掩码与锁小区载荷；access-control.ts 是 Wi-Fi MAC 过滤与上网时段在一个控制会话内的读写与回读核对；sms.ts 是短信的请求序列：列表（明文，被拒时改走加密的联系人列表）、发送与状态轮询、标为已读、删除、免登录的未读数，以及未验证型号的明文写入）· adapter.ts（其他品牌：把驱动的 DriverSession 套成 RouterSession；快照换算、短信逐个收件人发送且每次只发一次、没有专门重拨指令的先断开再连上且结束时总会再连上）· connection.ts（按品牌挑选会话客户端与会话对象的唯一一处：调度器持有的当前连接、控制台的测试连接都由它构建；华为的客户端与它的登录记忆（登录方式、路由器是否给加密密钥签名）只在华为的连接里，重启后从 state.json 接上）· client.ts（其他品牌的登录协议：登录前检查、一次登录、finally 注销，跑在共用会话客户端上；登录拿到会话后被打断也会注销；注销之前补发会话欠下的请求，注销之后关闭这次会话的传输）· login.ts · types.ts（驱动会话的契约：DriverSession 与它可选的短信、数据、已连接设备、蜂窝设置，以及遥测、锁定状态与锁定目标；小区、载波这些读数的形状在 protocols/readings.ts）· cells.ts / bands.ts（小区与频段表，以及调制解调器自己的 LTE 频段编号）· snapshot.ts（转成与华为相同的快照）· readback.ts（写后回读）· sms.ts（各驱动共用的短信部件：UCS-2 十六进制正文、路由器时间、把长短信的分段拼成一条、短信写入的回读）· hosts.ts（已连接设备：各驱动读到的设备列表转成与华为相同的快照）· cellular.ts（各驱动共用的蜂窝设置部件：较长的应答字段、烽燧自己那份接入点配置档的名字、流量上限的回读、没有可回读内容的写入怎么记）· detect.ts（免登录识别品牌）· brands.ts（驱动注册表；其他品牌的协议在 brand-protocols.ts，第一次用到时才加载：连华为的守护进程和在线演示的华为世界都不加载）· zte/（中兴：goform.ts 是 goform 页面，以及同一套接口在 ZXIC 固件上的 `/reqproc/` 写法：另一套登录，写入带 `CSRFToken`；zwrt.ts 是 zWRT；cellular.ts 与 sms.ts 是两套接口共用的部件：网络制式的名字、搜网结果与注册进度、接入点配置档、卡槽编号、流量上限的写法、USSD 的应答，短信列表、条数、时间与指令状态）· dlink/（D-Link 的 DWR 系列 4G 路由器：driver.ts 是 `login.cgi` / `data.ria` / `webpost.cgi` 这套网页接口的登录与会话，密码按登录页的写法发（MD5，或登录页自己的 `encode_passwd`），发之前凭登录页定下用哪一种；parts.ts 是它的应答解析：频段编号、短信、已连接设备、接入点设置） · tplink/（TP-Link：crypto.ts 是会话加密（AES-128-CBC / GCM）与登录签名（路由器给的 RSA 公钥，不填充、OAEP 或 PKCS #1 v1.5；新固件的 ECIES P-224），frames.ts 是两种请求写法的拼法与解析：MR 系列的文本帧（`/cgi_gdpr`）和 EX / NX 系列的 JSON（`/cgi_gdpr?9`），driver.ts 是登录与会话：用哪种加密在发送密码之前凭路由器的密钥应答和页面脚本定下，登录页显示已锁定、或有人登录着的时候不登录；会话里的写入照管理页自己的表单发，固件的管理页没有的表单不发；parts.ts 是应答解析：信号与服务小区、已连接设备、短信；cellular.ts 是管理页蜂窝表单的读写形状：状态页的频段编号、频段选择（MR 系列的两个掩码、EX / NX 系列的频段名列表）、锁小区、网络制式的名字、搜网结果、流量上限与 SIM 锁；deco.ts 是 Deco 系列自己的那套 LuCI 表单接口：登录、蜂窝模组的信号、Mesh 上的设备、重启） · pinsu.ts · tozed.ts · fiberhome.ts · nradio.ts · openwrt.ts
│   ├── protocols/          # 协议部件：怎样和一种接口对话，不含只对某个品牌或型号成立的事实，供驱动组合；不引用 src/drivers/。transport.ts（只到路由器本机地址的 HTTP、响应上限、Cookie：路由器下发的，以及登录页自己写进浏览器的那几个；会话欠路由器的请求（断开之后的连上：会话被截断时由收尾补发，只发一次；会话已被截断时不再欠）、不超过会话时长的等待、会话结束后不再发出任何请求）· values.ts（取值清洗：路由器报的文字、数字、频段、PCI、信号读数，各自有界）· readings.ts（读数的形状，驱动与部件共用：小区、载波、邻区、流量计数、模组报告的锁定、网络制式的名字）· ussd.ts（USSD 的应答文字与等待次数）· hilink/（华为 HiLink：client.ts 是会话（EphemeralCpeSession：Cookie、令牌轮换、加密通道）与登录协议，HuaweiCpeClient 是共用会话客户端加上免登录读取与登录记忆；auth.ts 是登录方式选择（提交密码前定：password_type → SCRAM 挑战探测 → 旧式 SHA-256 / base64）与 SesTokInfo 令牌解析；crypto.ts 是非钳位大端 Curve25519、SCRAM-SHA256、AES-256-GCM 双向加解密与网页的转义；xml.ts 是防原型链污染与防 ReDoS 的线性安全 XML 编解码器（含 PreEscapedXmlText），鲲鹏无限的驱动也用它；parsers.ts 是应答的纯函数解析器：3CA 射频、邻区、双周期流量、已连接设备；generic-writes.ts 是按接口资料写的通用请求（附录 A.11、A.12）：LTE 锁频、重启、重拨、移动数据，以及蜂窝设置里有记录的几项（网络制式、手动选网、数据漫游、清零流量统计、USSD）与它们的读取，同一会话回读核对，绝不重试；H168-383 的蜂窝设置写入也走这里（只限真机核对过、登记进 VERIFIED_FEATURES 的几项）。`net-mode` 应答带 `networkOption` 的 5G 机型按它自己管理页的写法：制式只发两个字段（`00` 配 `networkOption`、`03` 配 `LTEBandOption`），锁频带上当前制式的那一个；手动选网在 `plmn_list_combine_enable` 为 1 时 `Rat` 发 `255`；选网和搜网等到 240 秒；access-control.ts 是 Wi-Fi MAC 过滤与上网时段的报文解析与拼法；sms.ts 是短信的报文：条数与单条短信的解析）· ubus.ts（OpenWrt 的 ubus JSON-RPC：调用、批量调用、拒绝怎样记成错误码；OpenWrt 与中兴 zWRT 共用，各自只给出路径和自己网页附带的参数）· at/：common.ts（各家模组都一样的 3GPP AT 指令：ERROR、逗号分隔、+CFUN、+CPIN 与剩余次数、+CGDCONT、运营商名、`+COPS` 的当前选择与搜网结果（接入技术的编号、搜到的运营商一行怎样读；中兴与华为的搜网结果也按它读），以及从 ATI 认出模组厂商）· quectel.ts（移远模组自己的指令：服务小区、载波、邻区、各天线读数、温度、流量计数、网络制式）· fibocom.ts（广和通模组自己的指令）· sms.ts（模组短信指令的应答：`AT+CPMS?` 的条数、`AT+CMGL=4` 列出的 PDU）；部件只管会话与解析，发哪些请求、怎样送到路由器由驱动决定
│   ├── alert-engine.ts     # 持续窗口 + 迟滞告警引擎（离线、WAN、信号、CA、重启、短信容量、流量阈值、电量低、SIM 卡锁住）
│   ├── self-heal.ts        # 可选 WAN 自愈（默认关闭）：锁定后 WAN 不恢复则自动解锁、WAN 掉线限次重拨（从不重启）；监视与重拨额度存于 state.json，重启后接着算；未验证的路由器上，任何入口发起的锁频或锁小区之后断网 3 分钟，写回锁前读到的频段设置或解除锁定（不受自愈开关影响，重启后同样接着算）；切 SIM 卡槽、改网络制式、手动选网、改 APN 之后断网 3 分钟，把这一项改回写入前读到的值（任何型号都一样，同样记在 state.json 里）
│   ├── features.ts         # 零依赖：能力登记表，一项功能一条记录：读或写、在「支持的设备」表的哪一列和列里的叫法、在哪个读取分区里读（或是 5 秒轮询顺带读的状态）、归到它名下的写操作、是不是蜂窝设置、AI 智能体测试是否覆盖；功能名单、写操作所属的功能、读取分区和表的列都从这里来，写闸门、表的生成器、设备报告、控制台「设置 → 设备」、实验开关与智能体测试只认这里的名字（守护进程、控制台与在线演示共用）
│   ├── operations/         # 零依赖：操作登记，烽燧对外的每个读写操作一条记录（名字、读或写、跑调度器的哪些写操作（所属功能由能力登记表查出，写闸门按它判断）、要路由器的哪个读取分区、令牌权限、第一层入参检查、REST 路径与方法、MCP 工具名 / 说明 / inputSchema（写工具必带 confirm）、「API 参考」的中英说明与示例请求体、Telegram 指令）；record.ts 是记录的形状；routes.ts 是每个 REST 路由的方法、路径和是不是写操作（控制台的客户端只引用它，构建时换成常量）；registry.ts 把各部分的记录合在一起（就是「API 参考」的顺序），给出每个 MCP 提供者的工具与顺序，以及由它生成的 REST 路由表、permissionForRoute、MCP 工具定义和各入口处理函数表的类型；reads.ts（读取与刷新）· router.ts（路由器控制）· cellular-settings.ts（蜂窝设置）· access.ts（访问控制）· sms.ts（短信与通讯录）· daemon.ts（与路由器的会话、存活检查、事件流、指标，以及只给智能体的测试工具）是各部分的记录；守护进程、脚本与在线演示共用
│   ├── firmware.ts         # 零依赖：已验证的型号 / 固件版本清单、真机报告登记的功能（VERIFIED_FEATURES：品牌、路由器报的型号、固件、功能、读或写、issue 编号，任何品牌都适用）与报告为不能用的功能（UNSUPPORTED_FEATURES）、全部功能都由报告确认过的型号（isReportVerifiedModel；状态读数不计在内，逐项只凭自己的报告）、验证状态（已验证 / 已验证型号的新固件 / 未验证型号）与固件核对提示词（未验证版本只告警，不阻止写操作；控制台与在线演示共用）
│   ├── device-profile.ts   # 零依赖：型号识别与能力探测（固定的只读 GET 清单，未验证型号另加实验性写入回读要读的 3 个；四种接口状态；实验性写入的能力依据，按品牌事实里的 `probe` 判断）、路由器错误码计数与只含结构的脱敏设备报告（逐项列出登记表里的每个功能：与 VERIFIED_FEATURES 同名、读到了没有（状态读数看最近一次轮询有没有带上）、写入记录里回读是否一致；守护进程、控制台与在线演示同一实现）
│   ├── device-access.ts    # 零依赖：写闸门（未验证的路由器上，烽燧实现了的写入默认开启、用户可以逐项关闭，没有实现的拒绝；其他品牌实现了哪些写入取自 router-family.ts；VERIFIED_FEATURES 登记过的功能在任何品牌上都是「已验证」；解除锁定只要求两种锁定中任一项开着；只相信本次运行看到的型号，否则写操作先在自己的会话里确认）、每项写入功能在这台路由器上的状态（写操作归哪项功能由 features.ts 定）、写入记录与回读结果的类型，以及未验证型号各读取项可用与否
│   ├── feedback.ts         # 零依赖：兼容性反馈入口（cky008/cpe-dash 新 issue 的地址，只带模板与标题，绝不带报告内容）
│   ├── device-catalog.ts   # 零依赖：我们记录过的每个型号（按品牌分节；每个型号记品牌、走哪套接口与自动识别选哪套、形态、别名）与型号之间的差别（写成清单里的事实，不写进生成器）；「支持的设备」页的表由它生成（列与每列包含的功能取自 features.ts，每个功能一个符号：✓ 已在真机上验证、? 按接口资料实现了等真机确认、△ 部分支持或有条件（条件由事实生成在表下）、— 没有这项功能或实测不能用；烽燧还没有做的留空；每个型号的实测报告链接），守护进程也用它算出「设置 → 设备」里这台路由器的那一行；指南里唯一的型号表
│   ├── experimental-switch.ts # 零依赖：关闭或恢复一项实验性写入（控制台、MCP 的 set_experimental_write 与在线演示共用：只有烽燧在这台路由器上实现了的写入有开关）
│   ├── agent-test.ts       # 零依赖：一键开始 AI 智能体测试的规则（要改的设置与可选的短信、测试覆盖哪些实验性写入（在 features.ts 里标出：智能体的工具能写的，SIM PIN 与访问控制除外）、哪些写入要先问用户、提示词里点名的 MCP 工具与各自对应的读取分区或功能（测试保证与操作登记一致）、智能体令牌缺的权限、结束时只恢复还保持测试样子的、提醒时间与「全部通过」；守护进程、控制台与在线演示同一实现）
│   ├── agent-test-service.ts # 守护进程：一键开始 / 结束测试、记下哪个令牌在调用 MCP、每分钟检查并发出 AGENT_TEST_STILL_ON 提醒（控制台看过或 Telegram「知道了」后停止）
│   ├── endpoint-discovery.ts   # 零依赖：智能体的只读接口探查（probe_router_endpoints）：路径校验、会话接口与会改动路由器的路径直接拒绝、烽燧已用的接口清单（测试与协议模块对齐）、只留结构的结果
│   ├── console-settings.ts # 控制台管理的加密设置：路由器连接（含用户信任的路由器证书指纹）、登录密码（scrypt）、令牌（SHA-256，可过期 / 撤销）、一次性设置 / 重置 / 绑定码、被关闭的实验性写入（按型号 + 功能）；首次启动从 .env 导入一次
│   ├── http-settings.ts    # /api/console/*：先测后存的路由器连接（HTTPS 路由器先看证书：没人担保又没被信任的、或和已信任的不是同一张，就带着证书摘要失败，不发任何请求）、改密码、令牌、Telegram 绑定码、开关（只接受控制台 Cookie 会话）
│   ├── audit-log.ts        # 加密审计日志与 AsyncLocalStorage 调用方上下文（网页 / 令牌 / MCP / Telegram / 自愈）
│   ├── metrics.ts          # GET /metrics：Prometheus 文本格式，只读缓存快照（含电量、充电、SIM 卡锁住、飞行模式、漫游、路由器的负载与运行时间、各类温度传感器）与守护进程自身的内存 / CPU / 事件循环延迟（RuntimeSampler），不含任何设备标识
│   ├── sms/                # 短信：编解码（text-mode.ts 是 GSM 7-bit 字母表与分段计数，pdu.ts 是 3GPP TS 23.040 的 PDU：7-bit 打包、UCS-2、长短信的 UDH、SMS-DELIVER / SMS-SUBMIT）、号码解析、发送前的检查（submission.ts：收件人、正文、分段上限，各品牌共用）、加密镜像（含「最近删除」：删除后保留、恢复为只存于烽燧的副本、到期清理）、通讯录、应用服务、REST 路由与 MCP 工具的处理函数（input.ts 是 REST 入参的检查，登记引用）；华为的短信报文与请求在 protocols/hilink/sms.ts 与 drivers/huawei/sms.ts
│   ├── notify/             # Telegram Bot API 客户端与双向机器人（指令菜单由操作登记的 telegram 字段生成；短信，以及 /netmode、/airplane、/ussd 三条蜂窝设置指令：每次写入都要点卡片上的确认，卡片带一次性令牌、两分钟失效；回复短信卡片即发送，是唯一的例外）、签名 Webhook、通知中心
│   ├── http-server.ts      # REST / SSE / Streamable HTTP MCP 的传输（Host 白名单、Cookie 会话、CSRF、限流、令牌权限）：认证之后交给 http-api.ts；http-auth.ts 会话与限流、http-static.ts 静态资源
│   ├── http-api.ts         # 登录之后的 REST 分派（不引用 node:http；HTTP 服务器与在线演示共用）：每个登记了的操作的处理函数（路由与第一层检查取自操作登记）、短信与控制台的路由、错误到状态码与信封的映射、SSE 的 hello 快照、存活检查的应答；http-cellular.ts 蜂窝设置的处理函数
│   ├── control-input.ts    # 入参的第一层检查（不分品牌的形状与取值，零依赖；control-error.ts 为其错误类）：操作登记引用，REST、MCP、Telegram 与在线演示共用；mcp-schema.ts 工具 inputSchema 运行时校验
│   ├── sse-bus.ts          # /api/events SSE 总线（只用到应答对象的几个方法；在线演示把帧交给页面里的 EventSource）
│   ├── mcp-server.ts       # 零依赖 JSON-RPC MCP Server（挂载于 /mcp）：每个工具的权限、是否改动、写闸门、要的读取分区和 inputSchema 取自操作登记；可插拔的工具提供者只给出处理函数、运行时的开关与资源（mcp-core-tools.ts 核心 17 项工具、mcp-access-tools.ts 访问控制工具、mcp-cellular-tools.ts 蜂窝设置工具、mcp-tool-provider.ts 提供者契约、mcp-headers.ts 2026-07-28 路由头）
│   ├── mcp-stdio-bridge.ts # 零状态 stdio→HTTP /mcp 桥接（不连接 CPE）与它的进程收尾：cpe-dash mcp 与 Claude Desktop 扩展共用
│   ├── desktop-extension.ts # Claude Desktop 扩展的入口（打包进 .mcpb 的只有它和桥接）：只从 Desktop 传入的环境变量读 MCP_DAEMON_URL 与 API_TOKEN（不读 .env，不引用 node:fs），地址按 lan-address.ts 校验；没设好时对每个请求答一句去哪里设，什么都不转发
│   ├── lan-address.ts      # 零依赖：哪些主机算局域网 / 私网 / Tailscale（RFC 1918、RFC 6598、回环、链路本地、ULA，以及 .local / .lan / .internal / .ts.net 与单标签主机名），守护进程 /mcp 的地址怎样定（resolveDaemonMcpUrl：https 任何主机，明文 http 只限上面这些主机）；config.ts 与 Claude Desktop 扩展共用
│   ├── services.ts         # 服务的装配与接线（守护进程与在线演示共用）：控制台设置、审计、核心、短信、告警、自愈、一键测试、Telegram、通知中心、SSE 总线、API 分派，以及它们之间的接线（写入与短信的审计、国家代码、行为设置、自愈看护）和开机、后台工作、有序停止
│   ├── cli.ts              # serve 守护进程的进程外壳（数据目录锁、跨主机保护、MCP、HTTP 监听、进程读数、启动提示与有序启停，以及连路由器用的请求函数：pinned-fetch.ts 按指纹信任证书的那个；服务由 services.ts 装配）与 mcp 桥接入口
│   ├── maintenance.ts      # cpe-dash doctor / backup / restore / rekey：离线自检、加密备份与恢复、换密钥与找回被隔离的数据（不连接 CPE）
│   ├── peer-guard.ts       # 跨主机重复守护进程保护：scrypt 派生密钥签名的 UDP 广播信标，较晚启动者待机
│   ├── json-safe.ts · http-body.ts · text-sanitize.ts · constant-time.ts · i18n.ts · version.ts  # 无原型 JSON 解析、有界读取响应体、控制字符清理、常量时间的字符串比对、后端中英词典（locales/*.json）、版本号
│   ├── api-contract.ts     # REST / SSE 载荷类型（服务端以 satisfies 校验，Web 前端直接复用）
│   ├── rf-bounds.ts · privacy-mask.ts · units.ts · console-policy.ts · behaviour-settings.ts · self-heal-status.ts · router-trust.ts · sms/{text-mode,otp,vcard,thread-view}.ts  # 零依赖共享模块：锁定边界、脱敏规则、流量单位、控制台密码与令牌规则、控制台可改的行为设置（AI 总开关、自愈、告警、短信行为；不设则跟随 .env）、短信分段 / 验证码 / vCard / 会话列表（守护进程、控制台与在线演示同一实现）
│   └── index.ts            # 公共模块导出入口
├── web/                    # 「烽燧」Web 控制台：100% 严格 TS（tsconfig.web.json）+ Tailwind v4 / daisyUI v5，离线构建到 dist/web/public
│   ├── index.html · styles.css · brand/logo.svg（标志唯一来源：构建生成页面图标与 favicon.svg）
│   ├── site/main.ts        # 文档站唯一的脚本（主题、复制、搜索、目录高亮），无导入、无外部请求
│   └── src/                # core/（无 DOM、node:test 覆盖率门禁；endpoints.ts 是 REST 客户端：登记了的操作的路径与方法取自 src/operations/routes.ts，写操作自动带 `confirm: true`，控制台自己的路由写在这里；router-brand.ts 为品牌字段与连接表单的规则，lock-form.ts 为各品牌的锁频 / 锁小区表单规则；agent-test-view.ts 为一键测试的提示词：按这台路由器的品牌、型号、固件和它实际开着的读写项拼出，只点名它有的工具，文字在 i18n/settings.ts；cellular-view.ts 为控制抽屉「蜂窝设置」小节的规则（显示哪几项、PIN 能不能发、填写内容的检查），小节本身在 ui/cellular.ts、文字在 i18n/cellular.ts，按需加载；core/help.ts 为术语帮助：每个专业名词的一句话解释与文档站锚点，ui/help.ts 画「?」，「设置 → 外观」可关）· ui/（视图）· i18n/（类型化中英词典）· demo/（在线演示，纳入覆盖率门禁：页面里跑守护进程的服务（src/services.ts）与登录之后的分派（src/http-api.ts）：runtime.ts 装配并开机（布置家里的数据，等第一轮读取落地），transport.ts 把控制台的 fetch 与 EventSource 接上去，另有演示自己的登录（任何密码都能进）；worlds.ts 是演示世界：四台路由器（H168-383、未验证的 B535-232、中兴 MU5001、没有锁频与锁小区的 D-Link DWR-961）布置在测试用的模拟路由器上，npm run demo、截图、浏览器测试与在线演示共用，radio.ts 是锁定下服务小区怎样变，world.ts 是家里的节奏；node/ 是只进演示包的 Node 内置模块替身：crypto 的同步子集、Buffer、events、只在同步范围内的 AsyncLocalStorage、net、内存里的文件系统、path、url、process、不丢 Set-Cookie 的 Response）· boot.ts · main.ts
├── scripts/
│   ├── audit-secrets.ts    # 工作区 + 全量 Git 历史零密钥/零敏感硬件指纹/纯 TS 门禁扫描器（覆盖 src/ scripts/ test/ web/；私钥只放行路由器厂商写在网页里、每台都一样的那把，按指纹列在 PUBLIC_VENDOR_KEYS）
│   ├── build-mcpb.ts · zip.ts · json-schema.ts  # npm run build:mcpb：把 src/desktop-extension.ts 用 esbuild 打成一个 JS 文件（不带源码映射；测试保证里面没有守护进程的模块），按 package.json 写 manifest（版本、最低 Node 版本与 engines 一致），用 mcpb/ 里的官方 schema 校验（json-schema.ts：零依赖，只认这两份 schema 用到的关键字，遇到别的关键字就报错），再零依赖地打成 dist/fengsui-<版本>.mcpb（zip.ts：只用 store，测试也用它读回）；同时写 dist/server.json（官方 MCP Registry 的登记：名字、版本、Release 上这个文件的下载地址与 SHA-256、扩展读的两个环境变量），用 mcpb/ 里的 Registry schema 和官方 Registry 另加的规则校验
│   ├── build-web.ts        # esbuild 代码分割 + Tailwind CLI，内容哈希资源与 gzip 体积预算（--demo 构建 GitHub Pages 在线演示：node:* 换成 web/src/demo/node/ 的替身，演示的代码只进演示包）
│   ├── demo-router.ts      # 演示路由器上的真实守护进程（demo-server、截图与浏览器测试共用；四个世界在 web/src/demo/worlds.ts）；另有只给测试用的世界：每个品牌和接口写法各一台（test/helpers/ 里驱动测试的模拟路由器，`BRAND_SCENARIOS` 列出全部），可以按测试覆盖配置（`env`）
│   ├── demo-server.ts      # npm run demo：真实守护进程栈 + 进程内严格 Mock 路由器（不读 .env、不联网）；DEMO_MCP_WRITES=true 时智能体会改动路由器的工具也列出来、可以调用（仍只写到模拟路由器，Glama 的检查就这样跑）
│   ├── screenshots.ts      # npm run screenshots：本机无头 Chrome（DevTools 协议，零依赖）从演示环境重拍 docs/screenshots/，发版前运行
│   ├── cdp.ts              # 零依赖 DevTools 驱动（Node 自带 WebSocket）：启动无头 Chrome、打开页面、求值、等待、点击、截图，连接与每次调用各有期限、超时报出卡在哪一步；screenshots 与浏览器测试共用
│   ├── brand.ts · trace-logo.ts · brand-icon.ts  # 标志：检查 web/brand/logo.svg 并生成页面 <symbol>（构建时）；npm run brand:trace 把 PNG 概念图描成源文件；npm run brand:icon 零依赖地把源文件画成 Claude Desktop 扩展的 512×512 PNG 图标（浅色、深色各一张，透明底，写进 mcpb/；测试逐像素核对它们和源文件一致）（见 docs/dev/brand.md）
│   ├── build-docs.ts · markdown.ts · site-home.ts  # npm run build:docs：零依赖 Markdown 渲染 + 文档站（主页、用户指南、⌘K 搜索、SEO：搜索结果里的标题带上人们搜的词（页面 front matter 可另写 `seoTitle`，测试限制标题长度），首页的结构化数据给出站名与别名（FengSui、烽燧、cpe-dash），页脚不进摘要；域名只来自 DOCS_SITE_URL；docs/diagrams/ 的图内联进页面，跟着站点的主题切换，只放行图形与文字），输出 dist/site
│   ├── api-reference.ts · sync-docs.ts  # 指南「API 参考」由代码生成的部分（路由、方法、令牌需要的权限、中英说明与示例请求体取自操作登记；SSE 事件与错误码的中英说明写在这里）；npm run docs:sync 重写指南里所有生成的块（「支持的设备」的表与「API 参考」的三张表），--check 只检查；test/api-reference.test.ts 保证清单与代码一致、每个路由按所写的方法和示例请求体真能调用、页面与生成结果一致
│   ├── test-count-reporter.ts # node --test 报告器（门禁里的 test:coverage 与 test:browser 使用）：拿每条测试自己发的 test:complete 核对报告，失败被运行器漏报即失败，通过被漏报只列出；各目录跑过的测试数不得低于下限（TEST_FLOORS，加了测试就调高）
│   ├── release-notes.ts    # 从 CHANGELOG.md 对应版本段落生成 GitHub Release 说明：欢迎语、升级须知、`### Highlights` 亮点、按类分组只列每项首句（release.yml 的 notes 任务调用，标题只用版本号）
│   └── probe-*.ts          # 只读真机探针集（统一读取 .env 并默认脱敏；probe-sms 只输出聚合计数）
├── test/                   # 基于 node:test + node:assert/strict 的高覆盖率仿真测试集（helpers/ 内含加密 Mock 路由器，每个品牌一份；brand-walk 在每个品牌和接口写法的模拟路由器上把全部 REST 路由与 MCP 工具走一遍：没有的能力回错误码和一句话，从不 500，写入没有 confirm 在任何会话之前被拒，被关掉的写入与没实现的分得开；ci-config 守护 Action 的 SHA 固定，audit-gate 覆盖 audit:secrets 规则；desktop-extension 打出 .mcpb、核对 manifest 与包里的文件，再以 Desktop 的方式（只给环境变量）在演示守护进程前经 stdio 跑一遍；ui/ 为浏览器测试：无头 Chrome 对着真实守护进程与演示路由器（含其他品牌的模拟路由器：每个品牌走一遍首页、短信、控制抽屉与「设置 → 设备」，浅色深色轮换，再看手机宽度），以及构建好的在线演示（Node 内置模块的替身只在浏览器里用得上），在 npm run check 里由 test:browser 运行，单独跑用 npm run test:ui；它的 before / after 钩子一律经 test/ui/hooks.ts，带超时，卡住的 Chrome 让门禁失败而不是挂住）
├── mcpb/                   # Claude Desktop 扩展的固定文件：icon.png / icon-dark.png（npm run brand:icon 生成后提交）、官方 manifest schema（mcpb-manifest-v0.3.schema.json，原样取自 modelcontextprotocol/mcpb，它的许可证随附为 LICENSE-mcpb-schema）、官方 MCP Registry 的 server.json schema（server-2025-12-11.schema.json，原样取自 modelcontextprotocol/registry，它的许可证随附为 LICENSE-registry-schema）；出处见 docs/dev/sources.md 第 24 节；manifest 与 server.json 由 scripts/build-mcpb.ts 生成，不入库
├── Dockerfile · docker-compose.yml · .dockerignore   # 非 root、只读根文件系统、HEALTHCHECK 的生产镜像与群晖编排
├── LICENSE · THIRD_PARTY_NOTICES.md                # PolyForm Noncommercial 1.0.0；构建产物所含 Tailwind CSS / daisyUI / Lucide 的许可声明（构建放到控制台旁，镜像放在 /app）
├── .github/workflows/      # ci-docker.yml（门禁（Node 22.x、24.x、26.x）+ amd64 镜像冒烟）· release.yml（打 tag 推送 GHCR 多架构镜像；构建 Claude Desktop 扩展 .mcpb，带构建来源证明附到 GitHub Release，再凭 GitHub OIDC 登记到官方 MCP Registry（mcp-publisher 固定版本并核对 SHA-256；这个版本已登记过就跳过））· demo-pages.yml（打 tag 发布在线演示到公开仓库 fengsui-demo）· docs-pages.yml（文档站发布到本仓库 Pages，仓库变量 DOCS_PAGES_ENABLED 打开后才运行）
├── .github/ISSUE_TEMPLATE/ # device-report.yml：其他型号的兼容性报告表单（型号、固件、能用 / 不能用、报告、隐私确认）；bug-report.yml、feature-request.yml；config.yml 把安全问题引到私密报告
├── .github/pull_request_template.md · SECURITY.md · CONTRIBUTING.md · CODE_OF_CONDUCT.md  # PR 隐私自检、漏洞私密报告与范围、贡献规则（TDD、占位值、零运行时依赖）、行为准则（Contributor Covenant 2.1）
└── docs/
    ├── guide/{zh,en}/*.md            # 用户指南（支持的设备、快速开始、安装、功能、Docker Compose 配置、配置参考、API 参考、安全、备份、其他型号、架构与协议、排障、FAQ、致谢）：文档站的来源，中英文逐页对应；配置参考与智能体页由 contract-manifest 测试保证覆盖每个设置与工具；「支持的设备」的表与「API 参考」的接口、事件、错误码表由 npm run docs:sync 从代码生成，其余手写
    ├── dev/                          # 开发者文档（只有中文，只在 GitHub 上看，不进文档站；README.md 是目录）
    │   ├── protocol.md               # 华为 HiLink 协议：H168-383 的完整私有协议（含短信接口）与频段掩码、锁小区载荷算法；附录 A 为其他华为型号
    │   ├── architecture.md           # 架构与设计：选型、调度器、时序引擎、短信融合、控制台、访问控制、在线演示、主题、多品牌与统一后端（第 1–5、7–10、17 节），现在的分层（第 19 节）
    │   ├── audits.md                 # 审计记录：Phase 2.5 两轮与之后的每一轮全面审计（第 6、11–16 节）
    │   ├── sources.md                # 实现依据：每个品牌每项能力用的接口与出处、参考项目的提交与许可证、查过没找到的（第 18 节起，一个里程碑一节）；三份共用一套节号
    │   ├── api.md                    # REST / SSE / MCP 接口契约（含短信、告警；contract-manifest 测试保证覆盖每个路由、SSE 事件与 MCP 工具）
    │   ├── device-notes.md           # 各品牌型号的接口资料汇总（不是实测结果；实际实现以「支持的设备」页为准）
    │   └── brand.md                  # 标志：唯一来源、颜色如何跟随主题、怎么换标志
    ├── diagrams/{zh,en}/*.svg        # 指南里的图（「架构与协议」页的分层与一次会话）：两种语言同名同构，颜色用 site.css 的类，构建时内联
    └── site/site.css                 # 文档站样式（Tailwind v4，浅色 / 深色，含图的配色）
```

---

## 2. 七大工程与安全铁律（Mandatory Invariants）

### 铁律一：100% 严格 TypeScript，绝对禁绝纯 `.js` 源码
- 仓库内所有源码、探针脚本（`scripts/*.ts`）、测试套件（`test/*.test.ts`）与前后端模块**必须 100% 采用严格 TypeScript**，严禁编写、提交或混用任何手写 `.js` / `.mjs` / `.cjs` 源文件（由 [`scripts/audit-secrets.ts`](scripts/audit-secrets.ts) 自动拦截）。
- `tsconfig.json` 强制开启 `"strict": true`、`"noImplicitAny": true`、`"noUncheckedIndexedAccess": true`、`"noUnusedLocals": true`、`"noUnusedParameters": true`、`"erasableSyntaxOnly": true`、`"verbatimModuleSyntax": true` 与 `"rewriteRelativeImportExtensions": true`。
- 严禁使用显式或隐式 `any`；对所有网络 I/O、XML 解析与 `catch (err: unknown)` 必须执行显式类型收窄。

### 铁律二：零密钥与零硬件隐私泄露 (Zero-Secret & Zero-PII Git Hygiene)
- **严禁泄露清单**：在源码、测试夹具、探针终端输出、文档样本及 Git Commit 记录中，**绝对禁止出现**真实管理密码、API Token、真实公网 IPv4/IPv6、真实 Tailscale 节点 IP、个人公网域名（例外只有两个：作者主页链接 `https://iocky.com/`（控制台与文档站的页脚、文档站的常见问题），以及项目文档站 `https://fengsui.iocky.com/`（README、发布说明、docker-compose.yml、控制台术语帮助、Claude Desktop 扩展 manifest 与 MCP Registry 登记（server.json）的文档链接）；NAS 反代主机名等其他任何子域名仍然禁止）、**IMEI**、**IMSI**、**ICCID**、**手机号 (MSISDN)**、**设备序列号 (SN)**、**真实终端 MAC 地址**、**Wi-Fi 真实 SSID/密码** 以及 **真实基站位置指纹（TAC 跟踪区代码、CellID、gNodeB/eNodeB ID，以及服务小区与邻区的 PCI + 频点组合：同一运营商的频点加上几个 PCI 就能在公开基站数据库里定位到具体站点）**。
- **RFC 占位测试夹具规范**：
  - CPE 局域网网关：`192.168.8.1`；模拟公网 IPv4：RFC 5737 测试网段（`198.51.100.42` / `203.0.113.10`）；模拟公网 IPv6：RFC 3849（`2001:db8::42`）；
  - 模拟域名：`cpe.example.com`；模拟 MAC：`02:00:5E:10:00:01` / `00:00:5E:00:53:01`（RFC 7042 文档保留地址）；
  - 模拟蜂窝身份：`IMEI=860000000000000`、`IMSI=272010000000000`、`ICCID=8935301000000000000`、`MSISDN=+353830000000`、`TAC=10001`、`CellID=134217758`。
  - 模拟小区（演示世界、测试夹具与协议样本统一使用）：LTE PCC `B1 / EARFCN 300`、SCC `B3 / EARFCN 1850`、NR `N78 / NR-ARFCN 650000`，PCI `211` / `142`；绝不从真机抓包或探针输出复制 PCI 与频点。
- **物理隔离**：本地 `.env`、`data/*`、`.probe-cache/`、`*.har`、`*.pcap*`、`*.apk*`、`*.dll` 必须写入 [`.gitignore`](.gitignore) 严格隔离；每次提交前必须通过 `npm run audit:secrets` 对工作区与完整 `git log -p --all` 历史进行双向扫描。
- **短信与通知隐私铁律**：
  - 严禁在源码、测试夹具、文档、Issue、探针输出与 Commit 中出现**真实手机号、短信正文、验证码 (OTP)、联系人姓名/备注、Telegram Bot Token、真实 Telegram 聊天 ID、Webhook 地址与签名密钥**；`audit-secrets` 会把 `.env` 中的 `TELEGRAM_BOT_TOKEN`、`TELEGRAM_CHAT_IDS`、`WEBHOOK_URL`、`WEBHOOK_SECRET` 视为字面量密钥扫描。
  - 测试号码与文档示例只用保留号段：爱尔兰 `+3538300000xx`、英国 Ofcom 影视号段 `+447700900xxx`、中国 `+8613000000000`；需要成千上万个不同号码的测试用 ITU 空号国家码 `+999`（全世界没有用户）（`audit:secrets` 拦截工作区里其他完整国际号码，只报文件与行号）；字母发件人用 `DemoBank`、`Three` 等虚构名；Telegram 夹具用短 ID（如 `1001`）。
  - 日志、控制摘要（`control:applied`）与审计输出中的号码一律经 `maskPhoneNumber()` 脱敏，**严禁记录短信正文与验证码**；`probe-sms` 只输出计数、列表通道与会话耗时。
  - 短信镜像、通讯录与 Telegram 状态必须经 `StorageCipher` 加密落盘（`0600`）；消息标识统一使用不含号码的不透明 `uid`（索引 + 时间 + 号码的 SHA-256 截断），不得以号码或会被复用的 CPE 索引充当消息 ID。
  - 测试与探针**严禁向任何真实号码发送短信**；发送、标记已读、删除仅在注入式 Mock 路由器上验证。
  - **SIM PIN、APN 的用户名与密码、USSD 的指令与应答**同样对待：不进日志、控制摘要、审计记录、设备报告和 `control:applied`；写入记录只留指令名。测试夹具的 PIN 只用 `0000` / `1234`，APN 只用 `internet`、`example.apn` 这类虚构名，USSD 只用 `*100#` 与虚构的应答。USSD 只在注入式 Mock 路由器上验证，测试与探针不向真实网络发送。

### 铁律三：纯原生 `.env` 配置规范
- 所有启动参数与环境调优参数必须统一通过 [`src/config.ts`](src/config.ts) 从项目根目录 `.env`（及环境变量覆盖）加载，严禁在任何业务逻辑或探针脚本中硬编码密码、IP 或路径，且不引入第三方 `dotenv` 包。
- v1.5.0 起，路由器连接、控制台登录密码与 API 令牌由控制台管理，加密保存在 `settings.json`（[`src/console-settings.ts`](src/console-settings.ts)）：`.env` 中的 `CPE_*` / `API_TOKEN*` 只在首次启动时导入一次。密码只存 scrypt 哈希、令牌只存 SHA-256；任何令牌都不能修改控制台设置。探针脚本仍从 `.env` 读取路由器凭据。

### 铁律四：单管理员会话排他保护与真人在线避让
- H168-383 固件严格限制**同一时刻仅允许 1 个管理员会话在线**。若后台守护进程持久霸占会话，用户在浏览器打开 `http://192.168.8.1` 登录时将被迫报错或发生会话抢占。
- **其他品牌同样适用**：驱动品牌的会话走 `DriverCpeClient.withSession()`，与 HiLink 客户端共用同一个调度器队列，登录前先做各品牌自己的免登录检查（有人在线即让位、已锁定即不登录），`finally` 无条件注销，密码被拒即熔断、绝不重试。一个品牌的登录有几种写法时（D-Link 的 MD5 与登录页自己的编码，TP-Link 的几种加密与签名），驱动在发送密码之前凭路由器免登录给出的东西（登录页、密钥应答、页面脚本）定下用哪一种；定不下来就不发送密码（`LoginMethodError`），绝不逐种试。识别品牌（`detectRouterFamily`）只发免登录请求，不带密码、不建会话。
- **强制瞬时短连 (`withSession`)**：任何需要鉴权的读写操作必须包裹在串行互斥的 `HuaweiCpeClient.withSession()` 中，并在 `finally` 块内无条件调用 `POST /api/user/logout`（真机实测单次会话占用窗口仅 `~26ms–260ms`）。
- **短信同样受本铁律约束**：短信同步、发送、标记已读与删除只能经 `SmsService` 调用 `RouterBackend` 的短信动词进入 `MutexSessionScheduler`（所有品牌都走调度器的同一条读路径与写路径、同一个队列、同一个闸门），短信计数捎带在 5s 遥测会话内，严禁另起轮询或独立登录；所有品牌的短信写入都只发一次，发送被路由器接受之后的任何失败都记为「未确认」而不是失败，绝不重发。只有 `serve` 守护进程连接 CPE：它独占数据目录（`state.json.lock`），第二个守护进程启动即失败；`cpe-dash mcp` 与 Claude Desktop 扩展都是转发到守护进程 `/mcp` 的零状态 stdio 桥接，严禁在其他进程中实例化 `HuaweiCpeClient` 或调度器。
- **暂停连接**：主人要用路由器自己的管理页时，可以在「设置 → 路由器」暂停连接（`POST /api/session/pause`，1–120 分钟）。暂停期间调度器不开任何会话、不向路由器发任何请求：读取跳过，写入在任何会话之前以 `409 ROUTER_PAUSED` 拒绝，免登录的探测、连接测试和品牌识别也不做；到时间自动恢复，守护进程重启后接着暂停到原来的时间，没有无限期的暂停。还有断网回退的看守开着时不能暂停，一项写入正在它的会话里时也不能（第 4 节第 2 条的回退必须写得出去；看守是写入生效后才开的）。
- **双层真人在线主动避让（`state-login` 预检 + 跨 IP `108003` 让位）**：每次发起登录前先请求 `GET /api/user/state-login`；当 `respectBrowserSession: true`（后台轮询与探针默认开启）时，若 `<State>` 不为 `"-1"`（第 1 层）或跨局域网终端已有浏览器在线返回 `108003`/`108009`（第 2 层），客户端必须**立即静默挂起让位（返回 `null`）**，严禁强行抢占或循环重试干扰真人会话。

### 铁律五：`108006` / `108007` 防爆破熔断断路器 (Circuit Breaker)
- H168-383 连续输错 3 次管理密码即触发硬件级账户锁定（`<error><code>108007</code></error>` 或 `<lockstatus>1</lockstatus>`）。
- 当登录握手返回错误码 `108006`（密码错误）、`108002`、`108001` 或检测到 `108007` / `lockstatus === "1"` 时，客户端内置断路器（`CircuitBreaker`）必须**立即熔断锁死**，绝对禁止自动重试，并在后续调用中直接短路抛出熔断异常，直至人工修正 `.env` 并显式重置后方可恢复。

### 铁律六：现代 Web 高危漏洞纵深防御
1. **CSRF 防御**：所有会话 Cookie 强制设置 `HttpOnly; SameSite=Strict`（在受信任 HTTPS 反代下追加 `Secure`）；所有状态变更请求（`POST`/`PUT`/`DELETE`）强制校验自定义请求头（`X-Requested-With: XMLHttpRequest`）与常量时间比对（`crypto.timingSafeEqual`）的鉴权令牌。
2. **防伪造反代头绕过限流**：速率限制器与审计日志默认提取底层 Socket 直连地址 `req.socket.remoteAddress`；仅当直连对端精确命中 `.env` 中 `TRUSTED_PROXIES` 白名单时，才允许解析 `X-Forwarded-For` / `X-Forwarded-Proto`。
3. **防原型链污染 (Prototype Pollution)**：解析外部 JSON、URL Query 或 XML 键值映射时统一使用无原型字典（`Object.create(null)`）或 `Map`，并显式拦截过滤 `__proto__`、`constructor`、`prototype` 危险键名。
4. **防正则回溯拒绝服务 (ReDoS)**：对 HTTP 请求体、XML 报文及正则输入施加上限截断（如单报文上限校验），采用确定性边界扫描提取标签，严禁在未受信输入上运行含嵌套量词的回溯正则。
5. **MCP 提示词注入防御**：短信正文与发件人名称来自第三方，USSD 的应答和搜到的运营商名称来自运营商，MCP 工具结果必须附带不可信数据声明；所有 MCP 写工具（锁频锁站、开关、重拨重启、访问控制、蜂窝设置、短信发送 / 已读 / 删除、通讯录）都强制 `confirm: true`（写工具的 inputSchema 由操作登记生成，必带必填的 `confirm`），服务端在 Schema 校验与任何会话之前检查；REST 的写操作同样要 `confirm: true`（操作登记统一检查）；`send_sms` 单收件人、默认仅限已知号码 (`MCP_SMS_SEND_POLICY=known`) 且按小时限额，`delete_sms` 默认拒绝删除未读短信。Telegram `/auth` 采用常量时间比对并按聊天与全局双重限流；Telegram 里每个会改动路由器的指令（短信发送与删除、`/netmode`、`/airplane`、`/ussd`）都要点卡片上的确认按钮，确认按钮绑定一次性令牌与聊天、两分钟失效，写闸门拒绝的写入不给出卡片；唯一的例外是回复机器人在这个聊天里发出的短信卡片：回复即发给那张卡片上的号码，不再给确认卡片（收件人由卡片定、不是输入的，正文是本人写的，回复这个动作就是确认），照样经写闸门与发送前的检查、只发一次；USSD 的指令与应答只出现在聊天里，不进机器人的日志。
6. **防服务端请求伪造 (SSRF)**：[`normalizeCpeUrl()`](src/config.ts) 严格校验协议仅限 `http:` / `https:`、禁止内嵌 `username:password@`、禁止查询串与片段注入，并强制校验目标主机属于合法局域网/私网地址空间（RFC 1918 / RFC 6598 / Loopback / 本地单节点），请求全程启用 `redirect: "error"` 阻断跨源重定向逃逸。
7. **路由器自签名 HTTPS 证书只按指纹信任**：连接路由器默认按系统的证书机构校验。管理页只能用 HTTPS、证书由路由器自己签发时，用户在「设置 → 路由器」核对指纹后可以信任这一张：烽燧把证书的 SHA-256 指纹随连接加密保存，之后对这个来源（协议 + 主机 + 端口）的每个请求都先完成 TLS 握手、常量时间比对证书指纹，一致才发送任何内容；不一致立即失败，不发送密码，也绝不自动改信任。看证书只做握手、不发请求。严禁用 `NODE_TLS_REJECT_UNAUTHORIZED=0` 或任何全局开关关闭证书校验，严禁对没有信任指纹的来源放宽校验；测试用的证书在测试里现场生成（[`test/helpers/self-signed.ts`](test/helpers/self-signed.ts)），仓库里不放私钥。

### 铁律七：强制 TDD（红-绿-重构）与 >= 90% 覆盖率质量门禁
1. **Red（先写失败测试）**：新功能、协议算法（如 `BandMask` 位运算、锁小区载荷）或异常边界修复前，先在 `test/*.test.ts` 编写基于 `node:test` 与注入式 `fetchImpl` 替身的自动化仿真测试（**单元测试严禁访问真实 `192.168.8.1` 硬件**）。
2. **Green（最小干净实现）**：编写严格类型的 TypeScript 实现使测试通过。
3. **Refactor & Gate（全量门禁校验）**：每次 Git Commit 前必须跑通 `npm run check` 且退出码为 `0`：
   - `npm run typecheck`：全仓 `src/` + `scripts/` + `test/` 零类型错误；
   - `npm run build:web`：构建 Web 控制台，首屏与按需加载合计超过 192 KiB gzip 即失败（与 CI、发版和 Docker 构建同一上限）；
   - `npm run test:coverage`：`c8` 语句覆盖率 `>= 90%`、行覆盖率 `>= 90%`、函数覆盖率 `>= 90%`；失败的测试一条都没有被运行器漏报，测试总数不低于 `scripts/test-count-reporter.ts` 的下限；
   - `npm run test:browser`：浏览器测试（`test/ui/`，无头 Chrome，对着刚构建的控制台、真实守护进程与模拟路由器，以及先构建出来的在线演示；演示包超过它的体积上限即失败），同样核对测试数下限；本机没有 Chrome 时设 `CHROME_PATH`，不得跳过；
   - `npm run audit:secrets`：工作区与全量 Git 历史零密钥、零敏感指纹、零 `.js` 混入。
4. **CI 在三个 Node 版本上各跑一遍门禁**：`22.x`（`engines` 的下限）、`24.x`（Claude Desktop 自带的 Node，扩展在它上面运行）、`26.x`（镜像用的 LTS）；同一个任务里还打一次 Claude Desktop 扩展（`npm run build:mcpb`）。

---

## 3. Git 提交规范 (Conventional Commits)

- 每完成一个独立里程碑、规范定义或探针实测验证，必须立即执行原子化提交：
  `<type>(<scope>): <concise imperative summary>`（`type` 限 `feat` | `fix` | `refactor` | `security` | `test` | `docs` | `chore` | `ci` | `release`；`ci` 用于 Docker / 工作流，`release` 仅用于版本发布提交）。
- 提交前必须确认 `npm run check` 全绿，且暂存区不包含任何未脱敏抓包或临时产物。
- 一个里程碑推送之后，CI 与 CodeQL 全绿，代码扫描、Dependabot、密钥扫描三类告警清零，才算完成。发版（版本号、标签、镜像）是单独的决定，不随里程碑自动发生。

---

## 4. 路由器能力规则（所有品牌）

给任何品牌增加或搬动一项读取或写入，都照这九条做。

1. **记录了就实现，实现了就可用。** 一个接口只要有记录（接口资料、厂商手册或开源实现），就实现它，实现后默认可用：不等真机实测，不因为「没验证过」留着不做，也不另加开关挡住。记录不完整时（常见的是只有接口名或指令名，缺应答格式），先查公开资料把细节补齐再实现；查遍公开资料也没有任何记录的才不做。不凭空编接口。每项实现的依据（哪个接口、出自哪里）写进 [`docs/dev/sources.md`](docs/dev/sources.md)。
2. **实现了的写入默认开启，用户可以逐项关闭；保护不变。** 每次写入只发一次，写后在同一会话回读，回读不一致告警；会意外断网的写入有断网 3 分钟的自动回退（未验证的路由器上，任何入口发起的锁频写回锁前的频段，锁小区解除锁定；切 SIM 卡槽、改网络制式、手动选网、改 APN 改回写入前在同一会话里读到的值，读不到原值的不回退并在告警里说明；都独立于 `LOCK_ROLLBACK_AFTER_MIN`，守护进程重启后接着算）；用户有意断网的写入（关闭移动数据、打开飞行模式）不自动回退，确认框里写明要回到烽燧里关掉；控制台每个写操作有自己的确认框；REST 与 MCP 的写操作都要 `confirm: true`，MCP 另要 `MCP_ALLOW_MUTATIONS` 和令牌权限；自愈默认关闭；除了上面的回退，烽燧不会自己主动写任何东西。
3. **每类能力是 `RouterBackend` 上的一个动词**（或快照里的一组字段）：哪个品牌的资料里有，就在哪个品牌的后端里实现；华为有对应能力的归到同一个动词。没有这项能力的品牌，读返回「此型号不提供」，写由闸门拒绝。服务层不判断品牌，不做品牌特例（`test/router-backend.test.ts` 守着这条线）。路由器状态这类读数（电池、SIM 卡、飞行模式等，`src/router-status.ts`）捎带在 5 秒轮询的同一个会话里读，不另开登录；同一类读数在不同品牌上的单位和取值在后端里统一，路由器没报告的留空，不编零值；新读的请求读不到时只丢这些新读数，不影响原有的遥测。
4. **已验证的 H168-383 发给路由器的请求一个字节都不变。** 搬动华为代码时，用严格模拟路由器的测试和请求序列比对证明这一点。给 H168-383 增加读写只有一条路：主人在场时先做只读探测（只看结构），再逐项在真机上写入核对（写入、同会话回读、改回原样、改前改后逐项比对），通过的登记进 `VERIFIED_FEATURES`；新增的请求只在这些功能打开时才发，原有的请求序列仍逐字节不变，请求序列比对证明。唯一的例外是锁频：H168-383 的锁频写 `net-mode`，用户改过网络制式时带上当前制式（`00` 带当前的 `networkOption`、`03` 带 `LTEBandOption`，取自 5 秒轮询已经读到的应答，不多发请求），默认制式（`00` + `networkOption 2`）下逐字节不变。
5. **对外只说验证过的型号。** 目前只有 H168-383；用户看得到的文字里不写成功率。H168-383 的验证只覆盖验证时已有的读写：之后才加的蜂窝设置写入，H168-383 上只开放在真机上核对过、登记进 `VERIFIED_FEATURES` 的几项（2026-11-13 主人在场核对：数据漫游、网络制式、手动选网与搜网、清零流量统计；USSD 路由器自己报告关着，核对不了），其余仍不提供、表里留空，直到有人在真机上验证。别的型号（任何品牌）的功能、以及 H168-383 验证之后才加的状态读数（电池、SIM 卡、飞行模式），只有登记进 [`src/firmware.ts`](src/firmware.ts) 的 `VERIFIED_FEATURES`（来自真机报告的 issue，确认后登记；什么样的报告算数、登记要改哪里见 `CONTRIBUTING.md`）才标为已验证，表里标 `✓`。一个型号上烽燧实现的每项功能（状态读数除外：有的设备没有这样的硬件）都登记过（或报告为路由器没有这项功能）时，它就算验证过的型号（`isReportVerifiedModel`，验证状态 `report-verified`），不需要另外核对：登记它的提交同时把它写进所有说明「在哪些路由器上验证过」的地方（`test/verified-features.test.ts` 列出这些文件并检查）。它的写入仍按它的品牌发送，绝不走 H168-383 的请求。
6. **「支持的设备」表跟着代码走。** 表由 [`src/device-catalog.ts`](src/device-catalog.ts) 生成，测试保证页面与生成结果一致。一项新功能先登记进能力登记表 [`src/features.ts`](src/features.ts)（一项一条：读或写、表的哪一列和列里的叫法、在哪里读或归到它名下的写操作），写闸门、表、设备报告、控制台和智能体测试都从这里取，品牌的事实（`src/router-family.ts`）只引用登记过的名字（`test/features.test.ts` 守着）。增加或搬动一项能力后，在品牌的事实或型号清单里加事实，重新生成表；型号之间的差别（某个型号要先打开开发者选项、只能锁 5G 小区之类）写成清单里的事实，不写进生成器。烽燧还没有做的格子留空，`—` 只用于路由器没有这项功能（接口资料排除，或这类设备没有这样的硬件，比如室内 CPE 没有电池）或实测失败。重新生成用 `npm run docs:sync`；「API 参考」的表同理：接口表由操作登记生成（第 9 条），增加 SSE 事件或错误码时在 `scripts/api-reference.ts` 写一句中英说明，再运行它（`test/api-reference.test.ts` 守着），同时更新开发者文档的接口契约 `docs/dev/api.md`。
7. **这几类即使资料里有记录也不实现**：改设备身份（IMEI、序列号、蜂窝侧的 MAC）；解除运营商锁或 SIM 锁；打开 telnet、ADB、SSH 之类的远程 shell 或调试后门；刷固件、写 NV 或校准分区；关闭路由器自身的登录保护；恢复出厂设置（恢复后路由器的密码和设置都回到默认，烽燧会连不上）；输入 PUK、修改 PIN（见第 8 条）。
8. **会锁死 SIM 卡的写入。** 烽燧只做两件事：输入 PIN，开关「开机要 PIN」。每次只发一次，路由器说不对就停，绝不换一个再试，也不自动重发；只有路由器报告了剩余次数、并且还剩不止一次时才提供，确认框和 MCP 工具的结果里都写明剩余次数；剩余次数读不到、或只剩一次的，烽燧不发，请用户到路由器管理页处理。PUK 输错十次 SIM 卡就永久作废，烽燧不提供。PIN 不落盘、不进任何记录（铁律二）。
9. **每个读写操作只登记一次。** 烽燧对外的每个读写操作（一个 REST 路由、一个 MCP 工具、一条 Telegram 指令，或同一件事的几种问法）在操作登记 [`src/operations/`](src/operations/registry.ts) 里有且只有一条记录：名字、读或写、跑调度器的哪些写操作（所属功能由此从能力登记表查出，写闸门按它判断）、要路由器的哪个读取分区、令牌权限、入参的第一层检查（不分品牌的形状与取值，写在 `src/control-input.ts`、`src/cellular.ts`、`src/sms/input.ts`，REST、MCP、Telegram 与在线演示共用；智能体的工具参数写法不同的，记录里另写这一种）、REST 路径与方法、MCP 工具名、说明与 inputSchema（写工具的 inputSchema 一律带必填的 `confirm`，由登记加上）、「API 参考」的中英说明与示例请求体、对应的 Telegram 指令。REST 路由表、`permissionForRoute`、MCP 工具清单与每个工具要的权限和写闸门、「API 参考」的接口表、控制台 REST 客户端的路径与方法（`src/operations/routes.ts`：构建控制台时换成只含路由的常量，登记里的文字不进控制台）、Telegram 机器人的指令菜单都由它生成；写操作在 REST 与 MCP 上一律要 `confirm: true`，入口在入参检查之前按记录统一检查；各入口只写处理函数，类型检查保证每个登记了的操作在它出现的入口都有处理函数。第二层检查（路由器自己品牌的边界：频段、信道、一次能锁几个小区）由后端在入队前问品牌的 `RouterDriver`；入口要单独用时经 `RouterBackend` 问（如 `checkCellLock`），不在入口引用某个品牌的模块（`test/router-backend.test.ts` 守着）。Telegram 指令的文案仍由人写，入参检查和闸门用同一条记录。

**参考其他项目**（厂商手册之外的开源实现）：只取事实（接口路径、参数名、取值、应答格式），不复制、不改写它的代码和测试数据，不加任何运行时依赖。每个参考过的项目把地址、提交号或日期、许可证记进实现依据 `docs/dev/sources.md`；致谢一个项目一句，只写在指南的致谢页 `docs/guide/{zh,en}/acknowledgments.md`（按品牌分节）。两份 README 和「其他型号与品牌」页只留一句指向致谢页的链接，指南的其他页面都不点名别的项目。
