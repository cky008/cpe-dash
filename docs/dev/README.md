# 开发者文档

这些资料写给参与开发的人，只有中文，不发布到文档站。使用烽燧请看[用户指南](../guide/zh/overview.md)。

*Developer notes, in Chinese only. To use FengSui, see the [user guide](../guide/en/overview.md).*

| 文件 | 原文件名 | 内容 | 什么时候改 |
| :--- | :--- | :--- | :--- |
| [protocol.md](protocol.md) | `docs/PHASE1_PROTOCOL_SPEC.md` | 华为 HiLink 协议：H168-383 的会话与登录、已验证的接口与脱敏报文、锁频与锁小区算法、短信接口；附录 A 是其他华为型号（未验证） | 改动发给华为路由器的请求或对应答的解析时 |
| [architecture.md](architecture.md) | `docs/PHASE2_ARCHITECTURE_REPORT.md` | 架构与设计记录：选型、调度器、时序引擎、短信融合、各版本的实现与各轮审计；第 17 节起是多品牌支持，每项实现的依据（哪个接口、出自哪里、参考项目的提交与许可证） | 每实现一项能力，记下它的依据（[`AGENTS.md`](../../AGENTS.md) 第 4 节第 1 条）；每轮审计 |
| [api.md](api.md) | `docs/PHASE2_BACKEND_CONTRACT.md` | REST / SSE / MCP 接口契约：路由、请求与返回字段、错误码、SSE 事件、MCP 工具 | 增加或改动路由、事件、工具或错误码时；[`test/contract-manifest.test.ts`](../../test/contract-manifest.test.ts) 检查每一项都写到了 |
| [device-notes.md](device-notes.md) | `SUPPORTED_DEVICES_DOCS.md`（仓库根目录） | 各品牌型号的接口资料汇总（不是实测结果；烽燧实际实现了什么以「支持的设备」页为准） | 资料里出现新型号时；[`test/device-catalog.test.ts`](../../test/device-catalog.test.ts) 检查其中每个型号都在型号清单里 |
| [brand.md](brand.md) | `docs/BRAND.md` | 标志：唯一来源、颜色怎样跟随主题、怎么换标志 | 换标志时 |

另见：[`AGENTS.md`](../../AGENTS.md)（工程规则）、[`CONTRIBUTING.md`](../../CONTRIBUTING.md)（怎么参与）、[`CHANGELOG.md`](../../CHANGELOG.md)（更新日志）。
