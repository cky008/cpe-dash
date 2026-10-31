import assert from "node:assert/strict";
import crypto from "node:crypto";
import { describe, it } from "node:test";
import {
  HuaweiCpeClient,
  ReentrantCpeSessionError,
} from "../src/cpe-client.ts";
import {
  CpeControlValidationError,
  applyBandLock,
  applyCellLock,
  fetchGlobalTelemetry,
  fetchRouterSettings,
  fetchTerminalTopology,
  rebootCpe,
  scanNeighborCells,
  triggerCellularReconnect,
  unlockAllRfLocks,
  updateAntennaMode,
  updateMobileDataSwitch,
  updateSecuritySettings,
  updateWifi7Mlo,
} from "../src/cpe-domain.ts";
import { computeScram } from "../src/crypto.ts";
import { getXmlTag } from "../src/xml.ts";

function buildMockCpeRouter(opts: {
  password?: string;
  stateLoginXml?: string;
  extraRoutes?: Record<string, (method: string, body: string) => string>;
  postedBodies?: Array<{ path: string; body: string; contentType: string }>;
}) {
  const password = opts.password ?? "unit_test_admin_pwd";
  const saltHex = "11".repeat(32);
  const serverNonce = `${"22".repeat(32)}${"33".repeat(32)}`;
  let tokenSeq = 100;
  let lastFirstNonce = "";

  const nextToken = (): string => `tok_${String(++tokenSeq).padStart(28, "0")}`;

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const pathname = url.pathname;
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? init.body : "";
    const reqHeaders = new Headers(init?.headers);
    if (method === "POST" && opts.postedBodies) {
      opts.postedBodies.push({
        path: pathname,
        body,
        contentType: reqHeaders.get("content-type") ?? "",
      });
    }

    const makeRes = (payload: string, includeTokens = true): Response => {
      const headers = new Headers({ "Content-Type": "text/html; charset=utf-8" });
      if (includeTokens) {
        headers.set("__RequestVerificationTokenone", nextToken());
        headers.set("__RequestVerificationTokentwo", nextToken());
      }
      headers.set("Set-Cookie", "SessionID=mock_session_cookie; Path=/; HttpOnly");
      return new Response(payload, { status: 200, headers });
    };

    if (pathname === "/api/user/state-login") {
      return makeRes(
        opts.stateLoginXml ??
          "<response><State>-1</State><lockstatus>0</lockstatus><remainwaittime>0</remainwaittime></response>",
        false
      );
    }
    if (pathname === "/api/monitoring/status") {
      return makeRes(
        "<response><ConnectionStatus>901</ConnectionStatus><SignalIcon>5</SignalIcon><SimStatus>1</SimStatus></response>"
      );
    }
    if (pathname === "/api/webserver/token") {
      return makeRes(`<response><token>${"0".repeat(32)}${nextToken()}</token></response>`, false);
    }
    if (pathname === "/api/user/challenge_login") {
      lastFirstNonce = getXmlTag(body, "firstnonce") ?? "";
      return makeRes(
        `<response><salt>${saltHex}</salt><iterations>1000</iterations><servernonce>${serverNonce}</servernonce></response>`
      );
    }
    if (pathname === "/api/user/authentication_login") {
      const scram = computeScram(password, saltHex, 1000, lastFirstNonce, serverNonce);
      const clientProof = getXmlTag(body, "clientproof") ?? "";
      if (clientProof.toLowerCase() !== scram.clientProofHex.toLowerCase()) {
        return makeRes("<error><code>108006</code><remaincount>2</remaincount></error>");
      }
      const eccPub = "09".padStart(64, "0");
      const eccSig = crypto
        .createHmac("sha256", scram.serverKey)
        .update(Buffer.from(eccPub, "hex"))
        .digest("hex");
      return makeRes(
        `<response><serversignature>${scram.expectedServerSig}</serversignature><ecc_server_pubkey>${eccPub}</ecc_server_pubkey><ecc_pubkey_signature>${eccSig}</ecc_pubkey_signature></response>`
      );
    }
    if (pathname === "/api/user/logout") {
      return makeRes("<response>OK</response>");
    }

    const custom = opts.extraRoutes?.[pathname];
    if (custom) {
      return makeRes(custom(method, body));
    }

    // Default telemetry & settings fixtures strictly matching PHASE1_PROTOCOL_SPEC.md
    switch (pathname) {
      case "/api/device/signal":
        return makeRes(
          `<response>
            <pci>321</pci>
            <cell_id>134217758</cell_id>
            <enodeb_id>0524288</enodeb_id>
            <tac>10001</tac>
            <band>20MHz@100(B1) + 20MHz@1700(B3) + 100MHz@647424(N78)</band>
            <bandInfo>B1</bandInfo>
            <earfcn>DL:100 UL:18100</earfcn>
            <nrearfcn>DL:647424 UL:647424</nrearfcn>
            <ulbandwidth>20MHz</ulbandwidth>
            <dlbandwidth>20MHz</dlbandwidth>
            <nrulbandwidth>100MHz</nrulbandwidth>
            <nrdlbandwidth>100MHz</nrdlbandwidth>
            <rsrp>-86dBm</rsrp>
            <rsrq>-8dB</rsrq>
            <rssi>-57dBm</rssi>
            <sinr>19dB</sinr>
            <nrrsrp>-82dBm</nrrsrp>
            <nrrsrq>-10dB</nrrsrq>
            <nrsinr>24dB</nrsinr>
            <transmode>TM[4]</transmode>
            <nrrank>2</nrrank>
            <cqi0>14</cqi0>
            <cqi1>13</cqi1>
            <nrcqi0>15</nrcqi0>
            <nrcqi1>14</nrcqi1>
            <ul_mcs>mcsUpCarrier1:27@256QAM</ul_mcs>
            <dl_mcs>mcsDownCarrier1Code0:26@256QAM mcsDownCarrier1Code1:25@256QAM</dl_mcs>
            <nrulmcs>NRmcsUpCarrier1:24@256QAM</nrulmcs>
            <nrdlmcs>NRmcsDownCarrier1Code0:27@256QAM NRmcsDownCarrier1Code1:0</nrdlmcs>
            <txpower>PPusch:9dBm PPucch:-7dBm PSrs:0dBm PPrach:-2dBm</txpower>
            <nrtxpower>PPusch:11dBm PPucch:-4dBm PSrs:0dBm PPrach:-1dBm</nrtxpower>
            <mode>7</mode>
          </response>`
        );
      case "/api/device/seccellinfo":
        return makeRes(
          `<response>
            <lteseccell_list>1700,3,20MHz,321,-89dBm,-9dB,-60dBm,17dB;</lteseccell_list>
            <nrseccell_list>647424,78,100MHz,512,-82dBm,-10dB,-54dBm,24dB;</nrseccell_list>
          </response>`
        );
      case "/api/device/ri":
        return makeRes("<response><ri>2</ri></response>");
      case "/api/net/cell-info":
        return makeRes("<response><lac>2711</lac><cellinfo>800001e</cellinfo></response>");
      case "/api/net/current-plmn":
        return makeRes("<response><FullName>MockTel 5G</FullName><Numeric>27201</Numeric><Rat>7</Rat></response>");
      case "/api/net/net-mode":
        return makeRes("<response><NetworkMode>00</NetworkMode><NetworkBand>3fffffff</NetworkBand><LTEBand>5</LTEBand></response>");
      case "/api/device/information":
        return makeRes(
          `<response>
            <DeviceName>H168-383</DeviceName>
            <HardwareVersion>WL1H168M</HardwareVersion>
            <SoftwareVersion>4.4.0.1(H1006SP19C00)</SoftwareVersion>
            <WebUIVersion>WEBUI 4.4.0.1(W2SP24C03)</WebUIVersion>
            <WanIPAddress>198.51.100.42</WanIPAddress>
            <wan_dns_address>1.1.1.1,8.8.8.8</wan_dns_address>
            <WanIPv6Address>2001:db8::42</WanIPv6Address>
            <wan_ipv6_dns_address>2001:db8::53</wan_ipv6_dns_address>
            <workmode>LTE</workmode>
            <uptime>86400</uptime>
          </response>`
        );
      case "/api/device/basic_information":
        return makeRes("<response><devicename>H168-383</devicename><spreadname_en>HUAWEI 5G CPE Ultra 6</spreadname_en></response>");
      case "/api/monitoring/traffic-statistics":
        return makeRes(
          `<response>
            <CurrentConnectTime>3600</CurrentConnectTime>
            <CurrentUpload>104857600</CurrentUpload>
            <CurrentDownload>1073741824</CurrentDownload>
            <CurrentDownloadRate>12500000</CurrentDownloadRate>
            <CurrentUploadRate>2500000</CurrentUploadRate>
            <TotalUpload>5368709120</TotalUpload>
            <TotalDownload>53687091200</TotalDownload>
            <TotalConnectTime>86400</TotalConnectTime>
          </response>`
        );
      case "/api/monitoring/month_statistics":
        return makeRes(
          `<response>
            <CurrentMonthDownload>21474836480</CurrentMonthDownload>
            <CurrentMonthUpload>2147483648</CurrentMonthUpload>
            <MonthDuration>43200</MonthDuration>
            <MonthLastClearTime>2026-10-01</MonthLastClearTime>
            <CurrentDayUsed>3221225472</CurrentDayUsed>
            <CurrentDayDuration>7200</CurrentDayDuration>
          </response>`
        );
      case "/api/monitoring/start_date":
        return makeRes("<response><StartDay>1</StartDay><DataLimit>0MB</DataLimit><MonthThreshold>90</MonthThreshold></response>");
      case "/api/device/nbrcellinfo":
        return makeRes(
          `<response>
            <nbrcell_ltelist>100,1,322,-94dBm,-11dB,-66dBm,8dB;</nbrcell_ltelist>
            <nbrcell_nrlist>647424,78,513,-88dBm,-11dB,-60dBm,18dB;</nbrcell_nrlist>
          </response>`
        );
      case "/api/system/HostInfo":
        return makeRes(
          JSON.stringify([
            {
              MACAddress: "02:00:5E:10:00:01",
              ActualName: "nas-ds923",
              HostName: "nas-ds923",
              InterfaceType: "Ethernet",
              Layer2Interface: "LAN1",
              Frequency: "",
              EthernetSpeed: 1000,
              PhyType: 1000,
              Active: 1,
              IPAddress: "192.168.8.10",
              IPv6Address: "2001:db8::10",
              V6Active: 1,
              AddressSource: "Static",
              LeaseTime: 82000,
              AssociatedTime: 86000,
            },
            {
              MACAddress: "02:00:5E:10:00:02",
              ActualName: "wifi7-phone",
              HostName: "wifi7-phone",
              InterfaceType: "Wireless",
              Layer2Interface: "SSID1",
              Frequency: "5GHz",
              rate: 2401,
              rssi: -52,
              Active: 1,
              IPAddress: "192.168.8.21",
              IPv6Address: "2001:db8::21",
              V6Active: 1,
              AddressSource: "DHCP",
              LeaseTime: 43200,
              AssociatedTime: 3600,
            },
          ])
        );
      case "/api/system/topology":
        return makeRes(
          JSON.stringify([
            { Active: 1, AccessType: "Ethernet", ConnectedDevices: [] },
            { Active: 1, AccessType: "Wireless", ConnectedDevices: [] },
          ])
        );
      case "/api/security/upnp":
        return makeRes(method === "POST" ? "<response>OK</response>" : "<response><UpnpStatus>0</UpnpStatus></response>");
      case "/api/security/dmz":
        return makeRes(
          method === "POST"
            ? "<response>OK</response>"
            : "<response><DmzMacAddress></DmzMacAddress><DmzStatus>0</DmzStatus><DmzIPAddress>192.168.8.100</DmzIPAddress></response>"
        );
      case "/api/security/firewall-switch":
        return makeRes(
          method === "POST"
            ? "<response>OK</response>"
            : "<response><FirewallMainSwitch>1</FirewallMainSwitch><FirewallIPFilterSwitch>1</FirewallIPFilterSwitch><FirewallWanPortPingSwitch>0</FirewallWanPortPingSwitch><firewallmacfilterswitch>1</firewallmacfilterswitch><firewallurlfilterswitch>1</firewallurlfilterswitch></response>"
        );
      case "/api/security/nat":
        return makeRes("<response><NATType>1</NATType></response>");
      case "/api/security/bridgemode":
        return makeRes("<response><bridgemode>0</bridgemode></response>");
      case "/api/wlan/wlandbho":
        return makeRes(method === "POST" ? '{"errcode":0}' : '{"MloEnable":true,"DbhoEnable":true}');
      case "/api/device/antenna_set_type":
        return makeRes(method === "POST" ? "<response>OK</response>" : "<response><antennasettype>0</antennasettype></response>");
      case "/api/device/antenna_type":
        return makeRes("<response><antenna1insertstatus>0</antenna1insertstatus><antenna2insertstatus>0</antenna2insertstatus></response>");
      case "/api/dialup/mobile-dataswitch":
        return makeRes(method === "POST" ? "<response>OK</response>" : "<response><dataswitch>1</dataswitch></response>");
      case "/api/net/lock-freq":
      case "/api/device/control":
      case "/api/net/reconnect":
        return makeRes("<response>OK</response>");
      default:
        return makeRes("<response>OK</response>");
    }
  };

  return { fetchImpl, password };
}

describe("HuaweiCpeClient Phase 2 concurrency & breaker hardening", () => {
  it("prevents re-entrant withSession deadlocks via AsyncLocalStorage", async () => {
    const { fetchImpl, password } = buildMockCpeRouter({});
    const client = new HuaweiCpeClient({
      cpeUrl: "http://192.168.8.1",
      cpePassword: password,
      fetchImpl,
    });

    await assert.rejects(
      () =>
        client.withSession(async () => {
          return await client.withSession(async () => "nested");
        }),
      ReentrantCpeSessionError
    );
  });

  it("never replays fn(session) writes if an occupied error occurs after login", async () => {
    let fnExecutions = 0;
    const { fetchImpl, password } = buildMockCpeRouter({
      extraRoutes: {
        "/api/device/control": () => "<error><code>108003</code><message>occupied</message></error>",
      },
    });
    const client = new HuaweiCpeClient({
      cpeUrl: "http://192.168.8.1",
      cpePassword: password,
      respectBrowserSession: false,
      fetchImpl,
    });

    await assert.rejects(
      () =>
        client.withSessionDetailed(
          async (session) => {
            fnExecutions++;
            return await session.postXml("/api/device/control", { Control: 1 });
          },
          { retriesOnOccupied: 3, occupiedRetryDelayMs: 5 }
        ),
      /108003/
    );
    assert.equal(fnExecutions, 1);
  });

  it("persists circuit breaker across restarts until password fingerprint changes", async () => {
    const { fetchImpl, password } = buildMockCpeRouter({});
    const client = new HuaweiCpeClient({
      cpeUrl: "http://192.168.8.1",
      cpePassword: "wrong_password_123",
      fetchImpl,
    });

    await assert.rejects(() => client.withSession(async () => "x"), /108006/);
    const savedState = client.getCircuitBreakerState();
    assert.equal(savedState.tripped, true);
    assert.equal(savedState.remainCount, 2);
    assert.ok(savedState.passwordFingerprintHex);

    // Simulate container restart with the SAME wrong password -> stays tripped without touching network!
    const restartedSamePwd = new HuaweiCpeClient({
      cpeUrl: "http://192.168.8.1",
      cpePassword: "wrong_password_123",
      fetchImpl: async () => {
        throw new Error("Should not hit network while hydrated breaker matches wrong password!");
      },
    });
    restartedSamePwd.hydrateCircuitBreaker(savedState);
    assert.equal(restartedSamePwd.getCircuitBreakerState().tripped, true);
    await assert.rejects(() => restartedSamePwd.withSession(async () => "x"), /108006/);

    // Reloading corrected credentials unlocks the breaker and succeeds!
    const hotReloaded = new HuaweiCpeClient({
      cpeUrl: "http://192.168.8.1",
      cpePassword: "wrong_password_123",
      fetchImpl,
    });
    hotReloaded.hydrateCircuitBreaker(savedState);
    hotReloaded.reloadCredentials(password);
    assert.equal(hotReloaded.getCircuitBreakerState().tripped, false);
    const outcome = await hotReloaded.withSessionDetailed(async () => "recovered");
    assert.equal(outcome.status, "ok");
  });
});

describe("CpeDomain telemetry & router control actions", () => {
  it("fetches 3CA + 256QAM + dual-period traffic + device telemetry in one JSON-safe snapshot", async () => {
    const { fetchImpl, password } = buildMockCpeRouter({});
    const client = new HuaweiCpeClient({
      cpeUrl: "http://192.168.8.1",
      cpePassword: password,
      fetchImpl,
    });

    const outcome = await client.withSessionDetailed((session) =>
      fetchGlobalTelemetry(session)
    );
    assert.equal(outcome.status, "ok");
    if (outcome.status !== "ok") return;

    const snap = outcome.value;
    assert.equal(snap.rf.caActive, true);
    assert.equal(snap.rf.caComponentCount, 3);
    assert.equal(snap.rf.totalAggregatedBandwidthMhz, 140);
    assert.equal(snap.rf.lteUlMcs[0]?.modulation, "256QAM");
    assert.equal(snap.rf.nrDlMcs[0]?.modulation, "256QAM");
    assert.equal(snap.rf.lteMimoRank, 2);
    assert.equal(snap.rf.nrMimoRank, 2);
    assert.deepEqual(snap.bandConfig.activeLteBands, [1, 3]);
    assert.equal(snap.traffic.downloadBps, 100_000_000);
    assert.equal(snap.traffic.todayUsedBytesStr, "3221225472");
    assert.equal(snap.traffic.monthTotalBytesStr, "23622320128");
    assert.equal(snap.thermal.temperatureCelsius, null);
    assert.equal(snap.thermal.temperatureSupported, false);

    // Must serialize cleanly to JSON without BigInt TypeError
    const json = JSON.stringify(snap);
    assert.ok(json.includes('"totalAggregatedBandwidthMhz":140'));
  });

  it("scans 4G/5G neighbor cells, terminal topology, and extended router settings", async () => {
    const { fetchImpl, password } = buildMockCpeRouter({});
    const client = new HuaweiCpeClient({
      cpeUrl: "http://192.168.8.1",
      cpePassword: password,
      fetchImpl,
    });

    const bundle = await client.withSession(async (session) => ({
      neighbors: await scanNeighborCells(session),
      topology: await fetchTerminalTopology(session),
      settings: await fetchRouterSettings(session),
    }));
    assert.ok(bundle);
    assert.equal(bundle.neighbors.lteNeighbors.length, 1);
    assert.equal(bundle.neighbors.nrNeighbors.length, 1);
    assert.equal(bundle.neighbors.nrNeighbors[0]?.pci, 513);

    assert.equal(bundle.topology.countsByMedium.LAN_1000M, 1);
    assert.equal(bundle.topology.countsByMedium.WIFI_5G, 1);
    assert.equal(bundle.topology.hosts[1]?.negotiatedRateMbps, 2401);

    assert.equal(bundle.settings.upnpEnabled, false);
    assert.equal(bundle.settings.dmzEnabled, false);
    assert.equal(bundle.settings.firewall.mainSwitch, true);
    assert.equal(bundle.settings.wifi7.mloEnable, true);
    assert.equal(bundle.settings.antenna.mode, "auto");
    assert.equal(bundle.settings.mobileDataEnabled, true);
  });

  it("executes validated band lock, cell lock, unlock, security/Wi-Fi7/antenna controls and guards reboot confirm: true", async () => {
    const postedBodies: Array<{ path: string; body: string; contentType: string }> = [];
    const { fetchImpl, password } = buildMockCpeRouter({ postedBodies });
    const client = new HuaweiCpeClient({
      cpeUrl: "http://192.168.8.1",
      cpePassword: password,
      fetchImpl,
    });

    await client.withSession(async (session) => {
      // Reboot MUST reject confirm: false before touching /api/device/control
      await assert.rejects(
        () => rebootCpe(session, { confirm: false }),
        CpeControlValidationError
      );

      await applyBandLock(session, { lteBands: ["B1", "B3"], nrBands: ["N78"] });
      await applyCellLock(session, { rat: "NR", band: "N78", arfcn: 647424, pci: 512 });
      await unlockAllRfLocks(session);
      await updateSecuritySettings(session, {
        upnpEnabled: true,
        dmz: { enabled: true, ipAddress: "192.168.8.100" },
        firewall: { wanPortPingSwitch: true },
      });
      await updateWifi7Mlo(session, { mloEnable: true, dbhoEnable: false });
      await updateAntennaMode(session, "external");
      await updateMobileDataSwitch(session, true);
      await triggerCellularReconnect(session);
      await rebootCpe(session, { confirm: true });
    });

    const controlPaths = postedBodies
      .map((p) => p.path)
      .filter((p) => !p.startsWith("/api/user/"));
    assert.ok(controlPaths.includes("/api/net/net-mode"));
    assert.ok(controlPaths.includes("/api/net/lock-freq"));
    assert.ok(controlPaths.includes("/api/security/upnp"));
    assert.ok(controlPaths.includes("/api/security/dmz"));
    assert.ok(controlPaths.includes("/api/security/firewall-switch"));
    assert.ok(controlPaths.includes("/api/wlan/wlandbho"));
    assert.ok(controlPaths.includes("/api/device/antenna_set_type"));
    assert.ok(controlPaths.includes("/api/dialup/mobile-dataswitch"));
    assert.ok(controlPaths.includes("/api/net/reconnect"));
    assert.ok(controlPaths.includes("/api/device/control"));

    const wlanPost = postedBodies.find((p) => p.path === "/api/wlan/wlandbho");
    assert.ok(wlanPost?.contentType.includes("application/json"));
    assert.equal(wlanPost?.body, '{"MloEnable":true,"DbhoEnable":false}');
  });

  it("exposes client credentials, awaits idle session, and rejects breaker hydration on mismatched password fingerprint", async () => {
    const { fetchImpl, password } = buildMockCpeRouter({});
    const client = new HuaweiCpeClient({
      cpeUrl: "http://192.168.8.1",
      cpeUsername: "custom_admin",
      cpePassword: password,
      fetchImpl,
    });

    assert.equal(client.username, "custom_admin");
    assert.equal(client.password, password);
    await client.waitForIdle();

    const hydrated = client.hydrateCircuitBreaker({
      tripped: true,
      code: "108006",
      reason: "persisted latch",
      trippedAtIso: new Date().toISOString(),
      remainCount: 2,
      waitTime: null,
      passwordFingerprintHex: "mismatched_password_fingerprint_hex",
    });
    assert.equal(hydrated, false);
    assert.equal(client.getCircuitBreakerState().tripped, false);
  });

  it("executes LTE cell lock, nrBands 'all' unlock, parses temperature telemetry, and enforces domain validation guards", async () => {
    const { fetchImpl, password } = buildMockCpeRouter({
      extraRoutes: {
        "/api/device/information": () =>
          `<response>
            <DeviceName>H168-383</DeviceName>
            <WanIPAddress>198.51.100.42</WanIPAddress>
            <temperature>47.5</temperature>
          </response>`,
      },
    });
    const client = new HuaweiCpeClient({
      cpeUrl: "http://192.168.8.1",
      cpePassword: password,
      fetchImpl,
    });

    await client.withSession(async (session) => {
      const lteCell = await applyCellLock(session, {
        rat: "LTE",
        band: "B3",
        arfcn: 1700,
        pci: 321,
      });
      assert.equal(lteCell.mode, "cell_lock");
      assert.deepEqual(lteCell.lteBands, [3]);
      assert.deepEqual(lteCell.nrBands, []);
      assert.equal(lteCell.cellLock?.rat, "LTE");

      const nrAll = await applyBandLock(session, { nrBands: "all" });
      assert.equal(nrAll.mode, "unlocked");
      assert.equal(nrAll.lteBands, "all");
      assert.deepEqual(nrAll.nrBands, []);

      const telemetry = await fetchGlobalTelemetry(session);
      assert.equal(telemetry.thermal.temperatureCelsius, 47.5);
      assert.equal(telemetry.thermal.temperatureSupported, true);

      await assert.rejects(
        () => applyBandLock(session, {}),
        CpeControlValidationError
      );
      await assert.rejects(
        () => applyCellLock(session, { rat: "GSM" as unknown as "LTE", band: "B1", arfcn: 100 }),
        CpeControlValidationError
      );
      await assert.rejects(
        () =>
          updateSecuritySettings(session, {
            dmz: { enabled: true, ipAddress: "999.999.999.999" },
          }),
        CpeControlValidationError
      );
      await assert.rejects(
        () => updateWifi7Mlo(session, {}),
        CpeControlValidationError
      );
      await assert.rejects(
        () => updateAntennaMode(session, "invalid_mode" as unknown as "auto"),
        CpeControlValidationError
      );
    });

    // Atomic pre-write validation: enabling DMZ when router has empty DmzIPAddress must NOT write UPnP
    const securityPosts: string[] = [];
    const { fetchImpl: emptyDmzFetch, password: emptyDmzPwd } = buildMockCpeRouter({
      extraRoutes: {
        "/api/security/upnp": (method) => {
          if (method === "POST") securityPosts.push("upnp");
          return "<response>OK</response>";
        },
        "/api/security/dmz": (method) => {
          if (method === "POST") securityPosts.push("dmz");
          return "<response><DmzStatus>0</DmzStatus><DmzIPAddress></DmzIPAddress></response>";
        },
      },
    });
    const atomicClient = new HuaweiCpeClient({
      cpeUrl: "http://192.168.8.1",
      cpePassword: emptyDmzPwd,
      fetchImpl: emptyDmzFetch,
    });
    await assert.rejects(
      () =>
        atomicClient.withSession(async (session) => {
          await updateSecuritySettings(session, {
            upnpEnabled: true,
            dmz: { enabled: true },
          });
        }),
      CpeControlValidationError
    );
    assert.deepEqual(securityPosts, []);
  });
});
