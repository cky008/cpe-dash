---
title: Router switches
description: What each switch in the Controls drawer does: UPnP, DMZ, firewall, WAN ping, MLO, 5 GHz priority, antennas, mobile data, reconnecting, and rebooting.
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
