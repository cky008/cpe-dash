---
title: Supported devices
description: Which Huawei routers FengSui is verified on, which it may work with, and where each feature stands on each.
section: Get started
order: 2
---

**FengSui is verified on the Huawei H168-383 (firmware 4.4.0.1) only.** The tables below also list, by brand, other routers that use Huawei's HiLink web interface: FengSui will most likely connect to them too, but nobody has verified them with FengSui yet, so they run read-only and each write has to be turned on first; see [Other Huawei models](other-routers.md). If your model is not listed, try it anyway: Huawei HiLink routers usually connect as well, read-only.

To see what FengSui looks like on such a router first, open the [live demo's other-model mode](https://cky008.github.io/fengsui-demo/?router=other).

<!-- devices:begin -->
What the marks mean:

- **○ Verified**: someone confirmed it on a real router, and it is in the code (`VERIFIED_FEATURES`). Everything is verified on the H168-383, which also works as usual on another firmware build and warns once with `FIRMWARE_UNVERIFIED`.
- **△ May work**: FengSui tries it on a model it was not verified on, and it works where the router provides it. Band lock (LTE only), sending and managing SMS, reboot, redial and mobile data are experimental writes there: locked until you turn each one on under Settings → Device.
- **? Unknown**: FengSui reads it the H168-383's way; whether the router answers is not known.
- **× Not supported**: FengSui does not make these writes on a model it was not verified on.
- "Router switches" are the security switches, Wi-Fi 7 and the antenna. A USB modem works only in HiLink mode, with its web interface.

## Huawei

| Model | Kind | Signal & traffic | Nearby cells | Connected devices | SMS | Band lock | Cell lock | Reboot & redial | Mobile data | Router switches | Access control | Your results |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :--- |
| H168-383 | 5G router | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | — |
| H112-372 | 5G router | △ | ? | △ | △ | △ | × | △ | △ | × | × | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+H112-372) |
| H122-373 | 5G router | △ | ? | △ | △ | △ | × | △ | △ | × | × | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+H122-373) |
| H165-383 | 5G router | △ | ? | △ | △ | △ | × | △ | △ | × | × | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+H165-383) |
| B310s-22 | 3G/LTE router | △ | ? | △ | △ | △ | × | △ | △ | × | × | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B310s-22) |
| B311-221 | 3G/LTE router | △ | ? | △ | △ | △ | × | △ | △ | × | × | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B311-221) |
| B315s-22 | 3G/LTE router | △ | ? | △ | △ | △ | × | △ | △ | × | × | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B315s-22) |
| B525s-23a | 3G/LTE router | △ | ? | △ | △ | △ | × | △ | △ | × | × | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B525s-23a) |
| B525s-65a | 3G/LTE router | △ | ? | △ | △ | △ | × | △ | △ | × | × | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B525s-65a) |
| B528s | 3G/LTE router | △ | ? | △ | △ | △ | × | △ | △ | × | × | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B528s) |
| B535-232 | 3G/LTE router | △ | ? | △ | △ | △ | × | △ | △ | × | × | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B535-232) |
| B612-233 | 3G/LTE router | △ | ? | △ | △ | △ | × | △ | △ | × | × | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B612-233) |
| B628-265 | 3G/LTE router | △ | ? | △ | △ | △ | × | △ | △ | × | × | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B628-265) |
| B715s-23c | 3G/LTE router | △ | ? | △ | △ | △ | × | △ | △ | × | × | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B715s-23c) |
| B818-263 | 3G/LTE router | △ | ? | △ | △ | △ | × | △ | △ | × | × | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B818-263) |
| E5180s-22 | 3G/LTE router | △ | ? | △ | △ | △ | × | △ | △ | × | × | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E5180s-22) |
| E5186s-22a | 3G/LTE router | △ | ? | △ | △ | △ | × | △ | △ | × | × | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E5186s-22a) |
| E5573s-320 | 3G/LTE router | △ | ? | △ | △ | △ | × | △ | △ | × | × | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E5573s-320) |
| E5576-320 | 3G/LTE router | △ | ? | △ | △ | △ | × | △ | △ | × | × | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E5576-320) |
| E5577Cs-321 | 3G/LTE router | △ | ? | △ | △ | △ | × | △ | △ | × | × | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E5577Cs-321) |
| E8231 | 3G/LTE router | △ | ? | △ | △ | △ | × | △ | △ | × | × | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E8231) |
| E3131 | USB modem | △ | ? | △ | △ | △ | × | △ | △ | × | × | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E3131) |
| E3372 | USB modem | △ | ? | △ | △ | △ | × | △ | △ | × | × | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E3372) |
| E3531 | USB modem | △ | ? | △ | △ | △ | × | △ | △ | × | × | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E3531) |
| E5530As-2 | USB modem | △ | ? | △ | △ | △ | × | △ | △ | × | × | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E5530As-2) |
| E8372h-608 | USB modem | △ | ? | △ | △ | △ | × | △ | △ | × | × | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E8372h-608) |

## SoyeaLink

| Model | Kind | Signal & traffic | Nearby cells | Connected devices | SMS | Band lock | Cell lock | Reboot & redial | Mobile data | Router switches | Access control | Your results |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :--- |
| B535-333 | 3G/LTE router | △ | ? | △ | △ | △ | × | △ | △ | × | × | [Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B535-333) |
<!-- devices:end -->

## Help verify your model

Choose "Report" on your model's row to open a new GitHub issue with the model already in its title. How to create and post a device report is under [Report compatibility](other-routers.md#report); an AI agent can also run the tests and draft the report for you, see [Test with an AI agent](other-routers.md#ai). Once someone reports a feature working on a real router, its mark in the table turns into ○.
