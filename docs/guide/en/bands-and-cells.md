---
title: Bands, carriers, and cells
description: How 4G and 5G work together, and what bands, bandwidth, carrier aggregation, frequencies, and cells mean. Read this before locking bands or cells.
section: Understand the readings
order: 13
---

Your router does not connect to "a single signal." It connects to one or more **carriers** transmitted by your operator on specific **bands** from a particular **cell**. This page clarifies these terms so the details on the Signal card, the Carrier aggregation bar, and the Nearby cells table make sense.

<a id="nsa-sa"></a>

## 4G, 5G, and NSA / SA

4G is called LTE, and 5G is called NR (New Radio). Current 5G networks operate in two deployment modes [[3GPP TR 21.915 (Release 15 overview)](https://www.3gpp.org/DynaReport/21915.htm)] [[3GPP TS 37.340](https://www.3gpp.org/DynaReport/37340.htm)]:

- **NSA (Non-Standalone)**: 5G relies on a 4G "backbone." The router connects to 4G first, then adds 5G to boost speeds. The console displays readings for both 4G and 5G at the same time.
- **SA (Standalone)**: 5G operates independently without requiring 4G.

<a id="anchor"></a>

### Anchor

In NSA mode, the 4G cell the router connects to is called the **anchor**. It handles signaling and control, while 5G carries most of the data. This is what the "4G LTE anchor" on the card refers to. If the anchor signal is poor, the 5G connection can also become unstable.

<a id="band"></a>

## Bands

Operator signals are distributed across different **bands**. Each band covers a specific frequency range and has a standardized number [[3GPP TS 36.101 (LTE bands)](https://www.3gpp.org/DynaReport/36101.htm)] [[3GPP TS 38.101-1 (NR bands)](https://www.3gpp.org/DynaReport/38101-1.htm)]:

- 4G bands are written as `B` plus a number, such as `B1` (2.1 GHz), `B3` (1.8 GHz), or `B20` (800 MHz).
- 5G bands are written as `n` plus a number, such as `n78` (around 3.5 GHz) or `n28` (700 MHz).

In general, **low-frequency bands** (hundreds of MHz) travel farther and penetrate walls better, but have lower capacity. **High-frequency bands** (above 3 GHz) offer faster speeds, but attenuate quickly and struggle with obstacles. In the same spot, signal strength and speed can vary dramatically across different bands, which is why locking bands is useful.

<a id="bandwidth"></a>

### Bandwidth

**Bandwidth** is the frequency width occupied by a carrier, measured in MHz. The wider the bandwidth, the more data can be transmitted simultaneously, and the higher the speed limit. The reading `100 / 100 MHz` on the card indicates 100 MHz each for downlink and uplink. A 4G carrier maxes out at 20 MHz, whereas 100 MHz is common on 5G band n78.

<a id="ca"></a>

## Carrier aggregation

**Carrier aggregation (CA)** allows your router to use multiple carriers at the same time, combining their bandwidth to boost overall speed [[3GPP: Carrier Aggregation explained](https://www.3gpp.org/technologies/101-carrier-aggregation-explained)]). The Carrier aggregation bar on the dashboard displays combinations such as `B1(20M) + B3(20M) + n78(100M)`, which means three carriers are in use simultaneously for a total of 140 MHz.

<a id="pcc-scc"></a>

### Primary and secondary carriers

Among the aggregated carriers, one serves as the **primary carrier** (PCC) and handles control; the rest are **secondary carriers** (SCC) that serve solely to carry additional data [[3GPP: Carrier Aggregation explained](https://www.3gpp.org/technologies/101-carrier-aggregation-explained)]. The "Secondary carriers" section below the Signal card lists the band, frequency, PCI, and signal readings for each secondary carrier. Secondary carriers can attach or drop at any time as signal conditions fluctuate; the `CA_DROPPED` alert warns you when a carrier drops.

<a id="arfcn"></a>

## Frequency channels

A **frequency channel number** identifies the exact frequency of a carrier. It is called EARFCN in 4G and NR-ARFCN in 5G [[3GPP TS 36.101](https://www.3gpp.org/DynaReport/36101.htm)] [[3GPP TS 38.104](https://www.3gpp.org/DynaReport/38104.htm)]. Each channel number corresponds directly to a frequency:

- Example: 4G `DL 300 · UL 18300` indicates downlink channel 300 and uplink channel 18300, which on band B1 corresponds to 2140 MHz downlink and 1950 MHz uplink.
- Example: 5G frequency `650000` corresponds to 3750 MHz.
- To convert between frequencies and channel numbers, use the [CellMapper ARFCN calculator](https://www.cellmapper.net/arfcn).

Within the same band, an operator typically deploys only one or two fixed frequencies. Locking to a specific frequency is more precise than locking to a band.

<a id="pci"></a>

## Cells and PCI

A cell tower typically covers several directions, and each coverage area is called a **cell** (or sector). The **PCI** (Physical Cell Identifier) is the number your router uses over the air to distinguish between nearby cells: 4G has 504 PCIs (0 to 503), and 5G has 1,008 PCIs (0 to 1007) [[3GPP TS 36.211](https://www.3gpp.org/DynaReport/36211.htm)] [[3GPP TS 38.211](https://www.3gpp.org/DynaReport/38211.htm)].

Because PCIs are reused by distant cell towers, only the combination of "frequency + PCI" uniquely identifies a cell in your vicinity. These are the two numbers you enter when locking to a cell.

<a id="cell-id"></a>

## TAC, Cell ID, and eNodeB

These are internal network identifiers used by your operator [[3GPP TS 23.003](https://www.3gpp.org/DynaReport/23003.htm)]:

- **TAC** (Tracking Area Code): Identifies an area that contains multiple cell towers.
- **Cell ID**: The full identifier for a cell in the operator network, globally unique within the network.
- **eNodeB**: The identifier for a 4G base station. A 4G Cell ID consists of the base station ID and the sector ID; dividing the Cell ID by 256 (integer division) gives the eNodeB ID.

> [!WARNING]
> Anyone can look up the approximate location of a TAC, Cell ID, or eNodeB ID in public cell tower databases, which reveals the towers near your home. FengSui masks these values by default. When sharing screenshots or asking for help online, make sure to mask these values, along with your PCI and frequency combinations.

<a id="neighbors"></a>

## Nearby cells

In addition to its connected cell, your router can detect other neighboring cells. The "Nearby cells" table in the console lists their bands, frequencies, PCIs, and signal readings. It refreshes every minute, and you can also trigger a manual scan.

- Cells labeled "Serving" are the ones currently in use.
- To switch to a cell with better signal, click "Lock to this cell" in the table; see [Band and cell locking](locking.md#lock-cell).
