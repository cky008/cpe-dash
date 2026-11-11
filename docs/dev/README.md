# 开发者文档

这些资料写给参与开发的人，只有中文，不发布到文档站。使用烽燧请看[用户指南](../guide/zh/overview.md)。

*Developer notes, in Chinese only. To use FengSui, see the [user guide](../guide/en/overview.md).*

| 文件 | 原文件名 | 内容 | 什么时候改 |
| :--- | :--- | :--- | :--- |
| [protocol.md](protocol.md) | `docs/PHASE1_PROTOCOL_SPEC.md` | 华为 HiLink 协议：H168-383 的会话与登录、已验证的接口与脱敏报文、锁频与锁小区算法、短信接口；附录 A 是其他华为型号（未验证） | 改动发给华为路由器的请求或对应答的解析时 |
| [architecture.md](architecture.md) | `docs/PHASE2_ARCHITECTURE_REPORT.md`（第 1–5、7–10、17 节） | 架构与设计：选型、调度器、时序引擎、短信融合、控制台、访问控制、在线演示、主题、多品牌与统一后端 | 架构有变化时 |
| [sources.md](sources.md) | `docs/PHASE2_ARCHITECTURE_REPORT.md`（第 18 节） | 实现依据：每个品牌每项能力用的接口与出处（资料库的文件与行号、厂商手册、参考项目的地址、提交与许可证），以及查过却没找到记录的地方；一个里程碑一节 | 每实现一项能力，记下它的依据（[`AGENTS.md`](../../AGENTS.md) 第 4 节第 1 条） |
| [audits.md](audits.md) | `docs/PHASE2_ARCHITECTURE_REPORT.md`（第 6、11–16 节） | 审计记录：Phase 2.5 两轮与之后每一轮全面审计的范围、发现与修复、结论、已知限制和误报 | 每轮审计 |
| [api.md](api.md) | `docs/PHASE2_BACKEND_CONTRACT.md` | REST / SSE / MCP 接口契约：路由、请求与返回字段、错误码、SSE 事件、MCP 工具 | 增加或改动路由、事件、工具或错误码时；[`test/contract-manifest.test.ts`](../../test/contract-manifest.test.ts) 检查每一项都写到了。给用户看的简要版是指南的[「API 参考」](../guide/zh/api.md)，它的接口、事件和错误码表由 `npm run docs:sync` 生成（说明写在 [`scripts/api-reference.ts`](../../scripts/api-reference.ts)） |
| [device-notes.md](device-notes.md) | `SUPPORTED_DEVICES_DOCS.md`（仓库根目录） | 各品牌型号的接口资料汇总（不是实测结果；烽燧实际实现了什么以「支持的设备」页为准） | 资料里出现新型号时；[`test/device-catalog.test.ts`](../../test/device-catalog.test.ts) 检查其中每个型号都在型号清单里 |
| [brand.md](brand.md) | `docs/BRAND.md` | 标志：唯一来源、颜色怎样跟随主题、怎么换标志 | 换标志时 |

`architecture.md`、`sources.md`、`audits.md` 原是同一份文件，2026-11-11 拆开，三份共用一套节号（沿用拆分前的编号），所以别处引用的「§12」「§18.4」仍然有效。

另见：[`AGENTS.md`](../../AGENTS.md)（工程规则）、[`CONTRIBUTING.md`](../../CONTRIBUTING.md)（怎么参与）、[`CHANGELOG.md`](../../CHANGELOG.md)（更新日志）。
