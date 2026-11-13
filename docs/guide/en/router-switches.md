---
title: Router switches
description: What each switch in the Controls drawer does: UPnP, DMZ, firewall, WAN ping, MLO, 5 GHz priority, antennas, mobile data, reconnecting, and rebooting, plus the cellular settings (network mode, operator selection, SIM slot and PIN, airplane mode, roaming, APN, data limit, USSD).
section: Use FengSui
order: 7
---

In the "Controls" drawer in the top right, alongside [Band and cell locking](locking.md), you will find a set of router switches. These are the same settings found in the router's own web page; changing a setting on one side updates the other. Every time you turn a switch on or off, a confirmation dialog appears to explain the impact.

> [!NOTE]
> The drawer does not poll these settings periodically. After opening the drawer, click "Read router settings" to see the router's current state.

## Security switches

<a id="upnp"></a>

### UPnP

UPnP (Universal Plug and Play) allows devices on your local network to request that the router open ports automatically so external clients can connect. Online games, BitTorrent clients, and some video calling apps use it [[Huawei: How to enable UPnP](https://consumer.huawei.com/en/support/content/en-us00275342/)].

- **On**: Convenient, but any device (including compromised smart home gadgets) can open ports on the router on its own.
- **Off**: More secure; a few apps that require inbound connections might fail to connect.
- Recommendation: Turn it off if you do not need it. Most consumer 5G connections sit behind carrier-grade NAT (CGNAT), so inbound connections might not reach your router even with UPnP enabled.

<a id="dmz"></a>

### DMZ host

A DMZ host forwards all incoming connections not handled by other rules directly to a device you designate [[Fortinet: What is a DMZ network?](https://www.fortinet.com/resources/cyberglossary/what-is-dmz)] [[Huawei: How to set a DMZ host](https://consumer.huawei.com/en/support/content/en-us15806289/)].

> [!CAUTION]
> Turning this on exposes that device directly to the public internet. Use it only if you understand the risks and the device runs its own firewall; turn it off as soon as you finish.

<a id="firewall"></a>

### Master firewall switch, IP filtering, and URL filtering

- **Master firewall switch**: Provides basic router protection by blocking unsolicited inbound connections. Keep this enabled.
- **IP filtering and URL filtering**: Blocks specific IP addresses or websites based on rules configured in the router's own web page. FengSui toggles these filters on or off; edit the rules themselves in the router's own web page.

<a id="wan-ping"></a>

### WAN ping

Determines whether the router responds to ping requests (ICMP Echo Requests) from the public internet [[RFC 792](https://www.rfc-editor.org/rfc/rfc792)]. Blocking ping requests makes it harder for automated scanners on the internet to detect your router, without affecting your regular internet access. Disabling WAN ping is recommended.

<a id="fw-mac"></a>

### MAC filtering (firewall)

This is the MAC address list inside the router firewall. It is different from the Wi-Fi MAC filter in [Devices and internet access](devices.md#mac-filter): it applies to both wired and wireless devices [[Huawei: Setting MAC address filtering on a carrier router (Chinese)](https://consumer.huawei.com/cn/support/content/zh-cn15933072/)].

> [!WARNING]
> If the filter is set to allowlist mode ("allow only"), any device not on the list loses internet access, which may include the machine running FengSui.

## Wi-Fi

<a id="mlo"></a>

### MLO (Multi-Link Operation)

MLO (Multi-Link Operation) is a Wi-Fi 7 feature. Supported devices can communicate with the router across multiple bands (such as 2.4 GHz and 5 GHz) at the same time, delivering faster speeds, lower latency, and better connection stability [[Wi-Fi Alliance: Wi-Fi CERTIFIED 7](https://www.wi-fi.org/news-events/newsroom/wi-fi-alliance-introduces-wi-fi-certified-7)] [[IEEE 802.11be](https://standards.ieee.org/ieee/802.11be/7516/)].

- Only Wi-Fi 7 client devices can use it; older devices connect normally.
- Certain older devices fail to connect or become unstable when MLO is on; if this happens, try turning it off.

<a id="dbho"></a>

### 5 GHz priority

Combines 2.4 GHz and 5 GHz into a single Wi-Fi network name (SSID), allowing the router to automatically steer devices to the better band, prioritizing 5 GHz [[Huawei: Enable 5 GHz priority](https://consumer.huawei.com/en/support/content/en-us00746587/)].

- On: Uses a single Wi-Fi name for ease of use.
- Off: Separates 2.4 GHz and 5 GHz into two different names, which helps when pairing smart home devices that only support 2.4 GHz.

## Antennas

<a id="antenna"></a>

Some models include external antenna ports. You can select "Auto," "Built-in," or "External" here, and see whether each port has an antenna connected. If no external antennas are connected, keep this set to "Auto" or "Built-in"; under normal conditions, the built-in antennas are sufficient [[Huawei: Purpose of external antenna ports](https://consumer.huawei.com/en/support/content/en-us00728109/)].

## Mobile data, reconnecting, and rebooting

<a id="mobile-data"></a>

- **Mobile data**: When turned off, the router stops using the SIM card for internet access, while the local network continues to work.
- **Reconnect cellular data**: Disconnects and reconnects to the operator network, similar to toggling airplane mode on a phone. The connection restores within a few seconds to half a minute. Try this first if your connection stalls.
- **Reboot router**: Reboots the entire router, interrupting your home internet connection for one to two minutes. Requires entering a confirmation phrase.

FengSui self-healing only reconnects automatically and never reboots the router; see [Band and cell locking](locking.md#self-heal).

## Cellular settings

The "Cellular settings" section of the Controls drawer covers how the router connects to the operator: which network generation, which operator, which SIM card and which access point. Each router shows only the settings it has; [Supported devices](supported-devices.md) lists them per model. On the H168-383, data roaming, the network mode, operator search and selection, and clearing the traffic counters were verified on a real router ([#3](https://github.com/cky008/cpe-dash/issues/3)). On every other model these settings have not been verified on a real router yet, so they are [experimental writes](other-routers.md): each is sent once, read back in the same connection to check it, and can be turned off one by one under Settings → Device. On the H168-383 too, each is sent once and read back in the same connection.

> [!NOTE]
> After you change the network mode, pick an operator by hand, switch the SIM slot or change the access point, FengSui puts that setting back to what it was if the internet stays down for more than 3 minutes, and sends an alert. Where the earlier value could not be read, FengSui changes nothing and says so in the alert. Turning mobile data off or airplane mode on is a disconnect you asked for, so FengSui does not undo it.

<a id="network-mode"></a>

### Network mode

Sets which network generations the router may use: automatic, 5G only, 4G only, 3G only and so on. The modes on offer depend on the router [[3GPP TS 23.122](https://www.3gpp.org/DynaReport/23122.htm)]. 5G only (SA) has no signal where there is no standalone 5G coverage. If you are unsure, use "Automatic".

A Huawei 5G router such as the H168-383 offers the modes of its own web page (developer mode → network mode): SA + NSA ("Automatic"), SA only, NSA only, 4G only, 4G TDD only and 4G FDD only. In 4G only a 5G band lock does nothing, so FengSui refuses it; a 4G band lock keeps the mode you chose.

<a id="operator-select"></a>

### Manual operator selection

Normally the router picks the operator itself. With manual selection, the router first searches for the networks in range, then registers only on the one you pick [[3GPP TS 23.122](https://www.3gpp.org/DynaReport/23122.htm)].

- A search takes one to three minutes, and the mobile connection is down meanwhile.
- The names in the list are the operators' own text. Networks marked "Not allowed" cannot be used with this SIM card.
- Once you pick an operator, the router no longer changes operator by itself. If that network does not work, the internet goes down, and after 3 minutes FengSui switches back to automatic selection.
- ZTE routers can only register on a network from their latest search, so search first, then pick.

### SIM slot

On a router with a built-in SIM (eSIM) or more than one slot, you can switch to the other card here. The router then connects again, which takes about a minute. See [Dashboard](dashboard.md#esim) for what the slots mean.

### SIM PIN

You can do two things: enter the PIN when the SIM card is waiting for it, and turn "ask for the PIN at start" on or off. See [Dashboard](dashboard.md#sim-pin) for what the PIN is.

- FengSui sends a PIN once. If the router says it is wrong, FengSui stops and does not try another.
- A PIN can only be sent while the router reports more than one attempt left; the confirmation shows how many are left. If the count cannot be read, or one attempt is left, use the router's own page.
- Ten wrong PUKs block a SIM card for good, so FengSui does not enter a PUK and does not change the PIN.
- The PIN goes to the router only. FengSui does not store it or write it to any record.

### Airplane mode

When on, the router switches its cellular radio off and disconnects from the mobile network; the local network and Wi-Fi keep working. You have to come back to FengSui to turn it off. If you reach FengSui remotely through this mobile connection, you lose it once airplane mode is on. See [Dashboard](dashboard.md#airplane-mode).

### Data roaming

Sets whether the router uses data while connected through another operator's network. Roaming data may cost extra. If you turn it off while the router is roaming, the internet goes down at once. See [Dashboard](dashboard.md#roaming).

<a id="apn"></a>

### Access point (APN)

The APN (access point name) tells the operator which service this SIM card connects through [[3GPP TS 23.003](https://www.3gpp.org/DynaReport/23003.htm)]. Most SIM cards work with "Automatic". IoT and private-network cards need the name the operator gave you.

- A wrong APN takes the internet down; after 3 minutes FengSui switches back to the earlier one.
- On ZTE routers FengSui writes only its own profile (named `FengSui`) and leaves the router's profiles as they are. Going back makes the earlier profile the default again.
- On OpenWrt you can set the name and the address type only, not a user name or password.
- The access point's name, user name and password never appear in any FengSui record.

<a id="data-limit"></a>

### Data limit and traffic counters

This is the monthly limit the router itself keeps. It is separate from FengSui's own [traffic alerts](notifications.md): at the warning share you set, the router warns in its own way. "Clear traffic counters" sets the router's own counters back to zero and cannot be undone; FengSui's traffic charts are not affected.

<a id="ussd"></a>

### USSD

USSD codes are short commands sent to the operator, such as `*100#`, to check a balance or a plan, or to order a service [[3GPP TS 22.090](https://www.3gpp.org/DynaReport/22090.htm)].

- Some codes order a service or cost money, so check a code before you send it.
- The operator sometimes answers with a menu and waits for a reply. You can reply, or end the session.
- The answer is the operator's own text. The code and the answer are shown to you only: FengSui does not store them or write them to any record.
