---
title: 看懂信号
description: 信号卡上每个数字是什么意思、多少算好，以及信号不好时可以做什么。
section: 看懂数据
order: 11
---

控制台上的信号卡分两块：**5G NR** 和 **4G LTE**。大多数 5G 路由器同时连着这两张网（5G NSA，见[频段、载波与小区](bands-and-cells.md#nsa-sa)），所以两块都有数字。这一页按卡片上的顺序解释每一项。

下面是一张卡片的例子（数值是虚构的）：

| 卡片上显示 | 意思 | 这个例子说明什么 |
| :--- | :--- | :--- |
| `5G NR` · `N78` · `100 / 100 MHz` | 5G 网络，n78 频段，上下行各 100 MHz 带宽 | 用的是 3.5 GHz 附近的 5G 主力频段 |
| RSRP `-95 dBm` | 信号强度 | 中等 |
| RSRQ `-11 dB` | 信号质量 | 良好 |
| SINR `8 dB` | 信号干净程度 | 偏差，速度会受影响 |
| PCI `211`，下行频点 `650000` | 连的是哪个小区、哪个频率 | 锁小区时会用到 |
| MIMO `DL 2 层` | 同时传几路数据 | 2 路 |
| 上 / 下行调制 `256QAM`，`MCS 20` | 每次传多少数据 | 信号够好时才能用到 256QAM |
| PUSCH / PUCCH `21 dBm` | 路由器的发射功率 | 接近上限 23 dBm，说明离基站较远 |

## 先看这三个数

RSRP、RSRQ 和 SINR 最能说明信号好坏。RSRP 说明能不能连上、覆盖够不够；SINR 更能说明速度能跑多快 [[Rohde & Schwarz: Smart macro network enhancements](https://www.rohde-schwarz.com/us/solutions/critical-infrastructure/mobile-network-testing/stories-insights/article-smart-macro-network-enhancements-antenna-tilt-optimization_253577.html)]。

华为给出的 4G 参考范围如下 [[华为：CPE 插卡上网页面的信号格数与信号强度](https://consumer.huawei.com/cn/support/content/zh-cn15978552/)]：

| 信号 | RSRP | SINR |
| :--- | :--- | :--- |
| 非常好 | 高于 -85 dBm | 高于 25 dB |
| 好 | -85 到 -95 dBm | 16 到 25 dB |
| 可以接受 | -95 到 -105 dBm | 11 到 15 dB |
| 差 | -105 到 -115 dBm | 3 到 10 dB |
| 很差 | 低于 -115 dBm | 低于 3 dB |

5G 的数值通常比 4G 低一些（频率更高、衰减更快），同一个位置 5G RSRP 低 5 到 10 dB 很常见。卡片上圆环的颜色已经按好坏分好了级。

<a id="rsrp"></a>

### RSRP：信号有多强

RSRP（参考信号接收功率）是路由器收到的基站信号的强度，单位 dBm，是负数，**越接近 0 越强**。它测的是基站专门发出的参考信号，所以不受当时有没有人在用网的影响，适合比较不同位置、不同小区 [[3GPP TS 36.214](https://www.3gpp.org/DynaReport/36214.htm)] [[3GPP TS 38.215](https://www.3gpp.org/DynaReport/38215.htm)]。

- 例子：-80 dBm 很强，-100 dBm 一般，-115 dBm 以下就很弱了。
- 每差 3 dB，功率差一倍；差 10 dB，差十倍。

<a id="rsrq"></a>

### RSRQ：信号质量

RSRQ（参考信号接收质量）把信号强度和整个频道里收到的总功率放在一起比，单位 dB，同样**越接近 0 越好** [[3GPP TS 36.214](https://www.3gpp.org/DynaReport/36214.htm)]。周围基站多、用户多时，RSRQ 会变差。

- 例子：-5 dB 很好，-10 dB 良好，-15 dB 以下就差了。

<a id="sinr"></a>

### SINR：信号有多干净

SINR（信号与干扰加噪声比）是有用信号比干扰和噪声强多少，单位 dB，**越大越好**。它和速度关系最密切：SINR 高，基站才敢用更快的调制方式 [[Rohde & Schwarz: Smart macro network enhancements](https://www.rohde-schwarz.com/us/solutions/critical-infrastructure/mobile-network-testing/stories-insights/article-smart-macro-network-enhancements-antenna-tilt-optimization_253577.html)]。

- 例子：20 dB 以上很好，10 dB 左右一般，0 dB 以下说明干扰比信号还强。
- RSRP 不错但 SINR 很低，通常是周围其他基站或小区的干扰太多。这时换个小区（见[锁频与锁小区](locking.md)）往往比挪位置更有效。

<a id="rssi"></a>

### RSSI：收到的总功率

RSSI 是整个频道里收到的全部功率，包括目标信号、邻近小区的信号和噪声 [[3GPP TS 36.214](https://www.3gpp.org/DynaReport/36214.htm)]。它会随网络忙闲变化，单独看意义不大，主要用来算 RSRQ。

<a id="cqi"></a>

### CQI：路由器对信道的打分

CQI（信道质量指示）是路由器根据当前信号，报告给基站的一个 0 到 15 的分数。基站据此决定给你用多快的调制方式 [[3GPP TS 36.213](https://www.3gpp.org/DynaReport/36213.htm)] [[3GPP TS 38.214](https://www.3gpp.org/DynaReport/38214.htm)]。

- 例子：`12 / 11` 是两个数据流各自的分数，越高越好；7 以下说明信道不太好。
- 显示 `—` 表示路由器这一刻没有报告（例如 5G 暂时没有数据要传）。

<a id="mcs"></a>

### 调制方式和 MCS：每次能传多少数据

**调制方式**决定每个符号装多少比特：QPSK 装 2 个，16QAM 装 4 个，64QAM 装 6 个，256QAM 装 8 个 [[3GPP TS 36.211](https://www.3gpp.org/DynaReport/36211.htm)]。装得越多越快，但对信号干净程度的要求也越高。

**MCS**（调制与编码方式）是基站从一张表里选出的编号，同时决定了调制方式和纠错的多少 [[3GPP TS 38.214](https://www.3gpp.org/DynaReport/38214.htm)]。卡片上的 `MCS 20@256QAM` 表示用的是 20 号方案、256QAM 调制。

- 编号会随信号实时变化，几秒变一次很正常。
- 下行常年停在 QPSK 或 16QAM，说明信号质量差（多半是 SINR 低）。

<a id="mimo"></a>

### MIMO 层数和 TM：同时传几路

MIMO（多输入多输出）让基站和路由器用多根天线，在同一频率上同时传几路独立的数据，每一路叫一**层** [[Ericsson: Using Massive MIMO to meet 5G network requirements](https://www.ericsson.com/en/reports-and-papers/ericsson-technology-review/articles/using-massive-mimo-to-meet-5g-network-requirements)]。层数越多，速度越快。

- 例子：`DL 2 层` 表示下行同时传 2 路；信号好、天线多时能到 4 层。
- `TM[4]` 是 4G 的传输模式编号，4 表示「闭环空间复用」，就是上面说的多路同时传 [[3GPP TS 36.213](https://www.3gpp.org/DynaReport/36213.htm)]。

<a id="tx-power"></a>

### 发射功率：路由器要多费力才能发到基站

PUSCH 是发数据时的功率，PUCCH 是发控制信息（例如 CQI）时的功率，单位 dBm。离基站越远、遮挡越多，路由器就要用越大的功率。普通终端的上限是 23 dBm [[3GPP TS 36.101](https://www.3gpp.org/DynaReport/36101.htm)] [[3GPP TS 38.101-1](https://www.3gpp.org/DynaReport/38101-1.htm)]。

- 例子：长期在 20 dBm 以上，说明上行很吃力，上传速度会慢；10 dBm 以下说明离基站很近。

## 信号不好时可以试试

1. **换个位置**：放到窗边、高处，远离金属柜和厚墙。每挪一次，等一分钟看 RSRP 和 SINR 的变化。
2. **对准基站**：看[附近的基站](bands-and-cells.md#neighbors)里哪个小区信号最好，把路由器朝那个方向的窗户放。
3. **接外置天线**：部分型号有外置天线接口，接上合适的天线能明显改善信号；一般情况下内置天线已经够用 [[华为：外置天线接口的作用](https://consumer.huawei.com/en/support/content/en-us00728109/)]。
4. **锁频或锁小区**：把路由器固定到信号更好、更空闲的频段或小区，见[锁频与锁小区](locking.md)。
