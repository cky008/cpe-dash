---
title: 路由器开关
description: 控制抽屉里每个开关是做什么的：UPnP、DMZ、防火墙、WAN 口 Ping、MLO、双频优选、天线、移动数据、重拨和重启。
section: 使用烽燧
order: 7
---

右上角的「控制」抽屉里，除了[锁频与锁小区](locking.md)，还有一组路由器开关。它们和路由器官方网页里的同名设置是同一份，改一边另一边也会变。每次打开或关闭都会先弹出确认，说明会有什么影响。

> [!NOTE]
> 抽屉不会定时读取这些设置。打开抽屉后点「读取路由器配置」，看到的才是路由器当前的状态。

## 安全开关

<a id="upnp"></a>

### UPnP

UPnP（通用即插即用）让家里的设备自动请求路由器打开端口，外面的人就能连进来。联机游戏、BT 下载、部分视频通话软件会用到它 [[华为：如何开启 UPnP](https://consumer.huawei.com/en/support/content/en-us00275342/)]。

- **开着**：方便，但任何一台设备（包括被入侵的智能设备）都可以自己在路由器上开端口。
- **关着**：更安全；少数需要外部连入的应用可能连不上。
- 建议：用不到就关闭。注意：大多数家用 5G 网络在运营商那里还有一层地址转换，即使开了 UPnP，外部也未必连得进来。

<a id="dmz"></a>

### DMZ 主机

DMZ 主机会把所有没有被别的规则处理的外部连接，统统转给你指定的那台设备 [[Fortinet: What is a DMZ network?](https://www.fortinet.com/resources/cyberglossary/what-is-dmz)] [[华为：如何设置 DMZ 主机](https://consumer.huawei.com/en/support/content/en-us15806289/)]。

> [!CAUTION]
> 开启后，那台设备相当于直接暴露在公网上。只在你清楚后果、且那台设备自己有防火墙时使用；用完就关。

<a id="firewall"></a>

### 防火墙总开关、IP 过滤、URL 过滤

- **防火墙总开关**：路由器的基础防护，挡掉外部主动发来的连接。保持开启。
- **IP 过滤**、**URL 过滤**：按你在路由器官方网页里设置的规则，挡掉某些地址或网站。烽燧只负责开关，规则本身在官方网页里编辑。

<a id="wan-ping"></a>

### WAN 口 Ping

决定路由器要不要回应来自公网的 Ping（ICMP 回显请求）[[RFC 792](https://www.rfc-editor.org/rfc/rfc792)]。屏蔽后，网上的扫描器更难发现你的路由器在线，对正常上网没有影响。建议屏蔽。

<a id="fw-mac"></a>

### MAC 过滤（防火墙）

这是路由器防火墙里的 MAC 名单，和[设备与上网管理](devices.md#mac-filter)里的 Wi-Fi MAC 过滤不是一回事：它对有线和无线设备都生效 [[华为：路由器如何设置 MAC 地址过滤](https://consumer.huawei.com/cn/support/content/zh-cn15933072/)]。

> [!WARNING]
> 如果名单是「只允许」模式，名单外的设备都会断网，可能包括运行烽燧的那台机器。

## Wi-Fi

<a id="mlo"></a>

### MLO 多链路

MLO（多链路操作）是 Wi-Fi 7 的功能：支持它的设备可以同时用 2.4 GHz、5 GHz 等多个频段和路由器通信，速度更快、延迟更低、更不容易断 [[Wi-Fi Alliance: Wi-Fi CERTIFIED 7](https://www.wi-fi.org/news-events/newsroom/wi-fi-alliance-introduces-wi-fi-certified-7)] [[IEEE 802.11be](https://standards.ieee.org/ieee/802.11be/7516/)]。

- 只有 Wi-Fi 7 设备能用上；老设备照常连接。
- 个别老设备在 MLO 开启时连不上或不稳定，遇到时可以先关掉试试。

<a id="dbho"></a>

### 双频优选

把 2.4 GHz 和 5 GHz 合成一个 Wi-Fi 名称，由路由器自动把设备引导到更合适的频段，通常优先 5 GHz [[华为：设置 5 GHz 优先](https://consumer.huawei.com/en/support/content/en-us00746587/)]。

- 开着：只有一个 Wi-Fi 名称，省心。
- 关着：2.4 GHz 和 5 GHz 分成两个名称，适合只支持 2.4 GHz 的智能家居设备配网。

## 天线

<a id="antenna"></a>

部分型号带外置天线接口。这里可以选「自动」「内置」或「外置」，并显示每个接口有没有接上天线。没有接外置天线时请保持「自动」或「内置」；一般情况下内置天线已经够用 [[华为：外置天线接口的作用](https://consumer.huawei.com/en/support/content/en-us00728109/)]。

## 移动数据、重拨和重启

<a id="mobile-data"></a>

- **移动数据**：关闭后路由器不再通过 SIM 卡上网，局域网照常工作。
- **重拨蜂窝数据**：断开再重新连接运营商网络，相当于手机开关一次飞行模式，几秒到几十秒后恢复。上网卡住时先试这个。
- **重启路由器**：整台路由器重启，家里会断网一两分钟。需要输入确认词。

烽燧的自愈功能只会自动重拨，从不自动重启路由器，见[锁频与锁小区](locking.md#self-heal)。
