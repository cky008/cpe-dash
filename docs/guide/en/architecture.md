---
title: Architecture and protocols
description: FengSui is built in layers. The upper ones work the same for every brand; only the lowest talks to your router in its brand's way. What each layer does, how one session and one write go, and which interface each brand's routers use.
section: Manage
order: 20
---

FengSui is built in layers. The upper ones do the same work whichever brand of router you have; only the brand drivers and protocol parts at the bottom talk to the router in its brand's way. So a feature is written once, and another brand only means another bottom layer.

![FengSui's layers: the top six do not depend on the brand; brand drivers and protocol parts connect to the router by brand](../../diagrams/en/layers.svg)

## What each layer does

| Layer | What it does |
| :--- | :--- |
| Entrances | Where you deal with FengSui: the web console, the REST API, MCP for AI agents, the Telegram bot, and self-healing (off by default). |
| Shared rules | Checks every entrance goes through: whether the input is right (a band number, a PCI in range); whether this router can make this write and whether you turned it off in Settings → Device (the write gate); an entry in the audit log. |
| Services | The features themselves, for every brand: reading signal and traffic on a schedule, keeping the history, band and cell locks and the other controls, syncing and sending SMS, cellular settings, alerts. |
| Backend | Turns each read or write into one fixed action (read the signal, lock a cell, send an SMS…), queues it, and records whether this router has it and whether a write read back as written. |
| Scheduler | The one queue. Requests from every entrance wait here, writes ahead of reads; while you are signed in to the router's page FengSui steps aside; on a wrong password it stops. |
| Session | One login to the router: one at a time, one password try, logged out as soon as the work is done. |
| Brand drivers | One per brand: how that brand logs in, what to send in a session, which features its interface is documented for. |
| Protocol parts | Parts several brands share that belong to none of them, such as ubus (used by OpenWrt and ZTE zWRT) and the AT commands of Quectel and Fibocom modules. |

## One session

A router lets only one administrator sign in at a time. FengSui uses it briefly and leaves:

![One session: ask whether someone is there, log in once, read or write, log out](../../diagrams/en/session.svg)

- **Ask first.** Before logging in, FengSui asks the router whether someone is signed in (no password needed for that). If you are on the router's page, FengSui steps aside and comes back later. It does the same when the router answers the login with "someone else is signed in".
- **One password try.** When the router says the password is wrong, FengSui stops and does not try again until you correct it in Settings → Router. Many routers lock their login after three wrong passwords, so FengSui never tries even one more.
- **Log out every time.** When the work is done, fails or times out, or the daemon stops, FengSui logs out and frees the administrator's slot. A session lasts 90 seconds at most, usually under one.

With the brand left to automatic detection, FengSui first tells the brand from requests that need no login, and sends the password only after that.

## How one write goes

Locking a cell, for example:

1. **Input check.** The channel must lie in the band, the PCI in 0–503 (4G) or 0–1007 (5G). If not, you are told at once and nothing is sent.
2. **Write gate.** Does this router have this write? Did you turn it off? A write that is not allowed is refused before it is queued, without a session.
3. **Queue.** Writes go ahead of reads, but never cut into a session in progress.
4. **Check again in the session.** If this run has not seen the router's model yet, the same session reads it first and decides by the model.
5. **Sent once.** The write goes out once and is never sent again, whatever happens.
6. **Read back.** The same session reads the setting back and alerts you if it differs from what was written.
7. **Record.** The console, the audit log and the device report keep what was sent (names only, never values) and how the read-back went.
8. **Way back.** After a band or cell lock on a router nobody verified, or a SIM slot, network mode, operator or APN change on any router, FengSui puts the setting back if the network is still down 3 minutes later. A write that disconnects on purpose (mobile data off, airplane mode on) is never undone on its own.

## How each brand talks

| Brand | The router's interface | Protocol parts used |
| :--- | :--- | :--- |
| Huawei | HiLink: XML endpoints, SCRAM or the older password login, a one-time token on each write | HiLink |
| ZTE | The goform web interface (including the `/reqproc/` form of ZXIC firmware), or zWRT on newer models | ubus (zWRT) |
| Pinsu | The web page's JSON interface | — |
| Tozed (ZLT) | The web page's `cmd` interface | — |
| FiberHome | The web page's JSON interface (the Pro series uses another encrypted form) | — |
| NRadio | LuCI web pages, plus some endpoints written like HiLink's | — |
| OpenWrt | ubus; the cellular part is the module's AT commands, sent through a modem service on the router | ubus, AT commands (Quectel, Fibocom) |

Which models support which features is in [Supported devices](supported-devices.md); how writes are on by default on routers nobody verified, and how to turn them off, is in [Other models and brands](other-routers.md).

## Where the data lives

- Everything FengSui keeps is in the `data/` directory: runtime state, console settings, the SMS mirror and contacts, the audit log, all encrypted with your `DATA_ENCRYPTION_KEY` and readable only by the user that runs FengSui. Backing up and changing the key are in [Backup and restore](backup.md).
- FengSui connects to no cloud service. Only the Telegram bot and webhook you set up yourself receive notifications.
- At run time it uses Node.js's own modules only, with no third-party dependency.

## Taking part in development

- **Adding a brand:** write its driver (login-free detection, the check before login, one login, logout, and the reads and writes inside a session), record which features the brand has, and add it to the driver table. The backend, the scheduler and the services stay as they are.
- **Adding a feature:** add one action to the backend and to the session, and implement it for the brands whose interface documents it. On the others the read says "not on this model" and the write gate refuses the write.
- **The verified H168-383:** what FengSui sends it must not change by a single byte. Every change proves that by comparing the requests byte for byte on a mock router.
- The full design record is in the [developer notes](../../dev/architecture.md) on GitHub (section 19, in Chinese). How to take part is in [CONTRIBUTING.md](../../../CONTRIBUTING.md).
