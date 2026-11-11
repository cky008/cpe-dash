# 烽燧实现依据

> **写什么**：每个品牌每项能力用的接口与出处（资料库的文件与行号、厂商手册、开源项目的地址、提交与许可证），以及查过却没有找到记录的地方；一个里程碑一节。[`AGENTS.md`](../../AGENTS.md) 第 4 节第 1 条要求每项实现把依据记在这里。  
> **从哪来**：2026-11-11 从 [`architecture.md`](architecture.md) 拆出，正文未改，只给指向其他文件的节号加了文件名。节号沿用拆分前的编号（第 18 节起），与 [`architecture.md`](architecture.md)、[`audits.md`](audits.md) 共用一套，所以代码注释里的「§18.4」仍然有效。  
> **另见**：架构（含第 17 节多品牌与统一后端、17.3 规范交叉审计）见 [`architecture.md`](architecture.md)；各轮审计见 [`audits.md`](audits.md)。

---

## 18. v1.9.0：各品牌的能力补齐（2026-11-10 起，按里程碑记录）

v1.9.0 分成几个里程碑，一个里程碑一节。每个里程碑推送之后 CI 与 CodeQL 全绿、三类告警清零才算完成；发版是单独的决定。这一版的规则写在 [`AGENTS.md`](../../AGENTS.md) 第 4 节（记录了就实现；实现了的写入默认开启、保护不变；每类能力是一个后端动词；H168-383 的请求不变；只说验证过的；即使有记录也不实现的几类），下面每一节只记当时的决定、依据和验证。

### 18.1 第 1 步：实现了的写入，在未验证的路由器上默认开启

**决定（主人，2026-11-10）**：烽燧已经实现的写入，在没有验证过的路由器上不再默认拒绝，而是默认开启、可以逐项关闭；没有实现的写入仍然拒绝。v1.6.0–v1.8.3 的做法是默认拒绝、逐项输入型号同意（architecture.md 17.2、17.5 第 1 条记的是当时的状态）。这一步没有新增任何路由器接口，也没有参考新的外部项目：通用写入的请求格式仍是协议附录 A.11，其他品牌的写入仍是 17 节审计过的驱动。

**闸门（[`src/device-access.ts`](../../src/device-access.ts)）**

| 以前的状态 | 现在的状态 | 闸门 |
| :--- | :--- | :--- |
| `consented`（用户同意了） | `enabled`（烽燧为这台路由器实现了，默认） | 放行，作为实验性写入 |
| `available`（可以同意，还没同意） | `disabled`（用户关闭了） | 拒绝，`409 DEVICE_WRITE_DISABLED` |
| `unsupported`、`not_implemented` | 不变 | 拒绝，`409 DEVICE_UNVERIFIED_READ_ONLY` |

- 「实现了」由每个品牌自己的清单决定：`ROUTER_FAMILY_FACTS[品牌].writes`（[`src/router-family.ts`](../../src/router-family.ts)）。此前所有驱动共用一份 `DRIVER_WRITE_FEATURES`，HiLink 另用 `EXPERIMENTAL_FEATURES`；现在闸门对两者用同一条规则，某个品牌以后多实现一项写入，只改它自己那一行。HiLink 型号仍然要求识别探测找到这项写入回读所读的接口（附录 A.11 的「能力判断」），找不到是 `unsupported`。
- `schedulerStatus.device.writes` 在未验证型号上从 `read_only` 改为 `experimental`：这个值不再表示「只读」，哪些写入可用看 `features`。
- 解除锁定仍然跟着两种锁定走（任一项开着就放行）。MCP 的 `unlock_rf_locks` 以前只按 `bandLock` 判断是否列出，所以只开着锁小区时智能体能锁不能解；现在按动作问闸门（`McpToolProvider.routerWriteActions`），与调度器一致。

**关闭清单（[`src/console-settings.ts`](../../src/console-settings.ts) 的 `disabledWrites`）**

- 按「型号 + 功能」记录，加密存在 `settings.json`。**换型号时不清空**（替主人定的）：条目各自带着型号，闸门只认当前型号的条目。换上另一个型号，它从「实现了的都开着」开始；换回原来的路由器，关掉的仍然是关的。理由：关闭表达的是「我不要在这台路由器上做这件事」，换回同一台时仍然成立；而把它带到另一个型号上没有依据。旧的同意清单在换型号时清空，是因为同意必须对着具体型号重新确认，关闭没有这个问题。清单最多 120 条，超出时丢最早的。
- 守护进程启动时还不知道型号（例如 `state.json` 丢了）时，清单原样保留，识别出型号后照常生效。旧做法在这种情况下会清空同意；关闭清单不清空，因为「看不到路由器」不是把写入重新打开的理由。
- 旧版本存下的同意记录（`experimental`）读入时忽略、下次保存时去掉，不会被解释成「没同意的就是关闭」：升级后所有实现了的写入都是开着的，这是这一版默认行为的改变，写在 `CHANGELOG.md` 的 `### Upgrading` 里。`cpe-dash doctor`、`backup`、`restore` 对新旧文件都通过（[`test/maintenance.test.ts`](../../test/maintenance.test.ts)）。

**保护不变，安全网扩大（[`src/self-heal.ts`](../../src/self-heal.ts)）**

- 每次写入只发一次、同一会话回读、回读不一致告警，控制台每个写操作的确认框，MCP 的 `confirm: true`、总开关与令牌权限，都没有改动。
- 断网 3 分钟的回退以前只看守 AI 智能体（MCP）发起的锁频。现在未验证的路由器上任何入口的锁频段和锁小区都看守：`CpeControlService.onExperimentalLock` 在写入生效后通知 `WanSelfHeal.guardExperimentalLock`，不再看调用方是谁。锁频段写回锁前在同一会话里读到的 LTE 频段；锁小区没有可以写回的设置，回退是解除全部锁定（`RouterBackend.lockCell` 为此返回这次写入是不是实验性写入）。
- 它独立于 `LOCK_ROLLBACK_AFTER_MIN`（取两者中较长的窗口），并且在守护进程重启后接着算：看守标记与锁前的频段掩码随锁定看守一起存进 `state.json`（`selfHealLockWatch.guard`、`restoreLteMask`），重启时按锁定的时间重新算出同一个期限，已经被 WAN 证明可用或已经回退过的锁定不会再看守。存下的掩码不是十六进制掩码时不写回，改为解除全部锁定。v1.8.3 存下的看守记录没有这个标记，按原来的规则处理。

**各入口**

- 错误码：被关闭是 `409 DEVICE_WRITE_DISABLED`（`DeviceWriteDisabledError`，`DeviceReadOnlyError` 的子类，所以各适配器原有的处理都还成立），没有实现仍是 `409 DEVICE_UNVERIFIED_READ_ONLY`。
- MCP `set_experimental_write` 保留名字（替主人定的）：名字说的是「设置一项实验性写入开不开」，新含义仍然成立，改名只会让已经接入的智能体失效。它不再接收型号；`enabled: false` 关闭，`true` 恢复。
- 一键 AI 智能体测试只打开智能体的开关和令牌权限，不再碰任何一项写入的开关；主人关掉的写入，测试不会重新打开。结束测试只恢复这些设置。提示词只改了两处会说错的话（看不到工具时去看这项写入是不是被关掉了；没通过的那一项请主人关掉），其余留给后面的里程碑。
- 控制台：页头从「未验证型号 · 只读」改为「未验证型号」；「设置 → 设备」的开关默认是开，去掉输入型号的同意框，开关旁和每个写操作的确认框里保留「没有在真机上验证过」。
- 在线演示的页面内后端用同一套规则（[`web/src/demo/device.ts`](../../web/src/demo/device.ts)），与守护进程逐项对照（[`test/demo-backend-other.test.ts`](../../test/demo-backend-other.test.ts)）。

**验证**

- H168-383 的请求序列与写入报文在这一步前后逐字节相同：用以前留下的请求序列比对工具，在 v1.8.3 的代码和这一步的代码上各跑一遍严格模拟路由器（26 个操作、233 个请求、22 次写入：登录、每种轮询、短信同步与发送、全部写操作、连接测试、密码错误后的熔断），输出完全一致。仓库内的 [`test/h168-wire.test.ts`](../../test/h168-wire.test.ts) 同样通过。
- 闸门、关闭清单、两种错误码、安全网、MCP、Telegram、一键测试与控制台各有测试；浏览器测试覆盖开关默认是开、关闭与恢复各一次点击、页头在最长的徽标下不溢出。
- 体积：控制台 154.9 / 160 KiB，演示 190.0 / 200 KiB，没有调上限（去掉同意框的文字后略有减少）。

**已知限制**

1. 重拨、移动数据、路由器开关、访问控制和短信仍由服务直接打开华为会话，没有搬到 `RouterBackend` 动词后面；其他品牌上它们是 `not_implemented`。后面的里程碑逐项搬。
2. 「支持的设备」页的符号还是 ○ △ ? ×，这一步只把图例里的说法改到如实；符号和按型号列表留给下一个里程碑。
3. `docs/screenshots/experimental-writes.webp` 拍的是已经去掉的同意框。截图只在发版时重拍，所以指南里暂时不引用这张图；`scripts/screenshots.ts` 里这一张的步骤已经改成拍开关列表。

### 18.2 第 2 步：「支持的设备」按型号列出，四态符号，从报告到 ✓

**决定（主人，2026-11-10）**：「支持的设备」不再一个品牌一行，而是记录过的每个型号一行，按品牌分节，所有品牌用同一个生成器；符号换成 ✓ ? △ —，烽燧还没有做的格子留空；「有人在真机上确认 → 登记 → 表里变成 ✓」这条链路在所有品牌上走通。这一步没有新增路由器接口，也没有参考新的外部项目。

**型号清单（[`src/device-catalog.ts`](../../src/device-catalog.ts) 的 `DEVICE_CATALOG`，248 个型号）**

- 起点是`docs/dev/device-notes.md`（两份资料库的汇总），再逐个对照两份资料库各协议文档开头的「适用型号」表，补上汇总里漏掉的：华为 B818-260、B612s-25d、B310As-852、E5785Lh-22c、E8372h-320、N5368X，源 Link SRT873，鼎桥 MT5700M-CN；中兴 MU5001A、U50S、MC889A Pro、MF286A；品速 PS-R500、PS-R600、PS-M50；通则康威 ZLT X21G、ZLT S20；移远 RM520N-CN、RM521F-GL、RM502Q-GL、RM505Q-AE、RM510Q-GL、RG520N-EB、RG501Q-EU、RG502Q-EA、RG650V、EM160R-GL、EM12-G、EC25、EC200U；广和通 L860-GL、L850-GL；OpenWrt 整机 Suncomm O1 / O2 / O8 Pro、Kunlun CP520、QWRT RM520N、ROOter；展锐 / 高通公版 SRT838、SRT853、CPE905、FNR310、A50、H80、T1（资料库 B 的品速 / ODM 一节）。原表里来自 huawei-lte-api「Tested on」清单的型号（E5180s-22、B612-233、E3131、E3531、E5530As-2、E8231 等）保留。
- 没有列：品速那一行里的 `X55`、`X62`（高通基带的名字，不是型号）；`C8-52x`（型号的写法模式）；公版表里的 `NX200`、`C8-660`（已在 TP-Link、鲲鹏无限两节）；MediaTek 芯片名。
- 两份资料不一致的地方：ZLT P28（A：5G 室外 ODU；B：4G Cat.4 CPE），按描述更细的 A 记为室外；MT5700M-CN（B：鼎桥 5G 工业 CPE；鲲鹏无限资料：模组），记为模组；G5 系列、U60 Pro、MC8512（A：zWRT，A 的 goform 资料里也有 MC8512 / U60 Pro 分支；B：goform），两套接口都记。
- 每个型号记：所在的节（品牌）、资料里的接口（`families`；有两套时自动识别按 `DETECTION_ORDER` 选第一套，这个顺序从 `src/drivers/detect.ts` 搬到零依赖的 `src/router-family.ts`，控制台和文档构建也能用）、形态（室内 / 室外 CPE、随身路由器、USB 上网卡、模组、工业网关；只有随身路由器有电池，第 5 步要用）、别名（路由器自报的名字与市场名不同时的 `code`，以及其他认得的名字）。D-Link 与 TP-Link 的接口为空，整行留空（第 7 步补）。
- `test/device-catalog.test.ts` 把 `docs/dev/device-notes.md` 各表里出现的型号逐个对照清单，漏一个就失败。

**每一格怎么算**

1. 这个型号走的那套接口实现了什么：`ROUTER_FAMILY_FACTS[接口]` 的 `reads` 与 `writes`（读取项新增 `sms`：HiLink 读短信这件事以前写死在表的生成器里，现在是品牌的事实，第 3 步给其他品牌加短信时只改这一处）。实现了是 `?`，没实现留空。
2. 型号自己的事实（`MODEL_FACTS`）：条件让那几格变 `△`，「没有这项功能」让它变 `—`（目前没有这一类）；没有功能的事实是表下的说明，不改符号。一格包含几个功能、只做了其中一部分时也是 `△`，说明由生成器写出（「只有重启，重拨烽燧在这里还没有做」）。
3. 真机报告：`VERIFIED_FEATURES` 让那一格变 `✓`，`UNSUPPORTED_FEATURES` 让它变 `—`。已验证型号（H168-383）整行 `✓`。
4. 一格里几个功能都有符号但不同时，按顺序列出（`✓/?`），图例这时才加上说明。

目前的型号事实与依据：华为未验证型号锁频段只锁 4G（协议附录 A.11 的通用写入只有 LTE 掩码）、附近的基站读的是 H168-383 的接口（附录 A.10）、USB 上网卡要在 HiLink 模式下；中兴 zWRT 只能锁 5G 小区；中兴 goform 的 MC8020、MC888 系列、MC8830、F50、MF79U 锁定前打开开发者选项（驱动的 `zteBranch` 第 2、3 支，测试对照）；鲲鹏无限锁 5G 频段要模组报告 5G 频段设置；OpenWrt 的重启只重启模组、广和通模组的网络制式只能自动或仅 5G SA；通则康威部分运营商固件加密连不上；公版那几款资料说用 `http.cgi` 或 `lua.cgi` 变体，烽燧只实现了前一种。这些以前是指南里手写的一段，现在由事实生成到各品牌的表下面。

**页面与搜索**

- 页首是品牌目录，每个品牌一节（锚点 `brand-<节>`，控制台链接用；原来的 `brands` 锚点放在第一个非 HiLink 品牌之前，别的页面还链着它），节首一句写常见地址、怎么登录、在「设置 → 路由器」选哪个品牌，都取自品牌的事实。表在手机宽度下在自己的容器里横向滚动（文档站原有的宽表样式）。
- 文档站的搜索索引原来每页只留前 6000 个字符，大部分型号搜不到。Markdown 渲染器现在记下每个标题下面的文字，索引随标题带上（每节最多 4000 字），搜索词落在某一节里时直接打开那一节。索引 gzip 后从 36 KB 增到 47 KB，仍然只在打开搜索时加载。

**从报告到 ✓**

- `VERIFIED_FEATURES` 的条目加上品牌（`family`，替主人定的：必填），型号写路由器自报的名字（设备报告的 `identity.model`），所以同名的另一个品牌的路由器不算。闸门（`DeviceAccess.writeState`）对所有品牌都读这份清单：登记过的写入是 `verified`。
- 顺带发现并修了一处：控制台的写操作面板在未验证型号上只列 `enabled` 的写入，登记成 `verified` 的写入反而从面板上消失了；现在一起列出，确认框里「没有在真机上验证过」只对还没确认的写入出现。
- 设备报告末尾加 `checks`：每个功能一行，名字和读 / 写的划分与 `VERIFIED_FEATURES` 相同，结果 `works` / `failed` / `untested` 和依据（读取项所在读取项的状态；写入项写入记录里最近一次的回读）；`access.family` 给出品牌。在线演示用同一个函数按当时的状态算。issue 表单说明了 `checks`，并加了「其他品牌」一项，D-Link、TP-Link 的报告也有地方选。
- 登记步骤写进 `CONTRIBUTING.md`（什么样的报告算数、改哪里、什么时候生效），指南「其他型号与品牌」的「报告兼容性」同步。`test/verified-features.test.ts` 用一条只在测试里的假登记走完整条链路：表里那一格变 ✓、闸门是 `verified`、控制台显示「已验证」、确认框不再提示没验证过、这台路由器的那一行也是 ✓。
- 控制台「设置 → 设备」只显示这台路由器的那一行：守护进程按闸门所用的品牌与型号算好，放在 `GET /api/device/profile` 的 `support` 里（表里没有的型号按品牌的默认情况，`model` 为 `null`，从不回显路由器自报的名字），并链接到文档站对应的一节；整张表不进控制台的包。

**测试运行器漏报（这一步开工前，主人要求的「测试总数下限」）**

- `scripts/test-count-reporter.ts` 跟 spec 报告器一起跑在 `npm run test:coverage` 与 `npm run test:ui` 里。第一版按「开始了的测试必须报结果」检查，推上去后 Node 22 的 CI 立刻失败：`maintenance.test.ts` 里「backup / restore」这一组开始了却没有结果。追下去发现是运行器自己的问题：进程隔离模式下，每个测试结束时子进程都发出了 `test:complete`，但运行器重新排序报告时会丢掉紧跟在异步测试后面的那个结果（Node 26 丢下一个测试，Node 22 丢这一组的结束）；`--test-isolation=none` 时不丢。把一个故意失败的测试放到那个位置，TAP 报告显示 `fail 0`、整个运行通过。
- 所以报告器改成拿 `test:complete` 核对报告：失败被漏报就让运行失败；通过被漏报只列出来（测试本身是通过的），并且照样计入测试数；各目录跑过的测试数不得低于下限（加了测试就调高）。Node 22 的 CI 现在每次列出那一组。

**验证**

- 这一步没有改华为的请求代码（只改了闸门读 `VERIFIED_FEATURES` 的条件、型号清单和报告），`test/h168-wire.test.ts` 照常通过。
- 体积：控制台 156.1 / 160 KiB（首屏 79.7 KiB，「设置 → 设备」那一行约 1 KB，在按需加载的设置块里），没有调上限。

**替主人定的**

1. `VERIFIED_FEATURES` 条目必须带品牌，型号按路由器自报的名字写。
2. 一格只做了一部分时标 `△` 并写明哪部分没做，而不是 `?/` 这样带空白的组合。
3. 未验证的华为型号上，附近的基站与锁频段标 `△`（条件见上）；路由器开关和访问控制在这些型号上烽燧不写，留空。
4. 「一个型号的全部功能都登记过之后算不算已验证型号」：我建议不自动算、等固件核对后再手动加；**主人否决**（2026-11-11）：别人提交报告、开了 issue，确认后登记、更新文档即可。所以烽燧在一个型号上实现的每项功能都登记过（或报告为路由器没有）时，它就是验证过的型号（`isReportVerifiedModel`，验证状态 `report-verified`）：控制台与表里称它验证过，不再发 `MODEL_UNVERIFIED`，表里那一行不再有报告链接。它和 H168-383 的区别只在写入：仍按它的品牌发送（`DeviceAccess.writes` 仍是 `experimental`，`generic` 仍为真），绝不走 H168-383 的请求，所以 `VERIFIED_FIRMWARE` 不收这类型号。登记它的提交同时把它写进所有说明「在哪些路由器上验证过」的页面，测试列出这些页面并检查。

**设备报告的摘要**（主人同意的建议，2026-11-11）：控制台生成报告后，在报告上方按 `checks` 显示「能用 N 项」「不能用 N 项」「还没试 N 项」并列出各项的名称（与控制台其他地方同名），方便填 issue 表单的「能用的功能」「不能用或有问题的」两栏。

### 18.3 第 3 步：短信成为后端动词，其他品牌的短信

**决定**：短信不再由 `SmsService` 直接打开华为会话，而是 `RouterBackend` 的动词；资料里查得到短信接口的品牌都实现，实现后默认可用。architecture.md 17.4 记的是 v1.8.3 的状态（两份本地资料库里其他品牌没有可照着实现的短信接口），这一步靠联网检索补齐。

**架构**

- `RouterBackend` 新增五个动词：`listSms`（列表，连同同一会话里读到的计数）、`peekSmsUnread`（有人登录路由器网页期间的免登录未读数）、`sendSms`、`markSmsRead`、`deleteSms`。计数仍然捎带在 `readTelemetry` 的 5 秒会话里，不另开登录。
- `HilinkBackend` 调用的还是 [`src/sms/protocol.ts`](../../src/sms/protocol.ts) 里的同一批函数、同样的顺序；`SmsService` 只留下不分品牌的部分（收件人与正文校验、镜像、「路由器接受之后的任何失败都记为未确认」）。验证：请求序列比对工具在重构前后的输出逐字节相同（26 个操作、233 个请求、22 次写入），`test/sms-protocol.test.ts`、`test/sms-service.test.ts`、`test/h168-wire.test.ts` 原样通过。`test/router-backend.test.ts` 新增一条：`SmsService` 不得出现 `executeRead(` / `executeControl(` / `probePublic(`，从华为协议模块只能引入两个不分品牌的校验函数。
- 驱动会话多一组可选的短信方法（[`src/drivers/types.ts`](../../src/drivers/types.ts) 的 `DriverSms`：`list`、`counters`、`send`、`markRead`、`delete`）。`DriverBackend` 把动词交给它们：逐个收件人发送，每个只发一次；第一条发出去之后再有收件人被拒，剩下的记为失败而不重发，也不把已经发出的记成失败。没有某个方法的品牌，对应的写入在会话里以明确的说明拒绝，什么都不发。
- 两个由品牌事实决定的差别（[`src/router-family.ts`](../../src/router-family.ts) 的 `smsReadState` 与驱动的 `keepsSent`，服务层不判断品牌）：
  - **已读状态由谁保管。** 通则康威的接口没有「标为已读」，OpenWrt 的模组一列出短信就把它记成已读（3GPP TS 27.005 的 `+CMGL`）。这两个品牌上已读状态由烽燧自己记：镜像在同步时保留已有记录的已读状态，标为已读不开会话、不写路由器，计数里的未读数恒为 0（角标用烽燧自己的未读数）。
  - **路由器留不留发件。** 模组不保存 `AT+CMGS` 发出的短信，所以这类路由器上发出的短信在镜像里是烽燧自己的副本（`localOnly`，全量同步不清掉），而不是等路由器副本来替换的临时记录。
- 计数里新增可选的 `newest`（最新一条的存储句柄）：通则康威没有计数接口，5 秒轮询读的是收件箱第一页；一页满了之后新短信不改变条数，所以连同最新句柄一起比较。
- 公共编解码：[`src/sms/pdu.ts`](../../src/sms/pdu.ts)（3GPP TS 23.040 的 SMS-DELIVER / SMS-SUBMIT、TS 23.038 的 7-bit 打包与扩展表、UCS-2、长短信的 UDH、地址与时间戳）。7-bit 字母表就是 `text-mode.ts` 里编辑框计数用的那一张（现在按 septet 顺序导出），没有第二套；测试核对编码与分段数和编辑框显示的一致。

**各品牌的实现与依据**

| 品牌 | 读取与计数 | 发送 | 标为已读 | 删除 | 依据 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 中兴 goform | `cmd=sms_data_total`（`page` / `data_per_page=500` / `mem_store=1` / `tags=10` / `order_by`），正文是 UTF-16 十六进制；`cmd=sms_capacity_info` 加 `sms_unread_num` | `SEND_SMS`（`Number`、`sms_time`、`MessageBody`、`ID=-1`、`encode_type`、`notCallback`），再轮询 `sms_cmd_status_info&sms_cmd=4`（`3` 成功、`2` 失败） | `SET_MSG_READ`（`msg_id=1;2;`、`tag=0`） | `DELETE_SMS`（每次 20 个 id），轮询 `sms_cmd=6` | zltrouter、ZTE_API_and_Hack、zte-lte-modem |
| 中兴 zWRT | `zwrt_wms.zte_libwms_get_sms_data`、`zwrt_wms_get_wms_capacity` | `zte_libwms_send_sms`，轮询 `zwrt_wms_get_cmd_status`（`sms_cmd: 4`） | `zwrt_wms_modify_tag` | `zwrt_wms_delete_sms`（`sms_cmd: 6`） | zte-cpe-rs、ZTE-SMS-Gateway、open-u60-pro |
| OpenWrt | `AT+CPMS?`、`AT+CMGF=0`、`AT+CMGL=4`（PDU） | QModem 的 `qmodem.send_raw_pdu`（每段一个 PDU，应答里的 `+CMGS` 算发出） | 不写（烽燧保管已读状态） | `AT+CMGD`（长短信的每一段） | 3GPP TS 27.005 / 23.040 / 23.038、QModem 的 rpcd 接口文档 |
| 通则康威 | `cmd 12`（`subcmd` 0 收件箱 / 1 发件箱，`page_num`），`sms_list` 是逗号分隔的 Base64，每条「索引 已读标记 号码 日期 时间 正文」 | `cmd 13`（`phoneNo`、Base64 的 `content`、`cmd 233` 给的 `token`），应答 `message` 为 `0` 即发出 | 没有记录 | 没有记录 | 5G流量监控（VN007+） |
| 烽火 | `FHAPIS` 的 `get_sms_data`（会话 → 短信：`msg_content`、`time`、`childnode`、`isOpened`、`rcvorsend`） | `send_msg`（`recv_number`、`encode_schema: "GSM_8BIT"`、`content`） | `set_value_by_xmlnode`（`…SMS_Recv.SMS_RecvMsg.<n>.isOpened`） | `sms_del_session`（`del_phone`，整段对话） | fiberhome-cpe-lg6121f-sms-notice、fiberhome-cpe、FiberHome-CPE-HA、Codming 的固件分析文章 |
| 品速、鲲鹏无限 | 没有记录 | | | | 见下 |

逐项说明：

- **中兴 goform。** 读的是路由器自己的存储（`mem_store=1`）；SIM 卡存储的取值两处出处说法不一（`0` 与 `2`），所以不读。长短信由路由器自己拼好，一行一条。计数永远用容量接口加未读数这两个请求（列表之后也是）：有固件的未读数滞后于列表，如果两种算法混用，每次轮询都会和上次同步的计数不同而反复同步。有固件会把控制字符直接写进 JSON，解析前去掉。写入都经驱动原有的 `#post`（带 `AD`，不需要它的旧固件忽略）。
- **中兴接口的另一种写法（`/reqproc/`）。** ZXIC 平台的固件（多见于贴牌的 4G CPE / MiFi，包括 ZLT 牌子的一些型号）把同一套接口写成 `GET /reqproc/proc_get` 与 `POST /reqproc/proc_post`：`cmd` 键和 `goformId` 动作相同，短信的字段完全相同，不同的是登录和写入的签名。登录：`cmd=get_random_login` 取随机数，`username` 是用户名的 Base64，`password` 是「随机数 + 密码」的小写 SHA-256 再做 Base64，连同 `cmd=get_token` 的值（登录前为空）作为 `CSRFToken` 一起提交；之后每次写入前取一次新的 `get_token`，原样作为 `CSRFToken`，不带 `AD`。驱动现在两种写法都说：先按 goform 的写法发它一直在发的那个请求（goform 路由器上的请求序列没有变，原有测试原样通过），没有应答再按 `reqproc` 问。这类固件有的只在 `cr_version` 里报自己是谁，这时用版本串开头的平台名作型号。识别品牌时因此多一个免登录的 GET。依据：zltrouter 的协议说明（在 ZTE NV8645 平台的真机上核对过）。
- **中兴 zWRT。** 同一个存储，多一层：网页侧把正文和号码加密。会话向路由器要 RSA 公钥（`zwrt_web.web_crt_get`），把一把 AES-256 密钥（64 位十六进制文本，PKCS #1 v1.5）交给它（`web_http_enstr_set`），之后这两个字段是 AES-256-GCM（Base64 的 IV 12 字节 + tag 16 字节 + 密文）。密钥只在列表或发送时才交换，5 秒轮询不做。没有这套交换的固件按明文字段收发（ubus 对象本身就是明文，open-u60-pro 在设备上这样调用）。发件人号码是否写成十六进制看 `uci zwrt_wms.config.zte_wms_number_encode`。这个固件对删除请求总是回同样的应答、并且不删 SIM 卡上的行，所以删除以列表回读为准，没删掉就告警。
- **OpenWrt。** 模组之上没有短信接口，所以直接说 3GPP TS 27.005。读取、计数、删除经驱动原有的 AT 通道，哪个通道都行。发送要两步（`AT+CMGS=<长度>` 之后在提示符下发 PDU 和 Ctrl-Z），一次只发一条指令的 AT 通道做不到：按 QModem 文档，它的 `qmodem.send_raw_pdu`（`config_section`、`cmd` 为 PDU）替它完成这个交互，所以装有 QModem 的路由器能发送，其他通道上发送在会话里被拒绝、读取和删除可用。顺带把 QModem 自己的 `qmodem.send_at`（要 `config_section` 和 `params.at` / `params.port`，取自 `uci get qmodem`）加进驱动尝试的 AT 通道，否则只有 QModem 的路由器根本连不上。读取会执行 `AT+CMGF=0`（把这个端口切到 PDU 格式，不改任何存储的设置）；读的是模组当前选用的存储，烽燧不改 `AT+CPMS`。存储索引从 0 起，烽燧的句柄是索引加一；长短信按「发件人 + 参考号 + 总段数」拼接，删除时删掉每一段。
- **通则康威。** 来源是一个 VN007+ 的桌面工具，它的请求对齐路由器网页的 `login.js`。没有查到删除和标为已读的指令号（查过：两份本地资料库、GitHub 与 Gitee 上能找到的 VN007 / ZLT 项目、恩山与相关博客），所以这两项不做，删除时明确说明。收件箱和发件箱各自从头编号，发件箱的句柄另加一百万以免相撞。
- **烽火。** 短信在网页自己的 `FHAPIS` 上：请求和应答都是 AES-128-CBC（密钥是这次请求的 `sessionid` 前 16 个字符，IV 固定为 112 到 127 这 16 个字节，十六进制）。三处限制，都在写入之前拦下：① 固件把短信正文拼进命令行（`mn_send_pdu '<号码>' '<编码>' "<正文>"`），所以烽燧只发可打印 ASCII（资料里这个调用只有 `GSM_8BIT` 一种编码），并且拒绝含反引号、`$`、双引号、反斜杠的正文；删除时会话的发件人名同样会进命令行，含其他字符的拒绝。② 路由器按整段对话删除，所以只有选中了这段对话的全部短信才发删除。③ 驱动登录用的是手机 App 的接口（`app_do_login`），`FHAPIS` 就在这个会话里请求；路由器要求网页登录（`DO_WEB_LOGIN`）才应答时，烽燧读不懂它的应答，短信记为「此型号不提供」，**不会为它再发一次密码**（一个会话只提交一次密码，铁律五）。发送后路由器不给结果，以随后的列表里出现一条新的同号码同正文的发件为「已发出」，否则是「未确认」。Pro 系列（`/fh_api/` 路径、请求体带前缀、另一套密钥协商）没有实现。
- **品速、鲲鹏无限：没有做，因为查不到任何接口记录。** 鲲鹏无限的官方说明书写明网页后台和 App 里有短信功能，但没有任何公开资料给出它的请求路径或格式；品速没有查到任何短信相关的资料。查过的地方：两份本地资料库、GitHub 与 Gitee 的代码搜索（`nradioadv`、`get_mgdb_params`、`/action/` 等关键词）、恩山无线论坛与相关博客、两家的官方文档页。

**参考过的项目（只取事实：路径、参数名、取值、应答格式；没有复制代码或测试数据，没有新增依赖）**

| 项目 | 提交（日期） | 许可证 | 取了什么 |
| :--- | :--- | :--- | :--- |
| [exbyte-dev/zltrouter](https://github.com/exbyte-dev/zltrouter) | `60a47a6`（2026-08-20） | MIT | goform / reqproc 的短信列表参数、发送字段、状态槽 4 与 6、id 列表写法、空闲槽不返回状态、未读数不可靠 |
| [paulo-correia/ZTE_API_and_Hack](https://github.com/paulo-correia/ZTE_API_and_Hack) | `7272fc6`（2022-05-03） | 仓库里没有许可证文件 | goform 的列表、发送、删除请求（`notCallback`、`encode_type`） |
| [teixeluis/zte-lte-modem](https://github.com/teixeluis/zte-lte-modem) | `d9abd56`（2024-01-07） | Apache-2.0 | `sms_nv_*`、`sms_unread_num` 等字段名 |
| [1zun4/zte-cpe-rs](https://github.com/1zun4/zte-cpe-rs) | `c85b47b`（2026-11-04） | GPL-3.0 | `zwrt_wms` 的方法与参数、标签取值、字段加密的格式与密钥交换、号码十六进制开关 |
| [Stantastic/ZTE-SMS-Gateway](https://github.com/Stantastic/ZTE-SMS-Gateway) | `2a57b8d`（2026-03-17） | MIT | zWRT 发送的握手与字段（与上一个互相印证） |
| [jesther-ai/open-u60-pro](https://github.com/jesther-ai/open-u60-pro) | `5596b8d`（2026-11-04） | MIT | 设备上 ubus 的明文字段、删除应答不可信 |
| [FUjr/QModem](https://github.com/FUjr/QModem) | `1eae689`（2026-11-08） | MPL-2.0 | `qmodem` 对象的 `send_at`、`send_raw_pdu` 及其参数、UCI 配置的 `at_port` |
| [assad2008/5g-traffic-monitoring-system](https://gitee.com/assad2008/5g-traffic-monitoring-system) | `29ba04b`（2026-07-12） | 木兰宽松许可证 v2 | 通则康威 `cmd 12` / `13` / `233` 的字段与应答 |
| [Curtion/fiberhome-cpe-lg6121f-sms-notice](https://github.com/Curtion/fiberhome-cpe-lg6121f-sms-notice) | `1f3d4a1`（2025-09-12） | 仓库里没有许可证文件 | `FHAPIS` 的加密格式、`get_sms_data` 的结构、标为已读的节点 |
| [upchr/fiberhome-cpe](https://github.com/upchr/fiberhome-cpe)（及其分支 kukume/fiberhome-cpe） | `85a8707`（2026-03-23） | 仓库里没有许可证文件 | 同上（互相印证）；分支记录了 Pro 系列的不同路径 |
| [neon9809/FiberHome-CPE-HA](https://github.com/neon9809/FiberHome-CPE-HA) | `6382cb4`（2026-05-17） | MIT | 同上（互相印证） |

另外读过但没有取用事实的：`obsy/sms_tool`（Apache-2.0）与 `4IceG/luci-app-sms-tool-js`（GPL-3.0，读的是它们的用法说明，烽燧用的是标准本身）、`mattfaraday/vn007`（没有短信接口）。烽火 Pro 系列的两个出处见下面「烽火 Pro 系列」一段。烽火发送与删除的字段、以及正文进命令行这件事，出自 Codming 的《烽火 LG6121F 5G CPE 安全研究》（2026-04-12）。没有许可证文件的仓库同样只取了接口事实。致谢按约定只写在 `other-routers.md` 的「致谢」与两份 README 的致谢行。

**烽火 Pro 系列**（第 3 步之后补上）

- 出处：[kukume/fiberhome-cpe](https://github.com/kukume/fiberhome-cpe)（`facd8fd`，2026-04-04，仓库里没有许可证文件：Pro 系列的路径、`is_encrypt`、密钥的推导、令牌 `JJ8Hs`、网页登录的结果码、TR-069 节点名、`get_sms_data` 与标为已读）与 [xxtg666/FiberHome-LG6851F-SMS-Forward](https://github.com/xxtg666/FiberHome-LG6851F-SMS-Forward)（`ee32f48`，2026-08-10，MIT：同一套密钥推导与 IV，互相印证；另记了令牌本身在 `is_encrypt` 的 `data` 里用 RSA 加密下发）。两者都只取了事实，没有复制代码。
- 接口：与第一代同一套 `{dataObj, ajaxmethod, sessionid}` 调用，路径在 `/fh_api/` 下（`tmp/FHNCAPIS` 免登录、`tmp/FHAPIS` 登录后、`sign/DO_WEB_LOGIN` / `DO_WEB_LOGOUT`）。`is_encrypt` 的 `enable` 为 `1` 时请求体是 6 个随机字符加 AES-128-CBC 的十六进制，IV 是字节 111 到 126；应答同样格式，也可能是明文 JSON。密钥 16 字节：第 5、7、10、11、13 位取令牌的字符，加上会话 ID 第 2 个字符的编码模 3 再减 1；其余位取会话 ID 从倒数第 2 个字符起每隔 4 个往前、减 1，越过开头后从前往后、加 1。
- 识别与会话：先按第一代问 `/api/tmp/FHNCAPIS`，没有回答再问 `/fh_api/tmp/FHNCAPIS`（识别因此多一个免登录 GET）。登录前检查记下这台是哪一代，登录照着走，不再多问；第一代发给路由器的请求一个字节都没变（`test/driver-fiberhome.test.ts` 原样通过）。
- 密钥：令牌先取路由器在 `is_encrypt` 的 `data` 里下发的那个：base64 解开后用这个系列固件里固定的 RSA 私钥（2048 位，PKCS #1 v1.5）解密。私钥取自 xxtg666/FiberHome-LG6851F-SMS-Forward（MIT），那里套的是 PKCS #1 的标签，正文其实是 PKCS #8，仓库里照正文标成 `PRIVATE KEY`（`FIBERHOME_PRO_RSA_KEY`）。它是每台路由器网页里都有的同一把私钥，保护不了用户的任何东西；项目所有者 2026-11-11 决定放进仓库（那个仓库的 README 请求不要外传，已告知所有者）。Node 不再做 PKCS #1 v1.5 解密（防填充预言攻击），所以这里用无填充解密后按 RFC 8017 §7.2.2 自己去掉填充；令牌只接受 5 到 64 个可打印字符。路由器的令牌解不开或打不开应答时，再用资料里记的 `JJ8Hs`。两者都在发送密码之前用一次免登录调用（`get_device_info`）核对；都打不开就抛 `DriverLoginMethodError`：不发密码、不触发熔断。
- 审计：`audit:secrets` 照旧拦所有 PEM 私钥，只按 DER 的 SHA-256 放行这一把（`scripts/audit-secrets.ts` 的 `PUBLIC_VENDOR_KEYS`），工作区与 `git log -p`（跳过行首的差异标记）都按同一规则；改动一个字符、另一种标签或缺结尾行的都会被拦（`test/audit-gate.test.ts`）。仓库的 GitHub 密钥扫描只开了服务商模式，通用私钥不在其中。
- 登录结果：`0` 成功，`1` 别处已登录（让位），`2` 锁定（等 60 秒，熔断），`3` 账户停用（熔断），`4` 密码错误（熔断）。
- 读取：`get_value_by_xmlnode` 的 15 个节点：型号、软硬件版本、RSRP / RSSI / SINR / RSRQ、频段、PCI、`SSB_RSRP`（有值就是 NR 服务小区，否则 LTE）、运营商名、5G / 4G 模组温度（千分之一度）、本月收发字节。制式、频点和辅载波不在节点里，留空。附近的基站在资料里没有，按「此型号不提供」处理。
- 短信：列表与标为已读（`set_value_by_xmlnode` 写 `SMS_RecvMsg.N.isOpened`，写后读列表核对）。发送、删除、锁频、锁小区、重启在资料里没有，短信能力报告 `{ send: false, delete: "none", markRead: "router" }`，控制台不显示发送和删除。
- 接口写法：品牌事实多一个 `variants`（[`src/router-family.ts`](../../src/router-family.ts)），烽火记一种 `pro`：资料里用它的型号（LG6851F）、能读的（信号、短信）与能写的（`smsWrite`）。驱动识别时在身份里报告 `variant: "pro"`（第一代不报告），随识别结果存进 `state.json`；写操作在自己的会话里确认型号时也一并确认写法。闸门（`DeviceAccess.variant`）按「驱动报告的写法，没有报告时按型号在资料里的写法」取这一份事实：Pro 上锁频、锁小区、重启是 `not_implemented`，「设置 → 设备」不显示它们的开关，请求以 `409 DEVICE_UNVERIFIED_READ_ONLY` 拒绝、不建会话；附近的基站按「此型号不提供」，后台不再去读。驱动会话里的拒绝留作最后一道防线。
- 「支持的设备」：加 LG6851F，格子由同一份写法事实算出（资料里没有的留空）；`ModelFact.variant` 让一条说明只适用于某种写法（`null`：品牌自己的写法），第一代的两条短信说明因此不落到 Pro 上。`GET /api/device/profile` 的 `support` 行同样按闸门取的写法算。

**各入口与保护**

- 闸门：短信写入是这五个品牌清单里的 `smsWrite`，默认开启，可以在「设置 → 设备」关闭；写入记录只有指令名和回读结果，没有号码和正文。回读：中兴看写后的列表（标为已读、删除）与状态槽（发送），OpenWrt 删除看 `AT+CPMS?` 前后的条数，烽火看写后的列表。
- 镜像、最近删除、通讯录、Telegram、Webhook、MCP 的 `send_sms` 策略（已知号码、每小时限额、`confirm`）都在 `SmsService` 之上，没有改动；每个品牌的测试都走了「遥测捎带计数 → 同步 → 发送 → 标为已读 → 删除 → 最近删除」这条链路里它做得到的部分。存储空间告警只在路由器报告容量时才有（中兴、OpenWrt）。
- REST、MCP 没有新增路由或工具；契约里 `via` 多一个取值 `driver`，`SmsCounters` 多一个可选的 `newest`，`localMax` 为 0 表示路由器不报告容量，`SmsSyncSummary.mode` 是实际做的同步。
- 「支持的设备」表的短信一列由事实重新生成：中兴 `?`，OpenWrt、通则康威、烽火 `?/△`（读取 `?`，发送与管理有条件，条件写在各自的表下）。

**替主人定的**

1. 烽火不为短信再发一次网页登录的密码（见上）；代价是「要求网页登录才给读」的固件上短信不可用。
2. 烽火的发送限制为可打印 ASCII 并拒绝四个字符，而不是照网页的做法转义后发送：网页怎么转义没有记录，而这里错了的后果是在路由器上执行命令。
3. 通则康威、OpenWrt 的已读状态由烽燧保管；OpenWrt 上发出的短信只留在烽燧里。
4. 已读状态由烽燧保管的品牌，计数里的未读数报 0。
5. 中兴只读路由器自己的存储，不读 SIM 卡存储。
6. 多个收件人在其他品牌上逐个发送；一次最多 4 段、5 个收件人的限制沿用华为的。
7. 一格里读取与写入符号不同时显示 `?/△`（第 2 步定的规则第一次用上），图例随之多出一句说明。

**留给后面的步骤**

- 中兴 `/reqproc/` 写法的固件现在连得上、能读写短信，但「支持的设备」的型号清单里还没有这类型号（两份资料库都没有记）；它们的网络制式取值（`NETWORK_auto`、`TD_W_LTE` 等 4G 制式）和锁频也没有逐项核对。
- 通则康威的写入（`cmd 160` / `161` / `218`）没有带 `cmd 233` 的写令牌，而网页是带的；这一步只在短信发送里带了。
- 烽火 Pro 系列的接口变体。
- 控制台没有按品牌隐藏做不了的按钮（通则康威的删除、没有 QModem 时的发送）：现在是点了之后给出明确的说明。

### 18.4 第 4 步：补齐上一版留下的缺口

**决定**：烽燧对路由器的每一项读写都是 `RouterBackend` 的动词。重拨、自愈重拨、移动数据、安全开关、Wi-Fi 7、天线、Wi-Fi MAC 过滤和上网时段此前由 `CpeControlService` 直接打开华为会话，这一步搬到后端后面；其他品牌按资料实现它们有记录的那几项。architecture.md 17.3、17.5 里因为「资料只有指令名」搁置的几项，这一步查公开资料补齐了应答格式后实现。

**架构**

- `RouterBackend` 新增八个写动词：`reconnect`、`autoReconnect`、`setMobileData`、`setSecuritySwitches`、`setWifi7`、`setAntennaMode`、`setWifiAccess`、`manageTimeRule`。`HilinkBackend` 里是原来的函数、原来的顺序；`DriverBackend` 对一个品牌（连同它的各种接口写法）都没有实现的写入调用 `MutexSessionScheduler.refuseDriverWrite`，拒绝和审计与以前 `executeControl` 在其他品牌上的拒绝完全相同（不排队、不建会话）。`test/router-backend.test.ts` 新增一条：写服务里不得出现 `executeRead(` / `executeControl(`，也不得引入 `generic-writes.ts`、`access-control.ts`。
- 驱动会话多三组可选部件（[`src/drivers/types.ts`](../../src/drivers/types.ts)）：`data`（`enabled`、`set`、可选的 `redial`）、`hosts()`、`setAntennaMode()`。没有某个部件的品牌，对应的读返回「此型号不提供」，写在会话里以明确的说明拒绝（闸门在前面已经按品牌事实拒绝过）。
- **重拨**：路由器有自己的重拨指令就用它；没有的，`DriverBackend` 先 `set(false)` 再在 `finally` 里 `set(true)`，所以断开失败（被拒、会话出错）时也会发「连上」，两条指令各发一次，回读交给之后的轮询（`pending`，和华为通用写入的重拨同一套判断）。断开之后会在同一会话里等路由器报告断开（最多问 8 次、间隔 1 秒），免得「连上」落在断开的过程里。
- **自愈重拨**：会话里先读遥测，WAN 已经连上就跳过（`wan_up`）；能读到数据开关且开关是关的就跳过（`mobile_data_off`，用户有意关掉的）；读不到 WAN 的会话直接失败，不盲目重拨。自愈仍然默认关闭。
- **已连接设备**：`MutexSessionScheduler.executeDriverTopologyRead` 与 [`src/drivers/hosts.ts`](../../src/drivers/hosts.ts) 把驱动列出的设备转成与华为相同的快照：MAC 校验后统一写法、同一台设备只留一次、名字与华为一样经 `sanitizeFreeText` 清理。接入方式新增 `UNKNOWN`（控制台显示「接入方式未知」）：DHCP 租约不说设备是有线还是 Wi-Fi，不猜。
- **流量计数**：`DriverTraffic.counterSource` 记下累计值来自哪个计数器，`CounterRates` 在计数器换了的时候重新开始，模组在 4G 和 5G 之间切换不会被算成一阵流量；`DriverTraffic.todayBytes` 进入快照的「今日流量」（此前所有驱动都是 0）。

**各项的实现与依据**

| 品牌 | 能力 | 接口 | 依据 |
| :--- | :--- | :--- | :--- |
| 中兴 goform | 重拨、移动数据 | `DISCONNECT_NETWORK` / `CONNECT_NETWORK`（带 `notCallback=true`，照常签 `AD` 或 `CSRFToken`），应答 `result: success`；回读 `ppp_status`（路由器没有可读的开关，只有连接状态，所以连接没跟上记为「未知」而不是不一致） | 两份资料库（A 第 290–291 行，B 第 331 行） |
| 中兴 goform | 已连接设备 | `cmd=lan_station_list`（`mac_addr`、`hostname`、`ip_addr`、`connect_time` 秒）与 `cmd=station_list`（`mac_addr`、`hostname`），各自单独问，和路由器网页一样 | 资料 B 只有名字；格式取自 zte-mce888-ultra-daemon 的接口样本与 ZTE MF823 固件网页的 `service.js` |
| 中兴 zWRT | 重拨、移动数据 | `zwrt_data.get_wwaniface`（`enable`、`connect_mode`、`roam_enable`、`connect_status`）与 `set_wwaniface`：照路由器 App 的写法带回当前的 `connect_mode`（打开时为 1）和 `roam_enable`，读不到时退回资料 A 的最简写法（`source_module`、`cid`、`enable`）；回读 `enable` | 资料 A 第 226 行；open-u60-pro 的 `mobile.rs` |
| 鲲鹏无限 | 重拨、移动数据 | 模组桥接的 `/api/dialup/mobile-dataswitch`（GET 读 `<dataswitch>`，POST 带 `?token=` 写 0 / 1）；资料说切换它就是重拨 | 资料 A 表 3.2 第 13、14 行 |
| OpenWrt（装有 QModem） | 重拨、移动数据 | QModem 的 rpcd 对象 `qmodem`，每次带模组的 `config_section`：`modem_hang` / `modem_dial` / `modem_redial`（应答 `result.status` 为 `1` 即执行了；有专门的重拨，不用先断开再连上），`dial_status` 的 `running`（拨号进程在不在跑，即数据开关）作回读，`get_connect_status` 的 `connection_status`（`Yes` / `No`）作为遥测里的 WAN 状态（没有 QModem 时仍按有没有服务小区）。QModem 的拨号进程拥有数据连接，用 netifd 停掉网络接口并不会断开它，所以不走 netifd；没有 QModem 的路由器在会话里拒绝、什么都不发 | 资料里没有；QModem 的 `usr/libexec/rpcd/qmodem`、`luci-app-qmodem-next` 的 `qmodem.js` 与 `lib/netifd/proto/qmodem_runtime.sh` |
| 鲲鹏无限 | 天线 | `/api/device/antenna_set_type`，`0` 自动、`1` 外置、`2` 内置（`3` 混合不提供）；H168-383 的 1 / 2 与它相反，各按各自的资料写；回读按 HiLink 的写法 `GET antenna_set_type`，读不到为「未知」 | 资料 A 表 3.2 第 16 行 |
| 鲲鹏无限 | 已连接设备 | `/cgi-bin/luci/nradio/client/all_list` 的 `result.client[]`：`mac`、`hostname`、`type`（`wired` 或 Wi-Fi）、`frequency`（含 `2.4` / `5.` 分出频段）、`rssi`、`exsit`（`1` 为在线，页面只列这些） | 资料 A 表 3.1 第 5 行只有路径；格式取自 C2000 MAX 固件解出的 `nradio_status/terminal.htm`（ssh-nradio-plugin-installer） |
| 鲲鹏无限 | 硬件版本、PLMN | 识别时读一次模组桥接的 `/api/device/information` 的 `<HardwareVersion>`；`cpe_4.isp` 是数字时作为 PLMN 并按表命名运营商 | 资料 A 表 3.2 第 8 行、4.2 节 |
| OpenWrt | 流量 | 移远：4G 读 `AT+QGDCNT?`，5G（SA、NSA）读 `AT+QGDNRCNT?`，都是 `<bytes_sent>,<bytes_recv>` | 资料 B 第 117 行只有名字；格式取自移远 5G 模组 AT 手册（Helium_DPU 仓库里的转写，第 9.7 节）与 EC25 手册的 `AT+QGDCNT`；QManager 记录了 SDX55 固件把 `QGDNRCNT` 两个字段写反、SDX65 两个计数器互为镜像，烽燧按手册的顺序读 |
| OpenWrt | 载波聚合（广和通） | `AT+GTCAINFO?`：`PCC:` 一行（服务小区，已由 `AT+GTCCINFO?` 读到）与每个辅载波一行 `SCC <n>:state,ul_cfg,band,pci,earfcn,dl_bw,ul_bw,dl_mimo,ul_mimo,dl_mod,ul_mod,rsrp`；频段码 LTE 为 100 + 频段，NR 为 500 + 频段或 5000 + 频段；`state` 为 2 才是激活的；LTE 带宽是资源块数（6/15/25/50/75/100），NR 带宽各固件编码不同，不填；RSRP 已是 dBm | 资料 B 第 16 行只有名字；格式取自 luci-app-5gmodem 的 `docs/modems/fibocom.md` 与 QModem 的 `vendor/fibocom.sh` |
| OpenWrt | 已连接设备 | LuCI 的 `luci-rpc` `getDHCPLeases`：`dhcp_leases`（`macaddr`、`hostname`、`ipaddr`、`expires` 秒或 `false`）、`dhcp6_leases`（`ip6addr` / `ip6addrs`，按 MAC 合并）；没有 LuCI 的路由器读为「此型号不提供」 | LuCI 的 `libs/rpcd-mod-luci/src/luci.c` 与状态页 `40_dhcp.js` |
| 通则康威、烽火 | 运营商 | 路由器只报 PLMN，按两份资料里的大陆运营商对照表命名（CMCC / CUCC / CTCC / CBN），其他号码留空 | 通则康威资料第 958–975 行、烽火资料第 199 行 |
| 品速 | PLMN | `mnet_operator_name` 是数字时作为 PLMN 并按表命名运营商 | 品速资料第 259 行 |
| 烽火 | 今日流量 | `todayRxBytes` + `todayTxBytes` | 烽火资料第 233–234 行 |

**两份资料互相矛盾的中兴细节（architecture.md 17.3），查公开出处裁决**

| 项目 | 资料 A | 资料 B | 公开出处 | 处理 |
| :--- | :--- | :--- | :--- | :--- |
| `AD` 签名的种子 | 只有 MC888 拼接 `cr_version` | 一律拼接 | ZTE-Web-Script 与 UFI-TOOLS 的接口文档都是 `hash(hash(wa_inner_version + cr_version) + RD)`，不分型号 | 维持一律拼接（驱动原本如此） |
| 解除锁小区 | `1` / `1,1,1,1` | `0` / `0,0,0,0` | ZTE-Web-Script 写 `lte_pci_lock=0`、`lte_earfcn_lock=0`、`nr5g_cell_lock=0,0,0,0` | 改为写 0；读回仍把 0 和 1 都当作未锁 |
| 5G 锁小区的子载波间隔 | 编码 0 / 1 | kHz 数值 | ZTE-Web-Script 写 `pci,arfcn,band,30`，并只接受 15 / 30 / 60 / 120 / 240 | 改为 kHz；第 2 支（`Z5g_lockcell_scs`）原本就是 kHz |
| 自动制式的名字 | `WL_AND_5G` | `NETWORK_auto` | 两种都存在：ZTE-Web-Script 列的是 5G 路由器的 `WL_AND_5G` 一组；4G 固件（`reqproc` 写法与 MF286A 一类）用 `NETWORK_auto` | 两种都支持：路由器读回的制式是 `NETWORK_auto` 时按 4G 固件的名字写，并拒绝 5G 制式 |
| 按 `cr_version` 判第 4 支 | 有 | 无 | 没有找到出处 | 维持按硬件版本与型号判断 |
| 32 位 `LD` 的 MD5 登录 | 无 | 有 | ZTE-Web-Script 的登录是 `SHA256(SHA256(password) + LD)`；没有找到 MD5 写法的出处 | 维持不发密码 |
| 登录结果 `2` | 锁定 | 锁定 | 中兴自己网页的 `service.js`：`2` 是 duplicateUser（另一个用户已登录），`4` 是本机已登录、按成功处理 | 结果 `2` 时读路由器的剩余次数：还有次数且没有锁定，视为别处已登录、让位；有锁定或读不到次数，仍按锁定熔断。`4` 仍按「别处已登录」让位（较保守：不在一个可能属于别人的会话里继续） |

**中兴的「有人在线」检查（这一步的第 5 项）：查过，没有可用的标志**

- `loginfo`：中兴自己网页的 `service.js` 用 `loginfo == "ok"` 判断「本机」是否已登录（会话按客户端区分），登录前它对烽燧总是空的，说明不了别人在不在线。
- `check_web_conflict`：GitHub 代码搜索、两份资料库与相关项目（zte-lte-modem、ZTE-MF79U-api、zte-mf286-api、ZTE-MC-Home-assistant、zte-exporter、TBox 的样本等）里都只有键名，没有任何地方写明取值的含义；有项目在注释里写着「不知道能不能用它在登录前避让」。
- 所以登录前检查仍是「没人在线」，避让靠登录应答：`4`、以及上面改过的 `2`。

**这一步没有做的（只因为查不到记录，或属于不实现的几类）**

- **品速、通则康威、烽火的重拨与移动数据**：两份资料库都没有；GitHub / Gitee 代码搜索与这几家的公开项目里也没有。烽火资料里有飞行模式（`app_get_airplane` / `app_set_airplane`），那是新的功能种类，归第 5、6 步。
- **没有 QModem 的 OpenWrt 路由器的重拨与移动数据**：netifd 有公开的 `network.interface.<名字>` `up` / `down`，但哪一个接口是蜂窝接口没有记录，而且拨号程序（如 QModem）自己拥有数据连接时停掉接口并不断开它，所以不做。装有 QModem 的路由器用 QModem 自己的拨号接口（主人同意了这一条建议后补上，见上表）。
- **中兴 zWRT、品速、通则康威、烽火的已连接设备**：zWRT 只查到设备数量（`zwrt_router.api` `router_get_user_list_num`，open-u60-pro 与 MU5250-OpenUI 的 rpcd 权限表），没有设备列表；品速的公版写法（`http.cgi` 的 `cmd: 10` `dhcp_client_list`）只有字段名、且是烽燧没有实现的那种写法；通则康威、烽火查不到。
- **路由器开关（UPnP、DMZ、防火墙）、Wi-Fi 设置、访问控制**：其他品牌的资料里都没有（中兴 goform 只有 `wifi_onoff_state` 等读取键名，没有写入）。有线设备拦截按主人的决定不做。
- **品速的 `lua.cgi` 写法**：资料 B 只有识别请求（`{"cmd":"get_device_info"}`）和一套登录摘要与 AES 加密，没有登录请求本身和任何读取指令；公开项目里查到的 `/cgi-bin/lua.cgi` 是 ZLT 路由器上同一套 `cmd` 编号接口（`cmd 100` 登录、`cmd 165` / `166` 读写 4G 频段），没有信号读取的记录。烽燧的驱动以信号读取为基础，所以这一步不做，列为第 7 步的建议（作为通则康威接口的另一种写法）。
- **OpenWrt 在没有 QModem 的路由器上发短信（第 3 步的尾巴）**：再查了一次，发送仍然只有 QModem 的 `send_raw_pdu` 有记录；其他 AT 通道一次只发一条指令，做不到 `AT+CMGS` 的两步交互。
- 不实现的几类（改身份、解锁运营商、远程 shell、刷写、关闭登录保护）：这一步查到的资料里，ZLT 一类路由器有打开 telnet 的脚本、鲲鹏无限有安装 SSH 插件的项目，只从后者取了设备列表的页面字段，没有实现任何这类功能。

**参考过的项目（只取事实，没有复制代码或测试数据，没有新增依赖）**

| 项目 | 提交（日期） | 许可证 | 取了什么 |
| :--- | :--- | :--- | :--- |
| [tpoechtrager/ZTE-Web-Script](https://github.com/tpoechtrager/ZTE-Web-Script) | `3206010`（2025-12-13） | 仓库里没有许可证文件 | goform 的 `AD` 种子、锁 / 解锁小区的取值、5G 锁小区的子载波间隔写法、制式名 |
| [kanoqwq/UFI-TOOLS](https://github.com/kanoqwq/UFI-TOOLS) | `cf83b81`（2026-10-09） | MIT | `AD` 的计算（印证）、`loginfo` 的含义、`station_list` / `lan_station_list` 的键名 |
| [zhovner/mf823-pro](https://github.com/zhovner/mf823-pro) | `15c64d9`（2016-10-25） | 仓库里没有许可证文件 | 中兴固件网页 `service.js`：登录结果码、`loginfo`、`station_list` 的字段 |
| [Damecek/zte-mce888-ultra-daemon](https://github.com/Damecek/zte-mce888-ultra-daemon) | `3905793`（2025-10-28） | 仓库里没有许可证文件 | `lan_station_list` 的应答格式 |
| [561410590/ssh-nradio-plugin-installer](https://github.com/561410590/ssh-nradio-plugin-installer) | `d4dbd3a`（2026-10-20） | MIT | 鲲鹏无限固件网页读 `client/all_list` 的字段 |
| [openwrt/luci](https://github.com/openwrt/luci) | `fa567d5`（2026-11-11） | Apache-2.0 | `luci-rpc` `getDHCPLeases` 的应答字段 |
| [fildunsky/luci-app-5gmodem](https://github.com/fildunsky/luci-app-5gmodem) | `eb054a5`（2026-11-11） | GPL-3.0 | `AT+GTCAINFO?` 的字段顺序、频段码、状态与带宽编码 |
| [FUjr/QModem](https://github.com/FUjr/QModem) | `1eae689`（2026-11-08） | MPL-2.0 | `AT+GTCAINFO?` 的辅载波字段与频段、带宽换算（印证）；拨号接口 `modem_dial` / `modem_hang` / `modem_redial` / `dial_status` / `get_connect_status` 的参数与应答 |
| [jesther-ai/open-u60-pro](https://github.com/jesther-ai/open-u60-pro) | `5596b8d`（2026-11-04） | MIT | `get_wwaniface` / `set_wwaniface` 的字段与 App 的写法 |
| [asterfusion/Helium_DPU](https://github.com/asterfusion/Helium_DPU) | `ee9d08d`（2026-11-09） | Apache-2.0 | 移远 5G 模组 AT 手册转写里的 `AT+QGDNRCNT`（第 9.7 节） |
| [tcpqueue/quectel-rgmii-toolkit-Rust](https://github.com/tcpqueue/quectel-rgmii-toolkit-Rust) | `a357aea`（2026-10-16） | MIT | `QGDNRCNT` 字段顺序（引用移远手册的页码，印证「发送、接收」） |
| [dr-dolomite/QManager-RM520N](https://github.com/dr-dolomite/QManager-RM520N) | `b1ed828`（2026-11-04） | 没有标注许可证 | 两个计数器在 SDX55 / SDX65 上的差别 |

另外读过但没有取用事实的：dr-dolomite/QuecManager-JS（MIT，按制式选计数器的写法与手册一致）、16c-top/wifiadmin（MIT）、chami2000/band（没有许可证文件，`lua.cgi` 的登录与 4G 频段指令，见上面「没有做的」）、AlienWolfX/ZLT-S12-PRO、33333s/zwrt-datad、dklasens/MU5250-OpenUI。致谢写在指南的致谢页（`docs/guide/{zh,en}/acknowledgments.md`，按品牌分节；主人 2026-11-11 要求把 README 与「其他型号与品牌」里越来越长的致谢搬到一页），README 与「其他型号与品牌」只留指向它的一句。

**验证**

- 重构前后 H168-383 的请求序列逐字节相同：用以前留下的比对工具在重构前（`1259856`）与重构后各跑一遍严格模拟路由器，26 个操作、233 个请求、22 次写入，输出一致；`test/h168-wire.test.ts` 原样通过。
- 每个品牌的新能力都有模拟路由器测试：中兴 goform、zWRT、鲲鹏无限的数据连接（断开被拒时仍发「连上」、连接没跟上时回读为未知、自愈在 WAN 已连上或数据被有意关掉时不重拨），三个品牌的设备列表（含 IPv6 合并、不在线的不列、没有列表时读为「此型号不提供」），移远计数器按制式读、两个计数器之间不算速率，广和通辅载波，中兴的三处取值与结果码 `2`，鲲鹏无限的天线与硬件版本，运营商对照表。
- 体积：控制台首屏 80.1 KiB（超过 80 KiB 的目标 0.1 KiB）+ 按需 80.3 KiB，共 160.4 / 176 KiB，没有调上限。新的天线小节在控制抽屉里（按需加载）。

**替主人定的**

1. 断开之后、连上之前在同一会话里等路由器报告断开，最多 8 秒。
2. 中兴 goform 的数据写入回读的是连接状态，连接没跟上记为「未知」，不报不一致告警。
3. zWRT 的数据开关照路由器 App 的写法带回漫游设置，而不是只发资料 A 的三个字段。
4. 接入方式新增 `UNKNOWN`，而不是把 DHCP 租约标成有线。
5. 鲲鹏无限的天线按它自己资料的编码写，和 H168-383 相反；控制台的天线按钮不显示当前模式（读不到）。
6. 中兴结果码 `2` 按路由器的剩余次数区分；`4` 仍然让位而不是按中兴网页那样当作成功。

**留给后面的步骤**

- 第 5、6 步：烽火的飞行模式、zWRT 的电池与 SIM 卡槽等资料里有、烽燧还没有这类功能的项目；一个非华为的演示路由器（控制台里驱动品牌才有的天线小节、接入方式未知的设备，还没有浏览器测试）。
- 第 7 步：ZLT 的 `lua.cgi` 写法（通则康威接口的另一种写法），先补到信号读取的记录。
