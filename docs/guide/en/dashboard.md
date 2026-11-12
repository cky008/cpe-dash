---
title: Dashboard
description: What each section on the Dashboard shows: Signal, Carrier aggregation, Nearby cells, Data usage, Connected devices, and historical charts.
section: Use FengSui
order: 5
---

When you log in, you see the Dashboard. Data refreshes every 5 seconds. When reading the router, FengSui stays logged in for only a few dozen to a few hundred milliseconds and logs out immediately, so you can log into the router's own web page at any time.

![Dashboard (Polar Night theme)](../../screenshots/dashboard-full-jiye.webp)

## Header

- **Operator & SIM**: operator name, SIM status, and access mode (4G, 5G NSA, 5G SA), and, where the router reports them, the SIM slot, the PIN, roaming and airplane mode; see [Operator and SIM card](#sim) below.
- **Device**: model, firmware, and masked IMEI, IMSI, phone number and the SIM card's ICCID. Click the eye icon to reveal the values when needed; they stay masked by default for safe screenshots.
- **Network addresses**: IPv4, IPv6, and DNS addresses assigned by the operator network, also masked by default.
- **Router admin page status**: "free" means everything is normal; "Someone is using the router's admin page · paused" means someone signed in to the router's own web page and FengSui waits for them to sign out; "Router rejected the password · logins stopped" means you need to correct the password under Settings → Router.
- **Alert bell**: recent alerts.

Hover over any term with a <kbd>?</kbd> to see a short explanation, or click it for detailed notes. If you do not need them, turn them off under Settings → Appearance.

<a id="sim"></a>

## Operator and SIM card

Each row appears only where the router reports it; brands and models report different things.

<a id="sim-pin"></a>

### PIN and PUK

The PIN is the SIM card's own code. When it is on, the router must enter it at every start before it can connect. After three wrong PINs in a row the card asks for its PUK; after ten wrong PUKs it is blocked for good, and only your operator can replace it [[ETSI TS 102 221](https://www.etsi.org/deliver/etsi_ts/102200_102299/102221/)] [[3GPP TS 31.102](https://www.3gpp.org/DynaReport/31102.htm)].

- "Asked at start" means the card's PIN is on; "3 tries left" is how many wrong codes the card still accepts.
- While the SIM card waits for its PIN or PUK, FengSui raises a `SIM_LOCKED` alert. The PUK is usually printed on the holder the SIM card came in, or your operator has it.

<a id="esim"></a>

### SIM slot: physical card or built-in card

Some mobile routers have a built-in card (eSIM) next to the tray for a physical one; the operator writes its subscription remotely [[Ericsson: eSIM benefits](https://www.ericsson.com/en/blog/2019/11/esim-benefits)]. The "SIM slot" row shows which one the router uses.

<a id="roaming"></a>

### Roaming

Roaming means the router is connected through another operator's network, usually abroad [[3GPP TS 23.122](https://www.3gpp.org/DynaReport/23122.htm)]. Data while roaming may cost extra, so routers usually have a switch for using data abroad; FengSui shows whether it is on.

<a id="airplane-mode"></a>

### Airplane mode

Airplane mode turns the router's cellular radio off, so it cannot connect to the mobile network; the local network and Wi-Fi keep working, so FengSui still reaches the router [[3GPP TS 27.007](https://www.3gpp.org/DynaReport/27007.htm)]. If it shows "On" and nobody turned it on on purpose, turn it off: in the [Controls drawer](router-switches.md#cellular-settings) on routers where FengSui can switch airplane mode, on the router's own web page otherwise.

## Carrier aggregation

Lists every carrier the router is currently using together, such as `B1(20M) + B3(20M) + n78(100M)`. More carriers and wider bandwidth provide higher peak speeds. To learn what these notations mean, see [Bands, carriers, and cells](bands-and-cells.md#ca).

## Signal

Split into 5G and 4G sections, this card shows signal strength, quality, modulation, transmit power, and other metrics. To learn what each number means, what counts as good, and what to do when the signal is poor, see [Understand signal readings](signal.md).

The three most important numbers are **RSRP** (signal strength), **RSRQ** (signal quality), and **SINR** (signal purity). Ring colors indicate rating levels from good to poor. Cell identifiers (TAC, Cell ID, eNodeB) are masked by default.

## Nearby cells

Lists neighboring cells the router detects, sorted by signal strength. The cell labeled "Serving" is the active one. You can click "Lock to this cell" on any row; see [Lock bands and cells](locking.md#lock-cell). The table refreshes every minute, or you can click "Scan now" to scan immediately.

## Data usage

- **Real-time rates**: upload and download rate curves.
- **Daily and monthly usage**: two gauge rings. Click "Usage caps" to set a monthly data cap; the ring changes color and triggers an alert when exceeded. The billing day follows the router's setting.

## Status

Uptime, number of connected devices, response time of the last read from the router, and lock status. FengSui checks whether the locks on the router match what it applied; if they differ, it displays "differs from router".

Where the router reports them, it also shows:

- **Battery** (mobile routers): the charge, whether it is charging, the router's estimate until full or empty, and the battery temperature. On battery at 20 % or less, FengSui raises an alert (`BATTERY_LOW`; the threshold is in the [Configuration reference](configuration.md)).
- **Temperature**: the hottest sensor; where the router reports its modem, power amplifier, Wi-Fi and other sensors apart, a line below lists each.
- **Router load**: the router's own CPU and memory use.
- **Wi-Fi**: whether Wi-Fi and the guest network are on.
- **Firmware update**: shown when the router knows of a newer firmware; you update it on the router's own web page.
- When the router does not report its own uptime, "Uptime" shows "—".

## Historical charts

View rate and signal trends for the last 1, 6, 12, or 24 hours, or a custom time range. Drag the brush bar at the bottom to zoom into a specific period. Data points sampled every 5 seconds are kept for 3 hours, then aggregated by minute and kept for 7 days.

## Connected devices

Lists devices connected to the router: device name, connection type (wired or 2.4G/5G Wi-Fi), IP address, link speed, and DHCP lease duration. Wi-Fi devices feature "Block / Restore" buttons. For more management options, see [Manage devices and access](devices.md).

## Appearance

Switch between Chinese and English and choose a theme in the top right corner. FengSui includes 14 themes (7 light and 7 dark). When following the system appearance, you can pick separate themes for day and night, or create a custom theme using three colors. Preferences are saved only in your browser.
