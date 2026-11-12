---
title: Other models and brands
description: How FengSui works on routers other than the H168-383: telling the brand, which writes are available by default, turning one off, and reporting compatibility.
section: Manage
order: 19
---

**So far FengSui is verified on the H168-383 (firmware 4.4.0.1) only.** Other Huawei HiLink routers connect as well, and so do routers from ZTE, Pinsu, Tozed (ZLT), FiberHome and NRadio, and OpenWrt routers with a Quectel or Fibocom module, but no one has verified any of them with FengSui on a real device. On those routers, what FengSui implements works straight away, writes included: they are on by default, and you can turn each one off. This page covers how FengSui works on those routers; which brands and models may work, and where each feature stands, is under [Supported devices](supported-devices.md).

<a id="brand"></a>

## How FengSui detects your router

**The brand first.** Under "Settings → Router", the router brand starts on "Detect automatically". When you test or save a connection, FengSui first sends the router a few requests that need no login (the kind each brand's own login page sends), sees which brand answers, and only then sends the password. This step carries no password, takes no login and uses up no attempt. If FengSui cannot tell, it asks you to choose the brand; you can also choose it yourself from the start. The brand it found is what gets saved, and FengSui does not detect again on its own.

**Then the model.** After startup, and whenever you test or save a connection, FengSui reads the model and supported features once (read-only, without altering settings). The results appear in "Settings → Device".

FengSui settles the login method before sending the password (on Huawei, SCRAM for newer models, SHA-256 or Base64 for older ones). It never retries the same password another way, so it cannot use up the router's login attempts.

## What you can see

Signal, data usage, connected devices, SMS and whatever else the router provides show as usual. An item the router does not provide, or that FengSui cannot read, is labeled "Not on this model" and leaves the others unaffected; a model without 5G shows no 5G values.

What the router reports about itself shows on the matching card too: a mobile router's battery, the SIM card's state, slot and PIN tries left, airplane mode, roaming, and the router's own load and temperatures (which brands report which: the Battery, SIM card and Airplane mode columns of [Supported devices](supported-devices.md), and [the dashboard](dashboard.md#sim)). What the router does not report is not shown; on a router that reports no uptime of its own, Uptime shows "—".

The header shows "Unverified model"; choose it to open Settings → Device.

<a id="writes"></a>

## Writes: what FengSui implements is available by default

FengSui implements some writes from each brand's interface notes. Where it implements a write for your router, that write is available by default, with no switch to turn on first. Because none of them was checked on a real device, they are called experimental writes.

**Other Huawei HiLink models:**

- Band lock (4G only, among the bands the router reports)
- Reboot
- Redial
- Mobile data switch
- SMS (send, mark as read, delete)
- Five of the cellular settings: network mode, operator selection, data roaming, clearing the traffic counters, USSD (see [Cellular settings](router-switches.md#cellular-settings))

Each one also needs the router to have what it takes: when FengSui identifies the router, it reads the endpoint that the write is read back from, and a write whose endpoint does not answer is marked "not on this router" and is never sent. Cell lock, security switches, Wi-Fi 7, antenna selection and access control are not implemented on these models yet.

**Other brands:**

- Band lock (4G and 5G bands, typed as band numbers in the controls drawer)
- Cell lock (channel + PCI, from Nearby cells)
- Reboot
- Redial and the mobile data switch: ZTE (goform and zWRT), NRadio, and OpenWrt routers with QModem. On a router without a redial command of its own, a redial is a disconnect followed by a connect, and FengSui always sends the connect at the end
- Antenna (automatic, internal, external, both at once): NRadio
- Cellular settings: the network mode (ZTE, Pinsu, Tozed, FiberHome, NRadio, OpenWrt), operator selection and the access point (ZTE, OpenWrt), the SIM slot, data roaming and the data limit (ZTE), the SIM PIN (ZTE, and Quectel modules on OpenWrt), airplane mode (FiberHome, OpenWrt), USSD (ZTE goform). What each one does and what to watch for is under [Cellular settings](router-switches.md#cellular-settings)
- SMS: ZTE, OpenWrt, Tozed and FiberHome. What each brand can do differs (some cannot delete, some send with a condition); see [SMS](sms.md#other-brands)

Connected devices show on ZTE goform, NRadio and OpenWrt routers. OpenWrt lists its DHCP leases, which do not say whether a device is wired or on Wi-Fi, so the console shows "Link not reported".

Router switches (UPnP, DMZ, firewall) and access control are not in the other brands' interface notes, so FengSui does not do them there; Pinsu and NRadio have no SMS, and those parts of the console stay empty. What is particular to each brand is under [Supported devices](supported-devices.md#brands).

A write FengSui does not implement is never sent to the router: the web console, the API, MCP, Telegram and self-healing all go through the same gate on the server, and the endpoint answers `409 DEVICE_UNVERIFIED_READ_ONLY`.

<a id="safeguards"></a>

### How FengSui lowers the risk

> **Warning**: a write nobody verified may write a wrong setting or take the router offline, and an unexpected answer may trigger the router's login lockout.

- **Sent once, then read back.** Each write is sent once, never retried, and read back right away, with the result shown as "read back: matches" or "differs"; a mismatch raises a `WRITE_READBACK_MISMATCH` alert. The results are listed under Recent write results in Settings → Device.
- **A lock that cuts the internet is undone after 3 minutes.** Whether the lock came from the console, the API, an AI agent or Telegram: if the WAN stays down 3 minutes after a band lock, FengSui writes back the bands from before it; after a cell lock, it takes the lock off. A lock is kept once the WAN is back and stays up 2 minutes. This protection does not need the lock rollback under [self-healing](locking.md#self-heal), and it carries on after the daemon restarts.
- **A change of the network mode, the operator, the SIM slot or the access point is put back the same way.** FengSui reads the earlier value in the same connection that writes the new one, and puts the setting back if the internet stays down for 3 minutes. Where the earlier value could not be read, it changes nothing and says so in the alert. Turning mobile data off or airplane mode on is a disconnect you asked for, so FengSui does not undo it.
- **A SIM PIN is sent only when it is safe to.** Only while the router reports more than one attempt left, and once per request. FengSui does not enter a PUK or change the PIN.
- **You confirm every write.** Each write in the console has a confirmation of its own, which says the write was not verified on a real device. An AI agent's write tools need `confirm: true`, "Let agents change the router" and a token with the permission; see [AI agents](agents.md).
- **FengSui writes nothing on its own.** Apart from the fallback above, FengSui writes only when you (or an agent you allowed) ask for it; self-healing is off by default.

**If something goes wrong**: set it back or restart the router on its own web page, and use the reset button to restore factory settings if necessary.

<a id="turn-off"></a>

### Turn a write off

To stop using one of the writes:

1. Open Settings → Device.
2. Under Experimental writes, turn that write's switch off.

It takes effect at once, and nobody can make that write afterwards, AI agents and FengSui itself (self-healing's redial, for one) included; the endpoint answers `409 DEVICE_WRITE_DISABLED`. Turn the switch back on to restore it. Each change is recorded in the audit log.

- One switch covers everything filed under the feature: "Send and manage SMS" covers sending, marking read and deleting; "Band lock" covers unlocking too.
- Taking locks off has no switch of its own: with either the band lock or the cell lock on, you can unlock.
- A switch-off is kept per model. On a router of another model, the writes FengSui implements for it are on again; back on the first router, the ones you turned off are still off.

<a id="report"></a>

## Report compatibility

Your feedback helps verify more router models:

1. Use the features you want confirmed in the console first: open a read's page and see whether it has data; make a write once and wait for its read-back.
2. Under "Settings → Device", click "Create device report", review the contents, and copy or download the JSON. Above the report, the features are listed by what works, what does not, and what you have not tried yet: the issue form can take these over.
3. Click "Report on GitHub", open a new issue, paste the report, and note which features work and which do not.

The report contains only API structures and safe metadata (model, firmware, web interface version, feature toggles, and band numbers). It excludes IMEI, IMSI, MAC addresses, IP addresses, phone numbers, cell identifiers, and Wi-Fi network names. FengSui never uploads anything automatically.

The report ends with `checks`, one line per feature with its result on your router: `works`, `failed`, or `untested`. A read that had data, or a write that read back as written in the write record, is `works`. Maintainers record that line in `VERIFIED_FEATURES` in the codebase, and its mark under [Supported devices](supported-devices.md) turns into ✓: the table on the documentation site follows once the record is pushed, and the console shows it as verified from the next release. Once every feature FengSui implements on your model is confirmed, the model counts as verified.

<a id="ai"></a>

## Test with an AI agent

An AI agent connected to FengSui (Claude Code, Codex and the like) can run the tests for you:

1. Under Settings → Device, choose "Copy prompt and start test". The writes are on already; what the agent lacks is your leave. FengSui first lists the settings the test turns on; confirm once, and it turns them all on and copies the prompt:
   - "Let AI agents test this router" and "Let agents change the router";
   - the "Change the router" permission for the agent's token: FengSui picks the token that last connected to it, and you can pick another one or none;
   - SMS (ticked in the confirmation; you can untick it): the agents' SMS access set to read and write and their sending to any number (the hourly limit still applies), and the SMS permissions for the token. The agent sends one test SMS to a number you give it (your plan charges for it); once you reply from your phone, it marks the reply read and deletes both. How far it goes depends on the router's SMS interface, and the confirmation says so: a router that cannot send gets no SMS test; on one that cannot delete, the two test messages stay on the router; on one that deletes whole conversations only, give a number this router has no other messages with.
2. Give the prompt to the agent. If the agent is already running, have it reconnect to FengSui first (in Claude Code: `/mcp`), so it sees the new tools.
3. The agent tests every read first; it asks you before each write test. The write tests touch only the bands and cells in use: a 4G band lock, a 5G band lock when 5G is in use, and a cell lock, each put back right after; the network mode is left alone. It does not test a write you turned off, and the test does not turn it back on for you.
   Once the writes are done, it asks you to sign in to the router's own web page and check which network modes it offers and whether it locks 4G and 5G cells and bands, for the report: what the page has and FengSui cannot do tells the developers what to add. FengSui steps aside while you are signed in there; sign out when you are done.
4. It also uses `probe_router_endpoints` to find, on this router, the endpoints FengSui does not use yet: only `GET`s, inside FengSui's own session, with results that hold structure and never a value.
5. Finally it gives you a desensitized report and the issue link, for you to check and post yourself.
6. When the test is done, choose "End test" under Settings → Device: FengSui puts back only what the test turned on and you have not changed since (the agent switches and the token's permissions). The writes stay as they are; if one of them failed, you can turn it off.

While something the test turned on is still on, FengSui reminds you 3 hours after the agent's last test step (`AGENT_TEST_STILL_ON`: in the console's alerts, on Telegram if it is set up, and as a system notification when the console is open in a background browser tab that may show notifications), then once a day. The reminders stop as soon as one of these happens: the test's writes all read back as a match; you have seen the reminder in the console's alerts or chosen "Got it" in Telegram; you end the test.

The agent never logs in to the router itself: every request goes through FengSui, which still steps aside when someone logs in to the router's web page. A band or cell lock it makes is covered by the same [3-minute fallback](#safeguards).

## Try it first

No install needed: the [live demo's other-model mode](https://cky008.github.io/fengsui-demo/?router=other) simulates a Huawei router FengSui was not verified on (4G only). You can try the writes that are on by default, turn one off, see the read-back results, the device report and the one-click AI agent test there; every value is fictional, and a reload resets it.

On your own computer, `DEMO_SCENARIO=unverified npm run demo` runs the real daemon against the same simulated router (4G only, legacy login), so you can go through the writes, the switches, the read-backs and the report in full.

## Acknowledgments

The projects FengSui consulted when adding support for other models and brands are listed under [Acknowledgments](acknowledgments.md).

