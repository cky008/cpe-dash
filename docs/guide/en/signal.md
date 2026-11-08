---
title: Understand signal readings
description: What each number on the Signal card means, what values are good, and what you can do when your signal is poor.
section: Understand the readings
order: 11
---

The Signal card in the console is divided into two sections: **5G NR** and **4G LTE**. Most 5G routers connect to both networks at the same time (5G NSA; see [Bands, carriers, and cells](bands-and-cells.md#nsa-sa)), so both sections display numbers. This page explains each item in the order it appears on the card.

Here is an example card (with fictional values):

| Shown on card | Meaning | What this example shows |
| :--- | :--- | :--- |
| `5G NR` · `N78` · `100 / 100 MHz` | 5G network, band n78, 100 MHz bandwidth for both downlink and uplink | Connected to the main 5G band near 3.5 GHz |
| RSRP `-95 dBm` | Signal strength | Moderate |
| RSRQ `-11 dB` | Signal quality | Good |
| SINR `8 dB` | Signal clarity | Subpar; speeds will be affected |
| PCI `211`, downlink frequency `650000` | Which cell and frequency the router connects to | Used when locking to a cell |
| MIMO `DL 2 layers` | Number of simultaneous data streams | 2 streams |
| Uplink / downlink modulation `256QAM`, `MCS 20` | How much data is sent at a time | 256QAM is used only when the signal is good enough |
| PUSCH / PUCCH `21 dBm` | Router transmit power | Close to the 23 dBm limit, indicating the router is relatively far from the cell tower |

## Check these three numbers first

RSRP, RSRQ, and SINR tell you the most about signal health. RSRP shows whether you can connect and have sufficient coverage; SINR is a better indicator of how fast your connection can run [[Rohde & Schwarz: Smart macro network enhancements](https://www.rohde-schwarz.com/us/solutions/critical-infrastructure/mobile-network-testing/stories-insights/article-smart-macro-network-enhancements-antenna-tilt-optimization_253577.html)].

Huawei provides the following reference ranges for 4G [[Huawei: Signal strength of a HUAWEI CPE inserted with a SIM card](https://consumer.huawei.com/en/support/content/en-us16017504/)]:

| Signal | RSRP | SINR |
| :--- | :--- | :--- |
| Excellent | Above -85 dBm | Above 25 dB |
| Good | -85 to -95 dBm | 16 to 25 dB |
| Acceptable | -95 to -105 dBm | 11 to 15 dB |
| Poor | -105 to -115 dBm | 3 to 10 dB |
| Very poor | Below -115 dBm | Below 3 dB |

5G readings are typically lower than 4G because higher frequencies attenuate faster; seeing 5G RSRP 5 to 10 dB lower in the same spot is common. The ring colors on the card are already graded by signal quality.

<a id="rsrp"></a>

### RSRP: How strong the signal is

RSRP (Reference Signal Received Power) measures the strength of the tower signal received by your router. Measured in dBm, it is a negative number: **the closer to 0, the stronger the signal**. Because it measures dedicated reference signals transmitted by the cell tower, it is not affected by current network traffic, making it ideal for comparing different locations and cells [[3GPP TS 36.214](https://www.3gpp.org/DynaReport/36214.htm)] [[3GPP TS 38.215](https://www.3gpp.org/DynaReport/38215.htm)].

- Example: -80 dBm is strong, -100 dBm is moderate, and below -115 dBm is very weak.
- Every 3 dB difference doubles or halves the power; a 10 dB difference represents a ten-fold change.

<a id="rsrq"></a>

### RSRQ: Signal quality

RSRQ (Reference Signal Received Quality) compares the signal strength against the total power received across the entire channel. Measured in dB, **closer to 0 is also better** [[3GPP TS 36.214](https://www.3gpp.org/DynaReport/36214.htm)]. When there are many nearby cell towers or active users, RSRQ degrades.

- Example: -5 dB is excellent, -10 dB is good, and below -15 dB is poor.

<a id="sinr"></a>

### SINR: How clean the signal is

SINR (Signal-to-Interference-plus-Noise Ratio) measures how much stronger the useful signal is compared to interference and noise. Measured in dB, **higher is better**. It correlates most closely with your speed: when SINR is high, the cell tower can use faster modulation schemes [[Rohde & Schwarz: Smart macro network enhancements](https://www.rohde-schwarz.com/us/solutions/critical-infrastructure/mobile-network-testing/stories-insights/article-smart-macro-network-enhancements-antenna-tilt-optimization_253577.html)].

- Example: Above 20 dB is excellent, around 10 dB is moderate, and below 0 dB means interference is stronger than the signal itself.
- If RSRP is good but SINR is very low, you usually have too much interference from nearby towers or cells. In this case, switching to a different cell (see [Band and cell locking](locking.md)) is often more effective than moving the router.

<a id="rssi"></a>

### RSSI: Total received power

RSSI (Received Signal Strength Indicator) is the total power received across the entire channel, including the target signal, signals from neighboring cells, and noise [[3GPP TS 36.214](https://www.3gpp.org/DynaReport/36214.htm)]. It fluctuates with network traffic. On its own, it is not very informative and is mainly used to calculate RSRQ.

<a id="cqi"></a>

### CQI: How the router rates the channel

CQI (Channel Quality Indicator) is a score from 0 to 15 that the router reports to the cell tower based on current signal conditions. The tower uses it to determine how fast a modulation scheme to assign [[3GPP TS 36.213](https://www.3gpp.org/DynaReport/36213.htm)] [[3GPP TS 38.214](https://www.3gpp.org/DynaReport/38214.htm)].

- Example: `12 / 11` shows scores for two separate data streams; higher is better. A score below 7 indicates a subpar channel.
- A display of `—` means the router is not reporting at that moment (for example, when 5G has no data to transfer).

<a id="mcs"></a>

### Modulation and MCS: How much data is sent at a time

**Modulation** determines how many bits are packed into each symbol: QPSK carries 2 bits, 16QAM carries 4 bits, 64QAM carries 6 bits, and 256QAM carries 8 bits [[3GPP TS 36.211](https://www.3gpp.org/DynaReport/36211.htm)]. Packing more bits increases speed, but requires a cleaner signal.

**MCS** (Modulation and Coding Scheme) is an index selected by the tower from a standard table. It determines both the modulation scheme and the amount of error correction [[3GPP TS 38.214](https://www.3gpp.org/DynaReport/38214.htm)]. The reading `MCS 20@256QAM` on the card indicates index 20 using 256QAM modulation.

- The index adjusts in real time with signal conditions; changing every few seconds is normal.
- If downlink stays on QPSK or 16QAM constantly, your signal quality is poor (most likely due to low SINR).

<a id="mimo"></a>

### MIMO layers and TM: How many streams run simultaneously

MIMO (Multiple-Input Multiple-Output) allows the tower and router to use multiple antennas to transmit multiple independent data streams simultaneously on the same frequency. Each stream is called a **layer** [[Ericsson: Using Massive MIMO to meet 5G network requirements](https://www.ericsson.com/en/reports-and-papers/ericsson-technology-review/articles/using-massive-mimo-to-meet-5g-network-requirements)]. More layers yield faster speeds.

- Example: `DL 2 layers` means two downlink streams transmit simultaneously; with good signal and enough antennas, it can reach 4 layers.
- `TM[4]` is the 4G transmission mode index. Mode 4 represents "closed-loop spatial multiplexing," which is the multi-stream transmission described above [[3GPP TS 36.213](https://www.3gpp.org/DynaReport/36213.htm)].

<a id="tx-power"></a>

### Transmit power: How hard the router works to reach the tower

PUSCH is the transmit power for data, and PUCCH is the transmit power for control information (such as CQI), measured in dBm. The farther you are from the tower or the more obstacles in between, the more power the router must output. The upper limit for standard consumer devices is 23 dBm [[3GPP TS 36.101](https://www.3gpp.org/DynaReport/36101.htm)] [[3GPP TS 38.101-1](https://www.3gpp.org/DynaReport/38101-1.htm)].

- Example: Remaining above 20 dBm for long periods indicates the uplink is struggling, leading to slow upload speeds; staying below 10 dBm indicates you are close to the cell tower.

## Try these steps when your signal is poor

1. **Move the router**: Place it near a window or in an elevated spot, away from metal cabinets and thick walls. Each time you move it, wait one minute and check the change in RSRP and SINR.
2. **Face the cell tower**: Check which cell has the best signal under [Nearby cells](bands-and-cells.md#neighbors), and place the router near a window facing that direction.
3. **Connect external antennas**: Some models have external antenna ports. Connecting appropriate antennas can significantly improve reception; under normal conditions, the built-in antennas are sufficient [[Huawei: Purpose of external antenna ports](https://consumer.huawei.com/en/support/content/en-us00728109/)].
4. **Lock a band or cell**: Lock the router to a band or cell with better reception or less congestion; see [Band and cell locking](locking.md).
