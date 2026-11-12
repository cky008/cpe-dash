---
title: 支持的设备
description: 烽燧在哪台路由器上验证过，接口资料里记录的每个型号在烽燧里能做什么，以及一格怎样变成 ✓。
section: 开始使用
order: 2
---

**烽燧目前仅在华为 H168-383（固件 4.4.0.1）上验证过。** 下面按品牌列出接口资料里记录过的每个型号，以及烽燧在上面能做什么。这些型号都还没有人用烽燧在真机上验证过；烽燧在它们上面实现了的功能直接可用，写操作也默认开着，可以在「设置 → 设备」逐项关闭。

你不用知道自己的路由器走哪套接口：在「设置 → 路由器」把品牌留在「自动识别」，烽燧会先认出品牌再登录。表里没有你的型号也可以试试，同一品牌的型号大多用同一套接口，烽燧按这个品牌的情况工作。烽燧在这些路由器上怎样工作，见[其他型号与品牌](other-routers.md)。控制台的「设置 → 设备」会显示你这台路由器在这张表里的那一行。

想先看看烽燧在没验证过的路由器上的样子，可以打开[在线演示的「其他华为型号」模式](https://cky008.github.io/fengsui-demo/?router=other)。

<!-- devices:begin -->
表里的符号：

- **✓ 已验证**：有人在真机上确认过，并已登记进代码（`VERIFIED_FEATURES`）。H168-383 上除了「电池」、「SIM 卡」、「飞行模式」、「网络制式与选网」、「数据设置」、「USSD」这几列（后来加的：读数和其他型号一样按事实标，新的写入烽燧在它上面还没有做），全部功能都验证过；它换了别的固件也照常工作，只发一次 `FIRMWARE_UNVERIFIED` 提醒。
- **? 等待回报**：烽燧按接口资料实现了，默认开启，还没有人在真机上确认。写入每次只发一次，写后回读核对，可以在「设置 → 设备」逐项关闭。
- **△ 部分支持或有条件**：条件写在各品牌的表下面。
- **— 不支持**：路由器或它的接口没有这项功能（比如室内 CPE 没有电池），或者有人实测过不能用。
- 空白：烽燧还没有做。
- 一格里有几个符号时，依次对应这一列包含的功能：「短信」是读取 / 发送与管理，「重启与重拨」是重启 / 重拨，「路由器开关」是安全开关 / Wi-Fi 7 / 天线，「SIM 卡」是状态 / 切换卡槽 / PIN，「飞行模式」是状态 / 开关，「网络制式与选网」是网络制式 / 手动选网，「数据设置」是数据漫游 / 接入点（APN） / 流量上限 / 清零流量统计。
- 「路由器开关」指安全开关、Wi-Fi 7 和天线，路由器本身有这些功能才谈得上（比如 Wi-Fi 7 要路由器支持 Wi-Fi 7）。
- 「接口」一列有两套时，自动识别选第一套；你也可以在「设置 → 路由器」手动选另一套。

按品牌查看：[华为](#brand-huawei) · [博纬（华为智选）](#brand-brovi) · [鼎桥](#brand-td-tech) · [源 Link](#brand-soyealink) · [中兴](#brand-zte) · [品速](#brand-pinsu) · [通则康威 / ZLT（含联通 VN007）](#brand-tozed) · [烽火](#brand-fiberhome) · [鲲鹏无限（NRadio）](#brand-nradio) · [OpenWrt + 移远 / 广和通模组](#brand-openwrt) · [展锐 / 高通公版方案](#brand-reference) · [D-Link](#brand-dlink) · [TP-Link](#brand-tplink)

<a id="brand-huawei"></a>

## 华为

常见地址 `192.168.8.1`，用管理页的用户名 `admin` 和密码登录。在「设置 → 路由器」把品牌留在「自动识别」，或者选「华为（HiLink，含博纬、鼎桥、源 Link）」。

| 型号 | 形态 | 信号与流量 | 附近的基站 | 已连接设备 | 短信 | 锁频段 | 锁小区 | 重启与重拨 | 移动数据 | 路由器开关 | 访问控制 | 电池 | SIM 卡 | 飞行模式 | 网络制式与选网 | 数据设置 | USSD | 实测反馈 |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :--- |
| H168-383 | 室内 CPE | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — |  |  |  |  |  |  |
| H165-383 | 室内 CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+H165-383) |
| H158-381 | 室内 CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+H158-381) |
| H155-381 | 室内 CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+H155-381) |
| H155-382 | 室内 CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+H155-382) |
| H155-383 | 室内 CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+H155-383) |
| H153-381 | 室内 CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+H153-381) |
| H138-380 | 室内 CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+H138-380) |
| H122-373 | 室内 CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+H122-373) |
| H112-373 | 室内 CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+H112-373) |
| H112-372 | 室内 CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+H112-372) |
| H112-370 | 室内 CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+H112-370) |
| H352-381 | 室外 CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+H352-381) |
| H312-371 | 室外 CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+H312-371) |
| N5368X | 室外 CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+N5368X) |
| B818-263 | 室内 CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B818-263) |
| B818-260 | 室内 CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B818-260) |
| B715s-23c | 室内 CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B715s-23c) |
| B628-265 | 室内 CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B628-265) |
| B628-350 | 室内 CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B628-350) |
| B618s-22d | 室内 CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B618s-22d) |
| B618s-65d | 室内 CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B618s-65d) |
| B612-233 | 室内 CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B612-233) |
| B612s-25d | 室内 CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B612s-25d) |
| B535-836 | 室内 CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B535-836) |
| B535-232 | 室内 CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B535-232) |
| B528s-23a | 室内 CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B528s-23a) |
| B525s-23a | 室内 CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B525s-23a) |
| B525s-65a | 室内 CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B525s-65a) |
| B316-855 | 室内 CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B316-855) |
| B315s-22 | 室内 CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B315s-22) |
| B315s-936 | 室内 CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B315s-936) |
| B311-221 | 室内 CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B311-221) |
| B311-521 | 室内 CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B311-521) |
| B311As-853 | 室内 CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B311As-853) |
| B311B-853 | 室内 CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B311B-853) |
| B310s-22 | 室内 CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B310s-22) |
| B310s-927 | 室内 CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B310s-927) |
| B310As-852 | 室内 CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B310As-852) |
| E5180s-22 | 室内 CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E5180s-22) |
| E5186s-22a | 室内 CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E5186s-22a) |
| E6888-982 | 随身路由器 | ? | △ | ? | ? | △ |  | ? | ? |  |  | ? |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E6888-982) |
| E6878-370 | 随身路由器 | ? | △ | ? | ? | △ |  | ? | ? |  |  | ? |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E6878-370) |
| E6878-870 | 随身路由器 | ? | △ | ? | ? | △ |  | ? | ? |  |  | ? |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E6878-870) |
| E5885Ls-93a | 随身路由器 | ? | △ | ? | ? | △ |  | ? | ? |  |  | ? |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E5885Ls-93a) |
| E5785-320 | 随身路由器 | ? | △ | ? | ? | △ |  | ? | ? |  |  | ? |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E5785-320) |
| E5785Lh-22c | 随身路由器 | ? | △ | ? | ? | △ |  | ? | ? |  |  | ? |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E5785Lh-22c) |
| E5577Cs-321 | 随身路由器 | ? | △ | ? | ? | △ |  | ? | ? |  |  | ? |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E5577Cs-321) |
| E5576-320 | 随身路由器 | ? | △ | ? | ? | △ |  | ? | ? |  |  | ? |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E5576-320) |
| E5576-855 | 随身路由器 | ? | △ | ? | ? | △ |  | ? | ? |  |  | ? |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E5576-855) |
| E5573s-320 | 随身路由器 | ? | △ | ? | ? | △ |  | ? | ? |  |  | ? |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E5573s-320) |
| E8231 | USB 上网卡 | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E8231) |
| E8372h-153 | USB 上网卡 | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E8372h-153) |
| E8372h-320 | USB 上网卡 | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E8372h-320) |
| E8372h-608 | USB 上网卡 | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E8372h-608) |
| E3372 | USB 上网卡 | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E3372) |
| E3372h-153 | USB 上网卡 | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E3372h-153) |
| E3131 | USB 上网卡 | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E3131) |
| E3531 | USB 上网卡 | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E3531) |
| E5530As-2 | USB 上网卡 | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E5530As-2) |

这一节的说明：

- — 「电池」：只有随身路由器有电池（H168-383、H165-383、H158-381、H155-381、H155-382、H155-383、H153-381、H138-380、H122-373、H112-373、H112-372、H112-370、H352-381、H312-371、N5368X、B818-263、B818-260、B715s-23c、B628-265、B628-350、B618s-22d、B618s-65d、B612-233、B612s-25d、B535-836、B535-232、B528s-23a、B525s-23a、B525s-65a、B316-855、B315s-22、B315s-936、B311-221、B311-521、B311As-853、B311B-853、B310s-22、B310s-927、B310As-852、E5180s-22、E5186s-22a、E8231、E8372h-153、E8372h-320、E8372h-608、E3372、E3372h-153、E3131、E3531 和 E5530As-2）。
- △ 「附近的基站」：烽燧读的是 H168-383 的附近基站接口，路由器没有这个接口时这一项是空的（除 H168-383 外的全部型号）。
- △ 「锁频段」：只锁 4G 频段，5G 频段烽燧只在验证过的型号上锁（除 H168-383 外的全部型号）。
- USB 上网卡要在 HiLink 模式（有网页管理界面）下才能连（E8231、E8372h-153、E8372h-320、E8372h-608、E3372、E3372h-153、E3131、E3531 和 E5530As-2）。

<a id="brand-brovi"></a>

## 博纬（华为智选）

常见地址 `192.168.8.1`，用管理页的用户名 `admin` 和密码登录。在「设置 → 路由器」把品牌留在「自动识别」，或者选「华为（HiLink，含博纬、鼎桥、源 Link）」。

| 型号 | 形态 | 信号与流量 | 附近的基站 | 已连接设备 | 短信 | 锁频段 | 锁小区 | 重启与重拨 | 移动数据 | 路由器开关 | 访问控制 | 电池 | SIM 卡 | 飞行模式 | 网络制式与选网 | 数据设置 | USSD | 实测反馈 |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :--- |
| H155-380 | 室内 CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+H155-380) |
| H151-370 | 室内 CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+H151-370) |

这一节的说明：

- △ 「附近的基站」：烽燧读的是 H168-383 的附近基站接口，路由器没有这个接口时这一项是空的（这一节的全部型号）。
- △ 「锁频段」：只锁 4G 频段，5G 频段烽燧只在验证过的型号上锁（这一节的全部型号）。
- — 「电池」：只有随身路由器有电池（这一节的全部型号）。

<a id="brand-td-tech"></a>

## 鼎桥

常见地址 `192.168.8.1`，用管理页的用户名 `admin` 和密码登录。在「设置 → 路由器」把品牌留在「自动识别」，或者选「华为（HiLink，含博纬、鼎桥、源 Link）」。

| 型号 | 形态 | 信号与流量 | 附近的基站 | 已连接设备 | 短信 | 锁频段 | 锁小区 | 重启与重拨 | 移动数据 | 路由器开关 | 访问控制 | 电池 | SIM 卡 | 飞行模式 | 网络制式与选网 | 数据设置 | USSD | 实测反馈 |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :--- |
| MT5710-CN | 工业网关 | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MT5710-CN) |
| MH5000-31 | 工业网关 | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MH5000-31) |
| MH5000-82M | 工业网关 | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MH5000-82M) |
| MT5700M-CN | 模组 | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MT5700M-CN) |

这一节的说明：

- △ 「附近的基站」：烽燧读的是 H168-383 的附近基站接口，路由器没有这个接口时这一项是空的（这一节的全部型号）。
- △ 「锁频段」：只锁 4G 频段，5G 频段烽燧只在验证过的型号上锁（这一节的全部型号）。
- — 「电池」：只有随身路由器有电池（这一节的全部型号）。

<a id="brand-soyealink"></a>

## 源 Link

常见地址 `192.168.8.1`，用管理页的用户名 `admin` 和密码登录。在「设置 → 路由器」把品牌留在「自动识别」，或者选「华为（HiLink，含博纬、鼎桥、源 Link）」。

| 型号 | 形态 | 信号与流量 | 附近的基站 | 已连接设备 | 短信 | 锁频段 | 锁小区 | 重启与重拨 | 移动数据 | 路由器开关 | 访问控制 | 电池 | SIM 卡 | 飞行模式 | 网络制式与选网 | 数据设置 | USSD | 实测反馈 |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :--- |
| B535-333 | 室内 CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B535-333) |
| B535-932 | 室内 CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B535-932) |
| B628-540 | 室内 CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B628-540) |
| SLT869-A51 | 室内 CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+SLT869-A51) |
| SRT873 | 室内 CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+SRT873) |

这一节的说明：

- △ 「附近的基站」：烽燧读的是 H168-383 的附近基站接口，路由器没有这个接口时这一项是空的（这一节的全部型号）。
- △ 「锁频段」：只锁 4G 频段，5G 频段烽燧只在验证过的型号上锁（这一节的全部型号）。
- — 「电池」：只有随身路由器有电池（这一节的全部型号）。

<a id="brands"></a>

<a id="brand-zte"></a>

## 中兴

常见地址 `192.168.0.1`，只用管理密码登录（没有用户名）。在「设置 → 路由器」把品牌留在「自动识别」，或者选「中兴（zWRT 接口，G5 / U60 / U50 系列）」或「中兴（goform 网页接口）」。

| 型号 | 形态 | 接口 | 信号与流量 | 附近的基站 | 已连接设备 | 短信 | 锁频段 | 锁小区 | 重启与重拨 | 移动数据 | 路由器开关 | 访问控制 | 电池 | SIM 卡 | 飞行模式 | 网络制式与选网 | 数据设置 | USSD | 实测反馈 |
| :--- | :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :--- |
| U60 Pro (MU5250) | 随身路由器 | zWRT · goform | ? |  |  | ? | ? | △ | ? | ? |  |  | ? | ? |  | △ | △ |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+U60+Pro+%28MU5250%29) |
| G5 Ultra (MC8530) | 室内 CPE | zWRT · goform | ? |  |  | ? | ? | △ | ? | ? |  |  | — | ? |  | △ | △ |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+G5+Ultra+%28MC8530%29) |
| G5 Ultra (MC8531) | 室内 CPE | zWRT · goform | ? |  |  | ? | ? | △ | ? | ? |  |  | — | ? |  | △ | △ |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+G5+Ultra+%28MC8531%29) |
| G5 Pro (MC8512) | 室内 CPE | zWRT · goform | ? |  |  | ? | ? | △ | ? | ? |  |  | — | ? |  | △ | △ |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+G5+Pro+%28MC8512%29) |
| G5TS (MC8520) | 室内 CPE | zWRT · goform | ? |  |  | ? | ? | △ | ? | ? |  |  | — | ? |  | △ | △ |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+G5TS+%28MC8520%29) |
| G5F | 室内 CPE | zWRT · goform | ? |  |  | ? | ? | △ | ? | ? |  |  | — | ? |  | △ | △ |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+G5F) |
| MC888D | 室内 CPE | zWRT · goform | ? |  |  | ? | ? | △ | ? | ? |  |  | — | ? |  | △ | △ |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MC888D) |
| U50 Pro (MU5120) | 随身路由器 | zWRT · goform | ? |  |  | ? | ? | △ | ? | ? |  |  | ? | ? |  | △ | △ |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+U50+Pro+%28MU5120%29) |
| MC8510 | 室内 CPE | goform | ? | ? | ? | ? | ? | ? | ? | ? |  |  | — | ? |  | △ | △ | ? | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MC8510) |
| G5C | 室内 CPE | goform | ? | ? | ? | ? | ? | ? | ? | ? |  |  | — | ? |  | △ | △ | ? | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+G5C) |
| G5B | 室内 CPE | goform | ? | ? | ? | ? | ? | ? | ? | ? |  |  | — | ? |  | △ | △ | ? | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+G5B) |
| MC888 Ultra | 室内 CPE | goform | ? | ? | ? | ? | △ | △ | ? | ? |  |  | — | ? |  | △ | △ | ? | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MC888+Ultra) |
| MC888 Pro | 室内 CPE | goform | ? | ? | ? | ? | △ | △ | ? | ? |  |  | — | ? |  | △ | △ | ? | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MC888+Pro) |
| MC888 | 室内 CPE | goform | ? | ? | ? | ? | △ | △ | ? | ? |  |  | — | ? |  | △ | △ | ? | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MC888) |
| MC888S | 室内 CPE | goform | ? | ? | ? | ? | △ | △ | ? | ? |  |  | — | ? |  | △ | △ | ? | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MC888S) |
| MC8020 | 室内 CPE | goform | ? | ? | ? | ? | △ | △ | ? | ? |  |  | — | ? |  | △ | △ | ? | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MC8020) |
| MC801A | 室内 CPE | goform | ? | ? | ? | ? | ? | ? | ? | ? |  |  | — | ? |  | △ | △ | ? | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MC801A) |
| MC801A1 | 室内 CPE | goform | ? | ? | ? | ? | ? | ? | ? | ? |  |  | — | ? |  | △ | △ | ? | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MC801A1) |
| MC801 | 室内 CPE | goform | ? | ? | ? | ? | ? | ? | ? | ? |  |  | — | ? |  | △ | △ | ? | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MC801) |
| MC889 Pro | 室外 CPE | goform | ? | ? | ? | ? | ? | ? | ? | ? |  |  | — | ? |  | △ | △ | ? | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MC889+Pro) |
| MC889A Pro | 室外 CPE | goform | ? | ? | ? | ? | ? | ? | ? | ? |  |  | — | ? |  | △ | △ | ? | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MC889A+Pro) |
| MC889 | 室外 CPE | goform | ? | ? | ? | ? | ? | ? | ? | ? |  |  | — | ? |  | △ | △ | ? | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MC889) |
| MC7010 | 室外 CPE | goform | ? | ? | ? | ? | ? | ? | ? | ? |  |  | — | ? |  | △ | △ | ? | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MC7010) |
| MC7010D | 室外 CPE | goform | ? | ? | ? | ? | ? | ? | ? | ? |  |  | — | ? |  | △ | △ | ? | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MC7010D) |
| MC8830 | 工业网关 | goform | ? | ? | ? | ? | △ | △ | ? | ? |  |  | — | ? |  | △ | △ | ? | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MC8830) |
| MU5001 | 随身路由器 | goform | ? | ? | ? | ? | ? | ? | ? | ? |  |  | ? | ? |  | △ | △ | ? | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MU5001) |
| MU5001A | 随身路由器 | goform | ? | ? | ? | ? | ? | ? | ? | ? |  |  | ? | ? |  | △ | △ | ? | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MU5001A) |
| MU5001U | 随身路由器 | goform | ? | ? | ? | ? | ? | ? | ? | ? |  |  | ? | ? |  | △ | △ | ? | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MU5001U) |
| MU5002 | 随身路由器 | goform | ? | ? | ? | ? | ? | ? | ? | ? |  |  | ? | ? |  | △ | △ | ? | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MU5002) |
| MU510 | 随身路由器 | goform | ? | ? | ? | ? | ? | ? | ? | ? |  |  | ? | ? |  | △ | △ | ? | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MU510) |
| U50 | 随身路由器 | goform | ? | ? | ? | ? | ? | ? | ? | ? |  |  | ? | ? |  | △ | △ | ? | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+U50) |
| U50S | 随身路由器 | goform | ? | ? | ? | ? | ? | ? | ? | ? |  |  | ? | ? |  | △ | △ | ? | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+U50S) |
| U30 Air | 随身路由器 | goform | ? | ? | ? | ? | ? | ? | ? | ? |  |  | ? | ? |  | △ | △ | ? | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+U30+Air) |
| U10S Pro | 随身路由器 | goform | ? | ? | ? | ? | ? | ? | ? | ? |  |  | ? | ? |  | △ | △ | ? | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+U10S+Pro) |
| F50 Pro | 随身路由器 | goform | ? | ? | ? | ? | △ | △ | ? | ? |  |  | ? | ? |  | △ | △ | ? | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+F50+Pro) |
| F50 | 随身路由器 | goform | ? | ? | ? | ? | △ | △ | ? | ? |  |  | ? | ? |  | △ | △ | ? | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+F50) |
| MF971R | 随身路由器 | goform | ? | ? | ? | ? | ? | ? | ? | ? |  |  | ? | ? |  | △ | △ | ? | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MF971R) |
| MF935 | 随身路由器 | goform | ? | ? | ? | ? | ? | ? | ? | ? |  |  | ? | ? |  | △ | △ | ? | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MF935) |
| MF920U | 随身路由器 | goform | ? | ? | ? | ? | ? | ? | ? | ? |  |  | ? | ? |  | △ | △ | ? | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MF920U) |
| MF79U | USB 上网卡 | goform | ? | ? | ? | ? | △ | △ | ? | ? |  |  | — | ? |  | △ | △ | ? | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MF79U) |
| MF297D | 室内 CPE | goform | ? | ? | ? | ? | ? | ? | ? | ? |  |  | — | ? |  | △ | △ | ? | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MF297D) |
| MF289F | 室内 CPE | goform | ? | ? | ? | ? | ? | ? | ? | ? |  |  | — | ? |  | △ | △ | ? | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MF289F) |
| MF286 | 室内 CPE | goform | ? | ? | ? | ? | ? | ? | ? | ? |  |  | — | ? |  | △ | △ | ? | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MF286) |
| MF286A | 室内 CPE | goform | ? | ? | ? | ? | ? | ? | ? | ? |  |  | — | ? |  | △ | △ | ? | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MF286A) |
| MF286C | 室内 CPE | goform | ? | ? | ? | ? | ? | ? | ? | ? |  |  | — | ? |  | △ | △ | ? | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MF286C) |
| MF286D | 室内 CPE | goform | ? | ? | ? | ? | ? | ? | ? | ? |  |  | — | ? |  | △ | △ | ? | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MF286D) |
| MF286R | 室内 CPE | goform | ? | ? | ? | ? | ? | ? | ? | ? |  |  | — | ? |  | △ | △ | ? | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MF286R) |
| MF283+ | 室内 CPE | goform | ? | ? | ? | ? | ? | ? | ? | ? |  |  | — | ? |  | △ | △ | ? | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MF283%2B) |
| MF283U | 室内 CPE | goform | ? | ? | ? | ? | ? | ? | ? | ? |  |  | — | ? |  | △ | △ | ? | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MF283U) |
| MF253S | 室内 CPE | goform | ? | ? | ? | ? | ? | ? | ? | ? |  |  | — | ? |  | △ | △ | ? | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MF253S) |

这一节的说明：

- △ 「锁小区」：只能锁 5G 小区，不能锁 4G 小区（U60 Pro (MU5250)、G5 Ultra (MC8530)、G5 Ultra (MC8531)、G5 Pro (MC8512)、G5TS (MC8520)、G5F、MC888D 和 U50 Pro (MU5120)）。
- △ 「网络制式与选网」：只有网络制式，手动选网烽燧在这里还没有做（这一节的全部型号）。
- △ 「数据设置」：只有数据漫游和流量上限，接入点（APN）和清零流量统计烽燧在这里还没有做（这一节的全部型号）。
- 短信读写的是路由器自己的存储，存在 SIM 卡上的短信不显示（这一节的全部型号）。
- — 「电池」：只有随身路由器有电池（G5 Ultra (MC8530)、G5 Ultra (MC8531)、G5 Pro (MC8512)、G5TS (MC8520)、G5F、MC888D、MC8510、G5C、G5B、MC888 Ultra、MC888 Pro、MC888、MC888S、MC8020、MC801A、MC801A1、MC801、MC889 Pro、MC889A Pro、MC889、MC7010、MC7010D、MC8830、MF79U、MF297D、MF289F、MF286、MF286A、MF286C、MF286D、MF286R、MF283+、MF283U 和 MF253S）。
- △ 「锁频段」、「锁小区」：锁定前，烽燧会先用同一个管理密码打开路由器的开发者选项，并在这次写入的记录里写明（MC888 Ultra、MC888 Pro、MC888、MC888S、MC8020、MC8830、F50 Pro、F50 和 MF79U）。

<a id="brand-pinsu"></a>

## 品速

常见地址 `192.168.0.1`，用管理页的用户名 `admin` 和密码登录。在「设置 → 路由器」把品牌留在「自动识别」，或者选「品速」。

| 型号 | 形态 | 信号与流量 | 附近的基站 | 已连接设备 | 短信 | 锁频段 | 锁小区 | 重启与重拨 | 移动数据 | 路由器开关 | 访问控制 | 电池 | SIM 卡 | 飞行模式 | 网络制式与选网 | 数据设置 | USSD | 实测反馈 |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :--- |
| R200C | 室内 CPE | ? |  |  |  | ? | ? | △ |  |  |  |  |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+R200C) |
| R200 | 室内 CPE | ? |  |  |  | ? | ? | △ |  |  |  |  |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+R200) |
| R200P | 室内 CPE | ? |  |  |  | ? | ? | △ |  |  |  |  |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+R200P) |
| R100 | 室内 CPE | ? |  |  |  | ? | ? | △ |  |  |  |  |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+R100) |
| PS-R500 | 室内 CPE | ? |  |  |  | ? | ? | △ |  |  |  |  |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+PS-R500) |
| PS-R600 | 室内 CPE | ? |  |  |  | ? | ? | △ |  |  |  |  |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+PS-R600) |
| U200 | 随身路由器 | ? |  |  |  | ? | ? | △ |  |  |  |  |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+U200) |
| M1 | 随身路由器 | ? |  |  |  | ? | ? | △ |  |  |  |  |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+M1) |
| M200 | 随身路由器 | ? |  |  |  | ? | ? | △ |  |  |  |  |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+M200) |
| M200 Pro | 随身路由器 | ? |  |  |  | ? | ? | △ |  |  |  |  |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+M200+Pro) |
| PS-M50 | 随身路由器 | ? |  |  |  | ? | ? | △ |  |  |  |  |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+PS-M50) |
| F10 | 随身路由器 | ? |  |  |  | ? | ? | △ |  |  |  |  |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+F10) |

这一节的说明：

- △ 「重启与重拨」：只有重启，重拨烽燧在这里还没有做（这一节的全部型号）。

<a id="brand-tozed"></a>

## 通则康威 / ZLT（含联通 VN007）

常见地址 `192.168.0.1`，用管理页的用户名和密码登录。在「设置 → 路由器」把品牌留在「自动识别」，或者选「通则康威 / ZLT（含联通 VN007）」或「中兴（goform 网页接口）」。

| 型号 | 形态 | 接口 | 信号与流量 | 附近的基站 | 已连接设备 | 短信 | 锁频段 | 锁小区 | 重启与重拨 | 移动数据 | 路由器开关 | 访问控制 | 电池 | SIM 卡 | 飞行模式 | 网络制式与选网 | 数据设置 | USSD | 实测反馈 |
| :--- | :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :--- |
| VN007 | 室内 CPE | 通则康威 | ? | ? |  | ?/△ | ? | ? | △ |  |  |  |  |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+VN007) |
| VN007+ | 室内 CPE | 通则康威 | ? | ? |  | ?/△ | ? | ? | △ |  |  |  |  |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+VN007%2B) |
| VN009 | 室内 CPE | 通则康威 | ? | ? |  | ?/△ | ? | ? | △ |  |  |  |  |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+VN009) |
| ZLT X20 | 室内 CPE | 通则康威 | ? | ? |  | ?/△ | ? | ? | △ |  |  |  |  |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+ZLT+X20) |
| ZLT X21 | 室内 CPE | 通则康威 | ? | ? |  | ?/△ | ? | ? | △ |  |  |  |  |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+ZLT+X21) |
| ZLT X21G | 室内 CPE | 通则康威 | ? | ? |  | ?/△ | ? | ? | △ |  |  |  |  |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+ZLT+X21G) |
| ZLT X25 | 室内 CPE | 通则康威 | ? | ? |  | ?/△ | ? | ? | △ |  |  |  |  |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+ZLT+X25) |
| ZLT X28 | 室内 CPE | 通则康威 | ? | ? |  | ?/△ | ? | ? | △ |  |  |  |  |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+ZLT+X28) |
| ZLT X28 Pro | 室内 CPE | 通则康威 | ? | ? |  | ?/△ | ? | ? | △ |  |  |  |  |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+ZLT+X28+Pro) |
| ZLT X30 | 室内 CPE | 通则康威 | ? | ? |  | ?/△ | ? | ? | △ |  |  |  |  |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+ZLT+X30) |
| ZLT X100 | 室内 CPE | 通则康威 | ? | ? |  | ?/△ | ? | ? | △ |  |  |  |  |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+ZLT+X100) |
| ZLT X300M | 室内 CPE | 通则康威 | ? | ? |  | ?/△ | ? | ? | △ |  |  |  |  |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+ZLT+X300M) |
| LT500 | 室内 CPE | 通则康威 | ? | ? |  | ?/△ | ? | ? | △ |  |  |  |  |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+LT500) |
| ZLT S10 | 室内 CPE | 通则康威 | ? | ? |  | ?/△ | ? | ? | △ |  |  |  |  |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+ZLT+S10) |
| ZLT S10G | 室内 CPE | 通则康威 | ? | ? |  | ?/△ | ? | ? | △ |  |  |  |  |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+ZLT+S10G) |
| ZLT S12 Pro | 室内 CPE | 通则康威 | ? | ? |  | ?/△ | ? | ? | △ |  |  |  |  |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+ZLT+S12+Pro) |
| ZLT S20 | 室内 CPE | 通则康威 | ? | ? |  | ?/△ | ? | ? | △ |  |  |  |  |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+ZLT+S20) |
| ZLT S25 | 室内 CPE | 通则康威 | ? | ? |  | ?/△ | ? | ? | △ |  |  |  |  |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+ZLT+S25) |
| ZLT S50 | 室内 CPE | 通则康威 | ? | ? |  | ?/△ | ? | ? | △ |  |  |  |  |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+ZLT+S50) |
| ZLT X11 | 室外 CPE | 通则康威 | ? | ? |  | ?/△ | ? | ? | △ |  |  |  |  |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+ZLT+X11) |
| ZLT P11 | 室外 CPE | 通则康威 | ? | ? |  | ?/△ | ? | ? | △ |  |  |  |  |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+ZLT+P11) |
| ZLT P28 | 室外 CPE | 通则康威 | ? | ? |  | ?/△ | ? | ? | △ |  |  |  |  |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+ZLT+P28) |
| ZLT T30 | 室外 CPE | 通则康威 | ? | ? |  | ?/△ | ? | ? | △ |  |  |  |  |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+ZLT+T30) |
| ZLT T20 | 工业网关 | 通则康威 | ? | ? |  | ?/△ | ? | ? | △ |  |  |  |  |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+ZLT+T20) |
| MP510 | 工业网关 | 通则康威 | ? | ? |  | ?/△ | ? | ? | △ |  |  |  |  |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MP510) |
| ZLT M30S | 随身路由器 | 通则康威 · goform | ? | ? |  | ?/△ | ? | ? | △ |  |  |  |  |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+ZLT+M30S) |
| ZLT M60 | 随身路由器 | 通则康威 | ? | ? |  | ?/△ | ? | ? | △ |  |  |  |  |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+ZLT+M60) |
| ZLT T10D MAX | 室内 CPE | goform | ? | ? | ? | ? | △ | △ | ? | ? |  |  | — | ? |  | △ | △ | ? | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+ZLT+T10D+MAX) |

这一节的说明：

- △ 「短信」：能发送短信；路由器的接口资料里没有删除短信和标为已读的指令，这两项烽燧在这里不能做（除 ZLT T10D MAX 外的全部型号）。
- △ 「重启与重拨」：只有重启，重拨烽燧在这里还没有做（除 ZLT T10D MAX 外的全部型号）。
- 哪些短信没读过由烽燧自己记（路由器上的未读标记烽燧改不了）（除 ZLT T10D MAX 外的全部型号）。
- 有些运营商定制固件给接口加了一层加密，烽燧连不上这样的固件（除 ZLT T10D MAX 外的全部型号）。
- △ 「锁频段」、「锁小区」：这类 4G 固件的接口资料里没有锁频段和锁小区的指令，烽燧发的是中兴 goform 页面的写法，路由器不一定接受；网络制式只能设成自动或仅 4G（ZLT T10D MAX）。
- — 「电池」：只有随身路由器有电池（ZLT T10D MAX）。
- △ 「网络制式与选网」：只有网络制式，手动选网烽燧在这里还没有做（ZLT T10D MAX）。
- △ 「数据设置」：只有数据漫游和流量上限，接入点（APN）和清零流量统计烽燧在这里还没有做（ZLT T10D MAX）。
- 短信读写的是路由器自己的存储，存在 SIM 卡上的短信不显示（ZLT T10D MAX）。
- 这是中兴芯片平台的 4G 路由器，用的是中兴接口的另一种写法（`/reqproc/`），连接时烽燧会自己认出来（ZLT T10D MAX）。

<a id="brand-fiberhome"></a>

## 烽火

常见地址 `192.168.8.1`，用管理页的用户名 `admin` 和密码登录。在「设置 → 路由器」把品牌留在「自动识别」，或者选「烽火」。

| 型号 | 形态 | 信号与流量 | 附近的基站 | 已连接设备 | 短信 | 锁频段 | 锁小区 | 重启与重拨 | 移动数据 | 路由器开关 | 访问控制 | 电池 | SIM 卡 | 飞行模式 | 网络制式与选网 | 数据设置 | USSD | 实测反馈 |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :--- |
| LG6121F | 室内 CPE | ? | ? |  | △ | ? | ? | △ |  |  |  |  |  | △ |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+LG6121F) |
| LG6151M | 室内 CPE | ? | ? |  | △ | ? | ? | △ |  |  |  |  |  | △ |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+LG6151M) |
| LG6121 | 室内 CPE | ? | ? |  | △ | ? | ? | △ |  |  |  |  |  | △ |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+LG6121) |
| LG522 | 室内 CPE | ? | ? |  | △ | ? | ? | △ |  |  |  |  |  | △ |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+LG522) |
| LG6851F | 室内 CPE | △ |  |  | ?/△ |  |  |  |  |  |  |  |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+LG6851F) |

这一节的说明：

- △ 「短信」：短信走的是路由器网页自己的加密接口，烽燧用它已经登录的会话去读；路由器要求另外登录网页才给读时，这一项是空的（除 LG6851F 外的全部型号）。
- △ 「短信」：发送只接受英文字母、数字和常用标点（接口资料里只有这一种编码），并且不发送含 ` $ " \ 的正文：路由器会把正文交给命令行；删除只能整段对话一起删（除 LG6851F 外的全部型号）。
- △ 「重启与重拨」：只有重启，重拨烽燧在这里还没有做（除 LG6851F 外的全部型号）。
- △ 「飞行模式」：只有状态，开关烽燧在这里还没有做（除 LG6851F 外的全部型号）。
- △ 「信号与流量」：烽燧用路由器下发的令牌（用这个系列固件里固定的私钥解开）或资料里记的令牌打开路由器的加密应答；两者都打不开时，烽燧不发送密码，信号这一项是空的（LG6851F）。
- △ 「短信」：只能标为已读：这类固件的接口资料里没有发送和删除短信的写法（LG6851F）。
- 这是烽火的 Pro 系列：同一套网页接口换了路径（`/fh_api/`）和加密密钥，连接时烽燧会自己认出来。烽燧在它上面读信号（只有一个服务小区）、本月流量和短信，能把短信标为已读；附近的基站、锁频段、锁小区和重启在它的接口资料里没有，烽燧在这里不做（LG6851F）。

<a id="brand-nradio"></a>

## 鲲鹏无限（NRadio）

常见地址 `192.168.66.1`，用管理页的用户名 `root` 和密码登录。在「设置 → 路由器」把品牌留在「自动识别」，或者选「鲲鹏无限（NRadio）」。

| 型号 | 形态 | 信号与流量 | 附近的基站 | 已连接设备 | 短信 | 锁频段 | 锁小区 | 重启与重拨 | 移动数据 | 路由器开关 | 访问控制 | 电池 | SIM 卡 | 飞行模式 | 网络制式与选网 | 数据设置 | USSD | 实测反馈 |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :--- |
| C8-668GL | 室内 CPE | ? | ? | ? |  | △ | ? | ? | ? | △ |  |  |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+C8-668GL) |
| C8-660 | 室内 CPE | ? | ? | ? |  | △ | ? | ? | ? | △ |  |  |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+C8-660) |
| C8-620 | 室内 CPE | ? | ? | ? |  | △ | ? | ? | ? | △ |  |  |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+C8-620) |
| C8-520 | 室内 CPE | ? | ? | ? |  | △ | ? | ? | ? | △ |  |  |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+C8-520) |
| C8-500 | 室内 CPE | ? | ? | ? |  | △ | ? | ? | ? | △ |  |  |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+C8-500) |
| C5800-500 | 室内 CPE | ? | ? | ? |  | △ | ? | ? | ? | △ |  |  |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+C5800-500) |
| C2000 Ultra | 室内 CPE | ? | ? | ? |  | △ | ? | ? | ? | △ |  |  |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+C2000+Ultra) |
| C2000 Max | 室内 CPE | ? | ? | ? |  | △ | ? | ? | ? | △ |  |  |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+C2000+Max) |
| C2000 Pro | 室内 CPE | ? | ? | ? |  | △ | ? | ? | ? | △ |  |  |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+C2000+Pro) |
| C2000 | 室内 CPE | ? | ? | ? |  | △ | ? | ? | ? | △ |  |  |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+C2000) |
| C3000 | 工业网关 | ? | ? | ? |  | △ | ? | ? | ? | △ |  |  |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+C3000) |
| C5000 | 工业网关 | ? | ? | ? |  | △ | ? | ? | ? | △ |  |  |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+C5000) |
| C5200 | 工业网关 | ? | ? | ? |  | △ | ? | ? | ? | △ |  |  |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+C5200) |
| C9100 | 室外 CPE | ? | ? | ? |  | △ | ? | ? | ? | △ |  |  |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+C9100) |

这一节的说明：

- △ 「锁频段」：锁 5G 频段要路由器的蜂窝模组报告它的 5G 频段设置，不报告的型号只能锁 4G 频段（这一节的全部型号）。
- △ 「路由器开关」：只有天线，安全开关和 Wi-Fi 7烽燧在这里还没有做（这一节的全部型号）。

<a id="brand-openwrt"></a>

## OpenWrt + 移远 / 广和通模组

常见地址 `192.168.1.1`，用管理页的用户名 `root` 和密码登录。在「设置 → 路由器」把品牌留在「自动识别」，或者选「OpenWrt + 移远 / 广和通模组」。

| 型号 | 形态 | 信号与流量 | 附近的基站 | 已连接设备 | 短信 | 锁频段 | 锁小区 | 重启与重拨 | 移动数据 | 路由器开关 | 访问控制 | 电池 | SIM 卡 | 飞行模式 | 网络制式与选网 | 数据设置 | USSD | 实测反馈 |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :--- |
| Quectel RM551E-GL | 模组 | ? | ? | ? | ?/△ | ? | ? | △ | △ |  |  |  | △ | △ |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Quectel+RM551E-GL) |
| Quectel RM530N-GL | 模组 | ? | ? | ? | ?/△ | ? | ? | △ | △ |  |  |  | △ | △ |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Quectel+RM530N-GL) |
| Quectel RM520N-GL | 模组 | ? | ? | ? | ?/△ | ? | ? | △ | △ |  |  |  | △ | △ |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Quectel+RM520N-GL) |
| Quectel RM520N-CN | 模组 | ? | ? | ? | ?/△ | ? | ? | △ | △ |  |  |  | △ | △ |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Quectel+RM520N-CN) |
| Quectel RM521F-GL | 模组 | ? | ? | ? | ?/△ | ? | ? | △ | △ |  |  |  | △ | △ |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Quectel+RM521F-GL) |
| Quectel RM510Q-GL | 模组 | ? | ? | ? | ?/△ | ? | ? | △ | △ |  |  |  | △ | △ |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Quectel+RM510Q-GL) |
| Quectel RM505Q-AE | 模组 | ? | ? | ? | ?/△ | ? | ? | △ | △ |  |  |  | △ | △ |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Quectel+RM505Q-AE) |
| Quectel RM502Q-AE | 模组 | ? | ? | ? | ?/△ | ? | ? | △ | △ |  |  |  | △ | △ |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Quectel+RM502Q-AE) |
| Quectel RM502Q-GL | 模组 | ? | ? | ? | ?/△ | ? | ? | △ | △ |  |  |  | △ | △ |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Quectel+RM502Q-GL) |
| Quectel RM500Q-GL | 模组 | ? | ? | ? | ?/△ | ? | ? | △ | △ |  |  |  | △ | △ |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Quectel+RM500Q-GL) |
| Quectel RM500Q-AE | 模组 | ? | ? | ? | ?/△ | ? | ? | △ | △ |  |  |  | △ | △ |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Quectel+RM500Q-AE) |
| Quectel RM500U-CN | 模组 | ? | ? | ? | ?/△ | ? | ? | △ | △ |  |  |  | △ | △ |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Quectel+RM500U-CN) |
| Quectel RG650E | 模组 | ? | ? | ? | ?/△ | ? | ? | △ | △ |  |  |  | △ | △ |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Quectel+RG650E) |
| Quectel RG650V | 模组 | ? | ? | ? | ?/△ | ? | ? | △ | △ |  |  |  | △ | △ |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Quectel+RG650V) |
| Quectel RG520N-EU | 模组 | ? | ? | ? | ?/△ | ? | ? | △ | △ |  |  |  | △ | △ |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Quectel+RG520N-EU) |
| Quectel RG520N-EB | 模组 | ? | ? | ? | ?/△ | ? | ? | △ | △ |  |  |  | △ | △ |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Quectel+RG520N-EB) |
| Quectel RG520N-CN | 模组 | ? | ? | ? | ?/△ | ? | ? | △ | △ |  |  |  | △ | △ |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Quectel+RG520N-CN) |
| Quectel RG502Q-EA | 模组 | ? | ? | ? | ?/△ | ? | ? | △ | △ |  |  |  | △ | △ |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Quectel+RG502Q-EA) |
| Quectel RG501Q-EU | 模组 | ? | ? | ? | ?/△ | ? | ? | △ | △ |  |  |  | △ | △ |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Quectel+RG501Q-EU) |
| Quectel RG500Q-EA | 模组 | ? | ? | ? | ?/△ | ? | ? | △ | △ |  |  |  | △ | △ |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Quectel+RG500Q-EA) |
| Quectel RG500Q-CN | 模组 | ? | ? | ? | ?/△ | ? | ? | △ | △ |  |  |  | △ | △ |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Quectel+RG500Q-CN) |
| Quectel RG500U-CN | 模组 | ? | ? | ? | ?/△ | ? | ? | △ | △ |  |  |  | △ | △ |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Quectel+RG500U-CN) |
| Quectel RG200U-CN | 模组 | ? | ? | ? | ?/△ | ? | ? | △ | △ |  |  |  | △ | △ |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Quectel+RG200U-CN) |
| Quectel EM160R-GL | 模组 | ? | ? | ? | ?/△ | ? | ? | △ | △ |  |  |  | △ | △ |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Quectel+EM160R-GL) |
| Quectel EM12-G | 模组 | ? | ? | ? | ?/△ | ? | ? | △ | △ |  |  |  | △ | △ |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Quectel+EM12-G) |
| Quectel EC25 | 模组 | ? | ? | ? | ?/△ | ? | ? | △ | △ |  |  |  | △ | △ |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Quectel+EC25) |
| Quectel EC200U | 模组 | ? | ? | ? | ?/△ | ? | ? | △ | △ |  |  |  | △ | △ |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Quectel+EC200U) |
| Fibocom FG370 | 模组 | ? | ? | ? | ?/△ | △ | ? | △ | △ |  |  |  | △ | △ |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Fibocom+FG370) |
| Fibocom FG370-NA | 模组 | ? | ? | ? | ?/△ | △ | ? | △ | △ |  |  |  | △ | △ |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Fibocom+FG370-NA) |
| Fibocom FM350-GL | 模组 | ? | ? | ? | ?/△ | △ | ? | △ | △ |  |  |  | △ | △ |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Fibocom+FM350-GL) |
| Fibocom FM160-CN | 模组 | ? | ? | ? | ?/△ | △ | ? | △ | △ |  |  |  | △ | △ |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Fibocom+FM160-CN) |
| Fibocom FM160-EAU | 模组 | ? | ? | ? | ?/△ | △ | ? | △ | △ |  |  |  | △ | △ |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Fibocom+FM160-EAU) |
| Fibocom FG160-EAU | 模组 | ? | ? | ? | ?/△ | △ | ? | △ | △ |  |  |  | △ | △ |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Fibocom+FG160-EAU) |
| Fibocom FM150-AE | 模组 | ? | ? | ? | ?/△ | △ | ? | △ | △ |  |  |  | △ | △ |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Fibocom+FM150-AE) |
| Fibocom FG150-AE | 模组 | ? | ? | ? | ?/△ | △ | ? | △ | △ |  |  |  | △ | △ |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Fibocom+FG150-AE) |
| Fibocom FM650-CN | 模组 | ? | ? | ? | ?/△ | △ | ? | △ | △ |  |  |  | △ | △ |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Fibocom+FM650-CN) |
| Fibocom L860-GL | 模组 | ? | ? | ? | ?/△ | △ | ? | △ | △ |  |  |  | △ | △ |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Fibocom+L860-GL) |
| Fibocom L850-GL | 模组 | ? | ? | ? | ?/△ | △ | ? | △ | △ |  |  |  | △ | △ |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Fibocom+L850-GL) |
| GL.iNet GL-X3000 | 室内 CPE | ? | ? | ? | ?/△ | ? | ? | △ | △ |  |  |  | △ | △ |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+GL.iNet+GL-X3000) |
| GL.iNet GL-XE3000 | 随身路由器 | ? | ? | ? | ?/△ | ? | ? | △ | △ |  |  |  | △ | △ |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+GL.iNet+GL-XE3000) |
| GL.iNet GL-X750V2 | 室内 CPE | ? | ? | ? | ?/△ | ? | ? | △ | △ |  |  |  | △ | △ |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+GL.iNet+GL-X750V2) |
| GL.iNet GL-XE300 | 随身路由器 | ? | ? | ? | ?/△ | ? | ? | △ | △ |  |  |  | △ | △ |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+GL.iNet+GL-XE300) |
| Suncomm O1 | 室内 CPE | ? | ? | ? | ?/△ | ? | ? | △ | △ |  |  |  | △ | △ |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Suncomm+O1) |
| Suncomm O2 | 室内 CPE | ? | ? | ? | ?/△ | ? | ? | △ | △ |  |  |  | △ | △ |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Suncomm+O2) |
| Suncomm O8 Pro | 室内 CPE | ? | ? | ? | ?/△ | ? | ? | △ | △ |  |  |  | △ | △ |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Suncomm+O8+Pro) |
| Kunlun CP520 | 室内 CPE | ? | ? | ? | ?/△ | ? | ? | △ | △ |  |  |  | △ | △ |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Kunlun+CP520) |
| Kunlun OpenWrt 5G CPE | 室内 CPE | ? | ? | ? | ?/△ | ? | ? | △ | △ |  |  |  | △ | △ |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Kunlun+OpenWrt+5G+CPE) |
| Zhilian OpenWrt 5G CPE | 室内 CPE | ? | ? | ? | ?/△ | ? | ? | △ | △ |  |  |  | △ | △ |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Zhilian+OpenWrt+5G+CPE) |
| Trend-Link OpenWrt 5G CPE | 室内 CPE | ? | ? | ? | ?/△ | ? | ? | △ | △ |  |  |  | △ | △ |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Trend-Link+OpenWrt+5G+CPE) |
| QWRT RM520N | 室内 CPE | ? | ? | ? | ?/△ | ? | ? | △ | △ |  |  |  | △ | △ |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+QWRT+RM520N) |
| ROOter 5G | 室内 CPE | ? | ? | ? | ?/△ | ? | ? | △ | △ |  |  |  | △ | △ |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+ROOter+5G) |

这一节的说明：

- △ 「短信」：发送短信要路由器装有 QModem；没有装的固件上，烽燧能读取和删除短信，不能发送（这一节的全部型号）。
- △ 「重启与重拨」：「重启」只重启蜂窝模组，不重启整台路由器（这一节的全部型号）。
- △ 「重启与重拨」、「移动数据」：重拨和移动数据开关用的是 QModem 自己的拨号接口，要路由器装有 QModem；没有装的固件上烽燧不发任何拨号指令（这一节的全部型号）。
- △ 「SIM 卡」：PIN 和 PUK 的剩余次数只有移远模组报告（`AT+QPINC`）；广和通模组只报告卡是否可用（这一节的全部型号）。
- △ 「SIM 卡」：只有状态，切换卡槽和 PIN烽燧在这里还没有做（这一节的全部型号）。
- △ 「飞行模式」：只有状态，开关烽燧在这里还没有做（这一节的全部型号）。
- 短信读的是蜂窝模组当前选用的存储（SIM 卡或模组自身）。模组一列出短信就把它记成已读，所以哪些短信没读过由烽燧自己记；模组不保存发出的短信，发件只留在烽燧里（这一节的全部型号）。
- 烽燧通过路由器的 ubus 接口给模组发 AT 指令，自己分辨移远和广和通（这一节的全部型号）。
- △ 「锁频段」：广和通模组的网络制式只能设成自动或仅 5G 独立组网（SA）（Fibocom FG370、Fibocom FG370-NA、Fibocom FM350-GL、Fibocom FM160-CN、Fibocom FM160-EAU、Fibocom FG160-EAU、Fibocom FM150-AE、Fibocom FG150-AE、Fibocom FM650-CN、Fibocom L860-GL 和 Fibocom L850-GL）。

<a id="brand-reference"></a>

## 展锐 / 高通公版方案

常见地址 `192.168.0.1`，用管理页的用户名 `admin` 和密码登录。在「设置 → 路由器」把品牌留在「自动识别」，或者选「通则康威 / ZLT（含联通 VN007）」或「品速」。

| 型号 | 形态 | 接口 | 信号与流量 | 附近的基站 | 已连接设备 | 短信 | 锁频段 | 锁小区 | 重启与重拨 | 移动数据 | 路由器开关 | 访问控制 | 电池 | SIM 卡 | 飞行模式 | 网络制式与选网 | 数据设置 | USSD | 实测反馈 |
| :--- | :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :--- |
| UNISOC V510 mgdb | 室内 CPE | 品速 | ? |  |  |  | ? | ? | △ |  |  |  |  |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+UNISOC+V510+mgdb) |
| SRT838 | 室内 CPE | 通则康威 | ? | ? |  | ?/△ | ? | ? | △ |  |  |  |  |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+SRT838) |
| SRT853 | 室内 CPE | 通则康威 | ? | ? |  | ?/△ | ? | ? | △ |  |  |  |  |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+SRT853) |
| CPE905 | 室内 CPE | 通则康威 | ? | ? |  | ?/△ | ? | ? | △ |  |  |  |  |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+CPE905) |
| FNR310 | 室内 CPE | 通则康威 | ? | ? |  | ?/△ | ? | ? | △ |  |  |  |  |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+FNR310) |
| A50 | 室内 CPE | 通则康威 | ? | ? |  | ?/△ | ? | ? | △ |  |  |  |  |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+A50) |
| H80 | 室内 CPE | 通则康威 | ? | ? |  | ?/△ | ? | ? | △ |  |  |  |  |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+H80) |
| T1 | 室内 CPE | 通则康威 | ? | ? |  | ?/△ | ? | ? | △ |  |  |  |  |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+T1) |

这一节的说明：

- △ 「重启与重拨」：只有重启，重拨烽燧在这里还没有做（这一节的全部型号）。
- △ 「短信」：能发送短信；路由器的接口资料里没有删除短信和标为已读的指令，这两项烽燧在这里不能做（除 UNISOC V510 mgdb 外的全部型号）。
- 哪些短信没读过由烽燧自己记（路由器上的未读标记烽燧改不了）（除 UNISOC V510 mgdb 外的全部型号）。
- 有些运营商定制固件给接口加了一层加密，烽燧连不上这样的固件（除 UNISOC V510 mgdb 外的全部型号）。
- 资料说这些机型用通则康威那套 `/cgi-bin/http.cgi` 接口，或者 `/cgi-bin/lua.cgi` 的变体；烽燧只实现了前一种（除 UNISOC V510 mgdb 外的全部型号）。

<a id="brand-dlink"></a>

## D-Link

烽燧还没有这个品牌的实现：「设置 → 路由器」里选不到它，自动识别也认不出来，所以表里整行留空。资料记载这些路由器用 OpenWrt 的 LuCI RPC（`/cgi-bin/luci/rpc`）或厂商自己的网页 JSON 接口，和烽燧已有的 OpenWrt 实现（ubus + AT 指令）不是同一套。有这里的路由器，也欢迎提交实测报告。

| 型号 | 形态 | 信号与流量 | 附近的基站 | 已连接设备 | 短信 | 锁频段 | 锁小区 | 重启与重拨 | 移动数据 | 路由器开关 | 访问控制 | 电池 | SIM 卡 | 飞行模式 | 网络制式与选网 | 数据设置 | USSD | 实测反馈 |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :--- |
| D-Link DWR-2000M | 室内 CPE |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+D-Link+DWR-2000M) |
| D-Link DWR-2101 | 随身路由器 |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+D-Link+DWR-2101) |
| D-Link DWR-953V2 | 室内 CPE |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+D-Link+DWR-953V2) |
| D-Link DWR-960 | 室内 CPE |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+D-Link+DWR-960) |
| D-Link DWR-921 | 室内 CPE |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+D-Link+DWR-921) |

<a id="brand-tplink"></a>

## TP-Link

烽燧还没有这个品牌的实现：「设置 → 路由器」里选不到它，自动识别也认不出来，所以表里整行留空。资料记载这些路由器用厂商自己的网页 JSON 接口（新固件带 RSA + AES 签名），烽燧还没有对应的实现。有这里的路由器，也欢迎提交实测报告。

| 型号 | 形态 | 信号与流量 | 附近的基站 | 已连接设备 | 短信 | 锁频段 | 锁小区 | 重启与重拨 | 移动数据 | 路由器开关 | 访问控制 | 电池 | SIM 卡 | 飞行模式 | 网络制式与选网 | 数据设置 | USSD | 实测反馈 |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :--- |
| Archer NX200 | 室内 CPE |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Archer+NX200) |
| NX510v | 室内 CPE |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+NX510v) |
| Deco X50-5G | 室内 CPE |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Deco+X50-5G) |
| TL-TR961 5G | 随身路由器 |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+TL-TR961+5G) |
| TL-XDR3020 5G | 室内 CPE |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+TL-XDR3020+5G) |
| Archer MR600 | 室内 CPE |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | [提交报告](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Archer+MR600) |
<!-- devices:end -->

## 帮忙验证你的路由器

点你的型号那一行的「提交报告」，会在 GitHub 打开一个标题已经写好的新 issue。怎么生成设备报告并提交，见[报告兼容性](other-routers.md#report)；也可以让 AI 智能体替你测试并起草报告，见[用 AI 智能体测试](other-routers.md#ai)。

报告里读到了数据的读取项，和写入记录里回读一致的写入项，登记进代码后，表里那一格就会变成 ✓。表随文档站更新；控制台里显示「已验证」，要等包含这条登记的下一个版本。
