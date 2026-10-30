import { loadConfig } from "../src/config.ts";
import { HuaweiCpeClient } from "../src/cpe-client.ts";
import { maskMacAddress, sanitizeIpToken } from "../src/sanitize.ts";
import { huaweiXssDecode } from "../src/crypto.ts";
import { getXmlBlocks, getXmlTag } from "../src/xml.ts";

function decodeAntennaMode(code: string | null): string {
  if (code === "0") return "0 (Auto)";
  if (code === "1") return "1 (Internal)";
  if (code === "2") return "2 (External)";
  return `${code ?? "--"} (Unknown)`;
}

function decodeIpType(code: string | null): string {
  if (code === "0") return "0 (IPv4 Only)";
  if (code === "1") return "1 (IPv6 Only)";
  if (code === "2") return "2 (IPv4/IPv6 Dual-Stack)";
  return `${code ?? "--"}`;
}

async function main(): Promise<void> {
  console.log("=== [FengSui Probe #8] Extended Non-SMS Hardware & Management Capabilities ===");

  const cfg = loadConfig();
  const client = new HuaweiCpeClient({
    cpeUrl: cfg.cpeUrl,
    cpeUsername: cfg.cpeUsername,
    cpePassword: cfg.cpePassword,
    requestTimeoutMs: cfg.requestTimeoutMs,
    respectBrowserSession: cfg.respectBrowserSession,
  });

  const preState = await client.getLoginState();
  console.log(
    `Pre-check /api/user/state-login -> State=${preState.state}, isLoggedInElsewhere=${preState.isLoggedInElsewhere}`
  );

  const raw = await client.withSession(async (session) => {
    const safeGet = async (path: string): Promise<string> =>
      session.get(path).catch((err: unknown) =>
        err instanceof Error ? `<probe_err>${err.message}</probe_err>` : ""
      );

    const [
      basicXml,
      deviceInfoXml,
      wlandbhoJson,
      wifiFeatureXml,
      wifiSecXml,
      antennaSetXml,
      antennaTypeXml,
      dhcpSettingsXml,
      dhcpStaticXml,
      apnProfilesXml,
      dialupConnXml,
      dataSwitchXml,
      ipModeXml,
      cradleXml,
      timeRebootXml,
      sntpXml,
      pingXml,
      traceXml,
    ] = await Promise.all([
      safeGet("/api/device/basic_information"),
      safeGet("/api/device/information"),
      safeGet("/api/wlan/wlandbho"),
      safeGet("/api/wlan/wifi-feature-switch"),
      safeGet("/api/wlan/multi-security-settings-ex"),
      safeGet("/api/device/antenna_set_type"),
      safeGet("/api/device/antenna_type"),
      safeGet("/api/dhcp/settings"),
      safeGet("/api/dhcp/static-addr-info"),
      safeGet("/api/dialup/profiles"),
      safeGet("/api/dialup/connection"),
      safeGet("/api/dialup/mobile-dataswitch"),
      safeGet("/api/lan/switch-ipmode"),
      safeGet("/api/cradle/status-info"),
      safeGet("/api/diagnosis/time_reboot"),
      safeGet("/api/sntp/timeinfo"),
      safeGet("/api/diagnosis/ping_result"),
      safeGet("/api/diagnosis/traceroute_result"),
    ]);

    return {
      basicXml,
      deviceInfoXml,
      wlandbhoJson,
      wifiFeatureXml,
      wifiSecXml,
      antennaSetXml,
      antennaTypeXml,
      dhcpSettingsXml,
      dhcpStaticXml,
      apnProfilesXml,
      dialupConnXml,
      dataSwitchXml,
      ipModeXml,
      cradleXml,
      timeRebootXml,
      sntpXml,
      pingXml,
      traceXml,
    };
  });

  if (!raw) {
    console.log(
      `[Yielded] Active human admin session detected (State=${preState.state}); probe yielded peacefully.`
    );
    return;
  }

  const telemetry = client.getTelemetry();
  console.log(`Ephemeral Session Hold Time : ${telemetry.lastSessionHoldMs} ms (18 parallel GETs + logout)\n`);

  // 1. Hardware & Firmware Identity (strictly sanitized WAN IPs, zero SN/IMEI printed)
  const model = getXmlTag(raw.basicXml, "devicename") ?? "--";
  const marketing = getXmlTag(raw.basicXml, "spreadname_en") ?? "--";
  const hwVer = getXmlTag(raw.deviceInfoXml, "HardwareVersion") ?? "--";
  const swVer = getXmlTag(raw.deviceInfoXml, "SoftwareVersion") ?? "--";
  const webUiVer = getXmlTag(raw.deviceInfoXml, "WebUIVersion") ?? "--";
  const workMode = getXmlTag(raw.deviceInfoXml, "workmode") ?? "--";
  const wanV4 = (getXmlTag(raw.deviceInfoXml, "WanIPAddress") ?? "").trim()
    ? "198.51.100.42"
    : "--";
  const wanV6 = (getXmlTag(raw.deviceInfoXml, "WanIPv6Address") ?? "").trim()
    ? "2001:db8::42"
    : "--";
  console.log("[1] Device & WAN Dual-Stack Identity:");
  console.log(`    Model=${model} (${marketing}) | HW=${hwVer} | SW=${swVer} | WebUI=${webUiVer}`);
  console.log(
    `    WorkMode=${workMode} | WAN IPv4=${wanV4 || "--"} (redacted) | WAN IPv6=${wanV6 || "--"} (redacted) | CradleEthSpeed=${getXmlTag(raw.cradleXml, "ethernetspeed") ?? "--"} Mbps`
  );

  // 2. Wi-Fi 7 (802.11be) MLO & Channel Optimization
  let mloEnable = "--";
  let dbhoEnable = "--";
  try {
    const parsed = JSON.parse(raw.wlandbhoJson) as Record<string, unknown>;
    mloEnable = String(parsed["MloEnable"] ?? "--");
    dbhoEnable = String(parsed["DbhoEnable"] ?? "--");
  } catch {
    // Ignore if non-JSON
  }
  const ssidBlocks = getXmlBlocks(raw.wifiSecXml, "ssid");
  const radioModes = ssidBlocks
    .filter((b) => getXmlTag(b, "WifiEnable") === "1")
    .map((b) => {
      const id = getXmlTag(b, "ID") ?? "";
      const mode = huaweiXssDecode(getXmlTag(b, "WifiMode") ?? "");
      const ch = getXmlTag(b, "WifiChannel") ?? "0";
      const autoOpt = getXmlTag(b, "WifiChannelAutoOptimize") ?? "0";
      return `${id.replace("InternetGatewayDevice.X_Config.Wifi.", "")}[mode=${mode}, ch=${ch === "0" ? "Auto" : ch}, autoOpt=${autoOpt}]`;
    });

  console.log("\n[2] Wi-Fi 7 (802.11be) MLO, Band Steering & Channel Optimization:");
  console.log(
    `    MLO (Multi-Link Operation)=${mloEnable} | DBHO (Band Steering)=${dbhoEnable} | MaxAssoc=${getXmlTag(raw.wifiFeatureXml, "wifi_chip_maxassoc") ?? "--"} | EasyMesh=${getXmlTag(raw.wifiFeatureXml, "easymesh_enable") ?? "--"}`
  );
  console.log(
    `    ChannelOptimizeSwitch=${getXmlTag(raw.wifiFeatureXml, "channel_optimize_enable") ?? "--"} | ChannelDiagSwitch=${getXmlTag(raw.wifiFeatureXml, "wifi_channel_diagnosis_enable") ?? "--"}`
  );
  for (const rm of radioModes) {
    console.log(`    Active Radio Profile -> ${rm}`);
  }

  // 3. Antenna Mode & Physical Detection
  console.log("\n[3] Antenna Mode Control & Insertion Telemetry:");
  console.log(
    `    Operating Mode=${decodeAntennaMode(getXmlTag(raw.antennaSetXml, "antennasettype"))} | Ant1Inserted=${getXmlTag(raw.antennaTypeXml, "antenna1insertstatus") ?? "--"} (type=${getXmlTag(raw.antennaTypeXml, "antenna1type") ?? "--"}) | Ant2Inserted=${getXmlTag(raw.antennaTypeXml, "antenna2insertstatus") ?? "--"} (type=${getXmlTag(raw.antennaTypeXml, "antenna2type") ?? "--"})`
  );

  // 4. DHCP Pool & Static Reservations
  const staticHosts = getXmlBlocks(raw.dhcpStaticXml, "Host");
  console.log("\n[4] DHCP Server & Static MAC-IP Bindings:");
  console.log(
    `    Gateway=${getXmlTag(raw.dhcpSettingsXml, "DhcpIPAddress") ?? "--"} | Pool=${getXmlTag(raw.dhcpSettingsXml, "DhcpStartIPAddress") ?? "--"}..${getXmlTag(raw.dhcpSettingsXml, "DhcpEndIPAddress") ?? "--"} | LeaseTime=${getXmlTag(raw.dhcpSettingsXml, "DhcpLeaseTime") ?? "--"}s | ConfiguredStaticBindings=${staticHosts.length}`
  );
  for (const [idx, hostBlock] of staticHosts.slice(0, 3).entries()) {
    const maskedMac = maskMacAddress(getXmlTag(hostBlock, "HostHw") ?? "00:00:5E:00:53:01", idx + 1);
    const ip = sanitizeIpToken(getXmlTag(hostBlock, "HostIp") ?? "");
    const enabled = getXmlTag(hostBlock, "HostEnabled") ?? "1";
    console.log(`    Static Binding #${idx + 1} (sample): MAC=${maskedMac} -> IP=${ip} (enabled=${enabled}, alias=lan-static-0${idx + 1})`);
  }

  // 5. Dual-Stack APN, MTU & Bridge/Router Switch Mode
  const profiles = getXmlBlocks(raw.apnProfilesXml, "Profile");
  const primaryProfile = profiles[0] ?? "";
  console.log("\n[5] Cellular WAN Dialup, Dual-Stack APN & Bridge Mode:");
  console.log(
    `    MobileDataSwitch=${getXmlTag(raw.dataSwitchXml, "dataswitch") ?? "--"} | MTU=${getXmlTag(raw.dialupConnXml, "MTU") ?? "--"} | RoamAutoConnect=${getXmlTag(raw.dialupConnXml, "RoamAutoConnectEnable") ?? "--"} | LanSwitchIpMode=${getXmlTag(raw.ipModeXml, "ipmode") ?? "--"}/switchmode=${getXmlTag(raw.ipModeXml, "switchmode") ?? "--"}`
  );
  console.log(
    `    Active APN ProfileCount=${profiles.length} | APN=<REDACTED:internet.example> | IPType=${decodeIpType(getXmlTag(primaryProfile, "iptype"))} | ReadOnly=${getXmlTag(primaryProfile, "ReadOnly") ?? "--"}`
  );

  // 6. Scheduled Reboot, SNTP & WAN Ping/Traceroute Diagnostics
  const pingProbeErr = getXmlTag(raw.pingXml, "probe_err");
  const traceProbeErr = getXmlTag(raw.traceXml, "probe_err");
  console.log("\n[6] System Maintenance, SNTP & Network Diagnostics:");
  console.log(
    `    Scheduled Reboot : enable=${getXmlTag(raw.timeRebootXml, "enable") ?? "--"}, interval=${getXmlTag(raw.timeRebootXml, "dayinterval") ?? "--"}d, window=${getXmlTag(raw.timeRebootXml, "begintime") ?? "--"}..${getXmlTag(raw.timeRebootXml, "endtime") ?? "--"} min`
  );
  console.log(
    `    SNTP Time Sync   : status=${getXmlTag(raw.sntpXml, "time_sync_status") ?? "--"}, tz=${getXmlTag(raw.sntpXml, "currenttimezone") ?? "--"}`
  );
  console.log(
    `    Ping Engine      : ${pingProbeErr ? pingProbeErr : `available (DiagnosticsState=${getXmlTag(raw.pingXml, "DiagnosticsState") ?? "Idle"})`}`
  );
  console.log(
    `    Traceroute Engine: ${traceProbeErr ? traceProbeErr : `available (DiagnosticsState=${getXmlTag(raw.traceXml, "DiagnosticsState") ?? "Idle"})`}`
  );
}

main().catch((err: unknown) => {
  console.error("Probe #8 failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
