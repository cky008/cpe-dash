---
title: 支持的设备
description: 烽燧在哪些华为路由器上验证过、在哪些上可能能用，以及每项功能在各型号上的状态。
section: 开始使用
order: 2
---

**烽燧只在华为 H168-383（固件 4.4.0.1）上验证过。** 下面还按品牌列出了其他使用华为 HiLink 网页接口的路由器：烽燧很可能也能连上，但还没有人用烽燧验证过，所以它们默认只读，写操作要逐项打开，详见[其他华为型号](other-routers.md)。表里没有你的型号也可以试试，华为 HiLink 路由器通常都能以只读方式连上。

想先看看烽燧在这类路由器上的样子，可以打开[在线演示的「其他华为型号」模式](https://cky008.github.io/fengsui-demo/?router=other)。

<!-- devices:begin -->
表里的符号：

- **○ 已验证**：有人在真机上确认过，并已写进代码（`VERIFIED_FEATURES`）。H168-383 的全部功能都验证过；它换了别的固件也照常工作，只发一次 `FIRMWARE_UNVERIFIED` 提醒。
- **△ 可能支持**：烽燧在没验证过的型号上会尝试，路由器提供就能用。其中锁频段（只锁 4G）、短信的发送与管理、重启、重拨和移动数据是实验性写入，默认锁定，要在「设置 → 设备」逐项同意后才会打开。
- **? 未知**：烽燧按 H168-383 的方式读取，要看路由器给不给。
- **× 不支持**：烽燧不在没验证过的型号上做这些写操作。
- 「路由器开关」指安全开关、Wi-Fi 7 和天线。USB 上网卡要在 HiLink 模式（有网页管理界面）下才能连。

## 华为

| 型号 | 类型 | 信号与流量 | 附近的基站 | 已连接设备 | 短信 | 锁频段 | 锁小区 | 重启与重拨 | 移动数据 | 路由器开关 | 访问控制 | 实测反馈 |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :--- |
| H168-383 | 5G 路由器 | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | — |
| H112-372 | 5G 路由器 | △ | ? | △ | △ | △ | × | △ | △ | × | × | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+H112-372) |
| H122-373 | 5G 路由器 | △ | ? | △ | △ | △ | × | △ | △ | × | × | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+H122-373) |
| H165-383 | 5G 路由器 | △ | ? | △ | △ | △ | × | △ | △ | × | × | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+H165-383) |
| B310s-22 | 3G/4G 路由器 | △ | ? | △ | △ | △ | × | △ | △ | × | × | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B310s-22) |
| B311-221 | 3G/4G 路由器 | △ | ? | △ | △ | △ | × | △ | △ | × | × | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B311-221) |
| B315s-22 | 3G/4G 路由器 | △ | ? | △ | △ | △ | × | △ | △ | × | × | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B315s-22) |
| B525s-23a | 3G/4G 路由器 | △ | ? | △ | △ | △ | × | △ | △ | × | × | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B525s-23a) |
| B525s-65a | 3G/4G 路由器 | △ | ? | △ | △ | △ | × | △ | △ | × | × | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B525s-65a) |
| B528s | 3G/4G 路由器 | △ | ? | △ | △ | △ | × | △ | △ | × | × | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B528s) |
| B535-232 | 3G/4G 路由器 | △ | ? | △ | △ | △ | × | △ | △ | × | × | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B535-232) |
| B612-233 | 3G/4G 路由器 | △ | ? | △ | △ | △ | × | △ | △ | × | × | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B612-233) |
| B628-265 | 3G/4G 路由器 | △ | ? | △ | △ | △ | × | △ | △ | × | × | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B628-265) |
| B715s-23c | 3G/4G 路由器 | △ | ? | △ | △ | △ | × | △ | △ | × | × | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B715s-23c) |
| B818-263 | 3G/4G 路由器 | △ | ? | △ | △ | △ | × | △ | △ | × | × | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B818-263) |
| E5180s-22 | 3G/4G 路由器 | △ | ? | △ | △ | △ | × | △ | △ | × | × | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E5180s-22) |
| E5186s-22a | 3G/4G 路由器 | △ | ? | △ | △ | △ | × | △ | △ | × | × | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E5186s-22a) |
| E5573s-320 | 3G/4G 路由器 | △ | ? | △ | △ | △ | × | △ | △ | × | × | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E5573s-320) |
| E5576-320 | 3G/4G 路由器 | △ | ? | △ | △ | △ | × | △ | △ | × | × | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E5576-320) |
| E5577Cs-321 | 3G/4G 路由器 | △ | ? | △ | △ | △ | × | △ | △ | × | × | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E5577Cs-321) |
| E8231 | 3G/4G 路由器 | △ | ? | △ | △ | △ | × | △ | △ | × | × | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E8231) |
| E3131 | USB 上网卡 | △ | ? | △ | △ | △ | × | △ | △ | × | × | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E3131) |
| E3372 | USB 上网卡 | △ | ? | △ | △ | △ | × | △ | △ | × | × | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E3372) |
| E3531 | USB 上网卡 | △ | ? | △ | △ | △ | × | △ | △ | × | × | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E3531) |
| E5530As-2 | USB 上网卡 | △ | ? | △ | △ | △ | × | △ | △ | × | × | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E5530As-2) |
| E8372h-608 | USB 上网卡 | △ | ? | △ | △ | △ | × | △ | △ | × | × | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E8372h-608) |

## SoyeaLink

| 型号 | 类型 | 信号与流量 | 附近的基站 | 已连接设备 | 短信 | 锁频段 | 锁小区 | 重启与重拨 | 移动数据 | 路由器开关 | 访问控制 | 实测反馈 |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :--- |
| B535-333 | 3G/4G 路由器 | △ | ? | △ | △ | △ | × | △ | △ | × | × | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B535-333) |
<!-- devices:end -->

## 帮忙验证你的型号

点表里你的型号那一行的「提交报告」，会在 GitHub 打开一个标题已写好型号的新 issue。怎么生成设备报告并提交，见[报告兼容性](other-routers.md#report)；也可以让 AI 智能体替你测试并起草报告，见[用 AI 智能体测试](other-routers.md#ai)。有人报告某项功能在真机上可用后，表里那一格就会变成 ○。
