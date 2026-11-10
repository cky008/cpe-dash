---
title: 支持的设备
description: 烽燧在哪台路由器上验证过、在哪些品牌和型号上可能能用，以及每项功能在各处的状态。
section: 开始使用
order: 2
---

**烽燧只在华为 H168-383（固件 4.4.0.1）上验证过。** 除此之外，烽燧还能连两类路由器，它们都没有人用烽燧在真机上验证过，所以默认只读，写操作要逐项打开：

- **其他华为 HiLink 路由器**：和 H168-383 用同一套网页接口，下面按型号列出。表里没有你的型号也可以试试，华为 HiLink 路由器通常都能以只读方式连上。
- **其他品牌**：中兴、品速、通则康威（ZLT）、烽火、鲲鹏无限，以及装了 OpenWrt 并使用移远或广和通模组的路由器。烽燧按各品牌的接口资料为它们各写了一套实现，见[其他品牌](#brands)。

你不用知道自己的路由器属于哪一类：在「设置 → 路由器」把品牌留在「自动识别」，烽燧会先认出品牌再登录。烽燧在这些路由器上怎样工作，见[其他型号与品牌](other-routers.md)。

想先看看烽燧在没验证过的路由器上的样子，可以打开[在线演示的「其他华为型号」模式](https://cky008.github.io/fengsui-demo/?router=other)。

<!-- devices:begin -->
表里的符号：

- **○ 已验证**：有人在真机上确认过，并已写进代码（`VERIFIED_FEATURES`）。H168-383 的全部功能都验证过；它换了别的固件也照常工作，只发一次 `FIRMWARE_UNVERIFIED` 提醒。
- **△ 可能支持**：协议里有这项功能，烽燧也已经实现，只是还没人在这个型号上验证过。其中锁频段（只锁 4G）、短信的发送与管理、重启、重拨和移动数据，可以在「设置 → 设备」逐项同意后作为实验性写入试用；路由器开关和访问控制的改动，烽燧目前只在验证过的型号上开放。
- **? 未知**：烽燧只知道 H168-383 的接口，协议资料里没有其他型号的做法，能不能用要看路由器。
- **× 不支持**：协议里没有这项功能，或者有人在这个型号上实测过不能用（表里暂时还没有）。
- 「路由器开关」指安全开关、Wi-Fi 7 和天线，路由器本身有这些功能才谈得上（比如 Wi-Fi 7 要路由器支持 Wi-Fi 7）。USB 上网卡要在 HiLink 模式（有网页管理界面）下才能连。

## 华为

| 型号 | 类型 | 信号与流量 | 附近的基站 | 已连接设备 | 短信 | 锁频段 | 锁小区 | 重启与重拨 | 移动数据 | 路由器开关 | 访问控制 | 实测反馈 |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :--- |
| H168-383 | 5G 路由器 | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | — |
| H112-372 | 5G 路由器 | △ | ? | △ | △ | △ | ? | △ | △ | △ | △ | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+H112-372) |
| H122-373 | 5G 路由器 | △ | ? | △ | △ | △ | ? | △ | △ | △ | △ | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+H122-373) |
| H165-383 | 5G 路由器 | △ | ? | △ | △ | △ | ? | △ | △ | △ | △ | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+H165-383) |
| B310s-22 | 3G/4G 路由器 | △ | ? | △ | △ | △ | ? | △ | △ | △ | △ | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B310s-22) |
| B311-221 | 3G/4G 路由器 | △ | ? | △ | △ | △ | ? | △ | △ | △ | △ | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B311-221) |
| B315s-22 | 3G/4G 路由器 | △ | ? | △ | △ | △ | ? | △ | △ | △ | △ | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B315s-22) |
| B525s-23a | 3G/4G 路由器 | △ | ? | △ | △ | △ | ? | △ | △ | △ | △ | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B525s-23a) |
| B525s-65a | 3G/4G 路由器 | △ | ? | △ | △ | △ | ? | △ | △ | △ | △ | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B525s-65a) |
| B528s | 3G/4G 路由器 | △ | ? | △ | △ | △ | ? | △ | △ | △ | △ | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B528s) |
| B535-232 | 3G/4G 路由器 | △ | ? | △ | △ | △ | ? | △ | △ | △ | △ | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B535-232) |
| B612-233 | 3G/4G 路由器 | △ | ? | △ | △ | △ | ? | △ | △ | △ | △ | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B612-233) |
| B628-265 | 3G/4G 路由器 | △ | ? | △ | △ | △ | ? | △ | △ | △ | △ | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B628-265) |
| B715s-23c | 3G/4G 路由器 | △ | ? | △ | △ | △ | ? | △ | △ | △ | △ | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B715s-23c) |
| B818-263 | 3G/4G 路由器 | △ | ? | △ | △ | △ | ? | △ | △ | △ | △ | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B818-263) |
| E5180s-22 | 3G/4G 路由器 | △ | ? | △ | △ | △ | ? | △ | △ | △ | △ | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E5180s-22) |
| E5186s-22a | 3G/4G 路由器 | △ | ? | △ | △ | △ | ? | △ | △ | △ | △ | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E5186s-22a) |
| E5573s-320 | 3G/4G 路由器 | △ | ? | △ | △ | △ | ? | △ | △ | △ | △ | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E5573s-320) |
| E5576-320 | 3G/4G 路由器 | △ | ? | △ | △ | △ | ? | △ | △ | △ | △ | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E5576-320) |
| E5577Cs-321 | 3G/4G 路由器 | △ | ? | △ | △ | △ | ? | △ | △ | △ | △ | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E5577Cs-321) |
| E8231 | 3G/4G 路由器 | △ | ? | △ | △ | △ | ? | △ | △ | △ | △ | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E8231) |
| E3131 | USB 上网卡 | △ | ? | △ | △ | △ | ? | △ | △ | △ | △ | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E3131) |
| E3372 | USB 上网卡 | △ | ? | △ | △ | △ | ? | △ | △ | △ | △ | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E3372) |
| E3531 | USB 上网卡 | △ | ? | △ | △ | △ | ? | △ | △ | △ | △ | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E3531) |
| E5530As-2 | USB 上网卡 | △ | ? | △ | △ | △ | ? | △ | △ | △ | △ | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E5530As-2) |
| E8372h-608 | USB 上网卡 | △ | ? | △ | △ | △ | ? | △ | △ | △ | △ | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E8372h-608) |

## SoyeaLink

| 型号 | 类型 | 信号与流量 | 附近的基站 | 已连接设备 | 短信 | 锁频段 | 锁小区 | 重启与重拨 | 移动数据 | 路由器开关 | 访问控制 | 实测反馈 |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :--- |
| B535-333 | 3G/4G 路由器 | △ | ? | △ | △ | △ | ? | △ | △ | △ | △ | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B535-333) |
<!-- devices:end -->

<a id="brands"></a>

## 其他品牌

烽燧为下面每个品牌写了一套实现，依据的是各品牌管理接口的资料，没有在真机上验证过。一个品牌下的不同型号用的接口大体相同，所以这里按品牌列，不按型号列。

<!-- brands:begin -->
这张表里的符号：

- **△ 可能支持**：烽燧按这个品牌的接口资料实现了，还没有人在真机上验证过。读取不需要打开任何开关；锁频段、锁小区和重启是实验性写入，要在「设置 → 设备」逐项打开，每次只发一次，写后回读核对。
- **? 未知**：烽燧在这个品牌上还没有这一项，控制台里对应的部分是空的。
- 一格里有几个符号时，依次对应这一列包含的功能：「重启与重拨」是重启 / 重拨。

| 品牌 | 常见地址 | 信号与流量 | 附近的基站 | 已连接设备 | 短信 | 锁频段 | 锁小区 | 重启与重拨 | 移动数据 | 路由器开关 | 访问控制 | 实测反馈 |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :--- |
| 中兴（goform 网页接口） | `192.168.0.1` | △ | △ | ? | ? | △ | △ | △/? | ? | ? | ? | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+zte-goform) |
| 中兴（zWRT 接口，G5 / U60 / U50 系列） | `192.168.0.1` | △ | ? | ? | ? | △ | △ | △/? | ? | ? | ? | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+zte-zwrt) |
| 品速 | `192.168.0.1` | △ | ? | ? | ? | △ | △ | △/? | ? | ? | ? | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+pinsu) |
| 通则康威 / ZLT（含联通 VN007） | `192.168.0.1` | △ | △ | ? | ? | △ | △ | △/? | ? | ? | ? | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+tozed) |
| 烽火 | `192.168.8.1` | △ | △ | ? | ? | △ | △ | △/? | ? | ? | ? | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+fiberhome) |
| 鲲鹏无限（NRadio） | `192.168.66.1` | △ | △ | ? | ? | △ | △ | △/? | ? | ? | ? | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+nradio) |
| OpenWrt + 移远 / 广和通模组 | `192.168.1.1` | △ | △ | ? | ? | △ | △ | △/? | ? | ? | ? | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+openwrt) |
<!-- brands:end -->

几个品牌自己的情况：

- **中兴 MC8020、MC888**：这两个型号要先打开路由器的「开发者选项」才能锁频、锁小区。烽燧会在锁定前用同一个管理密码自动完成这一步，并把它记进这次写入的记录。
- **中兴 zWRT（G5、U60、U50 系列）**：只能锁 5G 小区，不能锁 4G 小区。
- **鲲鹏无限**：锁 5G 频段要路由器里的蜂窝模组自己报告 5G 频段设置；不报告的型号只能锁 4G 频段。
- **OpenWrt**：烽燧通过路由器的 ubus 接口向模组发 AT 指令，移远和广和通会自动区分。「重启」重启的是蜂窝模组，不是整台路由器。广和通模组的网络制式只能设成自动或仅 5G SA。
- **通则康威 / ZLT**：部分运营商定制固件给接口加了一层加密，烽燧连不上这类固件。

## 帮忙验证你的路由器

点表里你的型号（或品牌）那一行的「提交报告」，会在 GitHub 打开一个标题已经写好的新 issue。怎么生成设备报告并提交，见[报告兼容性](other-routers.md#report)；也可以让 AI 智能体替你测试并起草报告，见[用 AI 智能体测试](other-routers.md#ai)。有人报告某项功能在真机上可用后，表里那一格就会变成 ○。
