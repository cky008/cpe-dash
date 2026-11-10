---
title: 支持的设备
description: 烽燧验证过的路由器，以及可能支持、欢迎你帮忙验证的华为 HiLink 路由器。
section: 开始使用
order: 2
---

**烽燧只在华为 H168-383（固件 4.4.0.1）上验证过。** 下面的表格还按品牌列出了其他华为 HiLink 路由器：另一个 HiLink 客户端 huawei-lte-api 在这些型号上测试过同一套网页接口 [[huawei-lte-api：Tested on](https://github.com/Salamek/huawei-lte-api#tested-on)]，所以烽燧很可能也能连上，只是还没有人用烽燧验证过。表里没有你的型号也可以试试：其他华为 HiLink 路由器通常也能以只读方式连上。

想先看看烽燧在这类路由器上是什么样子，可以打开[在线演示的「其他华为型号」模式](https://cky008.github.io/fengsui-demo/?router=other)。

<!-- devices:begin -->
怎么看这些表格：

- **已验证**：有人在真机上确认过、并已写进代码的功能（`VERIFIED_FEATURES`）。H168-383 的全部功能都验证过。
- **可能支持（未验证）**：烽燧在没验证过的型号上会尝试的功能。**读取**指信号与流量、已连接设备、读取短信，只显示路由器实际提供的；**实验性写入**指锁 4G 频段、重启、重拨、移动数据开关、发送与管理短信，默认锁定，要你在「设置 → 设备」逐项知情同意后才会打开（见[其他华为型号](other-routers.md)）。附近的基站、路由器设置和访问控制用的是 H168-383 自己的接口，其他型号暂不支持。
- **实测反馈**：在 GitHub 打开一个新 issue，标题里已经写好型号。

## 华为

| 型号 | 类型 | 已验证 | 可能支持（未验证） | 实测反馈 |
| :--- | :--- | :--- | :--- | :--- |
| H168-383 | 5G 路由器 | ✅ 全部功能（固件 4.4.0.1） | — | — |
| H112-372 | 5G 路由器 | — | 读取、实验性写入 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+H112-372) |
| H122-373 | 5G 路由器 | — | 读取、实验性写入 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+H122-373) |
| H165-383 | 5G 路由器 | — | 读取、实验性写入 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+H165-383) |
| B310s-22 | 3G / 4G 路由器 | — | 读取、实验性写入 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B310s-22) |
| B311-221 | 3G / 4G 路由器 | — | 读取、实验性写入 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B311-221) |
| B315s-22 | 3G / 4G 路由器 | — | 读取、实验性写入 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B315s-22) |
| B525s-23a | 3G / 4G 路由器 | — | 读取、实验性写入 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B525s-23a) |
| B525s-65a | 3G / 4G 路由器 | — | 读取、实验性写入 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B525s-65a) |
| B528s | 3G / 4G 路由器 | — | 读取、实验性写入 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B528s) |
| B535-232 | 3G / 4G 路由器 | — | 读取、实验性写入 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B535-232) |
| B612-233 | 3G / 4G 路由器 | — | 读取、实验性写入 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B612-233) |
| B628-265 | 3G / 4G 路由器 | — | 读取、实验性写入 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B628-265) |
| B715s-23c | 3G / 4G 路由器 | — | 读取、实验性写入 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B715s-23c) |
| B818-263 | 3G / 4G 路由器 | — | 读取、实验性写入 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B818-263) |
| E5180s-22 | 3G / 4G 路由器 | — | 读取、实验性写入 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E5180s-22) |
| E5186s-22a | 3G / 4G 路由器 | — | 读取、实验性写入 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E5186s-22a) |
| E5573s-320 | 3G / 4G 路由器 | — | 读取、实验性写入 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E5573s-320) |
| E5576-320 | 3G / 4G 路由器 | — | 读取、实验性写入 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E5576-320) |
| E5577Cs-321 | 3G / 4G 路由器 | — | 读取、实验性写入 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E5577Cs-321) |
| E8231 | 3G / 4G 路由器 | — | 读取、实验性写入 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E8231) |
| E3131 | USB 上网卡（HiLink 模式） | — | 读取、实验性写入 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E3131) |
| E3372 | USB 上网卡（HiLink 模式） | — | 读取、实验性写入 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E3372) |
| E3531 | USB 上网卡（HiLink 模式） | — | 读取、实验性写入 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E3531) |
| E5530As-2 | USB 上网卡（HiLink 模式） | — | 读取、实验性写入 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E5530As-2) |
| E8372h-608 | USB 上网卡（HiLink 模式） | — | 读取、实验性写入 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E8372h-608) |

## SoyeaLink

| 型号 | 类型 | 已验证 | 可能支持（未验证） | 实测反馈 |
| :--- | :--- | :--- | :--- | :--- |
| B535-333 | 3G / 4G 路由器 | — | 读取、实验性写入 | [提交实测报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B535-333) |

huawei-lte-api 注明 B2368-22 和 B593s-22 的固件与它不兼容，烽燧很可能也连不上。
<!-- devices:end -->

## 帮忙验证你的型号

你的实测结果能把表里的「可能支持」变成「已验证」：

1. 按[快速开始](quick-start.md)装好烽燧，连上你的路由器。
2. 在「设置 → 设备」点「生成设备报告」，检查一遍，复制或下载 JSON。
3. 点上表里你的型号那一行的「提交实测报告」（或控制台里的「在 GitHub 报告」），把报告粘贴进去，写上哪些功能能用、哪些不能用。

也可以把测试交给 AI 智能体：它逐项测试，起草报告，再给你提交 issue 的链接，见[用 AI 智能体测试](other-routers.md#ai)。

报告只含接口结构和少量白名单信息（型号、固件、网页版本、功能开关、频段号），不含 IMEI、号码、MAC、IP 地址、小区或 Wi-Fi 名称。烽燧不会自动上传任何东西。有人报告某项功能在真机上可用后，维护者会把它加进 `VERIFIED_FEATURES`，这张表也随之更新。
