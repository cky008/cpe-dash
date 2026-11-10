---
title: Frequently asked questions
description: Short answers about cost, privacy, compatibility, and usage.
section: Help
order: 20
---

## Is FengSui free?

Yes. FengSui is released under the [PolyForm Noncommercial 1.0.0](../../../LICENSE) license: free to use and modify for personal, educational, research, and other non-commercial purposes. Commercial use requires a separate license from the author.

## Does my data get uploaded anywhere?

No. FengSui connects to no cloud services and collects no usage telemetry. All data is encrypted and stored in your own `data/` directory. Pushed content only goes to Telegram or webhooks if you configure them.

## Does it interfere with my own router logins?

No. The router allows only one administrator session at a time. FengSui logs in for only tens to hundreds of milliseconds each poll, reads metrics, and logs out immediately. When it detects that you logged in on the router's own web page, it steps aside and waits until you log out.

## Can it lock me out of the router by guessing passwords?

No. FengSui stops immediately on its first failed login (the breaker trips) until you correct the password in the console. It never retries automatically, and it never tries different login schemes with the same password.

## Can I use it if my router is not an H168-383?

Most likely for reading, but not necessarily for changing settings. Other Huawei models connect, and so do routers from ZTE, Pinsu, Tozed, FiberHome and NRadio, and OpenWrt routers with a Quectel or Fibocom module; FengSui tells the brand itself. They are read-only by default; you can enable experimental writes per feature at your own risk. See [Other models and brands](other-routers.md). You can also submit a device report to help verify more models.

## Do I need a NAS?

No. Any computer that stays on and can run Docker or Node.js 22.6 or later works, including `arm64` devices like Raspberry Pi boards. It only needs to be on the same local network as the router.

## How many system resources does it use?

Very few. During long-term testing on a Synology DS923+, memory usage stays around 55 MB, with an average single-core CPU usage of about 1%. History data is capped at under 6 MB in memory.

## Can I run two FengSui instances at the same time?

Not recommended. The router only allows a single administrator session, so two instances will interfere with each other. A `data/` directory can only be used by one process anyway.

## Can I use it on a company or school network?

Yes, as long as you manage the router and have its administrator password. Do not use it on equipment you do not have permission to manage.

## Does band locking violate rules?

FengSui only calls features already present on the router's own web page. It does not alter radio parameters or transmit power. However, locking changes how your router connects to carrier networks, so follow local regulations and your carrier's terms of service.

## Is this affiliated with Huawei?

No. FengSui is an independent project and is neither affiliated with nor endorsed by Huawei, Synology, or any carrier. All trademarks belong to their respective owners.

## How do I contribute or give feedback?

- Issues and feature requests: [GitHub Issues](https://github.com/cky008/cpe-dash/issues)
- Contributing: [CONTRIBUTING.md](../../../CONTRIBUTING.md)
- Security vulnerabilities: report privately according to [SECURITY.md](../../../SECURITY.md)

## How can I support FengSui?

Starring the repository, reporting problems and sending a compatibility report for another model all help. To sponsor the project, use [GitHub Sponsors](https://github.com/sponsors/cky008) or [Buy Me a Coffee](https://buymeacoffee.com/iocky). The author's site is [iocky.com](https://iocky.com/).
