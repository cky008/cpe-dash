---
title: 频段、载波与小区
description: 4G 和 5G 怎样一起工作，频段、带宽、载波聚合、频点和小区分别是什么。锁频锁站之前先读这一页。
section: 看懂数据
order: 12
---

你的路由器连的不是「一个信号」，而是运营商在某些**频段**上、从某个**小区**发出的一个或几个**载波**。这一页把这些词讲清楚，信号卡、载波聚合栏和附近的基站表里的内容都能对上。

<a id="nsa-sa"></a>

## 4G、5G 和 NSA / SA

4G 叫 LTE，5G 叫 NR（New Radio）。现在的 5G 有两种组网方式 [[3GPP TR 21.915（Release 15 概述）](https://www.3gpp.org/DynaReport/21915.htm)] [[3GPP TS 37.340](https://www.3gpp.org/DynaReport/37340.htm)]：

- **NSA（非独立组网）**：5G 借 4G 的「骨架」工作。路由器先连 4G，再加上 5G 来提速。控制台上会同时出现 4G 和 5G 两块数字。
- **SA（独立组网）**：5G 自己就能工作，不需要 4G。

<a id="anchor"></a>

### 锚点

在 NSA 里，路由器连着的那个 4G 小区叫**锚点**，负责信令和控制，5G 负责大部分数据。卡片上的「4G LTE 锚点」就是它。锚点信号差时，5G 也可能连不稳。

<a id="band"></a>

## 频段

运营商的信号分布在不同的**频段**上，每个频段是一段频率范围，有统一编号 [[3GPP TS 36.101（LTE 频段）](https://www.3gpp.org/DynaReport/36101.htm)] [[3GPP TS 38.101-1（NR 频段）](https://www.3gpp.org/DynaReport/38101-1.htm)]：

- 4G 频段写作 `B` 加数字，例如 `B1`（2.1 GHz）、`B3`（1.8 GHz）、`B20`（800 MHz）。
- 5G 频段写作 `n` 加数字，例如 `n78`（3.5 GHz 附近）、`n28`（700 MHz）。

一般来说，**低频段**（几百 MHz）传得远、穿墙好，但容量小；**高频段**（3 GHz 以上）速度快，但衰减快、怕遮挡。同一个位置，不同频段的信号和速度可能差很多，这也是锁频段有用的原因。

<a id="bandwidth"></a>

### 带宽

**带宽**是一个载波占用的频率宽度，单位 MHz。带宽越宽，能同时传的数据越多，速度上限越高。卡片上的 `100 / 100 MHz` 表示上下行各 100 MHz；4G 载波最宽 20 MHz，5G 在 n78 上常见 100 MHz。

<a id="ca"></a>

## 载波聚合

**载波聚合（CA）** 让路由器同时使用几个载波，把它们的带宽加起来，速度也就叠加起来 [[3GPP：Carrier Aggregation explained](https://www.3gpp.org/technologies/101-carrier-aggregation-explained)]。大屏上的载波聚合栏会显示类似 `B1(20M) + B3(20M) + n78(100M)` 的组合，意思是同时用了三个载波，共 140 MHz。

<a id="pcc-scc"></a>

### 主载波和辅载波

聚合的载波里，有一个是**主载波**（PCC），负责控制；其余是**辅载波**（SCC），只负责多传数据 [[3GPP：Carrier Aggregation explained](https://www.3gpp.org/technologies/101-carrier-aggregation-explained)]。信号卡下方的「辅载波」一栏列出每个辅载波的频段、频点、PCI 和信号。辅载波可能随信号变化随时增减，`CA_DROPPED` 告警就是在提醒少了载波。

<a id="arfcn"></a>

## 频点

**频点**是一个载波具体在哪个频率上的编号。4G 叫 EARFCN，5G 叫 NR-ARFCN [[3GPP TS 36.101](https://www.3gpp.org/DynaReport/36101.htm)] [[3GPP TS 38.104](https://www.3gpp.org/DynaReport/38104.htm)]。编号和频率一一对应：

- 例子：4G `DL 300 · UL 18300` 表示下行频点 300、上行频点 18300，在 B1 上对应下行 2140 MHz、上行 1950 MHz。
- 例子：5G 频点 `650000` 对应 3750 MHz。
- 想换算的话，可以用 [CellMapper 的频点计算器](https://www.cellmapper.net/arfcn)。

同一个频段里，运营商通常只用一两个固定的频点。锁「频点」比锁「频段」更精确。

<a id="pci"></a>

## 小区和 PCI

基站通常朝几个方向各覆盖一片区域，每一片叫一个**小区**（扇区）。**PCI**（物理小区标识）是路由器在空中区分附近小区用的编号：4G 有 504 个（0 到 503），5G 有 1008 个（0 到 1007）[[3GPP TS 36.211](https://www.3gpp.org/DynaReport/36211.htm)] [[3GPP TS 38.211](https://www.3gpp.org/DynaReport/38211.htm)]。

PCI 会在远处的基站上重复使用，所以只有「频点 + PCI」放在一起，才能在你附近唯一确定一个小区。锁小区时填的就是这两个数。

<a id="cell-id"></a>

## TAC、Cell ID 和 eNodeB

这几个是运营商网络里的「地址」[[3GPP TS 23.003](https://www.3gpp.org/DynaReport/23003.htm)]：

- **TAC**（跟踪区代码）：一片区域的编号，包含很多基站。
- **Cell ID**：小区在运营商网络里的完整编号，全网唯一。
- **eNodeB**：4G 基站的编号。4G 的 Cell ID 由基站编号和扇区编号组成，Cell ID 除以 256 取整就是 eNodeB 编号。

> [!WARNING]
> TAC、Cell ID 和 eNodeB 编号可以在公开的基站数据库里查到大致位置，等于暴露你家附近的基站。烽燧默认给它们打码；截图或在网上求助时，也请把它们、以及 PCI 和频点的组合遮住。

<a id="neighbors"></a>

## 附近的基站

路由器除了连着的小区，还能「听到」周围其他小区。控制台上的「附近的基站」表列出它们的频段、频点、PCI 和信号，每分钟刷新一次，也可以手动扫描。

- 标着「服务中」的是正在用的小区。
- 想换到信号更好的小区，可以在表里点「锁至此小区」，见[锁频与锁小区](locking.md#lock-cell)。
