---
title: Supported devices
description: The router FengSui is verified on, and the Huawei HiLink routers it may support, which you can help verify.
section: Get started
order: 2
---

**FengSui is verified on the Huawei H168-383 (firmware 4.4.0.1) only.** The tables below also list other Huawei HiLink routers by brand: another HiLink client, huawei-lte-api, was tested on the same web API of each of them [[huawei-lte-api: Tested on](https://github.com/Salamek/huawei-lte-api#tested-on)], so FengSui will most likely connect to them too, but nobody has verified them with FengSui yet. If your model is not listed, try it anyway: other Huawei HiLink routers usually connect as well, read-only.

To see what FengSui looks like on such a router first, open the [live demo's other-model mode](https://cky008.github.io/fengsui-demo/?router=other).

<!-- devices:begin -->
How to read the tables:

- **Verified**: features someone confirmed on a real router and the maintainers added to the code (`VERIFIED_FEATURES`). Everything is verified on the H168-383.
- **May work (not verified)**: what FengSui tries on a model it was not verified on. **Reads** are signal and traffic, connected devices, reading SMS, shown only where the router provides them. **Experimental writes** are LTE band lock, reboot, redial, mobile data switch, sending and managing SMS: locked until you turn each one on under Settings → Device after reading its risks (see [Other Huawei models](other-routers.md)). Nearby cells, router settings and access control use the H168-383's own endpoints and are not available on other models yet.
- **Report**: opens a new GitHub issue with the model already in its title.

## Huawei

| Model | Kind | Verified | May work (not verified) | Report |
| :--- | :--- | :--- | :--- | :--- |
| H168-383 | 5G router | ✅ everything (firmware 4.4.0.1) | — | — |
| H112-372 | 5G router | — | reads, experimental writes | [Report how it works](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+H112-372) |
| H122-373 | 5G router | — | reads, experimental writes | [Report how it works](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+H122-373) |
| H165-383 | 5G router | — | reads, experimental writes | [Report how it works](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+H165-383) |
| B310s-22 | 3G / LTE router | — | reads, experimental writes | [Report how it works](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B310s-22) |
| B311-221 | 3G / LTE router | — | reads, experimental writes | [Report how it works](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B311-221) |
| B315s-22 | 3G / LTE router | — | reads, experimental writes | [Report how it works](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B315s-22) |
| B525s-23a | 3G / LTE router | — | reads, experimental writes | [Report how it works](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B525s-23a) |
| B525s-65a | 3G / LTE router | — | reads, experimental writes | [Report how it works](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B525s-65a) |
| B528s | 3G / LTE router | — | reads, experimental writes | [Report how it works](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B528s) |
| B535-232 | 3G / LTE router | — | reads, experimental writes | [Report how it works](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B535-232) |
| B612-233 | 3G / LTE router | — | reads, experimental writes | [Report how it works](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B612-233) |
| B628-265 | 3G / LTE router | — | reads, experimental writes | [Report how it works](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B628-265) |
| B715s-23c | 3G / LTE router | — | reads, experimental writes | [Report how it works](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B715s-23c) |
| B818-263 | 3G / LTE router | — | reads, experimental writes | [Report how it works](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B818-263) |
| E5180s-22 | 3G / LTE router | — | reads, experimental writes | [Report how it works](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E5180s-22) |
| E5186s-22a | 3G / LTE router | — | reads, experimental writes | [Report how it works](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E5186s-22a) |
| E5573s-320 | 3G / LTE router | — | reads, experimental writes | [Report how it works](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E5573s-320) |
| E5576-320 | 3G / LTE router | — | reads, experimental writes | [Report how it works](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E5576-320) |
| E5577Cs-321 | 3G / LTE router | — | reads, experimental writes | [Report how it works](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E5577Cs-321) |
| E8231 | 3G / LTE router | — | reads, experimental writes | [Report how it works](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E8231) |
| E3131 | USB modem (HiLink mode) | — | reads, experimental writes | [Report how it works](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E3131) |
| E3372 | USB modem (HiLink mode) | — | reads, experimental writes | [Report how it works](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E3372) |
| E3531 | USB modem (HiLink mode) | — | reads, experimental writes | [Report how it works](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E3531) |
| E5530As-2 | USB modem (HiLink mode) | — | reads, experimental writes | [Report how it works](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E5530As-2) |
| E8372h-608 | USB modem (HiLink mode) | — | reads, experimental writes | [Report how it works](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+E8372h-608) |

## SoyeaLink

| Model | Kind | Verified | May work (not verified) | Report |
| :--- | :--- | :--- | :--- | :--- |
| B535-333 | 3G / LTE router | — | reads, experimental writes | [Report how it works](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+B535-333) |

huawei-lte-api lists the firmware of the B2368-22 and B593s-22 as incompatible, so FengSui most likely cannot connect to them either.
<!-- devices:end -->

## Help verify your model

Your results turn "may work" into "verified":

1. Install FengSui and connect it to your router (see [Quick start](quick-start.md)).
2. Under Settings → Device, choose "Create device report", check it, and copy or download the JSON.
3. Choose "Report how it works" on your model's row above (or "Report on GitHub" in the console), paste the report, and say which features work and which do not.

An AI agent can also run the tests for you: it tests each feature, drafts the report and gives you the link to post it; see [Test with an AI agent](other-routers.md#ai).

The report holds endpoint structure and a few allowlisted values only (model, firmware, web UI version, feature switches, band numbers): no IMEI, phone number, MAC or IP address, cell or Wi-Fi name. FengSui never uploads anything by itself. Once someone reports a feature working on a real router, the maintainers add it to `VERIFIED_FEATURES`, and this table changes with it.
