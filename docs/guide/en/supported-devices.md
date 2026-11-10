---
title: Supported devices
description: The router FengSui is verified on, the brands and models it may work with, and where each feature stands on each.
section: Get started
order: 2
---

**FengSui is verified on the Huawei H168-383 (firmware 4.4.0.1) only.** It also connects to two more kinds of router. Nobody has verified those with FengSui on a real device, so they run read-only and each write has to be turned on first:

- **Other Huawei HiLink routers**: they use the same web interface as the H168-383 and are listed by model below. If your model is not listed, try it anyway: Huawei HiLink routers usually connect, read-only.
- **Other brands**: ZTE, Pinsu, Tozed (ZLT), FiberHome, NRadio, and OpenWrt routers with a Quectel or Fibocom module. FengSui has an implementation for each, written from the brand's interface notes; see [Other brands](#brands).

You do not need to know which kind your router is: leave the brand on "Detect automatically" under Settings → Router, and FengSui tells the brand before it signs in. How FengSui works on these routers is under [Other models and brands](other-routers.md).

To see what FengSui looks like on a router nobody verified, open the [live demo's other-model mode](https://cky008.github.io/fengsui-demo/?router=other).

<!-- devices:begin -->
What the marks mean:

- **○ Verified**: someone confirmed it on a real router, and it is in the code (`VERIFIED_FEATURES`). Everything is verified on the H168-383, which also works as usual on another firmware build and warns once with `FIRMWARE_UNVERIFIED`.
- **△ May work**: the protocol has the feature and FengSui implements it, but nobody has checked it on this model yet. Band lock (LTE only), sending and managing SMS, reboot, redial and mobile data can be tried there as experimental writes, each turned on under Settings → Device; changes to the router switches and access control are offered on verified models only for now.
- **? Unknown**: FengSui knows only the H168-383's endpoints for it, and the protocol notes say nothing about other models; whether it works depends on the router.
- **× Not supported**: the protocol does not have the feature, or someone tested it on this model and it did not work (none in the table yet).
- "Router switches" are the security switches, Wi-Fi 7 and the antenna, where the router has them (Wi-Fi 7, for one, takes a Wi-Fi 7 router). A USB modem works only in HiLink mode, with its web interface.

## Huawei

| Model | Kind | Signal & traffic | Nearby cells | Connected devices | SMS | Band lock | Cell lock | Reboot & redial | Mobile data | Router switches | Access control | Your results |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :--- |
| H168-383 | 5G router | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | — |
| H112-372 | 5G router | △ | ? | △ | △ | △ | ? | △ | △ | △ | △ | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+H112-372) |
| H122-373 | 5G router | △ | ? | △ | △ | △ | ? | △ | △ | △ | △ | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+H122-373) |
| H165-383 | 5G router | △ | ? | △ | △ | △ | ? | △ | △ | △ | △ | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+H165-383) |
| B310s-22 | 3G/LTE router | △ | ? | △ | △ | △ | ? | △ | △ | △ | △ | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B310s-22) |
| B311-221 | 3G/LTE router | △ | ? | △ | △ | △ | ? | △ | △ | △ | △ | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B311-221) |
| B315s-22 | 3G/LTE router | △ | ? | △ | △ | △ | ? | △ | △ | △ | △ | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B315s-22) |
| B525s-23a | 3G/LTE router | △ | ? | △ | △ | △ | ? | △ | △ | △ | △ | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B525s-23a) |
| B525s-65a | 3G/LTE router | △ | ? | △ | △ | △ | ? | △ | △ | △ | △ | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B525s-65a) |
| B528s | 3G/LTE router | △ | ? | △ | △ | △ | ? | △ | △ | △ | △ | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B528s) |
| B535-232 | 3G/LTE router | △ | ? | △ | △ | △ | ? | △ | △ | △ | △ | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B535-232) |
| B612-233 | 3G/LTE router | △ | ? | △ | △ | △ | ? | △ | △ | △ | △ | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B612-233) |
| B628-265 | 3G/LTE router | △ | ? | △ | △ | △ | ? | △ | △ | △ | △ | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B628-265) |
| B715s-23c | 3G/LTE router | △ | ? | △ | △ | △ | ? | △ | △ | △ | △ | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B715s-23c) |
| B818-263 | 3G/LTE router | △ | ? | △ | △ | △ | ? | △ | △ | △ | △ | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B818-263) |
| E5180s-22 | 3G/LTE router | △ | ? | △ | △ | △ | ? | △ | △ | △ | △ | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E5180s-22) |
| E5186s-22a | 3G/LTE router | △ | ? | △ | △ | △ | ? | △ | △ | △ | △ | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E5186s-22a) |
| E5573s-320 | 3G/LTE router | △ | ? | △ | △ | △ | ? | △ | △ | △ | △ | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E5573s-320) |
| E5576-320 | 3G/LTE router | △ | ? | △ | △ | △ | ? | △ | △ | △ | △ | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E5576-320) |
| E5577Cs-321 | 3G/LTE router | △ | ? | △ | △ | △ | ? | △ | △ | △ | △ | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E5577Cs-321) |
| E8231 | 3G/LTE router | △ | ? | △ | △ | △ | ? | △ | △ | △ | △ | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E8231) |
| E3131 | USB modem | △ | ? | △ | △ | △ | ? | △ | △ | △ | △ | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E3131) |
| E3372 | USB modem | △ | ? | △ | △ | △ | ? | △ | △ | △ | △ | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E3372) |
| E3531 | USB modem | △ | ? | △ | △ | △ | ? | △ | △ | △ | △ | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E3531) |
| E5530As-2 | USB modem | △ | ? | △ | △ | △ | ? | △ | △ | △ | △ | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E5530As-2) |
| E8372h-608 | USB modem | △ | ? | △ | △ | △ | ? | △ | △ | △ | △ | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E8372h-608) |

## SoyeaLink

| Model | Kind | Signal & traffic | Nearby cells | Connected devices | SMS | Band lock | Cell lock | Reboot & redial | Mobile data | Router switches | Access control | Your results |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :--- |
| B535-333 | 3G/LTE router | △ | ? | △ | △ | △ | ? | △ | △ | △ | △ | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B535-333) |
<!-- devices:end -->

<a id="brands"></a>

## Other brands

FengSui has an implementation for each brand below, written from notes on the brand's management interface and not verified on a real router. Models of one brand largely share an interface, so this table has a row per brand, not per model.

<!-- brands:begin -->
What the marks mean here:

- **△ May work**: FengSui implements it from the brand's interface notes, and nobody has checked it on a real router yet. Reading needs nothing turned on. Band lock, cell lock and reboot are experimental writes: each is turned on under Settings → Device, sent once, and read back.
- **? Unknown**: FengSui has nothing for this brand here yet, so that part of the console stays empty.
- Where a cell has more than one mark, they follow the column's parts in order: Reboot & redial is reboot / redial.

| Brand | Usual address | Signal & traffic | Nearby cells | Connected devices | SMS | Band lock | Cell lock | Reboot & redial | Mobile data | Router switches | Access control | Your results |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :--- |
| ZTE (goform web interface) | `192.168.0.1` | △ | △ | ? | ? | △ | △ | △/? | ? | ? | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+zte-goform) |
| ZTE (zWRT interface: G5, U60, U50 series) | `192.168.0.1` | △ | ? | ? | ? | △ | △ | △/? | ? | ? | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+zte-zwrt) |
| Pinsu | `192.168.0.1` | △ | ? | ? | ? | △ | △ | △/? | ? | ? | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+pinsu) |
| Tozed / ZLT (also China Unicom VN007) | `192.168.0.1` | △ | △ | ? | ? | △ | △ | △/? | ? | ? | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+tozed) |
| FiberHome | `192.168.8.1` | △ | △ | ? | ? | △ | △ | △/? | ? | ? | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+fiberhome) |
| NRadio | `192.168.66.1` | △ | △ | ? | ? | △ | △ | △/? | ? | ? | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+nradio) |
| OpenWrt with a Quectel or Fibocom module | `192.168.1.1` | △ | △ | ? | ? | △ | △ | △/? | ? | ? | ? | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+openwrt) |
<!-- brands:end -->

What is particular to a brand:

- **ZTE MC8020 and MC888**: these two want the router's developer options opened before a band or cell lock. FengSui does that itself before the lock, with the same admin password, and names it in the write's record.
- **ZTE zWRT (G5, U60, U50 series)**: locks 5G cells only, not 4G cells.
- **NRadio**: locking 5G bands needs the router's cellular module to report its 5G band setting; a model that does not locks 4G bands only.
- **OpenWrt**: FengSui sends AT commands to the module through the router's ubus interface and tells Quectel from Fibocom itself. "Reboot" restarts the cellular module, not the whole router. A Fibocom module's network mode can be set to automatic or 5G standalone only.
- **Tozed / ZLT**: some operator builds wrap the interface in a layer of encryption; FengSui cannot connect to those.

## Help verify your router

Choose "Report" on your model's (or brand's) row to open a new GitHub issue with its title already written. How to create and post a device report is under [Report compatibility](other-routers.md#report); an AI agent can also run the tests and draft the report for you, see [Test with an AI agent](other-routers.md#ai). Once someone reports a feature working on a real router, its mark in the table turns into ○.
