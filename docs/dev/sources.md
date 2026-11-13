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
- `HilinkBackend` 调用的还是 [`src/drivers/huawei/sms.ts`](../../src/drivers/huawei/sms.ts) 里的同一批函数、同样的顺序；`SmsService` 只留下不分品牌的部分（收件人与正文校验、镜像、「路由器接受之后的任何失败都记为未确认」）。验证：请求序列比对工具在重构前后的输出逐字节相同（26 个操作、233 个请求、22 次写入），`test/sms-protocol.test.ts`、`test/sms-service.test.ts`、`test/h168-wire.test.ts` 原样通过。`test/router-backend.test.ts` 新增一条：`SmsService` 不得出现 `executeRead(` / `executeControl(` / `probePublic(`，从华为协议模块只能引入两个不分品牌的校验函数。
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

### 18.5 第 5 步：资料里有、烽燧还没有的能力（盘点），以及其中的读取

**决定**：先按品牌盘点两份资料库（下文「资料 A」是 `cpe-specs/protocols/`，「资料 B」是 `cpe-protocal/protocols/`）里有、烽燧还没有的每一项能力，再实现其中的读取；写入归第 6 步，另一种接口写法归第 7 步，不实现的几类照 AGENTS.md 第 4 节第 7 条列出。每项读取都捎带在 5 秒轮询的同一个会话里，不另开登录；同一类读数在各品牌上统一单位，路由器没报告的留 `null`。

**架构**

- [`src/router-status.ts`](../../src/router-status.ts)（零依赖，守护进程、控制台与在线演示共用）：`RouterStatusSnapshot` 是电池、SIM 卡、飞行模式、漫游、路由器自己的运行时间与负载、固件更新、Wi-Fi 开关；`TemperatureSensor` 把各个温度分开记（`thermal.sensors`），`thermal.temperatureCelsius` 仍是最热的那个。共用规则：`batteryIsLow`（默认 20 %，`DEFAULT_BATTERY_LOW_PERCENT`）、`simIsLocked`。遥测快照新增 `status`、`device.iccid`、`rf.wcdma`、`rf.rrcConnected`、`rf.qci`、`rf.ulMimoLayers`（字段说明见 [`api.md`](api.md)）；旧的加密状态文件读回时补上这些字段（`status` 为 `null`）。
- **华为只从已经在读的应答里取**：电池取 `monitoring/status` 的 `<BatteryLevel>`（1–4 档乘 25，0 记为 `null`）与 `<BatteryStatus>`；ICCID 取 `device/information` 的 `<Iccid>`；3G 取 `device/signal` 的 `<rscp>`、`<ecio>`、`<sc>`。H168-383 发出的请求一个字节都没变（见下面「验证」）。
- **驱动**：`DriverTelemetry` 多了可选的 `status`、`temperatures`、`ids`、`wcdma`、`rrcConnected`、`qci`、`ulMimoLayers` 与小区的 `cqi1`、`ulBandwidthMhz`、`puschTxDbm`、`pucchTxDbm`、`transmissionMode`；新读的请求失败时只丢这些新读数（`.catch(() => null)`），原有遥测照常。路由器没有自己的运行时间时，快照的 `unavailable` 含 `uptime`，控制台显示「—」，不再把连接时长当作运行时间。
- **功能与表**：`STATUS_READ_FEATURES`（`battery`、`simCard`、`airplaneMode`，[`src/router-family.ts`](../../src/router-family.ts)）是三个新的读取功能，「支持的设备」多三列；它们不随 H168-383 的「已验证型号」一并标 ✓，也不计入 `isReportVerifiedModel`（有的设备没有这样的硬件），只凭自己的报告登记；设备报告按最近一次轮询有没有带上判断「读到了没有」。室内 CPE 没有电池，电池格是 `—`（型号清单的 `forms` 事实）。
- **告警**：`BATTERY_LOW`（`ALERT_BATTERY_LOW_PERCENT`，默认 20，`0` 关闭；没在充电、持续 1 分钟；充电或回到阈值 + 5 以上重新布防）与 `SIM_LOCKED`（SIM 卡等 PIN 或 PUK）。
- **`/metrics`**：温度（最热的一个，以及每类传感器中最热的一个，标签只有 `sensor` 类别）、电量、充电、电池温度、SIM 卡锁住、飞行模式、漫游、路由器的 CPU 与内存；ICCID 一类标识不导出。
- **控制台**：读数只在路由器报告了的地方出现（运营商卡片的 SIM 卡状态、卡槽、PIN 与剩余次数、漫游、飞行模式；身份卡片的 ICCID，和 IMEI 一样默认遮住；健康卡片的电池、各传感器、负载、Wi-Fi、固件更新；信号卡片的上行 MIMO、RRC / QCI、3G）；术语帮助新增 SIM PIN、eSIM、漫游、飞行模式、RRC、QCI、WCDMA。
- **在线演示**：第三个世界 `?router=zte`，一台中兴 MU5001（goform）随身路由器，有电池与 SIM 卡槽；种子 `demo-seed-zte.json` 由真守护进程录制，`test/demo-backend-zte.test.ts` 对照守护进程。浏览器测试另有只给测试用的鲲鹏无限、OpenWrt 场景（驱动品牌才有的天线小节、「接入方式未知」的设备）。

**盘点表**

状态一栏：「已实现」后面是提交；「第 6 步」「第 7 步」是留给的步骤；「不做」写明原因（查不到记录或取值、会改变 H168-383 的请求等）；「不实现」是 AGENTS.md 第 4 节第 7 条的几类；「暂缓」是主人的决定。出处里的「中兴网页」指中兴固件自带网页的脚本（公开副本见下面的参考表）。

| 能力 | 品牌 | 读 / 写 | 出处 | 缺什么细节 | 归属 | 状态 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 电池：电量、充电、电池温度 | 中兴 goform | 读 | 资料 A zte-goform 第 270、346–348 行；`battery_pers` 是 0–4 档（中兴网页的电量图标） | 资料没写 `battery_pers` 是档位，按中兴网页补齐 | 第 5 步 | 已实现（`be6de2e`） |
| 电池：电量、充电、充满 / 用完的剩余分钟、电池温度 | 中兴 zWRT | 读 | 资料 A zte-zwrt 第 219、272–275 行（`get_device_info` 的 `deviceInfoList`） | `bat_charger_connect` 只有样本，含义取自 Primovist/Scripting 与 ZTE_Desktop_Status | 第 5 步 | 已实现（`10fc7c5`） |
| 电池：电量、充电 | 华为 | 读 | 资料 A huawei-hilink-scram 第 351–352 行 | `<BatteryPercent>` 两份资料都没有，不读 | 第 5 步 | 已实现（`b52d821`，只从已读的应答取） |
| SIM 卡状态、PIN 是否开启、PIN / PUK 剩余次数、卡槽（实体卡 / 内置卡 1、2） | 中兴 goform | 读 | 资料 A zte-goform 第 269–270、278、292 行；取值取自中兴网页 | `pin_status`、`modem_main_state` 的取值资料没写，按中兴网页补齐 | 第 5 步 | 已实现（`be6de2e`） |
| SIM 卡状态、PIN、卡槽（实体卡 / eSIM） | 中兴 zWRT | 读 | 资料 A zte-zwrt 第 220 行（`get_sim_info_before`）；`get_sim_info` 的字段取自 open-u60-pro，网页账号可调用取自 MU5250-OpenUI 的 rpcd 权限表 | `get_sim_info` 资料里没有；读不到时退回 `get_sim_info_before` | 第 5 步 | 已实现（`10fc7c5`） |
| SIM 卡状态、PIN 剩余次数 | OpenWrt（AT） | 读 | 3GPP TS 27.007 `AT+CPIN?`；移远 AT 手册 `AT+QPINC?` | 资料里没有；剩余次数只在移远模组上读 | 第 5 步 | 已实现（`818ab69`，每台路由器 60 秒读一次） |
| ICCID | 中兴 goform、华为、鲲鹏无限、OpenWrt | 读 | 资料 B zte-web 第 182 行；资料 A huawei-hilink-scram 第 346 行；资料 A nradio 第 961–995 行；资料 B quectel-fibocom 第 105 行 | 鲲鹏无限的 `overview_status` 只出现在资料的示例代码里，不在接口表 | 第 5 步 | 已实现（各品牌提交） |
| 切换 SIM 卡槽 | 中兴 goform（`SET_SIM_SLOT`）、zWRT（`zwrt_mdm_change_provision_session`）、鲲鹏无限（SIM 选择页） | 写 | 资料 A zte-goform 第 292 行；资料 A zte-zwrt 第 178、183、227 行；鲲鹏无限的页面取自 ssh-nradio-plugin-installer 解出的网页 | 鲲鹏无限的请求要从页面内嵌的数据补齐 | 第 6 步 | 已实现：中兴 goform（`188a7be`）、zWRT（`305045e`）；鲲鹏无限不做（切卡页发什么请求查不到，见 18.6） |
| 输入 SIM PIN、开关 PIN | 中兴 zWRT、华为 | 写 | 资料里没有；zWRT 的方法名见 MU5250-OpenUI 的 rpcd 权限表，华为的 `pin/operate` 见 huawei-lte-api | 参数与应答格式 | 第 6 步 | 已实现：goform（`188a7be`）、zWRT（`305045e`）、OpenWrt 移远（`7939ea2`）；华为不做（参考实现里 PIN 是加密后提交的，见 18.6） |
| 华为 SIM PIN 状态（`pin/status`） | 华为 | 读 | huawei-lte-api 只有接口名 | 字段含义查不到；而且会给 H168-383 新增请求 | — | 不做 |
| 飞行模式 | 烽火 | 读 | 资料 A fiberhome 第 56、122 行（`app_get_airplane` 的 `airplaneOn`） | — | 第 5 步 | 已实现（`c056963`） |
| 飞行模式 | OpenWrt（AT） | 读 | 3GPP TS 27.007 §8.2 `AT+CFUN?`（`1` 正常，`0` / `4` 记为飞行模式） | 资料里没有 | 第 5 步 | 已实现（`818ab69`） |
| 飞行模式开关 | 烽火 | 写 | 资料 A fiberhome 第 54、123 行（`app_set_airplane`） | 应答格式只有一部分 | 第 6 步 | 已实现（`d276d79`）；OpenWrt 用 `AT+CFUN`（`7939ea2`） |
| `RadioOff` | 中兴 goform | — | 资料 A zte-goform 第 270 行只有键名 | 中兴网页里它是 Wi-Fi 的开关，不是飞行模式（交叉核对时纠正了这一条） | — | 不做（不是飞行模式） |
| 第二码字 CQI、5G 上行带宽、上行发射功率 | 中兴 goform | 读 | 资料 B zte-web 第 183–184 行 | 取值格式按同组字段推断，越界的丢掉 | 第 5 步 | 已实现（`be6de2e`） |
| 3G 服务小区（RSCP、Ec/Io、扰码） | 中兴 goform | 读 | 资料 A zte-goform 第 322–324 行 | — | 第 5 步 | 已实现（`be6de2e`） |
| 3G 服务小区 | 华为 | 读 | 资料 A huawei-hilink-scram 第 292–293、357–361 行 | — | 第 5 步 | 已实现（`b52d821`，只从已读的应答取） |
| 3G 服务小区（CESQ 索引） | 品速 | 读 | 资料 A pinsu 第 173–174、265–266 行 | — | 第 5 步 | 已实现（`7abf990`） |
| PUSCH / PUCCH 发射功率、上行带宽、传输模式、上行 MIMO、QCI、RRC 状态 | 烽火 | 读 | 资料 A fiberhome 第 198–223 行 | — | 第 5 步 | 已实现（`c056963`） |
| DL / UL AMBR | 烽火 | 读 | 资料 A fiberhome 第 221–222 行 | 单位（kbps 还是 bps）查不到 | — | 不做 |
| CSI（MCS、秩、CQI） | OpenWrt 移远 | 读 | 资料 B quectel-fibocom 第 114–115、208–213 行（`AT+QNWCFG="lte_csi"` / `"nr5g_csi"`） | — | 第 5 步 | 已实现（`818ab69`） |
| 上行带宽、发射功率 | OpenWrt 移远 | 读 | 资料 B quectel-fibocom `AT+QENG="servingcell"` 的字段表 | 发射功率绝对值大于 40 时按 0.1 dBm 换算 | 第 5 步 | 已实现（`818ab69`） |
| 各接收通道的 RSRQ / SINR | OpenWrt 移远 | 读 | 资料 B quectel-fibocom 第 112 行（`AT+QRSRQ`、`AT+QSINR`） | 只有指令名与应答片段 | — | 未做（建议，见报告） |
| 其他华为型号的 RRC 状态、5G PRACH 功率 | 华为 | 读 | 资料 A huawei-hilink-scram 第 332、376 行 | 解析 H168-383 已验证的应答要另开分支 | — | 未做（建议） |
| 辅载波详情（`ca-scell-info`）、漫游自动连接（`dialup/connection`）、APN 列表（`dialup/profiles`） | 华为 | 读 | 资料 B huawei-hilink 第 323、349、350、430–433 行 | 会给 H168-383 新增请求 | — | 未做（建议放在未验证型号的宽容读取里） |
| 混合天线（`3`）、5G 外置天线开关（`antenna_ext_td_switch`）、天线状态（`antenna_type`） | 鲲鹏无限 | 读 / 写 | 资料 A nradio 第 166–168 行 | 应答格式只有一部分 | 第 6 步 | 已实现混合天线（`bb67f7c`）；`antenna_ext_td_switch` 不做（两份资料对请求体的说法不一致）；天线状态没有读 |
| 同上 | 华为 | 读 / 写 | 资料 A huawei-hilink-scram 第 277、753 行 | 会给 H168-383 新增请求 | — | 不做（资料 A 的天线代码和 H168-383 验证过的对应关系相反，见 18.6） |
| 3G、4G / 3G 等制式 | 中兴 goform、zWRT | 写 | 资料 A zte-goform 第 289 行；资料 A zte-zwrt 第 221、240 行 | — | 第 6 步 | 已实现（goform `188a7be`、zWRT `305045e`） |
| 只用 3G（`WCDMA_ONLY` / `11`） | 通则康威 | 写 | 资料 A tozed 第 329 行 | — | 第 6 步 | 已实现（`c32bb0f`，品速的 `mnet_set_prefer_net_mode` 同一提交） |
| 2G、3G、4G + 5G 优先、`networkOption` | 鲲鹏无限 | 写 | 资料 A nradio 第 162、289–299 行 | — | 第 6 步 | 已实现制式（`bb67f7c`，只列路由器 `<AccessList>` 里有的）；`<networkOption>` 不发（资料写明可选，取值只有一张示例表） |
| 2G、3G 制式与 `networkOption` | 其他华为型号 | 写 | 资料 A huawei-hilink-scram 第 609–629 行 | — | 第 6 步 | 已实现制式（`60914bb`）；`<networkOption>` 同上不发 |
| `mode_pref` 的 WCDMA | OpenWrt 移远 | 写 | 资料 B quectel-fibocom 第 119、223–227 行 | — | 第 6 步 | 已实现（`7939ea2`） |
| `AT+GTACT` 制式与优先频段 | OpenWrt 广和通 | 写 | 资料 B quectel-fibocom 第 266–278 行 | — | 第 6 步 | 已实现制式（`7939ea2`：自动与仅 5G SA，优先频段照模组报告的原样写回） |
| 5G SA / NSA 分开锁频段 | 中兴 goform | 写 | 资料 B zte-web 第 64、291–301 行 | 只在较新的固件上 | — | 不做（查无记录：只有资料 B 的一句注记；公开的中兴脚本都用 `WAN_PERFORM_NR5G_BAND_LOCK`，查不到这两个请求怎么回读、哪些固件支持） |
| 多个候选小区一起锁 | 烽火（LG6151M）、OpenWrt 移远（`QNWLOCK="common/4g"`） | 写 | 资料 A fiberhome 第 130–131、341–366 行；资料 B quectel-fibocom 第 125–126、242–251 行 | 列表长度上限 | — | 未做（锁小区这个动词的入参是一个小区，见 18.6「没做的」） |
| 只锁频点（不带 PCI） | 鲲鹏无限 | 写 | 资料 A nradio 第 163、443–490 行 | — | 第 6 步 | 已实现（`bb67f7c`） |
| 漫游状态 | 中兴 goform | 读 | 资料 A zte-goform 第 270 行（`simcard_roam`）；取值取自中兴网页 | 取值资料没写，按中兴网页补齐 | 第 5 步 | 已实现（`be6de2e`） |
| 漫游时的数据开关 | 中兴 zWRT | 读 | `get_wwaniface` 的 `roam_enable`（open-u60-pro） | 资料只有 `enable` | 第 5 步 | 已实现（`10fc7c5`） |
| 漫游开关 | 中兴 zWRT、goform | 写 | zWRT 见 open-u60-pro；goform 的 `roam_setting_option` 资料 A 第 270 行只有键名 | goform 的写法查不到 | 第 6 步 | 已实现：zWRT（`305045e`）、goform（`188a7be`，写法取自中兴网页的 `SET_CONNECTION_MODE`）、其他华为型号（`60914bb`） |
| 套餐上限与提醒比例 | 中兴 goform | 读 | 资料 A zte-goform 第 270 行；含义取自中兴网页 | 只按流量（`data`）的套餐读，按时长的不读 | 第 5 步 | 已实现（`be6de2e`） |
| 设置月流量上限 | 中兴 zWRT | 写 | MU5250-OpenUI 的 rpcd 权限表（`set_wwandst_monthlimit`） | 参数与应答 | 第 6 步 | 已实现：zWRT（`305045e`）、goform 的 `DATA_LIMIT_SETTING`（`188a7be`） |
| 清零流量统计 | 华为 | 写 | 资料 B huawei-hilink 第 346 行（`monitoring/clear-traffic`） | — | 第 6 步 | 已实现（`60914bb`，未验证的华为型号） |
| APN | 中兴 goform（`APN_PROC_EX`）、zWRT、OpenWrt（`AT+CGDCONT`）、华为 | 读 / 写 | UFI-TOOLS 的接口文档；MU5250-OpenUI 的 rpcd 权限表；资料 B quectel-fibocom 第 127 行；资料 B huawei-hilink 第 350 行 | 华为的应答格式没有；读取只为改 APN 服务，和写入一起做 | 第 6 步 | 已实现：goform（`982f65d`）、zWRT（`1fe7075`）、OpenWrt（`7939ea2`，只有名称和地址类型）；华为不做（参考实现里是加密后提交的，见 18.6） |
| USSD | — | 读 / 写 | 两份资料库都没有 | 公开项目里有华为的接口名，第 6 步查清参数与应答再定 | 第 6 步 | 已实现：中兴 goform（`188a7be`）、其他华为型号（`60914bb`）；zWRT 查无记录，OpenWrt 不做（见 18.6） |
| 分开的温度传感器 | 中兴 goform、烽火 Pro、OpenWrt 移远 | 读 | 资料 A zte-goform 第 275、342–345 行；烽火 Pro 的 4G / 5G 温度；资料 B quectel-fibocom 第 118 行（`AT+QTEMP`） | — | 第 5 步 | 已实现 |
| CPU 与内存占用 | 中兴 goform | 读 | 资料 B zte-web 第 186 行 | 格式按百分比解析（UFI-TOOLS 印证键名） | 第 5 步 | 已实现（`be6de2e`） |
| 运行时间、CPU、内存 | 鲲鹏无限 | 读 | 资料 A nradio 第 961–995 行（示例代码） | 只在示例代码里，按记录实现 | 第 5 步 | 已实现（`943d8de`） |
| 运行时间、内存 | OpenWrt | 读 | OpenWrt 的 ubus `system info`（procd） | 资料只有 `system.board` | 第 5 步 | 已实现（`818ab69`） |
| 固件更新提示 | 中兴 goform | 读 | 资料 A zte-goform 第 270 行；`fota_new_version_state` 的取值取自中兴网页 | `new_version_state` 的取值查不到，只读前者 | 第 5 步 | 已实现（`be6de2e`） |
| Wi-Fi 开关、访客网络（读） | 中兴 goform | 读 | 资料 A zte-goform 第 270 行；含义取自中兴网页 | — | 第 5 步 | 已实现（`be6de2e`） |
| Wi-Fi 设置写入 | 华为以外的品牌 | 写 | 两份资料库都只有读取的键名 | 没有写入记录 | — | 不做 |
| 夜间模式 / 指示灯 | 中兴 goform | 读 | 资料 A zte-goform 第 270 行（`is_night_mode`）只有键名 | 取值查不到 | — | 不做 |
| 品速公版接口（`http.cgi` 的 `cmd` 1–6、10、160、162、164、302：设备信息、SIM 卡、信号、载波聚合、邻区、流量、多个温度与负载、终端、制式、5G NSA 频段、桥接 / NAT / MTU） | 品速 | 读 / 写 | 资料 B pinsu-unisoc-qualcomm 第 152–292 行 | 另一种接口写法，烽燧的品速驱动用的是 `get_mgdb_params` | 第 7 步 | 未做 |
| 手动选网（运营商列表、注册） | 华为 | 读 / 写 | 资料 B huawei-hilink 第 334–336 行 | 扫描要 30–60 秒、会断网 | 第 6 步 | 已实现（主人决定做）：其他华为型号（`60914bb`）、goform（`982f65d`）、zWRT（`1fe7075`）、OpenWrt（`c27e409`） |
| 恢复出厂 | 华为 | 写 | 资料 B huawei-hilink（`device/control` 的 `4`） | 恢复后路由器密码回到默认，烽燧会连不上 | — | 不实现（主人的决定，已写进 AGENTS.md 第 4 节第 7 条） |
| GNSS、BLER、时间提前量、定时重启、eSIM 配置下载 | — | — | 两份资料库都没有接口记录 | — | — | 不做（查不到记录） |
| 型号表里写到的硬件能力（PoE、看门狗、NFC 等） | 各品牌 | — | 资料只在型号表里提到，没有接口 | — | — | 不做（查不到接口） |
| 改设备身份（IMEI、序列号、蜂窝侧 MAC） | 各品牌 | 写 | — | — | — | 不实现 |
| 解除运营商锁或 SIM 锁（如 zWRT 的 `set_simlock_nck`） | 中兴 zWRT 等 | 写 | rpcd 权限表 | — | — | 不实现 |
| 打开 telnet / ADB / SSH（鲲鹏无限的 SSH 插件等） | 各品牌 | 写 | 公开项目 | — | — | 不实现 |
| 刷固件、写 NV / 校准分区 | 各品牌 | 写 | — | — | — | 不实现 |
| 关闭登录保护（HiLink 的免密登录、调试模式） | 华为 | 写 | — | — | — | 不实现 |
| 有线设备拦截（防火墙 MAC 过滤） | 华为 | 写 | — | — | — | 暂缓（主人的决定） |

**单位与取值的统一**

- 电量一律是 0–100 的百分比：只按档报告的（华为 1–4、中兴 `battery_pers` 0–4）乘 25；`-1` 一类无效值为 `null`。
- 剩余时间一律是分钟，温度是 °C，发射功率是 dBm（-50 到 33 之外丢掉），上行带宽是 MHz。
- SIM 卡状态归成五种：`ready`、`absent`、`pin_required`、`puk_required`、`error`；各品牌的原始取值在驱动里换算（中兴 `modem_main_state`，zWRT `sim_states`，AT `+CPIN`）。
- 卡槽：`physical` 是实体卡，`embedded` 是内置卡（eSIM，按路由器的编号）。
- 漫游：`active` 是正在漫游，`dataAllowed` 是漫游时用不用数据。

**参考过的项目（只取事实，没有复制代码或测试数据，没有新增依赖）**

| 项目 | 提交（日期） | 许可证 | 取了什么 |
| :--- | :--- | :--- | :--- |
| [Zisbusy/PortableWiFi-Web](https://github.com/Zisbusy/PortableWiFi-Web) | `68347b1`（2025-06-29） | 仓库里没有许可证文件 | 中兴固件网页的 `com.js`：`battery_pers` 的档位、`pin_status`、`modem_main_state`、`simcard_roam`、套餐字段、`fota_new_version_state`、`wifi_cur_state`、`m_ssid_enable` 的取值，`RadioOff` 是 Wi-Fi 开关 |
| [xcfstudio/LinkUI-ZXIC](https://github.com/xcfstudio/LinkUI-ZXIC) | `3e7522b`（2026-07-08） | MIT | 设备信息页读 `battery_vol_percent`、`battery_charging`、`battery_pers` 的写法（印证） |
| [kanoqwq/UFI-TOOLS](https://github.com/kanoqwq/UFI-TOOLS) | `cf83b81`（2026-10-09） | MIT | `cpu_usage`、`mem_usage`、`sim_slot`、电量键名（印证）；`APN_PROC_EX`（第 6 步） |
| [jesther-ai/open-u60-pro](https://github.com/jesther-ai/open-u60-pro) | `5596b8d`（2026-11-04） | MIT | zWRT `get_sim_info` 的字段与 `sim_states` 的取值；`get_wwaniface` 的 `roam_enable` |
| [dklasens/MU5250-OpenUI](https://github.com/dklasens/MU5250-OpenUI) | `33fdb98`（2026-10-24） | 没有标注许可证 | rpcd 权限表：网页账号可调用 `get_sim_info`、`get_device_info`；第 6 步的方法名 |
| [MavisTok/ZTE_Desktop_Status](https://github.com/MavisTok/ZTE_Desktop_Status) | `18a0e0a`（2026-01-08） | 仓库里没有许可证文件 | zWRT `get_device_info` 的电池字段（印证） |
| [Primovist/Scripting](https://github.com/Primovist/Scripting) | `8654be7`（2026-10-26） | 仓库里没有许可证文件 | `bat_charger_connect` 为 1 是接了充电器 |
| [amenekowo/mu5250_tweaking](https://github.com/amenekowo/mu5250_tweaking) | `bd38bbb`（2026-08-18） | GPL-3.0 | zWRT 电池与 SIM 卡字段名（印证） |
| [Salamek/huawei-lte-api](https://github.com/Salamek/huawei-lte-api) | `d2eb2af`（2026-10-26） | LGPL-3.0 | 只用来确认 `pin/status` 与 `<BatteryPercent>` 没有字段说明（因此不做） |

另外依据的标准与手册：3GPP TS 27.007（`AT+CFUN`、`AT+CPIN`、`AT+CESQ`）、移远 AT 手册（`AT+QPINC`、`AT+QTEMP`、`AT+QNWCFG`）、OpenWrt 的 ubus 文档（`system info`）。读过但没有取用事实的：DarkNikGr/mifi-mu5001-lib-gui、Invalid8/mf935-telemetry、teixeluis/zte-lte-modem 的字段表、fildunsky/luci-app-5gmodem 的中兴与联发科随身路由器说明。

**交叉核对**：盘点由 10 份按品牌的简报（资料全文附行号）做出，再用 5 次核对把每条结论对回资料原文。纠正的：中兴 `RadioOff` 被当成飞行模式（实为 Wi-Fi 开关）；zWRT 的一份盘点混进了 goform 的项目；华为 `<BatteryPercent>`、`<RoamingStatus>` 在资料里不存在；鲲鹏无限的 `overview_status` 只在示例代码里。关键取值（SIM 卡状态、漫游、电池档位、卡槽编号）另外用中兴网页与开源项目逐一核对。

**验证**

- H168-383 的请求不变：用以前留下的比对工具在第 5 步之前（`07b068c`）与之后各跑一遍严格模拟路由器，请求序列（15384 字节）与报文记录（请求头、Cookie 名、请求体，4712 字节）逐字节相同。
- 每个品牌的新读数都有模拟路由器测试（单位换算、无效值为 `null`、新请求失败时只丢新读数）；告警、`/metrics`、控制台文字（`test/web-status-view.test.ts`）、设备报告与「支持的设备」都有测试；演示的中兴世界与守护进程逐项对照；浏览器测试覆盖中兴的电池与 SIM 卡行、鲲鹏无限的天线、OpenWrt 的「接入方式未知」。单元测试 1280 条，浏览器测试 26 条。
- 体积：控制台首屏 83.1 KiB + 按需 80.5 KiB，共 163.6 / 176 KiB；演示 201.3 KiB，上限由 200 调到 210 KiB。

**替主人定的**

1. 状态读数（电池、SIM 卡、飞行模式）不计入「全部功能都由报告确认过的型号」，也不随 H168-383 的已验证一并标 ✓：有的设备没有这样的硬件，只凭自己的报告登记。
2. 低电量告警默认开启，阈值 20 %，持续 1 分钟才告警，回到阈值 + 5 % 或开始充电才重新布防。
3. 其他品牌的路由器没有自己的运行时间时显示「—」，不再把连接时长当作运行时间。
4. ICCID 和 IMEI 一样，在 API 的脱敏副本与控制台里默认遮住（留前 6 位）。
5. 中兴 goform 只按流量的套餐读上限（按时长的不读）；`new_version_state` 不读。
6. OpenWrt 的 SIM 卡读数每台路由器 60 秒读一次（PIN 状态不会每 5 秒变）。
7. 烽火的 AMBR 不读（单位查不到）。
8. 在线演示的上限由 200 调到 210 KiB。

**留给后面的步骤**

- 第 6 步：上表归第 6 步的写入，结果见 18.6（主人定了手动选网做、恢复出厂不做）。
- 第 7 步：品速公版接口（`http.cgi`）与 ZLT 的 `lua.cgi` 写法。

### 18.6 第 6 步：盘点出来的写入（蜂窝设置）

**决定**：第 5 步盘点表里归第 6 步的写入，这一步做成一组「蜂窝设置」：网络制式、手动选网、SIM 卡槽、SIM PIN、飞行模式、数据漫游、接入点（APN）、路由器自己的流量上限、清零流量统计、USSD，另有鲲鹏无限的混合天线与只锁频点。主人中途定了两件事：手动选网做，恢复出厂不做（已写进 AGENTS.md 第 4 节第 7 条）。已验证的 H168-383 这些写入都不提供：它的验证早于这些写入，闸门对它报 `not_implemented`，表里留空，发给它的请求一个字节都不变。

**架构**

- [`src/cellular.ts`](../../src/cellular.ts)（零依赖，守护进程、控制台与在线演示共用）：各项设置的类型与入参校验，`CellularSettingsSnapshot`（一次读到的全部设置），`LinkChange`（会意外断网的四种更改与它原来的值），PIN 的发送条件（`pinAttemptAllowed`、`PIN_REFUSALS`）。
- 每项设置是 `RouterBackend` 的一个动词（`setNetworkMode`、`scanOperators`、`selectOperator`、`setSimSlot`、`enterSimPin`、`setSimPinLock`、`setAirplaneMode`、`setRoaming`、`setApn`、`setDataLimit`、`resetTraffic`、`sendUssd`，读是 `readCellular`，回退是 `revertLinkChange`）。其他品牌交给驱动会话的 `cellular` 部分（`DriverCellular`），华为走通用写入（[`protocol.md`](protocol.md) 附录 A.12）。十个功能名（`CELLULAR_WRITE_FEATURES`）进了写闸门、每个品牌的事实和「支持的设备」表。
- **断网 3 分钟的回退**：网络制式、手动选网、SIM 卡槽、接入点四项，写入的会话里先读原值，写入后交给 `WanSelfHeal.guardLinkChange` 看守（记在 `state.json` 的 `selfHealLinkWatches`，守护进程重启后接着算）。3 分钟后 WAN 仍断开就把这一项改回原值；WAN 已恢复、移动数据关着、飞行模式开着时什么都不写。告警 `SETTING_ROLLED_BACK`、`SETTING_ROLLBACK_FAILED`、`SETTING_NOT_ROLLED_BACK`（原值读不到）。把运营商交还给路由器自己选（自动）不看守；飞行模式和关闭移动数据是有意断网，不回退。
- **PIN**：会话里先读剩余次数，没有报告或只剩一次就不发；发一次，路由器说不对就停。不做 PUK 和修改 PIN。
- **不留痕**：PIN、接入点的名称与凭据、USSD 的指令与应答不进摘要、审计、写入记录和事件；写入记录只留指令名，没有可回读的写入（搜索、USSD、被拒的 PIN）记 `readback: "none"`。
- **入口**：REST `GET /api/cellular`、`POST /api/cellular/refresh` 与 `/api/control/` 下十一条写路由（[`api.md`](api.md) 2.13）；MCP `get_cellular_settings` 与每项一个写工具（4.6）；控制抽屉的「蜂窝设置」小节（按需加载）；Telegram 没有新指令。

**每项用的接口与出处**

| 设置 | 品牌 | 接口 | 出处 |
| :--- | :--- | :--- | :--- |
| 网络制式 | 中兴 goform | `SET_BEARER_PREFERENCE`，取值 `WL_AND_5G`、`Only_5G`、`LTE_AND_5G`、`Only_LTE`、`WCDMA_AND_LTE`、`Only_WCDMA`；4G 固件只有 `NETWORK_auto` 与 `Only_LTE` | 资料 A zte-goform 第 289 行；4G 固件的取值取自中兴网页 |
| 网络制式 | 中兴 zWRT | `zte_nwinfo_api.nwinfo_set_netselect {net_select}`，取值同上 | 资料 A zte-zwrt 第 221、240 行 |
| 网络制式 | 品速、通则康威 | 品速 `mnet_set_prefer_net_mode`；通则康威的 `networkMode` / `mode5g`，只用 3G 是 `11` | 资料 A pinsu 第 147、288 行；资料 A tozed 第 329 行 |
| 网络制式 | 烽火 | `app_set_network_info`（`networkMode` 与 `ENDC` 两个字段） | 资料 A fiberhome 第 125、136 行 |
| 网络制式 | 鲲鹏无限、其他华为型号 | `POST /api/net/net-mode` 的 `<NetworkMode>`（`00`、`01`、`02`、`03`、`08`、`0803`、`0302`），`NetworkBand` / `LTEBand` 照路由器报告的原样写回；只列 `net-mode-list` 的 `<AccessList>` 里有的 | 资料 A nradio 第 289–299 行；资料 A huawei-hilink-scram 第 609–629 行 |
| 网络制式 | OpenWrt | 移远 `AT+QNWPREFCFG="mode_pref"`（含 WCDMA）与 `"nr5g_disable_mode"`；广和通 `AT+GTACT`（自动、仅 5G SA，优先频段原样写回） | 资料 B quectel-fibocom 第 119、223–227、266–278 行 |
| 手动选网 | 中兴 goform | 搜索 `SCAN_NETWORK`，`m_netselect_status` 为 `manual_selecting` 时继续等，结果在 `m_netselect_contents`（`状态,"名称",代码,制式[,子制式]` 以 `;` 分隔）；注册 `SET_NETWORK {NetworkNumber, Rat, nSubrat}`（`Rat` 只收 0、2、7），`m_netselect_result` 为 `manual_success` / `manual_fail`，最多等 120 秒；改回自动是用当前制式再发一次 `SET_BEARER_PREFERENCE`；状态读 `net_select_mode` / `m_netselect_save`。网页只在数据连接断开时允许搜索和注册 | 中兴网页（PortableWiFi-Web 的 `com.js`、`net.js`） |
| 手动选网 | 中兴 zWRT | `nwinfo_manual_scan`、`nwinfo_m_netselect_status`（`manual_selecting`、`manual_search_fail` 或结束）、`nwinfo_m_netselect_contents`（数组，每行 `name` / `mcc_mnc` / `rat` / `status`）、`nwinfo_manual_register {m_mcc_mnc, m_rat}`（`m_rat` 是搜索结果里的原文）、`nwinfo_m_netselect_result`；改回自动 `nwinfo_set_netselect {net_select_mode: "auto_select"}` | open-u60-pro（`modem_ext.rs`、`operators.js`、`advanced.js`）；zte-cpe-rs（状态与结果的取值） |
| 手动选网 | OpenWrt | `AT+COPS=?`、`AT+COPS=1,2,"<代码>"[,<制式>]`、`AT+COPS=0`、`AT+COPS?` | 3GPP TS 27.007 §7.3；移远 AT 手册给 `AT+COPS` 的最长应答时间是 180 秒 |
| 手动选网 | 其他华为型号 | `GET /api/net/plmn-list`（最长等 120 秒）、`POST /api/net/register {Mode, Plmn, Rat}`、`GET /api/net/register` | 资料 B huawei-hilink 第 334–336 行；`Rat` 的取值取自 huawei-lte-api |
| SIM 卡槽 | 中兴 goform | `SET_SIM_SLOT {sim_slot}`（`0` 卡托，`1`、`2` 内置卡），读 `sim_slot` | 资料 A zte-goform 第 292 行；UFI-TOOLS |
| SIM 卡槽 | 中兴 zWRT | 一次请求里两条 `zwrt_mdm_change_provision_session`（要启用的卡槽 `active_flag: 1`，另一个 `0`） | 资料 A zte-zwrt 第 178、183、227 行 |
| SIM PIN | 中兴 goform | `ENTER_PIN {PinNumber}`、`ENABLE_PIN` / `DISABLE_PIN {OldPinNumber}`；剩余次数 `pinnumber` | 中兴网页 |
| SIM PIN | 中兴 zWRT | `sim_verify_pin_puk {pin_num, puk_num: "", pin_encode_flag: "0"}`、`sim_change_pin_mode {pin_num_m, pin_mode, pin_encode_flag: "0"}` | MU5250-OpenUI 的 rpcd 权限表（方法名）；open-u60-pro（参数） |
| SIM PIN | OpenWrt | `AT+CPIN="<PIN>"`、`AT+CLCK="SC",<0\|1>,"<PIN>"`；剩余次数只有移远的 `AT+QPINC="SC"` 报告，所以广和通模组上不发 PIN | 3GPP TS 27.007 §8.3、§7.4；移远 AT 手册 |
| 飞行模式 | 烽火 | `app_set_airplane`，读 `app_get_airplane` | 资料 A fiberhome 第 54、123 行 |
| 飞行模式 | OpenWrt | `AT+CFUN=4` 打开、`AT+CFUN=1` 关闭 | 3GPP TS 27.007 §8.2 |
| 数据漫游 | 中兴 goform | `SET_CONNECTION_MODE {ConnectionMode, roam_setting_option}`，拨号方式照路由器当前的写回 | 中兴网页 |
| 数据漫游 | 中兴 zWRT | `set_wwaniface` 的 `roam_enable`，数据连接的其他设置原样写回 | open-u60-pro |
| 数据漫游 | 其他华为型号 | `POST /api/dialup/connection` 的 `RoamAutoConnectEnable`，其余几项照路由器报告的写回（少于四项就不写） | 资料 B huawei-hilink 第 349 行；huawei-lte-api |
| 接入点 | 中兴 goform | `APN_PROC_EX`：自动 `apn_mode=auto`；手动先 `apn_action=save`（`profile_name`、`wan_dial=*99#`、`pdp_type`、`pdp_select=auto`、`index` 与各地址类型的字段），再 `apn_action=set_default`；配置档读 `APN_configtmp0…19`（`名称($)APN($)…($)认证($)用户名($)密码($)地址类型…`）；网页在数据连接断开时才改 | 中兴网页；UFI-TOOLS 与 LinkUI-ZXIC（印证） |
| 接入点 | 中兴 zWRT | `zwrt_apn_object`：`get_apn_mode` / `set_apn_mode {apn_mode: 0\|1}`、`get_manu_apn_list`（`apnListArray`）、`add_manu_apn` / `modify_manu_apn {profilename, wanapn, pdpType 1\|2\|3, pppAuthMode 0\|1\|2, username, password}`、`enable_manu_apn_id {profileId}` | open-u60-pro（`router.rs`、`controls.js`） |
| 接入点 | OpenWrt | `AT+CGDCONT=1,"<类型>","<名称>"`，读 `AT+CGDCONT?`；没有用户名和密码的指令记录，所以不收 | 3GPP TS 27.007 §10.1.1；资料 B quectel-fibocom 第 127 行 |
| 流量上限 | 中兴 goform | `DATA_LIMIT_SETTING`（`data_volume_limit_switch`、`_unit=data`、`_size=<数量>_<每单位 MB>`、`data_volume_alert_percent`） | 中兴网页 |
| 流量上限 | 中兴 zWRT | `zwrt_data.set_wwandst_monthlimit {enable, type: 2, value, ratio, overflow_auto_disconn}` | MU5250-OpenUI（方法名）；open-u60-pro（参数） |
| 清零流量统计 | 其他华为型号 | `POST /api/monitoring/clear-traffic {ClearTraffic: 1}` | 资料 B huawei-hilink 第 346 行 |
| USSD | 中兴 goform | `USSD_PROCESS`（`ussd_send` / `ussd_reply` / `ussd_cancel`），`ussd_write_flag` 为 15 时继续等、16 有应答、13 已取消，应答在 `ussd_data_info`（UTF-16 十六进制，`ussd_action` 为 1 表示等回复） | 中兴网页 |
| USSD | 其他华为型号 | `module-switch` 的 `ussd_enabled` 为 1 才发；`POST /api/ussd/send`，`GET /api/ussd/status`、`GET /api/ussd/get` | huawei-lte-api |
| 天线 | 鲲鹏无限 | `antenna_set_type` 的 `3`（内置加外置） | 资料 A nradio 第 166 行 |
| 只锁频点 | 鲲鹏无限 | 锁小区的请求不带 PCI | 资料 A nradio 第 163、443–490 行 |

**中兴的两点做法**

- **接入点只写烽燧自己的那一份配置。** 路由器的配置档一个都不改：第一次在列表末尾加一份名为 `FengSui` 的配置，以后只覆盖这一份；改回去是把原来那份重新设为默认。当前用的就是 `FengSui` 这份时，没有原值可回，回退会在告警里说明。配置列表读不出来或已满就不写。
- **goform 照网页的做法先断开再改。** 网页只在数据连接断开时允许搜索、注册和改接入点。驱动在连接开着时先发 `DISCONNECT_NETWORK`，结束时无论成败都再发一次 `CONNECT_NETWORK`；本来就断着的不替用户连上。注册失败（`manual_fail`）记为「回读不一致」而不是报错，这样断网 3 分钟的回退照常接手。

**没做的，和为什么**

| 项目 | 状态 | 原因 |
| :--- | :--- | :--- |
| 恢复出厂 | 不实现 | 主人的决定：恢复后路由器的密码和设置回到默认，烽燧会连不上（AGENTS.md 第 4 节第 7 条） |
| 输入 PUK、修改 PIN | 不实现 | PUK 输错十次 SIM 卡永久作废（AGENTS.md 第 4 节第 8 条） |
| 华为的 SIM PIN 与 APN | 不做 | huawei-lte-api 里这两项是用路由器的 RSA 公钥加密后提交的；通用写入只有明文格式，没有哪份资料写明未验证型号收明文 |
| 华为的天线 | 不做 | 资料 A 给的天线代码和 H168-383 验证过的对应关系相反，分不清其他型号用哪一种 |
| 鲲鹏无限的 `antenna_ext_td_switch` | 不做 | 资料 A 第 168 行与同一份资料的示例对请求体的说法不一致 |
| 鲲鹏无限切换 SIM 卡 | 查无记录 | 资料 A 没有这个接口；官方说明书（C8、C2000、TT 系列）只写了网页上点哪里；公开检索没有找到这个页面发的请求 |
| 中兴 goform 的 5G SA / NSA 分开锁频段 | 查无记录 | 只有资料 B 第 291–301 行的一句注记；公开的中兴脚本都用 `WAN_PERFORM_NR5G_BAND_LOCK`，查不到这两个请求怎么回读、哪些固件支持 |
| 中兴 zWRT 的 USSD | 查无记录 | 资料 A、open-u60-pro、MU5250-OpenUI 的 rpcd 权限表和 zte-cpe-rs 里都没有 USSD 的方法 |
| OpenWrt 的 USSD | 不做 | `AT+CUSD` 的应答是模组主动上报的一行，各个 ubus AT 接口只回指令自己的应答，没有资料写明哪个接口能带回它 |
| 华为 USSD 的「结束会话」 | 不做 | huawei-lte-api 没有这个请求 |
| `<networkOption>` | 不发 | 资料写明可选，取值只有一张示例表；制式本身已经用 `<NetworkMode>` 实现 |
| 多个候选小区一起锁（烽火 LG6151M、移远 `QNWLOCK="common/4g"`） | 未做 | 锁小区这个动词的入参是一个小区；多个小区要改 REST、MCP、控制台和断网回退的入参，这一步没有做，留作建议 |

**参考过的项目（只取事实，没有复制代码或测试数据，没有新增依赖）**

| 项目 | 提交（日期） | 许可证 | 取了什么 |
| :--- | :--- | :--- | :--- |
| [Zisbusy/PortableWiFi-Web](https://github.com/Zisbusy/PortableWiFi-Web) | `68347b1`（2025-06-29） | 仓库里没有许可证文件 | 中兴固件网页的 `com.js`、`net.js`：`SCAN_NETWORK` / `SET_NETWORK` 的流程与取值、`APN_PROC_EX` 的三种表单与配置档格式、`ENTER_PIN` / `ENABLE_PIN` / `DISABLE_PIN`、`SET_CONNECTION_MODE`、`DATA_LIMIT_SETTING`、`USSD_PROCESS` 与 `ussd_write_flag` 的取值、网页在连接断开时才允许选网和改接入点 |
| [xcfstudio/LinkUI-ZXIC](https://github.com/xcfstudio/LinkUI-ZXIC) | `3e7522b`（2026-07-08） | MIT | `APN_PROC_EX` 的 `set_default` 表单（印证） |
| [kanoqwq/UFI-TOOLS](https://github.com/kanoqwq/UFI-TOOLS) | `cf83b81`（2026-10-09） | MIT | `SET_SIM_SLOT`、`APN_PROC_EX` 的字段名（印证；它记的是另一种字段写法，没有采用） |
| [jesther-ai/open-u60-pro](https://github.com/jesther-ai/open-u60-pro) | `5596b8d`（2026-11-04） | MIT | zWRT 的选网方法与结果取值、`zwrt_apn_object` 的方法与字段、PIN 与流量上限的参数、`roam_enable` |
| [dklasens/MU5250-OpenUI](https://github.com/dklasens/MU5250-OpenUI) | `33fdb98`（2026-10-24） | 没有标注许可证 | rpcd 权限表：网页账号可调用的 PIN、流量上限方法名 |
| [1zun4/zte-cpe-rs](https://github.com/1zun4/zte-cpe-rs) | 2.1.0（2026-11-04，docs.rs 上的源码） | GPL-3.0 | `m_netselect_status` 的 `manual_selecting` / `manual_search_fail`、`m_netselect_result` 的 `manual_success` / `manual_fail`、`m_rat` 是搜索结果里的制式原文 |
| [Salamek/huawei-lte-api](https://github.com/Salamek/huawei-lte-api) | `d2eb2af`（2026-10-26） | LGPL-3.0 | `net/register` 的 `Rat` 取值、`dialup/connection` 的字段、`ussd/send` / `status` / `get`、`monitoring/clear-traffic`；PIN 与 APN 是加密后提交的（因此不做） |

另外依据的标准与手册：3GPP TS 27.007（`AT+COPS` §7.3、`AT+CLCK` §7.4、`AT+CFUN` §8.2、`AT+CPIN` §8.3、`AT+CGDCONT` §10.1.1）、3GPP TS 23.122（选网）、移远 AT 手册（`AT+QNWPREFCFG`、`AT+QPINC`，`AT+COPS` 的最长应答时间）、鲲鹏无限官方说明书（只确认切卡没有公开的接口）。

**验证**

- 每个品牌的每项写入都有模拟路由器测试：发了什么、怎么回读、哪些在发送之前就拒绝；经守护进程的测试覆盖闸门、PIN 的条件、回退要用的原值，以及摘要、审计与写入记录里没有 PIN、接入点和 USSD 文字。回退（`test/self-heal-links.test.ts`）覆盖到期改回、WAN 恢复后不动、有意断网时不动、原值读不到、守护进程重启后接着算。
- REST 与 MCP（`test/cellular-http-mcp.test.ts`）：每条路由的校验、`confirm: true`、令牌权限，H168-383 上全部拒绝且不发任何请求，USSD 应答带不可信声明。
- 在线演示：页面内后端的每条蜂窝路由与真守护进程在同一台模拟路由器上逐条比对（应答与写入记录），中兴与未验证华为两个世界各一组。
- 浏览器测试：中兴场景（小节里有哪些行、制式的确认框与写入、PIN 确认框里的剩余次数、USSD 的应答与不留痕、手机宽度），OpenWrt 场景（飞行模式的确认文字、接入点没有凭据栏）。单元测试 1404 条，浏览器测试 28 条。
- H168-383 的请求不变：用以前留下的比对工具在第 6 步之前（`8657c67`）与之后各跑一遍严格模拟路由器，请求序列（15384 字节）与报文记录（请求头、Cookie 名、请求体，4712 字节）逐字节相同。
- 体积：控制台首屏 84.2 KiB + 按需 91.8 KiB，共 176.0 KiB（小节刚加进来时 175.7 KiB），上限由 176 调到 192 KiB；演示 217.2 KiB，上限由 210 调到 226 KiB。
- 浏览器测试在 CI 上暴露了两个界面问题，都已修正：确认框的 `close` 事件晚一拍到达，会把紧接着弹出的确认框当成「取消」（`7754614`）；轮询让抽屉重画时回到顶部、并清掉正在填写的 PIN 或 USSD 指令（`7a4f7a8`）。

**替主人定的**

1. H168-383 不提供这些蜂窝设置写入（它的验证不覆盖），直到有人在真机上验证。
2. PIN 只在路由器报告还剩不止一次时才发；读不到次数的（广和通模组、没有 `pinnumber` 的固件）不发。
3. 同一项在看守期内再改一次，回退用的是第一次之前的值。
4. 把运营商交还给路由器（自动）不看守；手动选定才看守。
5. 中兴的接入点只写烽燧自己的配置档，名字固定为 `FengSui`。
6. goform 的搜索、注册、改接入点在连接开着时由烽燧先断开、结束时连上（网页要求用户自己先断开）。
7. 注册失败记为「回读不一致」并交给回退，而不是当作请求失败。
8. OpenWrt 的接入点只改第一个 PDP 上下文的名称和地址类型，不收凭据。
9. OpenWrt 选网带制式时用 `AT+COPS` 的 0、2、7、12；不带制式时让模组自己定。
10. 改完数据漫游，烽燧把新值并进上次读到的蜂窝设置，不另开会话。
11. 蜂窝设置的写入和其他写入一样计入「全部功能都由报告确认过的型号」。
12. 控制台上限调到 192 KiB，演示调到 226 KiB。

**留给后面的步骤**

- 第 7 步：品速公版接口（`http.cgi`）与 ZLT 的 `lua.cgi` 写法。
- 建议（不在这一步里）：多个候选小区一起锁；H168-383 上验证蜂窝设置写入；Telegram 的蜂窝设置指令。

### 18.7 第 6b 步：多个候选小区一起锁

一次锁小区可以给出一组候选小区（同一种网络），路由器在其中挑一个连接。入参是第一个小区加上 `more`（最多 9 个，各带 PCI）；上限 10 是烽燧自己定的：移远记录的是 20，烽火没有记录。

| 品牌 | 写法 | 出处 | 回读 |
| :--- | :--- | :--- | :--- |
| OpenWrt + 移远模组（只限 4G） | `AT+QNWLOCK="common/4g",<num of cells>,<freq>,<pci>[,<freq>,<pci>]...` | 资料 B quectel-fibocom 第 125、247 行（单个小区的写法，`1` 就是小区数）；多个小区的写法与 `<num of cells>` 的范围 0–20 来自 Quectel 官方论坛上技术支持的回答（forums.quectel.com，「Force 4G for Quectel EM12-G」与「EP06-A Cell lock」两帖，2026-11-13 查阅）；RM5xx 系列公开的 AT 手册里没有这条指令，技术支持说它只用于测试 | 读 `AT+QNWLOCK="common/4g"`，应答同样是小区数加频点 / PCI 列表；逐个比对（`settleCellLocks`） |
| 烽火 LG6151M | `app_set_cell_list`：`{ enable: "1", lock_cell: [{ arfcn, pci }, ...] }` | 资料 A fiberhome 第 130–131、341–366 行（「单个或多个」）；列表长度没有记录，公开检索（产品说明书、评测）也没有 | `app_get_cell_list` 的 `lock_cell` 列表，逐个比对 |

- 移远的 5G 锁小区（`common/5g`）、广和通的 `AT+GTCELLLOCK`、烽火第一代的 `app_set_lockcell` 都只收一个小区：会话里在发送前拒绝。其他品牌和华为在排队前拒绝（品牌事实 `multiCellLock` 没有这种网络；华为是 `assertOneCell`）。
- 断网回退照旧：未验证的路由器上锁小区后断网 3 分钟，解除锁定。

### 18.8 第 6b 步：华为与模组的新读数

| 读数 | 型号 | 接口 | 出处 | 状态 |
| :--- | :--- | :--- | :--- | :--- |
| LTE 辅载波详情（频段、频点、带宽、PCI、RSRP、RSRQ、SINR、RSSI） | 其他华为型号（`device/seccellinfo` 列不出辅载波时） | `GET /api/net/ca-scell-info`：`<scells><scell>` 的 `scell_band`、`scell_earfcn`、`scell_dl_bw`、`scell_pci`、`scell_rsrp`、`scell_rsrq`、`scell_sinr`、`scell_rssi` | 资料 B huawei-hilink 第 323、430–453 行 | 已实现（`parseCaScellInfoXml`）。只在宽容读取（未验证型号）且 `seccellinfo` 为空时多发这一个 GET；H168-383 不变 |
| 当前接入点（方式、名称、地址类型、认证方式、是否设了用户名） | 其他华为型号 | `GET /api/dialup/profiles`：`CurrentProfile` 与各 `<Profile>` 的 `Index`、`IsValid`、`ApnIsStatic`、`ApnName`、`iptype`、`AuthMode`、`Username` | 资料 B huawei-hilink 第 350 行；标签与取值（`AuthMode` 0 自动 / 1 PAP / 2 CHAP，`iptype` 0 / 1 / 2）取自 Salamek/huawei-lte-api（`d2eb2af`，LGPL-3.0，`enums/dialup.py` 与 `api/DialUp.py`） | 已实现（`hilinkApnOf`），随蜂窝设置的读取；用户名只看有没有，用户名和密码本身不保留。写入仍不做（参考实现是加密提交的，见 18.6） |
| 漫游自动连接（`RoamAutoConnectEnable`） | 其他华为型号 | `GET /api/dialup/connection` | 资料 B 第 349 行 | 第 6 步已读（蜂窝设置的 `dataRoaming`） |
| SRS、PRACH 发射功率 | 所有华为型号 | `device/signal` 的 `<txpower>`、`<nrtxpower>`（`PSrs`、`PPrach`） | 资料 A huawei-hilink-scram 第 376 行 | 早已解析（`parseTxPowerMetrics`），这一步只是在控制台显示出来；不增加请求，H168-383 也一样 |
| RRC 状态（`<rrc_status>`） | 华为 | `device/signal` | 资料 A 第 332 行只有一个值为 `1` 的示例 | 不做：取值说明查无记录（资料库、huawei-lte-api、公开检索都没有说明 0 / 1 各指什么），不猜 |
| 各接收通道的 RSRQ / SINR | OpenWrt 移远 | `AT+QRSRQ`、`AT+QSINR`：`+QRSRQ: <PRX>,<DRX>,<RX2>,<RX3>,<sysmode>`，`-32768` 无效 | 移远 RM5xx AT 手册 5.11、5.12 节 | 暂不做：各通道的 RSRP（中兴、移远）早已读到，但转成快照时没有带上，控制台也没有显示；只加读取不会让任何人看到，反而让每 5 秒的轮询多两条指令。建议整体做「各接收通道读数」的显示（见汇报） |


### 18.9 H168-383 真机核对：蜂窝设置在验证过的型号上开放（2026-11-13，主人在场）

**决定**：H168-383 验证之后才加的蜂窝设置，主人在场时逐项在真机上核对（先只读探测结构，再写入、同会话回读、改回原样、改前改后逐项比对，最后用烽燧的真代码再跑一遍），通过的登记进 `VERIFIED_FEATURES`（[#3](https://github.com/cky008/cpe-dash/issues/3)），在 H168-383 上开放；没有通过、或者核对不了的不开放（AGENTS.md 第 4 节第 4、5 条）。H168-383 原有的请求序列逐字节不变（请求序列 15384 字节、报文记录 4712 字节，和改动前相同）；唯一的例外是锁频在用户改过制式时带上当前制式的字段（默认制式下逐字节不变）。

**出处**：真机的应答，以及 H168-383（固件 4.4.0.1）自带的管理页脚本（路由器在登录后才给的 `js/networkmode.js`、`js/mobilesearch-mobilesearch-vue.js`、`js/lockband.js`、`js/statistic-statistic-vue.js`；`js/main.js` 免登录可读）。只取事实（接口路径、字段名、取值、超时），没有复制代码，也不进仓库。

| 能力 | 接口与写法 | 出处 | 真机结果 | 状态 |
| :--- | :--- | :--- | :--- | :--- |
| 数据漫游（`roaming`） | `POST dialup/connection`：六个标签原样回传，只改 `RoamAutoConnectEnable` | 第 6 步的通用写法（18.6） | 写入、改回回读一致，6 个标签和改之前相同 | 已登记（#3），H168-383 上开放 |
| 网络制式（`networkMode`） | `POST net/net-mode` 两个字段：`00` + `networkOption`（1 仅 SA、0 仅 NSA、2 SA + NSA），`03` + `LTEBandOption`（0 仅 4G、2 仅 TDD、1 仅 FDD）；选项来自 `/config/network/net-mode.xml` 的 `net_mode_list` | `js/networkmode.js`（`postConversionValue`、`postData`、`initPage`），超时 90 秒 | 通用的三字段写法以 `-1` 拒绝（7 种格式：只要不带 `networkOption` 就拒）；`03` 配 `networkOption` 也拒；两字段写法通过：仅 4G 后 5G 读数 10 秒内消失、90 秒没有，仅 NSA 保持 5G，改回 SA + NSA 后 5 个标签相同 | 已登记（#3）；同一写法用在所有报告 `networkOption` 的华为机型（`usesModeOption`），新增 `lte_tdd`、`lte_fdd` 两种制式 |
| 仅 4G 下锁 4G 频段（`bandLock`） | `POST net/net-mode` `03`、`3fffffff`、频段掩码、`LTEBandOption` | 真机核对（管理页自己的锁频走 `net/lte-band-info`，`js/lockband.js`） | 被接受，制式保持仅 4G、频段不变 | H168-383 的锁频带上当前制式（`NetModeKeep`）；通用锁频带上 `networkOption` / `LTEBandOption`（`modeOptionOf`）；仅 4G 时拒绝锁 5G 频段 |
| 选网与搜网（`operatorSelect`） | 搜网 `GET net/plmn-list`；手动 `POST net/register` `Mode 1`、`Plmn`、`Rat 255`（`plmn_list_combine_enable` 为 1 时）；自动 `Mode 0` | `js/mobilesearch-mobilesearch-vue.js`（`dialogSubmit`、`registerNetwork`），两者都等 240 秒 | 搜网 56–76 秒、3 个网络；手动选网 3–27 秒后应答，回读 `Mode 1`、`Plmn` 为空，仍在同一运营商；改回自动 3 个标签相同 | 已登记（#3）；等待上限 240 秒、会话最多占 250 秒（`CONTROL_HOLD_MS`；之前 15 秒 / 120 秒、会话 90 秒，H168-383 上会超时） |
| 清零流量统计（`trafficReset`） | `POST monitoring/clear-traffic` `ClearTraffic 1` | `js/statistic-statistic-vue.js`（和第 6 步的写法相同） | 清零后流量与时长计数全部变小；`MonthLastClearTime` 不变 | 已登记（#3）；加了同会话回读（`TotalConnectTime` 变小即一致） |
| USSD（`ussd`） | `POST ussd/send` | 第 6 步 | 没有发：路由器报告 `global/module-switch` 的 `ussd_enabled` 为 0 | 登记进 `UNSUPPORTED_FEATURES`（#3），表里为 — |
| 蜂窝设置的读取（制式、漫游、选网方式、接入点） | `net/net-mode`、`net-mode.xml`、`dialup/connection`、`net/register`、`dialup/profiles` | 只读探测（结构）与真代码读取 | 都有；接入点读到方式、地址类型、是否设了用户名（名称和密码不保留） | H168-383 上有一项蜂窝设置开着时就读（只在打开蜂窝设置时，不进 5 秒轮询） |
| SRS、PRACH 发射功率 | `device/signal` 的 `txpower`、`nrtxpower` | 18.8 | 4G、5G 都有 `PSrs`、`PPrach` | 早已显示（18.8），不增加请求 |
| `net/ca-scell-info` | — | 18.8 | `100003` | H168-383 不提供，不加 |
| 实际制式的判断 | `monitoring/status` 的 `CurrentNetworkTypeEx` | — | 仅 4G 时一直是 `1011` | 不用它判断；看 `device/signal` 的 5G 读数在不在 |

核对用的脚本在仓库外（`~/.cpe-dash-multimodel/v1.9.0/h168-real-device/`），只输出结构、开关、制式代码和是否一致；结论在协议笔记附录 A.12.1 和 #3。
