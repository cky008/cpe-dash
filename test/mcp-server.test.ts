import assert from "node:assert/strict";
import { createFengSuiCore } from "../src/core.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { HuaweiCpeClient } from "../src/cpe-client.ts";
import { computeScram } from "../src/crypto.ts";
import {
  FengSuiMcpServer,
  parseJsonSafeNullProto,
  SUPPORTED_MCP_PROTOCOL_VERSIONS,
  type JsonRpcErrorResponse,
  type JsonRpcSuccessResponse,
} from "../src/mcp-server.ts";
import { EncryptedStateStore } from "../src/state-store.ts";
import { TimeSeriesRingBuffer } from "../src/timeseries.ts";
import { getXmlTag } from "../src/xml.ts";

function createMockSchedulerFixture(opts: {
  password?: string;
  loginStateXml?: string;
  onPost?: (pathname: string, body: string) => void;
  throwOnGetCachedTelemetry?: boolean;
} = {}) {
  const password = opts.password ?? "sched_test_password";
  const saltHex = "aa".repeat(32);
  const serverNonce = `${"bb".repeat(32)}${"cc".repeat(32)}`;
  let tokenSeq = 0;
  let lastFirstNonce = "";
  const nextToken = (): string => `st_${String(++tokenSeq).padStart(29, "0")}`;

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const pathname = url.pathname;
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? init.body : "";

    if (method === "POST" && opts.onPost) {
      opts.onPost(pathname, body);
    }

    const makeRes = (payload: string, withTok = true, status = 200): Response => {
      const headers = new Headers({ "Content-Type": "text/html; charset=utf-8" });
      if (withTok) {
        headers.set("__RequestVerificationTokenone", nextToken());
        headers.set("__RequestVerificationTokentwo", nextToken());
      }
      headers.set("Set-Cookie", "SessionID=mock_session_cookie; Path=/; HttpOnly");
      return new Response(payload, { status, headers });
    };

    if (pathname === "/api/user/state-login") {
      const xml =
        opts.loginStateXml ??
        "<response><State>-1</State><lockstatus>0</lockstatus><remainwaittime>0</remainwaittime></response>";
      return makeRes(xml, false);
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
      return makeRes(`<response><serversignature>${scram.expectedServerSig}</serversignature></response>`);
    }
    if (pathname === "/api/user/logout") {
      return makeRes("<response>OK</response>");
    }
    if (pathname === "/api/webserver/token") {
      return makeRes(`<response><token>${"0".repeat(32)}${nextToken()}</token></response>`, false);
    }

    // Default telemetry fixtures strictly adhering to RFC placeholders
    if (pathname === "/api/device/signal") {
      return makeRes(
        "<response><pci>321</pci><band>20MHz@100(B1) + 100MHz@647424(N78)</band><rsrp>-84dBm</rsrp><sinr>20dB</sinr><nrrsrp>-80dBm</nrrsrp><nrsinr>25dB</nrsinr></response>"
      );
    }
    if (pathname === "/api/monitoring/traffic-statistics") {
      return makeRes(
        "<response><CurrentDownloadRate>6250000</CurrentDownloadRate><CurrentUploadRate>1250000</CurrentUploadRate><CurrentDownload>1048576</CurrentDownload><CurrentUpload>524288</CurrentUpload><TotalDownload>20971520</TotalDownload><TotalUpload>10485760</TotalUpload><CurrentConnectTime>3600</CurrentConnectTime><TotalConnectTime>86400</TotalConnectTime></response>"
      );
    }
    if (pathname === "/api/monitoring/month_statistics") {
      return makeRes(
        "<response><CurrentDayUsed>1048576</CurrentDayUsed><CurrentMonthDownload>10485760</CurrentMonthDownload><CurrentMonthUpload>2097152</CurrentMonthUpload><MonthDuration>43200</MonthDuration><CurrentDayDuration>7200</CurrentDayDuration><MonthLastClearTime>2026-10-01</MonthLastClearTime></response>"
      );
    }
    if (pathname === "/api/monitoring/status") {
      return makeRes(
        "<response><ConnectionStatus>901</ConnectionStatus><SignalIcon>5</SignalIcon><SimStatus>1</SimStatus></response>"
      );
    }
    if (pathname === "/api/monitoring/start_date") {
      return makeRes("<response><StartDay>1</StartDay><DataLimit>0MB</DataLimit><MonthThreshold>90</MonthThreshold></response>");
    }
    if (pathname === "/api/device/information") {
      return makeRes(
        "<response><DeviceName>H168-383</DeviceName><HardwareVersion>WL1H168M</HardwareVersion><SoftwareVersion>4.4.0.1</SoftwareVersion><WebUIVersion>WEBUI 4.4.0.1</WebUIVersion><WanIPAddress>198.51.100.42</WanIPAddress><WanIPv6Address>2001:db8::42</WanIPv6Address><workmode>LTE</workmode><uptime>86400</uptime></response>"
      );
    }
    if (pathname === "/api/device/basic_information") {
      return makeRes("<response><devicename>H168-383</devicename><spreadname_en>HUAWEI 5G CPE Ultra 6</spreadname_en></response>");
    }
    if (pathname === "/api/device/seccellinfo") {
      return makeRes("<response><lteseccell_list>1700,3,20MHz,321,-89dBm,-9dB,-60dBm,17dB;</lteseccell_list></response>");
    }
    if (pathname === "/api/device/ri") {
      return makeRes("<response><ri>2</ri></response>");
    }
    if (pathname === "/api/net/cell-info") {
      return makeRes("<response><lac>2711</lac><cellinfo>800001e</cellinfo></response>");
    }
    if (pathname === "/api/net/current-plmn") {
      return makeRes("<response><FullName>MockTel 5G</FullName><Numeric>27201</Numeric><Rat>7</Rat></response>");
    }
    if (pathname === "/api/net/net-mode") {
      return makeRes("<response><NetworkMode>00</NetworkMode><NetworkBand>3fffffff</NetworkBand><LTEBand>5</LTEBand></response>");
    }
    if (pathname === "/api/device/nbrcellinfo") {
      return makeRes(
        "<response><nbrcell_ltelist>100,1,322,-94dBm,-11dB,-66dBm,8dB;</nbrcell_ltelist><nbrcell_nrlist>647424,78,513,-88dBm,-11dB,-60dBm,18dB;</nbrcell_nrlist></response>"
      );
    }
    if (pathname === "/api/system/HostInfo") {
      return makeRes(
        JSON.stringify([
          {
            MACAddress: "02:00:5E:10:00:01",
            HostName: "nas-ds923",
            InterfaceType: "Ethernet",
            Active: 1,
            IPAddress: "192.168.8.10",
          },
        ])
      );
    }
    if (pathname === "/api/system/topology") {
      return makeRes(JSON.stringify([{ Active: 1, AccessType: "Ethernet", ConnectedDevices: [] }]));
    }
    if (pathname === "/api/security/upnp") {
      return makeRes(method === "POST" ? "<response>OK</response>" : "<response><UpnpStatus>0</UpnpStatus></response>");
    }
    if (pathname === "/api/security/dmz") {
      return makeRes(
        method === "POST"
          ? "<response>OK</response>"
          : "<response><DmzStatus>0</DmzStatus><DmzIPAddress>192.168.8.100</DmzIPAddress></response>"
      );
    }
    if (pathname === "/api/security/firewall-switch") {
      return makeRes(
        method === "POST"
          ? "<response>OK</response>"
          : "<response><FirewallMainSwitch>1</FirewallMainSwitch><FirewallIPFilterSwitch>1</FirewallIPFilterSwitch><FirewallWanPortPingSwitch>0</FirewallWanPortPingSwitch><firewallmacfilterswitch>1</firewallmacfilterswitch><firewallurlfilterswitch>1</firewallurlfilterswitch></response>"
      );
    }
    if (pathname === "/api/security/nat") {
      return makeRes("<response><NATType>1</NATType></response>");
    }
    if (pathname === "/api/security/bridgemode") {
      return makeRes("<response><bridgemode>0</bridgemode></response>");
    }
    if (pathname === "/api/wlan/wlandbho") {
      return makeRes(method === "POST" ? '{"errcode":0}' : '{"MloEnable":true,"DbhoEnable":true}');
    }
    if (pathname === "/api/device/antenna_set_type") {
      return makeRes(method === "POST" ? "<response>OK</response>" : "<response><antennasettype>0</antennasettype></response>");
    }
    if (pathname === "/api/device/antenna_type") {
      return makeRes(
        "<response><antenna1insertstatus>0</antenna1insertstatus><antenna2insertstatus>0</antenna2insertstatus></response>"
      );
    }
    if (pathname === "/api/dialup/mobile-dataswitch") {
      return makeRes(method === "POST" ? "<response>OK</response>" : "<response><dataswitch>1</dataswitch></response>");
    }
    if (pathname === "/api/net/lock-freq" || pathname === "/api/device/control" || pathname === "/api/net/reconnect") {
      return makeRes("<response>OK</response>");
    }

    return makeRes("<response>OK</response>");
  };

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fengsui-mcp-"));
  const stateStore = new EncryptedStateStore({
    filePath: path.join(tmpDir, "state.json"),
    encryptionKey: password,
  });
  const client = new HuaweiCpeClient({
    cpeUrl: "http://192.168.8.1",
    cpePassword: password,
    fetchImpl,
  });
  const ring = new TimeSeriesRingBuffer({ retentionHours: 24 });

  const core = createFengSuiCore({
    client,
    stateStore,
    timeseries: ring,
    pollIntervalMs: 60_000,
    neighborScanIntervalMs: 120_000,
  });
  const scheduler = core.scheduler;
  core.monitor.init();

  if (opts.throwOnGetCachedTelemetry) {
    core.monitor.getCachedTelemetry = () => {
      throw new Error("Telemetry cache corrupted");
    };
  }

  const cleanup = (): void => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  };

  return { core, scheduler, cleanup, client };
}

describe("FengSuiMcpServer protocol, schema, safe JSON parsing & tool dispatch", () => {
  it("parseJsonSafeNullProto strips __proto__, constructor, prototype and creates null-prototype objects", () => {
    const raw = JSON.stringify({
      __proto__: { injected: "evil" },
      constructor: { hacked: true },
      prototype: { polluted: true },
      normalKey: "safe_value",
      nested: {
        __proto__: 123,
        constructor: "bad",
        validSub: 42,
      },
      list: [1, "two", { constructor: "bad", arrayObj: true }],
    });

    const parsed = parseJsonSafeNullProto(raw) as Record<string, unknown>;
    assert.ok(parsed);
    assert.equal(typeof parsed, "object");
    assert.equal(Object.getPrototypeOf(parsed), null);
    assert.equal(parsed["normalKey"], "safe_value");
    assert.equal(parsed["__proto__"], undefined);
    assert.equal(parsed["constructor"], undefined);
    assert.equal(parsed["prototype"], undefined);

    const nested = parsed["nested"] as Record<string, unknown>;
    assert.equal(Object.getPrototypeOf(nested), null);
    assert.equal(nested["validSub"], 42);
    assert.equal(nested["__proto__"], undefined);
    assert.equal(nested["constructor"], undefined);

    // Primitives and arrays
    assert.equal(parseJsonSafeNullProto("123"), 123);
    assert.equal(parseJsonSafeNullProto('"string"'), "string");
    assert.equal(parseJsonSafeNullProto("true"), true);
    assert.equal(parseJsonSafeNullProto("null"), null);
    const arr = parseJsonSafeNullProto('[{"__proto__": "bad", "ok": 1}]') as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(arr));
    assert.equal(arr[0]?.["ok"], 1);
    assert.equal(arr[0]?.["__proto__"], undefined);
  });

  it("isSupportedProtocolVersion checks supported protocol versions and trim variations", () => {
    const fx = createMockSchedulerFixture();
    try {
      const server = new FengSuiMcpServer({ core: fx.core });
      assert.equal(server.isSupportedProtocolVersion(undefined), true);
      assert.equal(server.isSupportedProtocolVersion(""), true);
      assert.equal(server.isSupportedProtocolVersion("2025-06-18"), true);
      assert.equal(server.isSupportedProtocolVersion("2025-03-26"), true);
      assert.equal(server.isSupportedProtocolVersion("  2025-06-18  "), true);
      assert.equal(server.isSupportedProtocolVersion("1999-01-01"), false);
      assert.equal(server.isSupportedProtocolVersion("not_a_version"), false);

      for (const ver of SUPPORTED_MCP_PROTOCOL_VERSIONS) {
        assert.equal(server.isSupportedProtocolVersion(ver), true);
      }
    } finally {
      fx.cleanup();
    }
  });

  it("handleRawJsonMessage handles parse errors, invalid envelopes, batches, notifications, and unknown methods", async () => {
    const fx = createMockSchedulerFixture();
    try {
      const server = new FengSuiMcpServer({ core: fx.core });

      // Invalid JSON syntax (-32700)
      const parseErr = (await server.handleRawJsonMessage("{ not valid json")) as JsonRpcErrorResponse;
      assert.equal(parseErr.jsonrpc, "2.0");
      assert.equal(parseErr.id, null);
      assert.equal(parseErr.error.code, -32700);
      assert.match(parseErr.error.message, /Parse error/i);

      // JSON array batch (-32600)
      const batchErr = (await server.handleRawJsonMessage(
        JSON.stringify([{ jsonrpc: "2.0", method: "ping", id: 1 }])
      )) as JsonRpcErrorResponse;
      assert.equal(batchErr.error.code, -32600);
      assert.match(batchErr.error.message, /batches disabled/i);

      // Primitive string instead of object (-32600)
      const primErr = (await server.handleRawJsonMessage('"just a string"')) as JsonRpcErrorResponse;
      assert.equal(primErr.error.code, -32600);

      // Invalid envelope (-32600): wrong jsonrpc version
      const envErr1 = (await server.handleRawJsonMessage(
        JSON.stringify({ jsonrpc: "1.0", method: "ping", id: 1 })
      )) as JsonRpcErrorResponse;
      assert.equal(envErr1.error.code, -32600);
      assert.equal(envErr1.id, 1);

      // Invalid envelope (-32600): missing or empty method
      const envErr2 = (await server.handleRawJsonMessage(
        JSON.stringify({ jsonrpc: "2.0", method: "", id: "req_2" })
      )) as JsonRpcErrorResponse;
      assert.equal(envErr2.error.code, -32600);
      assert.equal(envErr2.id, "req_2");

      const envErr3 = (await server.handleRawJsonMessage(
        JSON.stringify({ jsonrpc: "2.0", method: 123, id: 3 })
      )) as JsonRpcErrorResponse;
      assert.equal(envErr3.error.code, -32600);

      // Notification without id produces null response
      const notif = await server.handleRawJsonMessage(
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })
      );
      assert.equal(notif, null);

      // ping method
      const pingRes = (await server.handleRawJsonMessage(
        JSON.stringify({ jsonrpc: "2.0", id: 10, method: "ping" })
      )) as JsonRpcSuccessResponse;
      assert.equal(pingRes.id, 10);
      assert.deepEqual(pingRes.result, {});

      // initialize method with requested version match
      const initRes1 = (await server.handleRawJsonMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 11,
          method: "initialize",
          params: { protocolVersion: "2025-03-26" },
        })
      )) as JsonRpcSuccessResponse;
      const initPayload1 = initRes1.result as Record<string, unknown>;
      assert.equal(initPayload1["protocolVersion"], "2025-03-26");
      assert.equal((initPayload1["serverInfo"] as Record<string, string>)["name"], "fengsui-cpe-dash");

      // initialize method fallback on unsupported version
      const initRes2 = (await server.handleRawJsonMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 12,
          method: "initialize",
          params: { protocolVersion: "unsupported_version" },
        })
      )) as JsonRpcSuccessResponse;
      const initPayload2 = initRes2.result as Record<string, unknown>;
      assert.equal(initPayload2["protocolVersion"], "2025-11-25", "unsupported versions negotiate the latest supported one");

      // Unknown method (-32601)
      const unknownMethodRes = (await server.handleRawJsonMessage(
        JSON.stringify({ jsonrpc: "2.0", id: 13, method: "nonexistent_method" })
      )) as JsonRpcErrorResponse;
      assert.equal(unknownMethodRes.error.code, -32601);
      assert.match(unknownMethodRes.error.message, /Method not found/i);

      // Non-primitive / null id handling: rejects with -32600 before dispatching
      const boolIdErr = (await server.handleRawJsonMessage(
        JSON.stringify({ jsonrpc: "1.0", method: "ping", id: true })
      )) as JsonRpcErrorResponse;
      assert.equal(boolIdErr.id, null);
      assert.equal(boolIdErr.error.code, -32600);

      const nullIdErr = (await server.handleRawJsonMessage(
        JSON.stringify({ jsonrpc: "2.0", method: "ping", id: null })
      )) as JsonRpcErrorResponse;
      assert.equal(nullIdErr.id, null);
      assert.equal(nullIdErr.error.code, -32600);

      const objIdErr = (await server.handleRawJsonMessage(
        JSON.stringify({ jsonrpc: "2.0", method: "ping", id: {} })
      )) as JsonRpcErrorResponse;
      assert.equal(objIdErr.id, null);
      assert.equal(objIdErr.error.code, -32600);
    } finally {
      fx.cleanup();
    }
  });

  it("tools/list switches between allowMutations: true (13 tools) and allowMutations: false (6 tools)", async () => {
    const fx = createMockSchedulerFixture();
    try {
      const serverRw = new FengSuiMcpServer({ core: fx.core, allowMutations: true });
      const toolsRw = serverRw.getToolDefinitions();
      assert.equal(toolsRw.length, 13);

      const listRw = (await serverRw.handleRawJsonMessage(
        JSON.stringify({ jsonrpc: "2.0", id: 20, method: "tools/list" })
      )) as JsonRpcSuccessResponse;
      const listRwPayload = listRw.result as { tools: Array<{ name: string }> };
      assert.equal(listRwPayload.tools.length, 13);

      const serverRo = new FengSuiMcpServer({ core: fx.core, allowMutations: false });
      const toolsRo = serverRo.getToolDefinitions();
      assert.equal(toolsRo.length, 6);
      const toolNames = new Set(toolsRo.map((t) => t.name));
      assert.ok(toolNames.has("get_cpe_telemetry"));
      assert.ok(toolNames.has("query_telemetry_history"));
      assert.ok(toolNames.has("list_neighbor_cells"));
      assert.ok(toolNames.has("get_cpe_session_status"));
      assert.ok(toolNames.has("list_terminal_topology"));
      assert.ok(toolNames.has("get_router_settings"));
      assert.ok(!toolNames.has("lock_band"));
      assert.ok(!toolNames.has("reboot_cpe"));

      // Invoking a mutating tool on read-only server returns MUTATIONS_DISABLED
      const mutRes = (await serverRo.handleRawJsonMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 21,
          method: "tools/call",
          params: { name: "lock_band", arguments: { lteBands: ["B1"] } },
        })
      )) as JsonRpcSuccessResponse;
      const mutPayload = mutRes.result as {
        isError: boolean;
        structuredContent: { errorCode: string };
      };
      assert.equal(mutPayload.isError, true);
      assert.equal(mutPayload.structuredContent.errorCode, "MUTATIONS_DISABLED");
    } finally {
      fx.cleanup();
    }
  });

  it("resources/list and resources/read serve telemetry, session, locks, and reject unknown URIs", async () => {
    const fx = createMockSchedulerFixture();
    try {
      const server = new FengSuiMcpServer({ core: fx.core });

      // Pre-warm cache
      await fx.core.monitor.refreshTelemetry();

      const listRes = (await server.handleRawJsonMessage(
        JSON.stringify({ jsonrpc: "2.0", id: 30, method: "resources/list" })
      )) as JsonRpcSuccessResponse;
      const resources = (listRes.result as { resources: Array<{ uri: string }> }).resources;
      assert.equal(resources.length, 3);
      assert.equal(resources[0]?.uri, "fengsui://telemetry/latest");
      assert.equal(resources[1]?.uri, "fengsui://session/status");
      assert.equal(resources[2]?.uri, "fengsui://locks/state");

      // Read telemetry
      const r1 = (await server.handleRawJsonMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 31,
          method: "resources/read",
          params: { uri: "fengsui://telemetry/latest" },
        })
      )) as JsonRpcSuccessResponse;
      const r1Payload = r1.result as { contents: Array<{ text: string; mimeType: string }> };
      assert.equal(r1Payload.contents[0]?.mimeType, "application/json");
      assert.match(r1Payload.contents[0]?.text ?? "", /"pci": 321/);

      // Read session
      const r2 = (await server.handleRawJsonMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 32,
          method: "resources/read",
          params: { uri: "fengsui://session/status" },
        })
      )) as JsonRpcSuccessResponse;
      const r2Payload = r2.result as { contents: Array<{ text: string }> };
      assert.match(r2Payload.contents[0]?.text ?? "", /"circuitBreaker"/);

      // Read lock state
      const r3 = (await server.handleRawJsonMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 33,
          method: "resources/read",
          params: { uri: "fengsui://locks/state" },
        })
      )) as JsonRpcSuccessResponse;
      const r3Payload = r3.result as { contents: Array<{ text: string }> };
      assert.match(r3Payload.contents[0]?.text ?? "", /"mode"/);

      // Unknown URI returns -32602
      const r4 = (await server.handleRawJsonMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 34,
          method: "resources/read",
          params: { uri: "fengsui://unknown/resource" },
        })
      )) as JsonRpcErrorResponse;
      assert.equal(r4.error.code, -32602);
      assert.match(r4.error.message, /Unknown resource URI/);
    } finally {
      fx.cleanup();
    }
  });

  it("handles internal exception in resources/read producing code -32603", async () => {
    const fx = createMockSchedulerFixture({ throwOnGetCachedTelemetry: true });
    try {
      const server = new FengSuiMcpServer({ core: fx.core });
      const res = (await server.handleRawJsonMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 39,
          method: "resources/read",
          params: { uri: "fengsui://telemetry/latest" },
        })
      )) as JsonRpcErrorResponse;
      assert.equal(res.error.code, -32603);
      assert.match(res.error.message, /Telemetry cache corrupted/);
    } finally {
      fx.cleanup();
    }
  });

  it("executes every read-only tool: get_cpe_telemetry, query_telemetry_history, list_neighbor_cells, get_cpe_session_status, list_terminal_topology, get_router_settings", async () => {
    const fx = createMockSchedulerFixture();
    try {
      const server = new FengSuiMcpServer({ core: fx.core });

      // 1. get_cpe_telemetry (refresh: true vs refresh: false)
      const telFresh = (await server.handleRawJsonMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 40,
          method: "tools/call",
          params: { name: "get_cpe_telemetry", arguments: { refresh: true } },
        })
      )) as JsonRpcSuccessResponse;
      const telFreshPayload = telFresh.result as {
        structuredContent: { ok: boolean; telemetry: { rf: { pci: number } } };
      };
      assert.equal(telFreshPayload.structuredContent.ok, true);
      assert.equal(telFreshPayload.structuredContent.telemetry.rf.pci, 321);

      const telCached = (await server.handleRawJsonMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 41,
          method: "tools/call",
          params: { name: "get_cpe_telemetry", arguments: { refresh: false } },
        })
      )) as JsonRpcSuccessResponse;
      assert.equal((telCached.result as { isError: boolean }).isError, false);

      // 2. query_telemetry_history (valid preset 1h & custom range, invalid fromMs > toMs)
      const hist1h = (await server.handleRawJsonMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 42,
          method: "tools/call",
          params: { name: "query_telemetry_history", arguments: { preset: "1h" } },
        })
      )) as JsonRpcSuccessResponse;
      assert.equal((hist1h.result as { isError: boolean }).isError, false);

      const now = Date.now();
      const histCustom = (await server.handleRawJsonMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 43,
          method: "tools/call",
          params: {
            name: "query_telemetry_history",
            arguments: { preset: "custom", fromMs: now - 300_000, toMs: now },
          },
        })
      )) as JsonRpcSuccessResponse;
      assert.equal((histCustom.result as { isError: boolean }).isError, false);

      const histInvalid = (await server.handleRawJsonMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 44,
          method: "tools/call",
          params: {
            name: "query_telemetry_history",
            arguments: { preset: "custom", fromMs: 2000, toMs: 1000 },
          },
        })
      )) as JsonRpcSuccessResponse;
      const histInvalidPayload = histInvalid.result as {
        isError: boolean;
        structuredContent: { errorCode: string };
      };
      assert.equal(histInvalidPayload.isError, true);
      assert.equal(histInvalidPayload.structuredContent.errorCode, "VALIDATION_ERROR");

      // 3. list_neighbor_cells (scanNow: false vs true)
      const nbr1 = (await server.handleRawJsonMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 45,
          method: "tools/call",
          params: { name: "list_neighbor_cells", arguments: { scanNow: true } },
        })
      )) as JsonRpcSuccessResponse;
      assert.equal((nbr1.result as { isError: boolean }).isError, false);

      const nbr2 = (await server.handleRawJsonMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 46,
          method: "tools/call",
          params: { name: "list_neighbor_cells", arguments: { scanNow: false } },
        })
      )) as JsonRpcSuccessResponse;
      assert.equal((nbr2.result as { isError: boolean }).isError, false);

      // 4. get_cpe_session_status (probeLive: false vs true)
      const st1 = (await server.handleRawJsonMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 47,
          method: "tools/call",
          params: { name: "get_cpe_session_status", arguments: { probeLive: false } },
        })
      )) as JsonRpcSuccessResponse;
      assert.equal((st1.result as { isError: boolean }).isError, false);

      const st2 = (await server.handleRawJsonMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 48,
          method: "tools/call",
          params: { name: "get_cpe_session_status", arguments: { probeLive: true } },
        })
      )) as JsonRpcSuccessResponse;
      const st2Payload = st2.result as { structuredContent: { liveStateLogin: { state: string } } };
      assert.equal(st2Payload.structuredContent.liveStateLogin.state, "-1");

      // 5. list_terminal_topology (refresh: false vs true)
      const topo1 = (await server.handleRawJsonMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 49,
          method: "tools/call",
          params: { name: "list_terminal_topology", arguments: { refresh: true } },
        })
      )) as JsonRpcSuccessResponse;
      assert.equal((topo1.result as { isError: boolean }).isError, false);

      const topo2 = (await server.handleRawJsonMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 50,
          method: "tools/call",
          params: { name: "list_terminal_topology", arguments: { refresh: false } },
        })
      )) as JsonRpcSuccessResponse;
      assert.equal((topo2.result as { isError: boolean }).isError, false);

      // 6. get_router_settings (refresh: false vs true)
      const set1 = (await server.handleRawJsonMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 51,
          method: "tools/call",
          params: { name: "get_router_settings", arguments: { refresh: true } },
        })
      )) as JsonRpcSuccessResponse;
      assert.equal((set1.result as { isError: boolean }).isError, false);

      const set2 = (await server.handleRawJsonMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 52,
          method: "tools/call",
          params: { name: "get_router_settings", arguments: { refresh: false } },
        })
      )) as JsonRpcSuccessResponse;
      assert.equal((set2.result as { isError: boolean }).isError, false);
    } finally {
      fx.cleanup();
    }
  });

  it("executes all control tools: lock_band, lock_cell, unlock_rf_locks, set_security_switches, set_wifi_and_antenna, reconnect_cellular, reboot_cpe", async () => {
    const posts: Array<{ path: string; body: string }> = [];
    const fx = createMockSchedulerFixture({
      onPost: (pathname, body) => {
        posts.push({ path: pathname, body });
      },
    });
    try {
      const server = new FengSuiMcpServer({ core: fx.core, allowMutations: true });

      // 1. lock_band valid (lteBands + nrBands) and 'all'
      const lb1 = (await server.handleRawJsonMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 60,
          method: "tools/call",
          params: {
            name: "lock_band",
            arguments: { lteBands: ["B1", "B3"], nrBands: ["N78"] },
          },
        })
      )) as JsonRpcSuccessResponse;
      assert.equal((lb1.result as { isError: boolean }).isError, false);

      const lbAll = (await server.handleRawJsonMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 61,
          method: "tools/call",
          params: {
            name: "lock_band",
            arguments: { lteBands: "all", nrBands: "all" },
          },
        })
      )) as JsonRpcSuccessResponse;
      assert.equal((lbAll.result as { isError: boolean }).isError, false);

      // lock_band validation errors: non-array non-all
      const lbBad1 = (await server.handleRawJsonMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 62,
          method: "tools/call",
          params: { name: "lock_band", arguments: { lteBands: 12345 } },
        })
      )) as JsonRpcSuccessResponse;
      assert.equal((lbBad1.result as { structuredContent: { errorCode: string } }).structuredContent.errorCode, "VALIDATION_ERROR");

      const lbBad2 = (await server.handleRawJsonMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 63,
          method: "tools/call",
          params: { name: "lock_band", arguments: { lteBands: [true] } },
        })
      )) as JsonRpcSuccessResponse;
      assert.equal((lbBad2.result as { structuredContent: { errorCode: string } }).structuredContent.errorCode, "VALIDATION_ERROR");

      // 2. lock_cell only targets observed cells: unknown before any telemetry/neighbour data ...
      const lcUnseen = (await server.handleRawJsonMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 640,
          method: "tools/call",
          params: { name: "lock_cell", arguments: { rat: "LTE", band: "B1", arfcn: 100, pci: 321 } },
        })
      )) as JsonRpcSuccessResponse;
      assert.equal((lcUnseen.result as { structuredContent: { errorCode: string } }).structuredContent.errorCode, "CELL_NOT_OBSERVED");
      await fx.core.monitor.refreshTelemetry();
      await fx.core.monitor.refreshNeighbors();
      const lcInvented = (await server.handleRawJsonMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 641,
          method: "tools/call",
          params: { name: "lock_cell", arguments: { rat: "LTE", band: "B1", arfcn: 100, pci: 999 } },
        })
      )) as JsonRpcSuccessResponse;
      assert.equal((lcInvented.result as { structuredContent: { errorCode: string } }).structuredContent.errorCode, "CELL_NOT_OBSERVED");

      // ... then the serving cell (PCI 321), a neighbour (PCI 322) and an aggregated NR carrier are lockable
      const lcNeighbour = (await server.handleRawJsonMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 642,
          method: "tools/call",
          params: { name: "lock_cell", arguments: { rat: "LTE", band: 1, arfcn: 100, pci: 322 } },
        })
      )) as JsonRpcSuccessResponse;
      assert.equal((lcNeighbour.result as { isError: boolean }).isError, false);
      const lcLte = (await server.handleRawJsonMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 64,
          method: "tools/call",
          params: {
            name: "lock_cell",
            arguments: { rat: "LTE", band: "B1", arfcn: 100, pci: 321 },
          },
        })
      )) as JsonRpcSuccessResponse;
      assert.equal((lcLte.result as { isError: boolean }).isError, false);

      const lcNr = (await server.handleRawJsonMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 65,
          method: "tools/call",
          params: {
            name: "lock_cell",
            arguments: { rat: "NR", band: "N78", arfcn: 647424 },
          },
        })
      )) as JsonRpcSuccessResponse;
      assert.equal((lcNr.result as { isError: boolean }).isError, false);

      // lock_cell invalid params
      const lcBadRat = (await server.handleRawJsonMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 66,
          method: "tools/call",
          params: {
            name: "lock_cell",
            arguments: { rat: "GSM", band: "B1", arfcn: 100 },
          },
        })
      )) as JsonRpcSuccessResponse;
      assert.equal((lcBadRat.result as { structuredContent: { errorCode: string } }).structuredContent.errorCode, "VALIDATION_ERROR");

      const lcBadBand = (await server.handleRawJsonMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 67,
          method: "tools/call",
          params: {
            name: "lock_cell",
            arguments: { rat: "LTE", arfcn: 100 },
          },
        })
      )) as JsonRpcSuccessResponse;
      assert.equal((lcBadBand.result as { structuredContent: { errorCode: string } }).structuredContent.errorCode, "VALIDATION_ERROR");

      const lcBadArfcn = (await server.handleRawJsonMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 68,
          method: "tools/call",
          params: {
            name: "lock_cell",
            arguments: { rat: "LTE", band: "B1", arfcn: "not_a_number" },
          },
        })
      )) as JsonRpcSuccessResponse;
      assert.equal((lcBadArfcn.result as { structuredContent: { errorCode: string } }).structuredContent.errorCode, "VALIDATION_ERROR");

      const lcMissingArfcn = (await server.handleRawJsonMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 681,
          method: "tools/call",
          params: {
            name: "lock_cell",
            arguments: { rat: "LTE", band: "B1" },
          },
        })
      )) as JsonRpcSuccessResponse;
      assert.equal((lcMissingArfcn.result as { structuredContent: { errorCode: string } }).structuredContent.errorCode, "VALIDATION_ERROR");

      // 3. unlock_rf_locks
      const unl = (await server.handleRawJsonMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 69,
          method: "tools/call",
          params: { name: "unlock_rf_locks", arguments: {} },
        })
      )) as JsonRpcSuccessResponse;
      assert.equal((unl.result as { isError: boolean }).isError, false);

      // 4. set_security_switches (with full options, and with upnp only)
      const sec = (await server.handleRawJsonMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 70,
          method: "tools/call",
          params: {
            name: "set_security_switches",
            arguments: {
              upnpEnabled: true,
              dmzEnabled: true,
              dmzIpAddress: "192.168.8.100",
              firewallMainSwitch: true,
              firewallIpFilterSwitch: true,
              firewallWanPortPingSwitch: false,
              firewallMacFilterSwitch: true,
              firewallUrlFilterSwitch: true,
            },
          },
        })
      )) as JsonRpcSuccessResponse;
      assert.equal((sec.result as { isError: boolean }).isError, false);

      const secUpnpOnly = (await server.handleRawJsonMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 701,
          method: "tools/call",
          params: {
            name: "set_security_switches",
            arguments: { upnpEnabled: false },
          },
        })
      )) as JsonRpcSuccessResponse;
      assert.equal((secUpnpOnly.result as { isError: boolean }).isError, false);

      // 5. set_wifi_and_antenna
      const wifiAnt = (await server.handleRawJsonMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 71,
          method: "tools/call",
          params: {
            name: "set_wifi_and_antenna",
            arguments: {
              mloEnable: true,
              dbhoEnable: true,
              antennaMode: "external",
            },
          },
        })
      )) as JsonRpcSuccessResponse;
      assert.equal((wifiAnt.result as { isError: boolean }).isError, false);

      // set_wifi_and_antenna with antennaMode only ("auto" and "internal")
      const antAuto = (await server.handleRawJsonMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 72,
          method: "tools/call",
          params: {
            name: "set_wifi_and_antenna",
            arguments: { antennaMode: "auto" },
          },
        })
      )) as JsonRpcSuccessResponse;
      assert.equal((antAuto.result as { isError: boolean }).isError, false);

      const antInt = (await server.handleRawJsonMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 73,
          method: "tools/call",
          params: {
            name: "set_wifi_and_antenna",
            arguments: { antennaMode: "internal" },
          },
        })
      )) as JsonRpcSuccessResponse;
      assert.equal((antInt.result as { isError: boolean }).isError, false);

      // set_wifi_and_antenna errors: bad antennaMode vs empty params
      const antBad = (await server.handleRawJsonMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 74,
          method: "tools/call",
          params: {
            name: "set_wifi_and_antenna",
            arguments: { antennaMode: "invalid_antenna" },
          },
        })
      )) as JsonRpcSuccessResponse;
      assert.equal((antBad.result as { structuredContent: { errorCode: string } }).structuredContent.errorCode, "VALIDATION_ERROR");

      const antEmpty = (await server.handleRawJsonMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 75,
          method: "tools/call",
          params: {
            name: "set_wifi_and_antenna",
            arguments: {},
          },
        })
      )) as JsonRpcSuccessResponse;
      assert.equal((antEmpty.result as { structuredContent: { errorCode: string } }).structuredContent.errorCode, "VALIDATION_ERROR");

      // 6. reconnect_cellular (confirm: false vs confirm: true)
      const recNoConfirm = (await server.handleRawJsonMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 76,
          method: "tools/call",
          params: { name: "reconnect_cellular", arguments: { confirm: false } },
        })
      )) as JsonRpcSuccessResponse;
      assert.equal((recNoConfirm.result as { structuredContent: { errorCode: string } }).structuredContent.errorCode, "CONFIRMATION_REQUIRED");

      const recConfirm = (await server.handleRawJsonMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 77,
          method: "tools/call",
          params: { name: "reconnect_cellular", arguments: { confirm: true } },
        })
      )) as JsonRpcSuccessResponse;
      assert.equal((recConfirm.result as { isError: boolean }).isError, false);

      // 7. reboot_cpe (confirm: false vs confirm: true)
      const rebNoConfirm = (await server.handleRawJsonMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 78,
          method: "tools/call",
          params: { name: "reboot_cpe", arguments: { confirm: false } },
        })
      )) as JsonRpcSuccessResponse;
      assert.equal((rebNoConfirm.result as { structuredContent: { errorCode: string } }).structuredContent.errorCode, "CONFIRMATION_REQUIRED");

      const rebConfirm = (await server.handleRawJsonMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 79,
          method: "tools/call",
          params: { name: "reboot_cpe", arguments: { confirm: true } },
        })
      )) as JsonRpcSuccessResponse;
      assert.equal((rebConfirm.result as { isError: boolean }).isError, false);

      // 8. Unknown tool name -> McpProtocolRpcError -32602
      const unkTool = (await server.handleRawJsonMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 80,
          method: "tools/call",
          params: { name: "unknown_rf_tool", arguments: {} },
        })
      )) as JsonRpcErrorResponse;
      assert.equal(unkTool.error.code, -32602);
      assert.match(unkTool.error.message, /Unknown MCP tool/);

      // 9. Argument type checks for asBooleanOpt and asNumberOpt
      const badBool = (await server.handleRawJsonMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 81,
          method: "tools/call",
          params: { name: "get_cpe_telemetry", arguments: { refresh: "not_a_bool" } },
        })
      )) as JsonRpcSuccessResponse;
      assert.equal((badBool.result as { structuredContent: { errorCode: string } }).structuredContent.errorCode, "VALIDATION_ERROR");

      const badNum = (await server.handleRawJsonMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 82,
          method: "tools/call",
          params: { name: "query_telemetry_history", arguments: { fromMs: "not_a_num" } },
        })
      )) as JsonRpcSuccessResponse;
      assert.equal((badNum.result as { structuredContent: { errorCode: string } }).structuredContent.errorCode, "VALIDATION_ERROR");
    } finally {
      fx.cleanup();
    }
  });

  it("handles BrowserSessionYieldedError when mock CPE returns State=0 during polite avoidance", async () => {
    // When state-login returns State=0, human admin is using official WebUI
    const fx = createMockSchedulerFixture({
      loginStateXml: "<response><State>0</State><lockstatus>0</lockstatus><remainwaittime>0</remainwaittime></response>",
    });
    try {
      const server = new FengSuiMcpServer({ core: fx.core, allowMutations: true });
      const res = (await server.handleRawJsonMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 90,
          method: "tools/call",
          params: { name: "lock_band", arguments: { lteBands: ["B1"] } },
        })
      )) as JsonRpcSuccessResponse;

      const payload = res.result as {
        isError: boolean;
        structuredContent: { errorCode: string; messageZh: string; avoidance: { active: boolean } };
      };
      assert.equal(payload.isError, true);
      assert.equal(payload.structuredContent.errorCode, "BROWSER_SESSION_YIELDED");
      assert.ok(payload.structuredContent.messageZh.length > 0);
      assert.equal(payload.structuredContent.avoidance.active, true);
    } finally {
      fx.cleanup();
    }
  });

  it("handles generic CPE execution error in executeToolCall", async () => {
    const fx = createMockSchedulerFixture();
    try {
      const server = new FengSuiMcpServer({ core: fx.core, allowMutations: true });
      // Force scheduler.lockBands to throw a generic Error
      fx.core.controls.lockBands = async () => {
        throw new Error("Modem baseband hardware fault");
      };

      const res = (await server.handleRawJsonMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 95,
          method: "tools/call",
          params: { name: "lock_band", arguments: { lteBands: ["B1"] } },
        })
      )) as JsonRpcSuccessResponse;

      const payload = res.result as {
        isError: boolean;
        structuredContent: { errorCode: string; message: string };
      };
      assert.equal(payload.isError, true);
      assert.equal(payload.structuredContent.errorCode, "CPE_EXECUTION_ERROR");
      assert.match(payload.structuredContent.message, /Modem baseband hardware fault/);

      // Also test non-Error string throw
      fx.core.controls.lockBands = async () => {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw "String hardware exception";
      };
      const resStr = (await server.handleRawJsonMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 96,
          method: "tools/call",
          params: { name: "lock_band", arguments: { lteBands: ["B1"] } },
        })
      )) as JsonRpcSuccessResponse;
      const payloadStr = resStr.result as {
        isError: boolean;
        structuredContent: { errorCode: string; message: string };
      };
      assert.equal(payloadStr.isError, true);
      assert.match(payloadStr.structuredContent.message, /String hardware exception/);
    } finally {
      fx.cleanup();
    }
  });

  it("attachStdio parses NDJSON input streams, skips empty lines, drops notifications, rejects oversized frames >64KiB, and detaches cleanly", async () => {
    const fx = createMockSchedulerFixture();
    try {
      const server = new FengSuiMcpServer({ core: fx.core });
      const inputStream = new PassThrough();
      const outputStream = new PassThrough();

      const receivedLines: string[] = [];
      outputStream.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        for (const line of text.split("\n")) {
          const trimmed = line.trim();
          if (trimmed) receivedLines.push(trimmed);
        }
      });

      const detach = server.attachStdio(inputStream, outputStream);

      // 1. Send normal ping request
      inputStream.write(`${JSON.stringify({ jsonrpc: "2.0", id: 101, method: "ping" })}\n`);
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(receivedLines.length, 1);
      const pingResp = JSON.parse(receivedLines[0] ?? "{}") as JsonRpcSuccessResponse;
      assert.equal(pingResp.id, 101);

      // 2. Empty line or whitespace-only is skipped without output
      inputStream.write("   \n\n");
      await new Promise((r) => setTimeout(r, 10));
      assert.equal(receivedLines.length, 1);

      // 3. Notification produces no line
      inputStream.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`
      );
      await new Promise((r) => setTimeout(r, 10));
      assert.equal(receivedLines.length, 1);

      // 4. Oversized line > 64KiB with newline returns -32600
      const largePayload = "a".repeat(65 * 1024);
      inputStream.write(`${largePayload}\n`);
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(receivedLines.length, 2);
      const errResp = JSON.parse(receivedLines[1] ?? "{}") as JsonRpcErrorResponse;
      assert.equal(errResp.error.code, -32600);
      assert.match(errResp.error.message, /exceeds 64 KiB/);

      // 5. Multi-chunk split request + newline-less >64KiB flood recovery
      const splitReq = JSON.stringify({ jsonrpc: "2.0", id: "chunk_102", method: "ping" });
      inputStream.write(splitReq.slice(0, 12));
      inputStream.write(`${splitReq.slice(12)}\n`);
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(receivedLines.length, 3);
      assert.equal((JSON.parse(receivedLines[2] ?? "{}") as JsonRpcSuccessResponse).id, "chunk_102");

      // Newline-less >64KiB chunk triggers immediate error, discards trailing chunks until \n, then recovers
      inputStream.write("x".repeat(65 * 1024));
      inputStream.write("still_discarding_no_newline");
      inputStream.write(`_tail\n${JSON.stringify({ jsonrpc: "2.0", id: 103, method: "ping" })}\n`);
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(receivedLines.length, 5);
      assert.equal((JSON.parse(receivedLines[3] ?? "{}") as JsonRpcErrorResponse).error.code, -32600);
      assert.equal((JSON.parse(receivedLines[4] ?? "{}") as JsonRpcSuccessResponse).id, 103);

      // 6. Detach removes data listener cleanly
      detach();

      // 7. Opus acceptance checks: unlock_rf_locks destructiveHint + pre-session validation on multi-write tools
      const unlockTool = server.getToolDefinitions().find((t) => t.name === "unlock_rf_locks");
      assert.equal(unlockTool?.annotations?.destructiveHint, true);

      // Every invalid argument must be rejected before the first write: zero CPE sessions, no partial apply
      const sessionsBefore = fx.scheduler.getStatus().totalSessionsCompleted;
      const invalidMultiWriteCalls: Array<{ name: string; arguments: Record<string, unknown> }> = [
        { name: "set_wifi_and_antenna", arguments: { mloEnable: true, antennaMode: "invalid_mode" } },
        { name: "set_security_switches", arguments: { upnpEnabled: true, dmzEnabled: true, dmzIpAddress: "bad_ip" } },
        { name: "set_security_switches", arguments: { upnpEnabled: true, dmzEnabled: true, dmzIpAddress: 42 } },
        { name: "set_security_switches", arguments: { upnpEnabled: true, dmzIpAddress: "192.168.8.100" } },
      ];
      for (const [idx, call] of invalidMultiWriteCalls.entries()) {
        const res = (await server.handleRawJsonMessage(
          JSON.stringify({ jsonrpc: "2.0", id: 201 + idx, method: "tools/call", params: call })
        )) as JsonRpcSuccessResponse;
        const result = res.result as { isError?: boolean; structuredContent?: { errorCode?: string } };
        assert.equal(result.isError, true, `${call.name} ${JSON.stringify(call.arguments)}`);
        assert.equal(result.structuredContent?.errorCode, "VALIDATION_ERROR");
      }
      assert.equal(fx.scheduler.getStatus().totalSessionsCompleted, sessionsBefore);
    } finally {
      fx.cleanup();
    }
  });
});
