---
title: Supported devices
description: The router FengSui is verified on, what FengSui does on every model the interface notes record, and how a cell turns into ✓.
section: Get started
order: 2
---

**So far FengSui is verified on the Huawei H168-383 (firmware 4.4.0.1) only.** Below, by brand, is every model the interface notes record, and what FengSui does on it. Nobody has verified FengSui on these models on a real router yet; what FengSui implements for them works straight away, and its writes are on by default. You can turn each write off under Settings → Device.

You do not need to know which interface your router uses: leave the brand on "Detect automatically" under Settings → Router, and FengSui tells the brand before it signs in. If your model is not listed, try it anyway: models of one brand mostly share an interface, and FengSui works as it does for the brand. How FengSui works on these routers is under [Other models and brands](other-routers.md). Settings → Device in the console shows your router's row of this table.

To see what FengSui looks like on a router nobody verified, open the [live demo's other-model mode](https://cky008.github.io/fengsui-demo/?router=other).

<!-- devices:begin -->
What the marks mean:

- **✓ Verified**: someone confirmed it on a real router, and it is recorded in the code (`VERIFIED_FEATURES`). Everything is verified on the H168-383 but the Battery, SIM card, Airplane mode, Network mode & operator, Data settings and USSD columns (added later: readings are marked from the facts like any other model, and FengSui does not do the new writes there yet); it also works as usual on another firmware build and warns once with `FIRMWARE_UNVERIFIED`.
- **? Waiting for a report**: FengSui implements it from the interface notes and it is on by default; nobody has confirmed it on a real router yet. Each write is sent once and read back, and you can turn each one off under Settings → Device.
- **△ Partly, or with a condition**: the conditions are under each brand's table.
- **— Not available**: the router or its interface does not have the feature (a CPE has no battery), or someone tested it and it did not work.
- An empty cell: FengSui does not do this there yet.
- Where a cell has more than one mark, they follow the column's parts in order: SMS is reading / sending and managing; Reboot & redial is reboot / redial; Router switches is the security switches / Wi-Fi 7 / the antenna; SIM card is its status / switching slots / the PIN; Airplane mode is its state / the switch; Network mode & operator is the network mode / choosing the operator; Data settings is data roaming / the access point (APN) / the data limit / clearing the traffic counters.
- "Router switches" are the security switches, Wi-Fi 7 and the antenna, where the router has them (Wi-Fi 7, for one, takes a Wi-Fi 7 router).
- Where the Interface column names two, detection connects through the first; you can choose the other under Settings → Router.

Brands: [Huawei](#brand-huawei) · [Brovi](#brand-brovi) · [TD Tech](#brand-td-tech) · [SoyeaLink](#brand-soyealink) · [ZTE](#brand-zte) · [Pinsu](#brand-pinsu) · [Tozed / ZLT (also China Unicom VN007)](#brand-tozed) · [FiberHome](#brand-fiberhome) · [NRadio](#brand-nradio) · [OpenWrt with a Quectel or Fibocom module](#brand-openwrt) · [UNISOC and Qualcomm reference designs](#brand-reference) · [D-Link](#brand-dlink) · [TP-Link](#brand-tplink)

<a id="brand-huawei"></a>

## Huawei

Usually at `192.168.8.1`; sign in with the user name `admin` and the admin password. Leave the brand on "Detect automatically" under Settings → Router, or choose "Huawei (HiLink, also Brovi, TD Tech, SoyeaLink)".

| Model | Form | Signal & traffic | Nearby cells | Connected devices | SMS | Band lock | Cell lock | Reboot & redial | Mobile data | Router switches | Access control | Battery | SIM card | Airplane mode | Network mode & operator | Data settings | USSD | Your results |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :--- |
| H168-383 | Indoor CPE | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — |  |  |  |  |  |  |
| H165-383 | Indoor CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+H165-383) |
| H158-381 | Indoor CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+H158-381) |
| H155-381 | Indoor CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+H155-381) |
| H155-382 | Indoor CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+H155-382) |
| H155-383 | Indoor CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+H155-383) |
| H153-381 | Indoor CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+H153-381) |
| H138-380 | Indoor CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+H138-380) |
| H122-373 | Indoor CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+H122-373) |
| H112-373 | Indoor CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+H112-373) |
| H112-372 | Indoor CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+H112-372) |
| H112-370 | Indoor CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+H112-370) |
| H352-381 | Outdoor CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+H352-381) |
| H312-371 | Outdoor CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+H312-371) |
| N5368X | Outdoor CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+N5368X) |
| B818-263 | Indoor CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B818-263) |
| B818-260 | Indoor CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B818-260) |
| B715s-23c | Indoor CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B715s-23c) |
| B628-265 | Indoor CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B628-265) |
| B628-350 | Indoor CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B628-350) |
| B618s-22d | Indoor CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B618s-22d) |
| B618s-65d | Indoor CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B618s-65d) |
| B612-233 | Indoor CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B612-233) |
| B612s-25d | Indoor CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B612s-25d) |
| B535-836 | Indoor CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B535-836) |
| B535-232 | Indoor CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B535-232) |
| B528s-23a | Indoor CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B528s-23a) |
| B525s-23a | Indoor CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B525s-23a) |
| B525s-65a | Indoor CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B525s-65a) |
| B316-855 | Indoor CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B316-855) |
| B315s-22 | Indoor CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B315s-22) |
| B315s-936 | Indoor CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B315s-936) |
| B311-221 | Indoor CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B311-221) |
| B311-521 | Indoor CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B311-521) |
| B311As-853 | Indoor CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B311As-853) |
| B311B-853 | Indoor CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B311B-853) |
| B310s-22 | Indoor CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B310s-22) |
| B310s-927 | Indoor CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B310s-927) |
| B310As-852 | Indoor CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B310As-852) |
| E5180s-22 | Indoor CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E5180s-22) |
| E5186s-22a | Indoor CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E5186s-22a) |
| E6888-982 | Mobile router | ? | △ | ? | ? | △ |  | ? | ? |  |  | ? |  |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E6888-982) |
| E6878-370 | Mobile router | ? | △ | ? | ? | △ |  | ? | ? |  |  | ? |  |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E6878-370) |
| E6878-870 | Mobile router | ? | △ | ? | ? | △ |  | ? | ? |  |  | ? |  |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E6878-870) |
| E5885Ls-93a | Mobile router | ? | △ | ? | ? | △ |  | ? | ? |  |  | ? |  |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E5885Ls-93a) |
| E5785-320 | Mobile router | ? | △ | ? | ? | △ |  | ? | ? |  |  | ? |  |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E5785-320) |
| E5785Lh-22c | Mobile router | ? | △ | ? | ? | △ |  | ? | ? |  |  | ? |  |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E5785Lh-22c) |
| E5577Cs-321 | Mobile router | ? | △ | ? | ? | △ |  | ? | ? |  |  | ? |  |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E5577Cs-321) |
| E5576-320 | Mobile router | ? | △ | ? | ? | △ |  | ? | ? |  |  | ? |  |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E5576-320) |
| E5576-855 | Mobile router | ? | △ | ? | ? | △ |  | ? | ? |  |  | ? |  |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E5576-855) |
| E5573s-320 | Mobile router | ? | △ | ? | ? | △ |  | ? | ? |  |  | ? |  |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E5573s-320) |
| E8231 | USB modem | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E8231) |
| E8372h-153 | USB modem | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E8372h-153) |
| E8372h-320 | USB modem | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E8372h-320) |
| E8372h-608 | USB modem | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E8372h-608) |
| E3372 | USB modem | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E3372) |
| E3372h-153 | USB modem | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E3372h-153) |
| E3131 | USB modem | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E3131) |
| E3531 | USB modem | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E3531) |
| E5530As-2 | USB modem | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E5530As-2) |

Notes for this table:

- — Battery: only a mobile router has a battery (H168-383, H165-383, H158-381, H155-381, H155-382, H155-383, H153-381, H138-380, H122-373, H112-373, H112-372, H112-370, H352-381, H312-371, N5368X, B818-263, B818-260, B715s-23c, B628-265, B628-350, B618s-22d, B618s-65d, B612-233, B612s-25d, B535-836, B535-232, B528s-23a, B525s-23a, B525s-65a, B316-855, B315s-22, B315s-936, B311-221, B311-521, B311As-853, B311B-853, B310s-22, B310s-927, B310As-852, E5180s-22, E5186s-22a, E8231, E8372h-153, E8372h-320, E8372h-608, E3372, E3372h-153, E3131, E3531 and E5530As-2).
- △ Nearby cells: FengSui reads the H168-383's nearby-cells endpoint; a router without it leaves this empty (every model but the H168-383).
- △ Band lock: locks 4G (LTE) bands only; FengSui locks 5G bands on a verified model only (every model but the H168-383).
- △ Data settings: data roaming and clearing the traffic counters only; FengSui does not do the access point (APN) and the data limit here yet (every model but the H168-383).
- A USB modem connects only in HiLink mode, with its web interface (E8231, E8372h-153, E8372h-320, E8372h-608, E3372, E3372h-153, E3131, E3531 and E5530As-2).

<a id="brand-brovi"></a>

## Brovi

Usually at `192.168.8.1`; sign in with the user name `admin` and the admin password. Leave the brand on "Detect automatically" under Settings → Router, or choose "Huawei (HiLink, also Brovi, TD Tech, SoyeaLink)".

| Model | Form | Signal & traffic | Nearby cells | Connected devices | SMS | Band lock | Cell lock | Reboot & redial | Mobile data | Router switches | Access control | Battery | SIM card | Airplane mode | Network mode & operator | Data settings | USSD | Your results |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :--- |
| H155-380 | Indoor CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+H155-380) |
| H151-370 | Indoor CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+H151-370) |

Notes for this table:

- △ Nearby cells: FengSui reads the H168-383's nearby-cells endpoint; a router without it leaves this empty (every model in this table).
- △ Band lock: locks 4G (LTE) bands only; FengSui locks 5G bands on a verified model only (every model in this table).
- — Battery: only a mobile router has a battery (every model in this table).
- △ Data settings: data roaming and clearing the traffic counters only; FengSui does not do the access point (APN) and the data limit here yet (every model in this table).

<a id="brand-td-tech"></a>

## TD Tech

Usually at `192.168.8.1`; sign in with the user name `admin` and the admin password. Leave the brand on "Detect automatically" under Settings → Router, or choose "Huawei (HiLink, also Brovi, TD Tech, SoyeaLink)".

| Model | Form | Signal & traffic | Nearby cells | Connected devices | SMS | Band lock | Cell lock | Reboot & redial | Mobile data | Router switches | Access control | Battery | SIM card | Airplane mode | Network mode & operator | Data settings | USSD | Your results |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :--- |
| MT5710-CN | Industrial gateway | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MT5710-CN) |
| MH5000-31 | Industrial gateway | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MH5000-31) |
| MH5000-82M | Industrial gateway | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MH5000-82M) |
| MT5700M-CN | Module | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MT5700M-CN) |

Notes for this table:

- △ Nearby cells: FengSui reads the H168-383's nearby-cells endpoint; a router without it leaves this empty (every model in this table).
- △ Band lock: locks 4G (LTE) bands only; FengSui locks 5G bands on a verified model only (every model in this table).
- — Battery: only a mobile router has a battery (every model in this table).
- △ Data settings: data roaming and clearing the traffic counters only; FengSui does not do the access point (APN) and the data limit here yet (every model in this table).

<a id="brand-soyealink"></a>

## SoyeaLink

Usually at `192.168.8.1`; sign in with the user name `admin` and the admin password. Leave the brand on "Detect automatically" under Settings → Router, or choose "Huawei (HiLink, also Brovi, TD Tech, SoyeaLink)".

| Model | Form | Signal & traffic | Nearby cells | Connected devices | SMS | Band lock | Cell lock | Reboot & redial | Mobile data | Router switches | Access control | Battery | SIM card | Airplane mode | Network mode & operator | Data settings | USSD | Your results |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :--- |
| B535-333 | Indoor CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B535-333) |
| B535-932 | Indoor CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B535-932) |
| B628-540 | Indoor CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B628-540) |
| SLT869-A51 | Indoor CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+SLT869-A51) |
| SRT873 | Indoor CPE | ? | △ | ? | ? | △ |  | ? | ? |  |  | — |  |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+SRT873) |

Notes for this table:

- △ Nearby cells: FengSui reads the H168-383's nearby-cells endpoint; a router without it leaves this empty (every model in this table).
- △ Band lock: locks 4G (LTE) bands only; FengSui locks 5G bands on a verified model only (every model in this table).
- — Battery: only a mobile router has a battery (every model in this table).
- △ Data settings: data roaming and clearing the traffic counters only; FengSui does not do the access point (APN) and the data limit here yet (every model in this table).

<a id="brands"></a>

<a id="brand-zte"></a>

## ZTE

Usually at `192.168.0.1`; sign in with the admin password (there is no user name). Leave the brand on "Detect automatically" under Settings → Router, or choose "ZTE (zWRT interface: G5, U60, U50 series)" or "ZTE (goform web interface)".

| Model | Form | Interface | Signal & traffic | Nearby cells | Connected devices | SMS | Band lock | Cell lock | Reboot & redial | Mobile data | Router switches | Access control | Battery | SIM card | Airplane mode | Network mode & operator | Data settings | USSD | Your results |
| :--- | :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :--- |
| U60 Pro (MU5250) | Mobile router | zWRT · goform | ? |  |  | ? | ? | △ | ? | ? |  |  | ? | ? |  | ? | △ |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+U60+Pro+%28MU5250%29) |
| G5 Ultra (MC8530) | Indoor CPE | zWRT · goform | ? |  |  | ? | ? | △ | ? | ? |  |  | — | ? |  | ? | △ |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+G5+Ultra+%28MC8530%29) |
| G5 Ultra (MC8531) | Indoor CPE | zWRT · goform | ? |  |  | ? | ? | △ | ? | ? |  |  | — | ? |  | ? | △ |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+G5+Ultra+%28MC8531%29) |
| G5 Pro (MC8512) | Indoor CPE | zWRT · goform | ? |  |  | ? | ? | △ | ? | ? |  |  | — | ? |  | ? | △ |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+G5+Pro+%28MC8512%29) |
| G5TS (MC8520) | Indoor CPE | zWRT · goform | ? |  |  | ? | ? | △ | ? | ? |  |  | — | ? |  | ? | △ |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+G5TS+%28MC8520%29) |
| G5F | Indoor CPE | zWRT · goform | ? |  |  | ? | ? | △ | ? | ? |  |  | — | ? |  | ? | △ |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+G5F) |
| MC888D | Indoor CPE | zWRT · goform | ? |  |  | ? | ? | △ | ? | ? |  |  | — | ? |  | ? | △ |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MC888D) |
| U50 Pro (MU5120) | Mobile router | zWRT · goform | ? |  |  | ? | ? | △ | ? | ? |  |  | ? | ? |  | ? | △ |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+U50+Pro+%28MU5120%29) |
| MC8510 | Indoor CPE | goform | ? | ? | ? | ? | ? | ? | ? | ? |  |  | — | ? |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MC8510) |
| G5C | Indoor CPE | goform | ? | ? | ? | ? | ? | ? | ? | ? |  |  | — | ? |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+G5C) |
| G5B | Indoor CPE | goform | ? | ? | ? | ? | ? | ? | ? | ? |  |  | — | ? |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+G5B) |
| MC888 Ultra | Indoor CPE | goform | ? | ? | ? | ? | △ | △ | ? | ? |  |  | — | ? |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MC888+Ultra) |
| MC888 Pro | Indoor CPE | goform | ? | ? | ? | ? | △ | △ | ? | ? |  |  | — | ? |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MC888+Pro) |
| MC888 | Indoor CPE | goform | ? | ? | ? | ? | △ | △ | ? | ? |  |  | — | ? |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MC888) |
| MC888S | Indoor CPE | goform | ? | ? | ? | ? | △ | △ | ? | ? |  |  | — | ? |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MC888S) |
| MC8020 | Indoor CPE | goform | ? | ? | ? | ? | △ | △ | ? | ? |  |  | — | ? |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MC8020) |
| MC801A | Indoor CPE | goform | ? | ? | ? | ? | ? | ? | ? | ? |  |  | — | ? |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MC801A) |
| MC801A1 | Indoor CPE | goform | ? | ? | ? | ? | ? | ? | ? | ? |  |  | — | ? |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MC801A1) |
| MC801 | Indoor CPE | goform | ? | ? | ? | ? | ? | ? | ? | ? |  |  | — | ? |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MC801) |
| MC889 Pro | Outdoor CPE | goform | ? | ? | ? | ? | ? | ? | ? | ? |  |  | — | ? |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MC889+Pro) |
| MC889A Pro | Outdoor CPE | goform | ? | ? | ? | ? | ? | ? | ? | ? |  |  | — | ? |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MC889A+Pro) |
| MC889 | Outdoor CPE | goform | ? | ? | ? | ? | ? | ? | ? | ? |  |  | — | ? |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MC889) |
| MC7010 | Outdoor CPE | goform | ? | ? | ? | ? | ? | ? | ? | ? |  |  | — | ? |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MC7010) |
| MC7010D | Outdoor CPE | goform | ? | ? | ? | ? | ? | ? | ? | ? |  |  | — | ? |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MC7010D) |
| MC8830 | Industrial gateway | goform | ? | ? | ? | ? | △ | △ | ? | ? |  |  | — | ? |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MC8830) |
| MU5001 | Mobile router | goform | ? | ? | ? | ? | ? | ? | ? | ? |  |  | ? | ? |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MU5001) |
| MU5001A | Mobile router | goform | ? | ? | ? | ? | ? | ? | ? | ? |  |  | ? | ? |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MU5001A) |
| MU5001U | Mobile router | goform | ? | ? | ? | ? | ? | ? | ? | ? |  |  | ? | ? |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MU5001U) |
| MU5002 | Mobile router | goform | ? | ? | ? | ? | ? | ? | ? | ? |  |  | ? | ? |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MU5002) |
| MU510 | Mobile router | goform | ? | ? | ? | ? | ? | ? | ? | ? |  |  | ? | ? |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MU510) |
| U50 | Mobile router | goform | ? | ? | ? | ? | ? | ? | ? | ? |  |  | ? | ? |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+U50) |
| U50S | Mobile router | goform | ? | ? | ? | ? | ? | ? | ? | ? |  |  | ? | ? |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+U50S) |
| U30 Air | Mobile router | goform | ? | ? | ? | ? | ? | ? | ? | ? |  |  | ? | ? |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+U30+Air) |
| U10S Pro | Mobile router | goform | ? | ? | ? | ? | ? | ? | ? | ? |  |  | ? | ? |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+U10S+Pro) |
| F50 Pro | Mobile router | goform | ? | ? | ? | ? | △ | △ | ? | ? |  |  | ? | ? |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+F50+Pro) |
| F50 | Mobile router | goform | ? | ? | ? | ? | △ | △ | ? | ? |  |  | ? | ? |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+F50) |
| MF971R | Mobile router | goform | ? | ? | ? | ? | ? | ? | ? | ? |  |  | ? | ? |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MF971R) |
| MF935 | Mobile router | goform | ? | ? | ? | ? | ? | ? | ? | ? |  |  | ? | ? |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MF935) |
| MF920U | Mobile router | goform | ? | ? | ? | ? | ? | ? | ? | ? |  |  | ? | ? |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MF920U) |
| MF79U | USB modem | goform | ? | ? | ? | ? | △ | △ | ? | ? |  |  | — | ? |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MF79U) |
| MF297D | Indoor CPE | goform | ? | ? | ? | ? | ? | ? | ? | ? |  |  | — | ? |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MF297D) |
| MF289F | Indoor CPE | goform | ? | ? | ? | ? | ? | ? | ? | ? |  |  | — | ? |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MF289F) |
| MF286 | Indoor CPE | goform | ? | ? | ? | ? | ? | ? | ? | ? |  |  | — | ? |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MF286) |
| MF286A | Indoor CPE | goform | ? | ? | ? | ? | ? | ? | ? | ? |  |  | — | ? |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MF286A) |
| MF286C | Indoor CPE | goform | ? | ? | ? | ? | ? | ? | ? | ? |  |  | — | ? |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MF286C) |
| MF286D | Indoor CPE | goform | ? | ? | ? | ? | ? | ? | ? | ? |  |  | — | ? |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MF286D) |
| MF286R | Indoor CPE | goform | ? | ? | ? | ? | ? | ? | ? | ? |  |  | — | ? |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MF286R) |
| MF283+ | Indoor CPE | goform | ? | ? | ? | ? | ? | ? | ? | ? |  |  | — | ? |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MF283%2B) |
| MF283U | Indoor CPE | goform | ? | ? | ? | ? | ? | ? | ? | ? |  |  | — | ? |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MF283U) |
| MF253S | Indoor CPE | goform | ? | ? | ? | ? | ? | ? | ? | ? |  |  | — | ? |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MF253S) |

Notes for this table:

- △ Cell lock: locks 5G cells only, not 4G cells (U60 Pro (MU5250), G5 Ultra (MC8530), G5 Ultra (MC8531), G5 Pro (MC8512), G5TS (MC8520), G5F, MC888D and U50 Pro (MU5120)).
- △ Data settings: data roaming, the access point (APN) and the data limit only; FengSui does not do clearing the traffic counters here yet (every model in this table).
- SMS is read from and written to the router's own storage; messages kept on the SIM card are not shown (every model in this table).
- — Battery: only a mobile router has a battery (G5 Ultra (MC8530), G5 Ultra (MC8531), G5 Pro (MC8512), G5TS (MC8520), G5F, MC888D, MC8510, G5C, G5B, MC888 Ultra, MC888 Pro, MC888, MC888S, MC8020, MC801A, MC801A1, MC801, MC889 Pro, MC889A Pro, MC889, MC7010, MC7010D, MC8830, MF79U, MF297D, MF289F, MF286, MF286A, MF286C, MF286D, MF286R, MF283+, MF283U and MF253S).
- △ Band lock, Cell lock: before the lock FengSui opens the router's developer options with the same admin password, and names it in the write's record (MC888 Ultra, MC888 Pro, MC888, MC888S, MC8020, MC8830, F50 Pro, F50 and MF79U).

<a id="brand-pinsu"></a>

## Pinsu

Usually at `192.168.0.1`; sign in with the user name `admin` and the admin password. Leave the brand on "Detect automatically" under Settings → Router, or choose "Pinsu".

| Model | Form | Signal & traffic | Nearby cells | Connected devices | SMS | Band lock | Cell lock | Reboot & redial | Mobile data | Router switches | Access control | Battery | SIM card | Airplane mode | Network mode & operator | Data settings | USSD | Your results |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :--- |
| R200C | Indoor CPE | ? |  |  |  | ? | ? | △ |  |  |  |  |  |  | △ |  |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+R200C) |
| R200 | Indoor CPE | ? |  |  |  | ? | ? | △ |  |  |  |  |  |  | △ |  |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+R200) |
| R200P | Indoor CPE | ? |  |  |  | ? | ? | △ |  |  |  |  |  |  | △ |  |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+R200P) |
| R100 | Indoor CPE | ? |  |  |  | ? | ? | △ |  |  |  |  |  |  | △ |  |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+R100) |
| PS-R500 | Indoor CPE | ? |  |  |  | ? | ? | △ |  |  |  |  |  |  | △ |  |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+PS-R500) |
| PS-R600 | Indoor CPE | ? |  |  |  | ? | ? | △ |  |  |  |  |  |  | △ |  |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+PS-R600) |
| U200 | Mobile router | ? |  |  |  | ? | ? | △ |  |  |  |  |  |  | △ |  |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+U200) |
| M1 | Mobile router | ? |  |  |  | ? | ? | △ |  |  |  |  |  |  | △ |  |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+M1) |
| M200 | Mobile router | ? |  |  |  | ? | ? | △ |  |  |  |  |  |  | △ |  |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+M200) |
| M200 Pro | Mobile router | ? |  |  |  | ? | ? | △ |  |  |  |  |  |  | △ |  |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+M200+Pro) |
| PS-M50 | Mobile router | ? |  |  |  | ? | ? | △ |  |  |  |  |  |  | △ |  |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+PS-M50) |
| F10 | Mobile router | ? |  |  |  | ? | ? | △ |  |  |  |  |  |  | △ |  |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+F10) |

Notes for this table:

- △ Reboot & redial: reboot only; FengSui does not do redial here yet (every model in this table).
- △ Network mode & operator: the network mode only; FengSui does not do choosing the operator here yet (every model in this table).

<a id="brand-tozed"></a>

## Tozed / ZLT (also China Unicom VN007)

Usually at `192.168.0.1`; sign in with the user name and password of the router's page. Leave the brand on "Detect automatically" under Settings → Router, or choose "Tozed / ZLT (also China Unicom VN007)" or "ZTE (goform web interface)".

| Model | Form | Interface | Signal & traffic | Nearby cells | Connected devices | SMS | Band lock | Cell lock | Reboot & redial | Mobile data | Router switches | Access control | Battery | SIM card | Airplane mode | Network mode & operator | Data settings | USSD | Your results |
| :--- | :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :--- |
| VN007 | Indoor CPE | Tozed | ? | ? |  | ?/△ | ? | ? | △ |  |  |  |  |  |  | △ |  |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+VN007) |
| VN007+ | Indoor CPE | Tozed | ? | ? |  | ?/△ | ? | ? | △ |  |  |  |  |  |  | △ |  |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+VN007%2B) |
| VN009 | Indoor CPE | Tozed | ? | ? |  | ?/△ | ? | ? | △ |  |  |  |  |  |  | △ |  |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+VN009) |
| ZLT X20 | Indoor CPE | Tozed | ? | ? |  | ?/△ | ? | ? | △ |  |  |  |  |  |  | △ |  |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+ZLT+X20) |
| ZLT X21 | Indoor CPE | Tozed | ? | ? |  | ?/△ | ? | ? | △ |  |  |  |  |  |  | △ |  |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+ZLT+X21) |
| ZLT X21G | Indoor CPE | Tozed | ? | ? |  | ?/△ | ? | ? | △ |  |  |  |  |  |  | △ |  |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+ZLT+X21G) |
| ZLT X25 | Indoor CPE | Tozed | ? | ? |  | ?/△ | ? | ? | △ |  |  |  |  |  |  | △ |  |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+ZLT+X25) |
| ZLT X28 | Indoor CPE | Tozed | ? | ? |  | ?/△ | ? | ? | △ |  |  |  |  |  |  | △ |  |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+ZLT+X28) |
| ZLT X28 Pro | Indoor CPE | Tozed | ? | ? |  | ?/△ | ? | ? | △ |  |  |  |  |  |  | △ |  |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+ZLT+X28+Pro) |
| ZLT X30 | Indoor CPE | Tozed | ? | ? |  | ?/△ | ? | ? | △ |  |  |  |  |  |  | △ |  |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+ZLT+X30) |
| ZLT X100 | Indoor CPE | Tozed | ? | ? |  | ?/△ | ? | ? | △ |  |  |  |  |  |  | △ |  |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+ZLT+X100) |
| ZLT X300M | Indoor CPE | Tozed | ? | ? |  | ?/△ | ? | ? | △ |  |  |  |  |  |  | △ |  |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+ZLT+X300M) |
| LT500 | Indoor CPE | Tozed | ? | ? |  | ?/△ | ? | ? | △ |  |  |  |  |  |  | △ |  |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+LT500) |
| ZLT S10 | Indoor CPE | Tozed | ? | ? |  | ?/△ | ? | ? | △ |  |  |  |  |  |  | △ |  |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+ZLT+S10) |
| ZLT S10G | Indoor CPE | Tozed | ? | ? |  | ?/△ | ? | ? | △ |  |  |  |  |  |  | △ |  |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+ZLT+S10G) |
| ZLT S12 Pro | Indoor CPE | Tozed | ? | ? |  | ?/△ | ? | ? | △ |  |  |  |  |  |  | △ |  |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+ZLT+S12+Pro) |
| ZLT S20 | Indoor CPE | Tozed | ? | ? |  | ?/△ | ? | ? | △ |  |  |  |  |  |  | △ |  |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+ZLT+S20) |
| ZLT S25 | Indoor CPE | Tozed | ? | ? |  | ?/△ | ? | ? | △ |  |  |  |  |  |  | △ |  |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+ZLT+S25) |
| ZLT S50 | Indoor CPE | Tozed | ? | ? |  | ?/△ | ? | ? | △ |  |  |  |  |  |  | △ |  |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+ZLT+S50) |
| ZLT X11 | Outdoor CPE | Tozed | ? | ? |  | ?/△ | ? | ? | △ |  |  |  |  |  |  | △ |  |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+ZLT+X11) |
| ZLT P11 | Outdoor CPE | Tozed | ? | ? |  | ?/△ | ? | ? | △ |  |  |  |  |  |  | △ |  |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+ZLT+P11) |
| ZLT P28 | Outdoor CPE | Tozed | ? | ? |  | ?/△ | ? | ? | △ |  |  |  |  |  |  | △ |  |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+ZLT+P28) |
| ZLT T30 | Outdoor CPE | Tozed | ? | ? |  | ?/△ | ? | ? | △ |  |  |  |  |  |  | △ |  |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+ZLT+T30) |
| ZLT T20 | Industrial gateway | Tozed | ? | ? |  | ?/△ | ? | ? | △ |  |  |  |  |  |  | △ |  |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+ZLT+T20) |
| MP510 | Industrial gateway | Tozed | ? | ? |  | ?/△ | ? | ? | △ |  |  |  |  |  |  | △ |  |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MP510) |
| ZLT M30S | Mobile router | Tozed · goform | ? | ? |  | ?/△ | ? | ? | △ |  |  |  |  |  |  | △ |  |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+ZLT+M30S) |
| ZLT M60 | Mobile router | Tozed | ? | ? |  | ?/△ | ? | ? | △ |  |  |  |  |  |  | △ |  |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+ZLT+M60) |
| ZLT T10D MAX | Indoor CPE | goform | ? | ? | ? | ? | △ | △ | ? | ? |  |  | — | ? |  | ? | △ | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+ZLT+T10D+MAX) |

Notes for this table:

- △ SMS: sends messages; the router's interface has no command on record to delete a message or to mark one read, so FengSui can do neither here (every model but the ZLT T10D MAX).
- △ Reboot & redial: reboot only; FengSui does not do redial here yet (every model but the ZLT T10D MAX).
- △ Network mode & operator: the network mode only; FengSui does not do choosing the operator here yet (every model but the ZLT T10D MAX).
- FengSui keeps track of what you have not read (it cannot change the router's own unread mark) (every model but the ZLT T10D MAX).
- Some operator builds wrap the interface in a layer of encryption; FengSui cannot connect to those (every model but the ZLT T10D MAX).
- △ Band lock, Cell lock: the notes on this 4G firmware name no band lock or cell lock, so FengSui sends the forms of ZTE's goform pages, which the router may not take; the network mode can be automatic or 4G only (ZLT T10D MAX).
- — Battery: only a mobile router has a battery (ZLT T10D MAX).
- △ Data settings: data roaming, the access point (APN) and the data limit only; FengSui does not do clearing the traffic counters here yet (ZLT T10D MAX).
- SMS is read from and written to the router's own storage; messages kept on the SIM card are not shown (ZLT T10D MAX).
- A 4G router on ZTE's chip platform: it uses another spelling of ZTE's interface (`/reqproc/`), which FengSui recognises when it connects (ZLT T10D MAX).

<a id="brand-fiberhome"></a>

## FiberHome

Usually at `192.168.8.1`; sign in with the user name `admin` and the admin password. Leave the brand on "Detect automatically" under Settings → Router, or choose "FiberHome".

| Model | Form | Signal & traffic | Nearby cells | Connected devices | SMS | Band lock | Cell lock | Reboot & redial | Mobile data | Router switches | Access control | Battery | SIM card | Airplane mode | Network mode & operator | Data settings | USSD | Your results |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :--- |
| LG6121F | Indoor CPE | ? | ? |  | △ | ? | ? | △ |  |  |  |  |  | ? | △ |  |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+LG6121F) |
| LG6151M | Indoor CPE | ? | ? |  | △ | ? | ? | △ |  |  |  |  |  | ? | △ |  |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+LG6151M) |
| LG6121 | Indoor CPE | ? | ? |  | △ | ? | ? | △ |  |  |  |  |  | ? | △ |  |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+LG6121) |
| LG522 | Indoor CPE | ? | ? |  | △ | ? | ? | △ |  |  |  |  |  | ? | △ |  |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+LG522) |
| LG6851F | Indoor CPE | △ |  |  | ?/△ |  |  |  |  |  |  |  |  |  |  |  |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+LG6851F) |

Notes for this table:

- △ SMS: SMS is on the encrypted interface of the router's own web page, which FengSui asks in the session it is signed in with; a router that wants a separate web sign-in for it leaves this empty (every model but the LG6851F).
- △ SMS: sends plain English text only (letters, digits and common punctuation: the one encoding on record), and never text with a backquote, a dollar sign, a double quote or a backslash, because the router hands the text to a command line; deletes a whole conversation at a time (every model but the LG6851F).
- △ Reboot & redial: reboot only; FengSui does not do redial here yet (every model but the LG6851F).
- △ Network mode & operator: the network mode only; FengSui does not do choosing the operator here yet (every model but the LG6851F).
- △ Signal & traffic: FengSui opens the router's encrypted answers with the token the router hands out (unsealed with the key fixed in this series' firmware) or the token on record; where neither opens them, FengSui sends no password and this stays empty (LG6851F).
- △ SMS: marks messages read only: this firmware's interface notes have no way to send or delete one (LG6851F).
- FiberHome's Pro series: the same web interface under another path (`/fh_api/`) with another encryption key, which FengSui recognises when it connects. FengSui reads its signal (one serving cell), this month's traffic and SMS there, and can mark messages read; nearby cells, band lock, cell lock and reboot are not in its interface notes, so FengSui does not do them here (LG6851F).

<a id="brand-nradio"></a>

## NRadio

Usually at `192.168.66.1`; sign in with the user name `root` and the admin password. Leave the brand on "Detect automatically" under Settings → Router, or choose "NRadio".

| Model | Form | Signal & traffic | Nearby cells | Connected devices | SMS | Band lock | Cell lock | Reboot & redial | Mobile data | Router switches | Access control | Battery | SIM card | Airplane mode | Network mode & operator | Data settings | USSD | Your results |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :--- |
| C8-668GL | Indoor CPE | ? | ? | ? |  | △ | ? | ? | ? | △ |  |  |  |  | △ |  |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+C8-668GL) |
| C8-660 | Indoor CPE | ? | ? | ? |  | △ | ? | ? | ? | △ |  |  |  |  | △ |  |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+C8-660) |
| C8-620 | Indoor CPE | ? | ? | ? |  | △ | ? | ? | ? | △ |  |  |  |  | △ |  |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+C8-620) |
| C8-520 | Indoor CPE | ? | ? | ? |  | △ | ? | ? | ? | △ |  |  |  |  | △ |  |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+C8-520) |
| C8-500 | Indoor CPE | ? | ? | ? |  | △ | ? | ? | ? | △ |  |  |  |  | △ |  |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+C8-500) |
| C5800-500 | Indoor CPE | ? | ? | ? |  | △ | ? | ? | ? | △ |  |  |  |  | △ |  |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+C5800-500) |
| C2000 Ultra | Indoor CPE | ? | ? | ? |  | △ | ? | ? | ? | △ |  |  |  |  | △ |  |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+C2000+Ultra) |
| C2000 Max | Indoor CPE | ? | ? | ? |  | △ | ? | ? | ? | △ |  |  |  |  | △ |  |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+C2000+Max) |
| C2000 Pro | Indoor CPE | ? | ? | ? |  | △ | ? | ? | ? | △ |  |  |  |  | △ |  |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+C2000+Pro) |
| C2000 | Indoor CPE | ? | ? | ? |  | △ | ? | ? | ? | △ |  |  |  |  | △ |  |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+C2000) |
| C3000 | Industrial gateway | ? | ? | ? |  | △ | ? | ? | ? | △ |  |  |  |  | △ |  |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+C3000) |
| C5000 | Industrial gateway | ? | ? | ? |  | △ | ? | ? | ? | △ |  |  |  |  | △ |  |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+C5000) |
| C5200 | Industrial gateway | ? | ? | ? |  | △ | ? | ? | ? | △ |  |  |  |  | △ |  |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+C5200) |
| C9100 | Outdoor CPE | ? | ? | ? |  | △ | ? | ? | ? | △ |  |  |  |  | △ |  |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+C9100) |

Notes for this table:

- △ Band lock: locking 5G bands needs the cellular module to report its 5G band setting; a model that does not locks 4G bands only (every model in this table).
- △ Router switches: the antenna only; FengSui does not do the security switches and Wi-Fi 7 here yet (every model in this table).
- △ Network mode & operator: the network mode only; FengSui does not do choosing the operator here yet (every model in this table).

<a id="brand-openwrt"></a>

## OpenWrt with a Quectel or Fibocom module

Usually at `192.168.1.1`; sign in with the user name `root` and the admin password. Leave the brand on "Detect automatically" under Settings → Router, or choose "OpenWrt with a Quectel or Fibocom module".

| Model | Form | Signal & traffic | Nearby cells | Connected devices | SMS | Band lock | Cell lock | Reboot & redial | Mobile data | Router switches | Access control | Battery | SIM card | Airplane mode | Network mode & operator | Data settings | USSD | Your results |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :--- |
| Quectel RM551E-GL | Module | ? | ? | ? | ?/△ | ? | ? | △ | △ |  |  |  | △ | ? | ? | △ |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Quectel+RM551E-GL) |
| Quectel RM530N-GL | Module | ? | ? | ? | ?/△ | ? | ? | △ | △ |  |  |  | △ | ? | ? | △ |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Quectel+RM530N-GL) |
| Quectel RM520N-GL | Module | ? | ? | ? | ?/△ | ? | ? | △ | △ |  |  |  | △ | ? | ? | △ |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Quectel+RM520N-GL) |
| Quectel RM520N-CN | Module | ? | ? | ? | ?/△ | ? | ? | △ | △ |  |  |  | △ | ? | ? | △ |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Quectel+RM520N-CN) |
| Quectel RM521F-GL | Module | ? | ? | ? | ?/△ | ? | ? | △ | △ |  |  |  | △ | ? | ? | △ |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Quectel+RM521F-GL) |
| Quectel RM510Q-GL | Module | ? | ? | ? | ?/△ | ? | ? | △ | △ |  |  |  | △ | ? | ? | △ |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Quectel+RM510Q-GL) |
| Quectel RM505Q-AE | Module | ? | ? | ? | ?/△ | ? | ? | △ | △ |  |  |  | △ | ? | ? | △ |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Quectel+RM505Q-AE) |
| Quectel RM502Q-AE | Module | ? | ? | ? | ?/△ | ? | ? | △ | △ |  |  |  | △ | ? | ? | △ |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Quectel+RM502Q-AE) |
| Quectel RM502Q-GL | Module | ? | ? | ? | ?/△ | ? | ? | △ | △ |  |  |  | △ | ? | ? | △ |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Quectel+RM502Q-GL) |
| Quectel RM500Q-GL | Module | ? | ? | ? | ?/△ | ? | ? | △ | △ |  |  |  | △ | ? | ? | △ |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Quectel+RM500Q-GL) |
| Quectel RM500Q-AE | Module | ? | ? | ? | ?/△ | ? | ? | △ | △ |  |  |  | △ | ? | ? | △ |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Quectel+RM500Q-AE) |
| Quectel RM500U-CN | Module | ? | ? | ? | ?/△ | ? | ? | △ | △ |  |  |  | △ | ? | ? | △ |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Quectel+RM500U-CN) |
| Quectel RG650E | Module | ? | ? | ? | ?/△ | ? | ? | △ | △ |  |  |  | △ | ? | ? | △ |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Quectel+RG650E) |
| Quectel RG650V | Module | ? | ? | ? | ?/△ | ? | ? | △ | △ |  |  |  | △ | ? | ? | △ |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Quectel+RG650V) |
| Quectel RG520N-EU | Module | ? | ? | ? | ?/△ | ? | ? | △ | △ |  |  |  | △ | ? | ? | △ |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Quectel+RG520N-EU) |
| Quectel RG520N-EB | Module | ? | ? | ? | ?/△ | ? | ? | △ | △ |  |  |  | △ | ? | ? | △ |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Quectel+RG520N-EB) |
| Quectel RG520N-CN | Module | ? | ? | ? | ?/△ | ? | ? | △ | △ |  |  |  | △ | ? | ? | △ |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Quectel+RG520N-CN) |
| Quectel RG502Q-EA | Module | ? | ? | ? | ?/△ | ? | ? | △ | △ |  |  |  | △ | ? | ? | △ |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Quectel+RG502Q-EA) |
| Quectel RG501Q-EU | Module | ? | ? | ? | ?/△ | ? | ? | △ | △ |  |  |  | △ | ? | ? | △ |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Quectel+RG501Q-EU) |
| Quectel RG500Q-EA | Module | ? | ? | ? | ?/△ | ? | ? | △ | △ |  |  |  | △ | ? | ? | △ |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Quectel+RG500Q-EA) |
| Quectel RG500Q-CN | Module | ? | ? | ? | ?/△ | ? | ? | △ | △ |  |  |  | △ | ? | ? | △ |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Quectel+RG500Q-CN) |
| Quectel RG500U-CN | Module | ? | ? | ? | ?/△ | ? | ? | △ | △ |  |  |  | △ | ? | ? | △ |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Quectel+RG500U-CN) |
| Quectel RG200U-CN | Module | ? | ? | ? | ?/△ | ? | ? | △ | △ |  |  |  | △ | ? | ? | △ |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Quectel+RG200U-CN) |
| Quectel EM160R-GL | Module | ? | ? | ? | ?/△ | ? | ? | △ | △ |  |  |  | △ | ? | ? | △ |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Quectel+EM160R-GL) |
| Quectel EM12-G | Module | ? | ? | ? | ?/△ | ? | ? | △ | △ |  |  |  | △ | ? | ? | △ |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Quectel+EM12-G) |
| Quectel EC25 | Module | ? | ? | ? | ?/△ | ? | ? | △ | △ |  |  |  | △ | ? | ? | △ |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Quectel+EC25) |
| Quectel EC200U | Module | ? | ? | ? | ?/△ | ? | ? | △ | △ |  |  |  | △ | ? | ? | △ |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Quectel+EC200U) |
| Fibocom FG370 | Module | ? | ? | ? | ?/△ | △ | ? | △ | △ |  |  |  | △ | ? | ? | △ |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Fibocom+FG370) |
| Fibocom FG370-NA | Module | ? | ? | ? | ?/△ | △ | ? | △ | △ |  |  |  | △ | ? | ? | △ |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Fibocom+FG370-NA) |
| Fibocom FM350-GL | Module | ? | ? | ? | ?/△ | △ | ? | △ | △ |  |  |  | △ | ? | ? | △ |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Fibocom+FM350-GL) |
| Fibocom FM160-CN | Module | ? | ? | ? | ?/△ | △ | ? | △ | △ |  |  |  | △ | ? | ? | △ |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Fibocom+FM160-CN) |
| Fibocom FM160-EAU | Module | ? | ? | ? | ?/△ | △ | ? | △ | △ |  |  |  | △ | ? | ? | △ |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Fibocom+FM160-EAU) |
| Fibocom FG160-EAU | Module | ? | ? | ? | ?/△ | △ | ? | △ | △ |  |  |  | △ | ? | ? | △ |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Fibocom+FG160-EAU) |
| Fibocom FM150-AE | Module | ? | ? | ? | ?/△ | △ | ? | △ | △ |  |  |  | △ | ? | ? | △ |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Fibocom+FM150-AE) |
| Fibocom FG150-AE | Module | ? | ? | ? | ?/△ | △ | ? | △ | △ |  |  |  | △ | ? | ? | △ |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Fibocom+FG150-AE) |
| Fibocom FM650-CN | Module | ? | ? | ? | ?/△ | △ | ? | △ | △ |  |  |  | △ | ? | ? | △ |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Fibocom+FM650-CN) |
| Fibocom L860-GL | Module | ? | ? | ? | ?/△ | △ | ? | △ | △ |  |  |  | △ | ? | ? | △ |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Fibocom+L860-GL) |
| Fibocom L850-GL | Module | ? | ? | ? | ?/△ | △ | ? | △ | △ |  |  |  | △ | ? | ? | △ |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Fibocom+L850-GL) |
| GL.iNet GL-X3000 | Indoor CPE | ? | ? | ? | ?/△ | ? | ? | △ | △ |  |  |  | △ | ? | ? | △ |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+GL.iNet+GL-X3000) |
| GL.iNet GL-XE3000 | Mobile router | ? | ? | ? | ?/△ | ? | ? | △ | △ |  |  |  | △ | ? | ? | △ |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+GL.iNet+GL-XE3000) |
| GL.iNet GL-X750V2 | Indoor CPE | ? | ? | ? | ?/△ | ? | ? | △ | △ |  |  |  | △ | ? | ? | △ |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+GL.iNet+GL-X750V2) |
| GL.iNet GL-XE300 | Mobile router | ? | ? | ? | ?/△ | ? | ? | △ | △ |  |  |  | △ | ? | ? | △ |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+GL.iNet+GL-XE300) |
| Suncomm O1 | Indoor CPE | ? | ? | ? | ?/△ | ? | ? | △ | △ |  |  |  | △ | ? | ? | △ |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Suncomm+O1) |
| Suncomm O2 | Indoor CPE | ? | ? | ? | ?/△ | ? | ? | △ | △ |  |  |  | △ | ? | ? | △ |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Suncomm+O2) |
| Suncomm O8 Pro | Indoor CPE | ? | ? | ? | ?/△ | ? | ? | △ | △ |  |  |  | △ | ? | ? | △ |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Suncomm+O8+Pro) |
| Kunlun CP520 | Indoor CPE | ? | ? | ? | ?/△ | ? | ? | △ | △ |  |  |  | △ | ? | ? | △ |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Kunlun+CP520) |
| Kunlun OpenWrt 5G CPE | Indoor CPE | ? | ? | ? | ?/△ | ? | ? | △ | △ |  |  |  | △ | ? | ? | △ |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Kunlun+OpenWrt+5G+CPE) |
| Zhilian OpenWrt 5G CPE | Indoor CPE | ? | ? | ? | ?/△ | ? | ? | △ | △ |  |  |  | △ | ? | ? | △ |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Zhilian+OpenWrt+5G+CPE) |
| Trend-Link OpenWrt 5G CPE | Indoor CPE | ? | ? | ? | ?/△ | ? | ? | △ | △ |  |  |  | △ | ? | ? | △ |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Trend-Link+OpenWrt+5G+CPE) |
| QWRT RM520N | Indoor CPE | ? | ? | ? | ?/△ | ? | ? | △ | △ |  |  |  | △ | ? | ? | △ |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+QWRT+RM520N) |
| ROOter 5G | Indoor CPE | ? | ? | ? | ?/△ | ? | ? | △ | △ |  |  |  | △ | ? | ? | △ |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+ROOter+5G) |

Notes for this table:

- △ SMS: sending needs QModem on the router; on firmware without it FengSui reads and deletes messages but cannot send (every model in this table).
- △ Reboot & redial: "Reboot" restarts the cellular module, not the whole router (every model in this table).
- △ Reboot & redial, Mobile data: redial and the mobile data switch use QModem's own dial calls, so they need QModem on the router; on firmware without it FengSui sends no dial command (every model in this table).
- △ SIM card: only a Quectel module reports the PIN and PUK tries left (`AT+QPINC`); a Fibocom one reports whether the card is usable (every model in this table).
- △ SIM card: its status and the PIN only; FengSui does not do switching slots here yet (every model in this table).
- △ Data settings: the access point (APN) only; FengSui does not do data roaming, the data limit and clearing the traffic counters here yet (every model in this table).
- SMS is read from the storage the cellular module is set to (the SIM card or the module's own). The module marks a message read as soon as it lists it, so FengSui keeps track of what you have not read; the module keeps no copy of what it sends, so sent messages are kept by FengSui only (every model in this table).
- FengSui sends AT commands to the module through the router's ubus interface and tells Quectel from Fibocom itself (every model in this table).
- △ Band lock: a Fibocom module's network mode can be set to automatic or 5G standalone (SA) only (Fibocom FG370, Fibocom FG370-NA, Fibocom FM350-GL, Fibocom FM160-CN, Fibocom FM160-EAU, Fibocom FG160-EAU, Fibocom FM150-AE, Fibocom FG150-AE, Fibocom FM650-CN, Fibocom L860-GL and Fibocom L850-GL).

<a id="brand-reference"></a>

## UNISOC and Qualcomm reference designs

Usually at `192.168.0.1`; sign in with the user name `admin` and the admin password. Leave the brand on "Detect automatically" under Settings → Router, or choose "Tozed / ZLT (also China Unicom VN007)" or "Pinsu".

| Model | Form | Interface | Signal & traffic | Nearby cells | Connected devices | SMS | Band lock | Cell lock | Reboot & redial | Mobile data | Router switches | Access control | Battery | SIM card | Airplane mode | Network mode & operator | Data settings | USSD | Your results |
| :--- | :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :--- |
| UNISOC V510 mgdb | Indoor CPE | Pinsu | ? |  |  |  | ? | ? | △ |  |  |  |  |  |  | △ |  |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+UNISOC+V510+mgdb) |
| SRT838 | Indoor CPE | Tozed | ? | ? |  | ?/△ | ? | ? | △ |  |  |  |  |  |  | △ |  |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+SRT838) |
| SRT853 | Indoor CPE | Tozed | ? | ? |  | ?/△ | ? | ? | △ |  |  |  |  |  |  | △ |  |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+SRT853) |
| CPE905 | Indoor CPE | Tozed | ? | ? |  | ?/△ | ? | ? | △ |  |  |  |  |  |  | △ |  |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+CPE905) |
| FNR310 | Indoor CPE | Tozed | ? | ? |  | ?/△ | ? | ? | △ |  |  |  |  |  |  | △ |  |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+FNR310) |
| A50 | Indoor CPE | Tozed | ? | ? |  | ?/△ | ? | ? | △ |  |  |  |  |  |  | △ |  |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+A50) |
| H80 | Indoor CPE | Tozed | ? | ? |  | ?/△ | ? | ? | △ |  |  |  |  |  |  | △ |  |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+H80) |
| T1 | Indoor CPE | Tozed | ? | ? |  | ?/△ | ? | ? | △ |  |  |  |  |  |  | △ |  |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+T1) |

Notes for this table:

- △ Reboot & redial: reboot only; FengSui does not do redial here yet (every model in this table).
- △ Network mode & operator: the network mode only; FengSui does not do choosing the operator here yet (every model in this table).
- △ SMS: sends messages; the router's interface has no command on record to delete a message or to mark one read, so FengSui can do neither here (every model but the UNISOC V510 mgdb).
- FengSui keeps track of what you have not read (it cannot change the router's own unread mark) (every model but the UNISOC V510 mgdb).
- Some operator builds wrap the interface in a layer of encryption; FengSui cannot connect to those (every model but the UNISOC V510 mgdb).
- The notes say these use Tozed's `/cgi-bin/http.cgi` interface or a `/cgi-bin/lua.cgi` variant of it; FengSui implements the first only (every model but the UNISOC V510 mgdb).

<a id="brand-dlink"></a>

## D-Link

FengSui has no implementation for this brand yet: you cannot choose it under Settings → Router and detection does not recognise it, so its rows are empty. The notes say these routers use OpenWrt's LuCI RPC (`/cgi-bin/luci/rpc`) or the maker's own web JSON interface, not the ubus and AT commands of FengSui's OpenWrt implementation. If you have one of these routers, a report still helps.

| Model | Form | Signal & traffic | Nearby cells | Connected devices | SMS | Band lock | Cell lock | Reboot & redial | Mobile data | Router switches | Access control | Battery | SIM card | Airplane mode | Network mode & operator | Data settings | USSD | Your results |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :--- |
| D-Link DWR-2000M | Indoor CPE |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+D-Link+DWR-2000M) |
| D-Link DWR-2101 | Mobile router |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+D-Link+DWR-2101) |
| D-Link DWR-953V2 | Indoor CPE |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+D-Link+DWR-953V2) |
| D-Link DWR-960 | Indoor CPE |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+D-Link+DWR-960) |
| D-Link DWR-921 | Indoor CPE |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+D-Link+DWR-921) |

<a id="brand-tplink"></a>

## TP-Link

FengSui has no implementation for this brand yet: you cannot choose it under Settings → Router and detection does not recognise it, so its rows are empty. The notes say these routers use the maker's own web JSON interface (signed with RSA and AES on newer firmware), which FengSui has no implementation of yet. If you have one of these routers, a report still helps.

| Model | Form | Signal & traffic | Nearby cells | Connected devices | SMS | Band lock | Cell lock | Reboot & redial | Mobile data | Router switches | Access control | Battery | SIM card | Airplane mode | Network mode & operator | Data settings | USSD | Your results |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :--- |
| Archer NX200 | Indoor CPE |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Archer+NX200) |
| NX510v | Indoor CPE |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+NX510v) |
| Deco X50-5G | Indoor CPE |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Deco+X50-5G) |
| TL-TR961 5G | Mobile router |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+TL-TR961+5G) |
| TL-XDR3020 5G | Indoor CPE |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+TL-XDR3020+5G) |
| Archer MR600 | Indoor CPE |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+Archer+MR600) |
<!-- devices:end -->

## Help verify your router

Choose "Report" on your model's row to open a new GitHub issue with its title already written. How to create and post a device report is under [Report compatibility](other-routers.md#report); an AI agent can also run the tests and draft the report for you, see [Test with an AI agent](other-routers.md#ai).

Once a read that had data, or a write that read back as written in the report's write record, is recorded in the code, its cell turns into ✓. The table follows on the documentation site; the console shows "verified" from the next release that carries the record.
