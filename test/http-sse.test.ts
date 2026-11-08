import assert from "node:assert/strict";
import { type FengSuiCore, createFengSuiCore, stopFengSuiCore } from "../src/core.ts";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import {
  createFengSuiRuntime,
  formatCliHelp,
  isCliEntryPoint,
  parseCliCommand,
  runCli,
} from "../src/cli.ts";
import { loadConfig } from "../src/config.ts";
import { HuaweiCpeClient } from "../src/cpe-client.ts";
import { computeScram } from "../src/crypto.ts";
import {
  constantTimeSecretMatch,
  FengSuiHttpServer,
} from "../src/http-server.ts";
import { FengSuiMcpServer } from "../src/mcp-server.ts";
import {
  MutexSessionScheduler,
  SchedulerQueueFullError,
} from "../src/scheduler.ts";
import {
  SseEventBus,
  type SseEventName,
} from "../src/sse-bus.ts";
import { EncryptedStateStore } from "../src/state-store.ts";
import { TimeSeriesRingBuffer } from "../src/timeseries.ts";
import type { AppConfig } from "../src/types.ts";
import { getXmlTag } from "../src/xml.ts";
import { consoleSettingsFor } from "./helpers/console-settings.ts";
import { removeTempDir, tempDir } from "./helpers/temp-dir.ts";

function rawHttpRequest(opts: {
  host: string;
  port: number;
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: opts.host,
        port: opts.port,
        method: opts.method ?? "GET",
        path: opts.path,
        headers: opts.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      }
    );
    req.on("error", reject);
    if (opts.body) {
      req.write(opts.body);
    }
    req.end();
  });
}

function createMockCpeFetch(opts: {
  password?: string;
  loginStateXml?: string;
  onPost?: (path: string, body: string) => void;
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
        "<response><pci>321</pci><cell_id>134217758</cell_id><tac>10001</tac><band>20MHz@300(B1) + 100MHz@650000(N78)</band><rsrp>-84dBm</rsrp><sinr>20dB</sinr><nrrsrp>-80dBm</nrrsrp><nrsinr>25dB</nrsinr></response>"
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
      return makeRes("<response><lteseccell_list>1850,3,20MHz,321,-89dBm,-9dB,-60dBm,17dB;</lteseccell_list></response>");
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
        "<response><nbrcell_ltelist>300,1,322,-94dBm,-11dB,-66dBm,8dB;</nbrcell_ltelist><nbrcell_nrlist>650000,78,513,-88dBm,-11dB,-60dBm,18dB;</nbrcell_nrlist></response>"
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

  return fetchImpl;
}

interface TestServerContext {
  server: FengSuiHttpServer;
  core: FengSuiCore;
  cpeClient: HuaweiCpeClient;
  scheduler: MutexSessionScheduler;
  sseBus: SseEventBus;
  mcpServer: FengSuiMcpServer;
  baseUrl: string;
  host: string;
  port: number;
  config: AppConfig;
  apiToken: string;
  tmpDir: string;
  staticDir: string;
  envPath: string;
  cleanup: () => Promise<void>;
}

async function createTestHttpServer(opts: {
  loginStateXml?: string;
  onPost?: (path: string, body: string) => void;
  mcpHttpEnabled?: boolean;
  rateLimitMaxAuthFailures?: number;
  trustedProxies?: string;
  sseMaxClients?: number;
  nonExistentStaticDir?: boolean;
  sessionTtlMs?: number;
} = {}): Promise<TestServerContext> {
  const tmpDir = tempDir("fengsui-http-test-");
  const staticDir = opts.nonExistentStaticDir
    ? path.join(tmpDir, "does-not-exist")
    : path.join(tmpDir, "public");

  if (!opts.nonExistentStaticDir) {
    fs.mkdirSync(staticDir, { recursive: true });
    fs.writeFileSync(path.join(staticDir, "index.html"), "<!doctype html><html><body>FengSui WebUI</body></html>", "utf8");
    fs.writeFileSync(path.join(staticDir, "style.css"), "body { color: #333; }", "utf8");
    fs.writeFileSync(path.join(staticDir, "app.js"), "console.log('ready');", "utf8");
    fs.writeFileSync(path.join(staticDir, "icon.svg"), "<svg></svg>", "utf8");
    fs.writeFileSync(path.join(staticDir, "data.json"), '{"static":true}', "utf8");
    fs.writeFileSync(path.join(staticDir, "blob.bin"), Buffer.from([1, 2, 3]));
    fs.writeFileSync(path.join(staticDir, "THIRD_PARTY_NOTICES.txt"), "# Third-party notices", "utf8");
  }

  const envPath = path.join(tmpDir, ".env");
  const dummyEnv = [
    "CPE_URL=http://192.168.8.1",
    "CPE_PASSWORD=sched_test_password",
    "API_TOKEN=test_api_token_abc",
    "DATA_ENCRYPTION_KEY=sched_test_password",
    "WEB_HOST=127.0.0.1",
    "WEB_PORT=0",
    "ALLOWED_HOSTS=127.0.0.1,localhost",
    `STATIC_DIR=${staticDir}`,
    `STATE_FILE=${path.join(tmpDir, "state.json")}`,
    `MCP_HTTP_ENABLED=${opts.mcpHttpEnabled !== false ? "true" : "false"}`,
    `RATE_LIMIT_MAX_AUTH_FAILURES=${opts.rateLimitMaxAuthFailures ?? 3}`,
    `TRUSTED_PROXIES=${opts.trustedProxies ?? "127.0.0.1"}`,
    `SSE_MAX_CLIENTS=${opts.sseMaxClients ?? 16}`,
    `SESSION_TTL_MS=${opts.sessionTtlMs ?? 86400000}`,
  ].join("\n");
  fs.writeFileSync(envPath, dummyEnv, "utf8");

  const config = loadConfig({ envPath, ignoreProcessEnv: true });
  const fetchImpl = createMockCpeFetch({
    password: config.cpePassword,
    loginStateXml: opts.loginStateXml,
    onPost: opts.onPost,
  });

  const stateStore = new EncryptedStateStore({
    filePath: config.stateFile,
    encryptionKey: config.dataEncryptionKey,
  });
  const ring = new TimeSeriesRingBuffer({ retentionHours: 24 });
  const cpeClient = new HuaweiCpeClient({
    cpeUrl: config.cpeUrl,
    cpePassword: config.cpePassword,
    fetchImpl,
  });
  const core = createFengSuiCore({
    client: cpeClient,
    stateStore,
    timeseries: ring,
    pollIntervalMs: 60_000,
    neighborScanIntervalMs: 120_000,
  });
  const scheduler = core.scheduler;
  core.monitor.init();

  const sseBus = new SseEventBus({
    heartbeatMs: 2000,
    maxClients: opts.sseMaxClients ?? 16,
    maxClientsPerIp: 6,
  });
  sseBus.attachCore(core);
  sseBus.start();

  const mcpServer = new FengSuiMcpServer({
    core,
    allowMutations: config.mcpAllowMutations,
  });

  const server = new FengSuiHttpServer({
    config,
    core,
    sseBus,
    mcpServer,
    envPath,
    settings: consoleSettingsFor(config),
  });

  const bound = await server.listen();
  const baseUrl = `http://${bound.host}:${bound.port}`;

  const cleanup = async (): Promise<void> => {
    sseBus.stop();
    await server.close();
    await stopFengSuiCore(core);
    try {
      removeTempDir(tmpDir);
    } catch {
      // Ignore cleanup error
    }
  };

  return {
    server,
    core,
    cpeClient,
    scheduler,
    sseBus,
    mcpServer,
    baseUrl,
    host: bound.host,
    port: bound.port,
    config,
    apiToken: config.apiToken,
    tmpDir,
    staticDir,
    envPath,
    cleanup,
  };
}

class MockServerResponse extends EventEmitter {
  writableEnded = false;
  destroyed = false;
  headers: Record<string, string> = {};

  writeHead(_status: number, h: Record<string, string>) {
    Object.assign(this.headers, h);
    return this;
  }
  write(_chunk: string) {
    return true;
  }
  end() {
    this.writableEnded = true;
    this.emit("close");
  }
  flushHeaders() {}
}

class MockIncomingMessage extends EventEmitter {}

describe("SseEventBus fan-out, lifecycle, rate caps, backpressure & event validation", () => {
  it("manages start and stop idempotently, and reports correct client count", () => {
    const bus = new SseEventBus({ heartbeatMs: 3000, maxClients: 5, maxClientsPerIp: 2 });
    assert.equal(bus.getClientCount(), 0);
    bus.start();
    bus.start(); // Idempotent start
    assert.equal(bus.getClientCount(), 0);
    bus.stop();
    bus.stop(); // Idempotent stop
  });

  it("enforces maxClients and maxClientsPerIp caps on subscribe", () => {
    const bus = new SseEventBus({ maxClients: 2, maxClientsPerIp: 1 });
    const dummyReq = new MockIncomingMessage() as unknown as IncomingMessage;

    // Client 1 from IP A (accepted)
    const res1 = new MockServerResponse() as unknown as ServerResponse;
    const sub1 = bus.subscribe({
      req: dummyReq,
      res: res1,
      clientIp: "192.168.8.10",
      initialSnapshot: {
        schedulerStatus: { mode: "idle" },
        avoidance: { active: false },
        telemetry: { pci: 321 },
        lockState: { mode: "unlocked" },
      },
    });
    assert.equal(sub1.accepted, true);
    assert.equal(bus.getClientCount(), 1);

    // Client 2 from same IP A (rejected: max per IP is 1)
    const res2 = new MockServerResponse() as unknown as ServerResponse;
    const sub2 = bus.subscribe({
      req: dummyReq,
      res: res2,
      clientIp: "192.168.8.10",
    });
    assert.equal(sub2.accepted, false);
    assert.match(sub2.reason ?? "", /per-IP stream limit/i);

    // Client 3 from IP B (accepted: global limit is 2)
    const res3 = new MockServerResponse() as unknown as ServerResponse;
    const sub3 = bus.subscribe({
      req: dummyReq,
      res: res3,
      clientIp: "192.168.8.20",
    });
    assert.equal(sub3.accepted, true);
    assert.equal(bus.getClientCount(), 2);

    // Client 4 from IP C (rejected: global limit is 2 reached)
    const res4 = new MockServerResponse() as unknown as ServerResponse;
    const sub4 = bus.subscribe({
      req: dummyReq,
      res: res4,
      clientIp: "192.168.8.30",
    });
    assert.equal(sub4.accepted, false);
    assert.match(sub4.reason ?? "", /global client limit/i);

    bus.stop();
  });

  it("throws on unsafe SSE event names containing CRLF or invalid characters", () => {
    const bus = new SseEventBus();
    assert.throws(
      () => bus.broadcast("bad\nevent" as SseEventName, {}),
      /Unsafe SSE event name/
    );
    assert.throws(
      () => bus.broadcast("event with spaces" as SseEventName, {}),
      /Unsafe SSE event name/
    );
  });

  it("forwards all 8 scheduler events when attached", () => {
    const bus = new SseEventBus();
    const mockScheduler = {
      handlers: new Map<string, (d: unknown) => void>(),
      on(event: string, fn: (d: unknown) => void) {
        this.handlers.set(event, fn);
      },
      off(event: string) {
        this.handlers.delete(event);
      },
    };

    const mockCore = { scheduler: mockScheduler, monitor: mockScheduler } as never;
    bus.attachCore(mockCore);
    // Attaching twice detaches previous handlers cleanly
    bus.attachCore(mockCore);

    const received: Array<{ event: string; data: unknown }> = [];
    bus.broadcast = (event, data) => {
      received.push({ event, data });
      return 1;
    };

    const eventNames = [
      "telemetry",
      "speed",
      "neighbors",
      "topology",
      "settings",
      "session:avoidance",
      "alert",
      "control:applied",
    ];

    for (const name of eventNames) {
      const handler = mockScheduler.handlers.get(name);
      assert.ok(handler, `Missing handler for ${name}`);
      handler({ name, ok: true });
    }

    assert.equal(received.length, 8);
    for (let i = 0; i < eventNames.length; i++) {
      assert.equal(received[i]?.event, eventNames[i]);
    }

    bus.stop();
    assert.equal(mockScheduler.handlers.size, 0);
  });

  it("evicts expired sessions and slow consumers with consecutive backpressures > 3", () => {
    const bus = new SseEventBus({ heartbeatMs: 5000 });
    const dummyReq = new MockIncomingMessage() as unknown as IncomingMessage;
    let writeShouldFail = false;
    let writeReturnFalse = false;

    const createTrackedRes = () => {
      const res = new MockServerResponse();
      res.write = () => {
        if (writeShouldFail) throw new Error("Socket broken");
        if (writeReturnFalse) return false;
        return true;
      };
      return res as unknown as ServerResponse;
    };

    // Sub 1: normal with session id
    bus.subscribe({
      req: dummyReq,
      res: createTrackedRes(),
      clientIp: "192.168.8.10",
      sessionId: "session_123",
    });

    // Sub 2: already expired
    bus.subscribe({
      req: dummyReq,
      res: createTrackedRes(),
      clientIp: "192.168.8.20",
      expiresAtMs: Date.now() - 1000,
    });

    // Sub 3: backpressured socket
    bus.subscribe({
      req: dummyReq,
      res: createTrackedRes(),
      clientIp: "192.168.8.30",
    });

    assert.equal(bus.getClientCount(), 3);

    // Broadcast triggers expired eviction on Sub 2
    bus.broadcast("telemetry", { sample: 1 });
    assert.equal(bus.getClientCount(), 2);

    // Send heartbeat triggers keepalive comment
    const heartbeats = bus.sendHeartbeat();
    assert.equal(heartbeats, 2);

    // Disconnect by session id
    const closed = bus.disconnectBySessionId("session_123");
    assert.equal(closed, 1);
    assert.equal(bus.getClientCount(), 1);

    // Cause consecutive backpressures on remaining client
    writeReturnFalse = true;
    bus.broadcast("telemetry", { test: 1 }); // count 1
    bus.broadcast("telemetry", { test: 2 }); // count 2
    bus.broadcast("telemetry", { test: 3 }); // count 3
    bus.broadcast("telemetry", { test: 4 }); // count 4 -> evict!
    assert.equal(bus.getClientCount(), 0);

    // Socket exception handling
    writeShouldFail = true;
    bus.subscribe({
      req: dummyReq,
      res: createTrackedRes(),
      clientIp: "192.168.8.40",
    });
    bus.broadcast("telemetry", {});
    assert.equal(bus.getClientCount(), 0);

    bus.stop();
  });
});

describe("constantTimeSecretMatch utility", () => {
  it("matches identical secrets in constant time and rejects mismatches or empty secrets", () => {
    assert.equal(constantTimeSecretMatch("my_secret_token", "my_secret_token"), true);
    assert.equal(constantTimeSecretMatch("wrong_token", "my_secret_token"), false);
    assert.equal(constantTimeSecretMatch("", "my_secret_token"), false);
    assert.equal(constantTimeSecretMatch("my_secret_token", ""), false);
  });
});

describe("FengSuiHttpServer security guards, auth flows, REST API, SSE & static file serving", () => {
  it("exposes server config getter and handles internal 500 error gracefully", async () => {
    const fx = await createTestHttpServer();
    try {
      assert.ok(fx.server.config.cpeUrl);

      // Force internal error in Date.now to hit line 173-181
      const originalNow = Date.now;
      try {
        Date.now = () => {
          throw new Error("Internal timestamp failure");
        };
        const res500 = await fetch(`${fx.baseUrl}/api/health`);
        assert.equal(res500.status, 500);
        const data500 = (await res500.json()) as { errorCode: string };
        assert.equal(data500.errorCode, "INTERNAL_ERROR");
      } finally {
        Date.now = originalNow;
      }
    } finally {
      await fx.cleanup();
    }
  });

  it("rejects DNS rebinding Host headers and rejects OPTIONS preflight with 405", async () => {
    const fx = await createTestHttpServer();
    try {
      // Re-listen idempotency
      const secondListen = await fx.server.listen();
      assert.equal(secondListen.port, fx.port);

      // DNS rebinding evil Host header -> 421 Misdirected Host
      const resEvil = await rawHttpRequest({
        host: "127.0.0.1",
        port: fx.port,
        path: "/api/health",
        headers: { Host: "evil.attacker.com" },
      });
      assert.equal(resEvil.status, 421);
      const dataEvil = JSON.parse(resEvil.body) as { errorCode: string };
      assert.equal(dataEvil.errorCode, "MISDIRECTED_HOST");

      // OPTIONS preflight -> 405 Method Not Allowed
      const resOpt = await fetch(`${fx.baseUrl}/api/telemetry`, {
        method: "OPTIONS",
      });
      assert.equal(resOpt.status, 405);
      const dataOpt = (await resOpt.json()) as { errorCode: string };
      assert.equal(dataOpt.errorCode, "METHOD_NOT_ALLOWED");

      // Invalid URL handling (line 464)
      const resBadUrl = await rawHttpRequest({
        host: "127.0.0.1",
        port: fx.port,
        path: "http://[invalid-host",
      });
      assert.equal(resBadUrl.status, 400);
    } finally {
      await fx.cleanup();
    }
  });

  it("serves public GET /api/health and GET /api/i18n endpoints", async () => {
    const fx = await createTestHttpServer();
    try {
      const resHealth = await fetch(`${fx.baseUrl}/api/health`);
      assert.equal(resHealth.status, 200);
      const dataHealth = (await resHealth.json()) as { ok: boolean; service: string; codename: string };
      assert.equal(dataHealth.ok, true);
      assert.equal(dataHealth.service, "cpe-dash");
      assert.equal(dataHealth.codename, "FengSui");

      // Valid i18n
      const resZh = await fetch(`${fx.baseUrl}/api/i18n/zh-CN`);
      assert.equal(resZh.status, 200);
      const dataZh = (await resZh.json()) as { ok: boolean; locale: string; catalog: Record<string, string> };
      assert.equal(dataZh.ok, true);
      assert.equal(dataZh.locale, "zh-CN");

      const resEn = await fetch(`${fx.baseUrl}/api/i18n/en`);
      assert.equal(resEn.status, 200);
      const dataEn = (await resEn.json()) as { locale: string };
      assert.equal(dataEn.locale, "en");

      // Unsupported locale -> 404
      const resFr = await fetch(`${fx.baseUrl}/api/i18n/fr`);
      assert.equal(resFr.status, 404);
      const dataFr = (await resFr.json()) as { errorCode: string };
      assert.equal(dataFr.errorCode, "LOCALE_NOT_FOUND");
    } finally {
      await fx.cleanup();
    }
  });

  it("enforces CSRF, rate limits, cookie sessions, and secure flags on /api/auth/*", async () => {
    const fx = await createTestHttpServer({ rateLimitMaxAuthFailures: 3 });
    try {
      const url = new URL(fx.baseUrl);
      const validHost = url.host;

      // 1. GET /api/auth/status when unauthenticated
      const resStUnauth = await fetch(`${fx.baseUrl}/api/auth/status`);
      assert.equal(resStUnauth.status, 200);
      const dataStUnauth = (await resStUnauth.json()) as { authenticated: boolean };
      assert.equal(dataStUnauth.authenticated, false);

      // 2. CSRF rejection: missing X-Requested-With
      const resCsrf1 = await fetch(`${fx.baseUrl}/api/auth/login`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: `http://${validHost}`,
        },
        body: JSON.stringify({ token: fx.apiToken }),
      });
      assert.equal(resCsrf1.status, 403);

      // CSRF rejection: Origin is null
      const resCsrf2 = await fetch(`${fx.baseUrl}/api/auth/login`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Requested-With": "XMLHttpRequest",
          Origin: "null",
        },
        body: JSON.stringify({ token: fx.apiToken }),
      });
      assert.equal(resCsrf2.status, 403);

      // CSRF rejection: cross-origin Origin
      const resCsrf3 = await fetch(`${fx.baseUrl}/api/auth/login`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Requested-With": "XMLHttpRequest",
          Origin: "http://evil.com",
        },
        body: JSON.stringify({ token: fx.apiToken }),
      });
      assert.equal(resCsrf3.status, 403);

      // CSRF rejection: malformed Origin
      const resCsrf4 = await fetch(`${fx.baseUrl}/api/auth/login`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Requested-With": "XMLHttpRequest",
          Origin: "not_a_valid_url",
        },
        body: JSON.stringify({ token: fx.apiToken }),
      });
      assert.equal(resCsrf4.status, 403);

      // Content-Type not JSON on login -> 403 (by CSRF guard)
      const resCt = await fetch(`${fx.baseUrl}/api/auth/login`, {
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
          "X-Requested-With": "XMLHttpRequest",
          Origin: `http://${validHost}`,
        },
        body: fx.apiToken,
      });
      assert.equal(resCt.status, 403);

      // Malformed JSON -> 400
      const resBadJson = await fetch(`${fx.baseUrl}/api/auth/login`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Requested-With": "XMLHttpRequest",
          Origin: `http://${validHost}`,
        },
        body: "{ not valid json",
      });
      assert.equal(resBadJson.status, 400);

      // Non-object JSON (array) -> 400
      const resArr = await fetch(`${fx.baseUrl}/api/auth/login`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Requested-With": "XMLHttpRequest",
          Origin: `http://${validHost}`,
        },
        body: "[]",
      });
      assert.equal(resArr.status, 400);

      // 3. Failed logins trigger rate limiting after 3 attempts
      for (let i = 0; i < 3; i++) {
        const failRes = await fetch(`${fx.baseUrl}/api/auth/login`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Requested-With": "XMLHttpRequest",
            Origin: `http://${validHost}`,
          },
          body: JSON.stringify({ token: "wrong_password_candidate" }),
        });
        assert.equal(failRes.status, 401);
      }

      // 4th attempt is rate-limited (429)
      const resRateLimited = await fetch(`${fx.baseUrl}/api/auth/login`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Requested-With": "XMLHttpRequest",
          Origin: `http://${validHost}`,
        },
        body: JSON.stringify({ token: fx.apiToken }),
      });
      assert.equal(resRateLimited.status, 429);
      assert.ok(resRateLimited.headers.get("retry-after"));

      // Rate limited Bearer request (line 634-646)
      const resBearerLimited = await fetch(`${fx.baseUrl}/api/telemetry`, {
        headers: { Authorization: `Bearer ${fx.apiToken}` },
      });
      assert.equal(resBearerLimited.status, 429);

      // Rate limited MCP request (line 1090-1102)
      const resMcpLimited = await fetch(`${fx.baseUrl}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${fx.apiToken}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
      });
      assert.equal(resMcpLimited.status, 429);
    } finally {
      await fx.cleanup();
    }
  });

  it("handles valid login issuing HttpOnly SameSite cookie and Secure flag under trusted HTTPS proxy", async () => {
    const fx = await createTestHttpServer();
    try {
      const url = new URL(fx.baseUrl);
      const validHost = url.host;

      // Login with valid token under plain HTTP
      const resLogin = await fetch(`${fx.baseUrl}/api/auth/login`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Requested-With": "XMLHttpRequest",
          Origin: `http://${validHost}`,
        },
        body: JSON.stringify({ token: fx.apiToken }),
      });
      assert.equal(resLogin.status, 200);
      const setCookie = resLogin.headers.get("set-cookie") ?? "";
      assert.match(setCookie, /fengsui_sid=[0-9a-f]{64}/);
      assert.match(setCookie, /HttpOnly/);
      assert.match(setCookie, /SameSite=Strict/);
      assert.doesNotMatch(setCookie, /Secure/);

      // Extract cookie
      const sidMatch = setCookie.match(/fengsui_sid=([0-9a-f]{64})/);
      assert.ok(sidMatch?.[1]);
      const sessionCookie = `fengsui_sid=${sidMatch[1]}`;

      // Status check with cookie
      const resStAuth = await fetch(`${fx.baseUrl}/api/auth/status`, {
        headers: { Cookie: sessionCookie },
      });
      assert.equal(resStAuth.status, 200);
      assert.equal(((await resStAuth.json()) as { authenticated: boolean }).authenticated, true);

      // Cookie state mutation without CSRF header is rejected (403)
      const resNoCsrf = await fetch(`${fx.baseUrl}/api/control/unlock`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: sessionCookie,
          Origin: `http://${validHost}`,
        },
        body: JSON.stringify({}),
      });
      assert.equal(resNoCsrf.status, 403);

      // Session rotation: login again with existing session cookie replaces session
      const resLoginRotate = await fetch(`${fx.baseUrl}/api/auth/login`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Requested-With": "XMLHttpRequest",
          Origin: `http://${validHost}`,
          Cookie: sessionCookie,
        },
        body: JSON.stringify({ password: fx.apiToken }),
      });
      assert.equal(resLoginRotate.status, 200);

      const rotatedSetCookie = resLoginRotate.headers.get("set-cookie") ?? "";
      const rotatedSidMatch = rotatedSetCookie.match(/fengsui_sid=([0-9a-f]{64})/);
      assert.ok(rotatedSidMatch?.[1]);
      const newSessionCookie = `fengsui_sid=${rotatedSidMatch[1]}`;

      // Cookie logout without CSRF header -> 403 (line 604-609)
      const resLogoutNoCsrf = await fetch(`${fx.baseUrl}/api/auth/logout`, {
        method: "POST",
        headers: {
          Cookie: newSessionCookie,
        },
      });
      assert.equal(resLogoutNoCsrf.status, 403);

      // Logout with Cookie and valid CSRF
      const resLogout = await fetch(`${fx.baseUrl}/api/auth/logout`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Requested-With": "XMLHttpRequest",
          Origin: `http://${validHost}`,
          Cookie: newSessionCookie,
        },
        body: JSON.stringify({}),
      });
      assert.equal(resLogout.status, 200);
      assert.match(resLogout.headers.get("set-cookie") ?? "", /fengsui_sid=logged_out/);

      // Logout with Bearer auth
      const resLogoutBearer = await fetch(`${fx.baseUrl}/api/auth/logout`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${fx.apiToken}`,
        },
      });
      assert.equal(resLogoutBearer.status, 200);

      // HTTPS reverse proxy simulation: X-Forwarded-Proto: https from trusted proxy 127.0.0.1
      const resHttpsLogin = await fetch(`${fx.baseUrl}/api/auth/login`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Requested-With": "XMLHttpRequest",
          Origin: `https://${validHost}`,
          "X-Forwarded-Proto": "https",
        },
        body: JSON.stringify({ token: fx.apiToken }),
      });
      assert.equal(resHttpsLogin.status, 200);
      const secureCookie = resHttpsLogin.headers.get("set-cookie") ?? "";
      assert.match(secureCookie, /Secure/);
    } finally {
      await fx.cleanup();
    }
  });

  it("evicts expired web sessions and oldest sessions on capacity limit", async () => {
    // 1. Session expiration
    const fxTtl = await createTestHttpServer({ sessionTtlMs: 50 });
    try {
      const url = new URL(fxTtl.baseUrl);
      const validHost = url.host;

      const resLogin = await fetch(`${fxTtl.baseUrl}/api/auth/login`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Requested-With": "XMLHttpRequest",
          Origin: `http://${validHost}`,
        },
        body: JSON.stringify({ token: fxTtl.apiToken }),
      });
      const cookieHeader = resLogin.headers.get("set-cookie") ?? "";
      const sid = cookieHeader.match(/fengsui_sid=([0-9a-f]{64})/)?.[1] ?? "";
      assert.ok(sid);

      // Advance Date.now past session TTL (60000ms minimum)
      const origNow = Date.now;
      try {
        Date.now = () => origNow() + 70000;
        const resCheck = await fetch(`${fxTtl.baseUrl}/api/auth/status`, {
          headers: { Cookie: `fengsui_sid=${sid}` },
        });
        assert.equal(resCheck.status, 200);
        assert.equal(((await resCheck.json()) as { authenticated: boolean }).authenticated, false);
      } finally {
        Date.now = origNow;
      }
    } finally {
      await fxTtl.cleanup();
    }

    // 2. Capacity eviction (>128 sessions)
    const fxCap = await createTestHttpServer();
    try {
      const url = new URL(fxCap.baseUrl);
      const validHost = url.host;

      for (let i = 0; i < 130; i++) {
        await fetch(`${fxCap.baseUrl}/api/auth/login`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Requested-With": "XMLHttpRequest",
            Origin: `http://${validHost}`,
          },
          body: JSON.stringify({ token: fxCap.apiToken }),
        });
      }
    } finally {
      await fxCap.cleanup();
    }
  });

  it("serves all protected GET endpoints with Bearer authentication", async () => {
    const fx = await createTestHttpServer();
    try {
      const authHeader = { Authorization: `Bearer ${fx.apiToken}` };

      // 1. GET /api/telemetry
      const resTel = await fetch(`${fx.baseUrl}/api/telemetry`, { headers: authHeader });
      assert.equal(resTel.status, 200);
      const dataTel = (await resTel.json()) as { ok: boolean; schedulerStatus: unknown };
      assert.equal(dataTel.ok, true);

      // 2. GET /api/timeseries (preset 1h & custom range, integer query parameter parsing)
      const resTs1h = await fetch(`${fx.baseUrl}/api/timeseries?preset=1h`, { headers: authHeader });
      assert.equal(resTs1h.status, 200);

      const now = Date.now();
      const resTsCustom = await fetch(
        `${fx.baseUrl}/api/timeseries?preset=custom&fromMs=${now - 300000}&toMs=${now}&bucketMs=5000&maxPoints=60`,
        { headers: authHeader }
      );
      assert.equal(resTsCustom.status, 200);

      // Invalid integer query param -> 400
      const resTsBadInt = await fetch(`${fx.baseUrl}/api/timeseries?fromMs=not_an_int`, {
        headers: authHeader,
      });
      assert.equal(resTsBadInt.status, 400);

      const resTsOutOfRange = await fetch(
        `${fx.baseUrl}/api/timeseries?fromMs=999999999999999999999999999999999999999999`,
        { headers: authHeader }
      );
      assert.equal(resTsOutOfRange.status, 400);

      // 3. GET /api/neighbors
      const resNbr = await fetch(`${fx.baseUrl}/api/neighbors`, { headers: authHeader });
      assert.equal(resNbr.status, 200);

      // 4. GET /api/topology
      const resTopo = await fetch(`${fx.baseUrl}/api/topology`, { headers: authHeader });
      assert.equal(resTopo.status, 200);

      // 5. GET /api/settings
      const resSet = await fetch(`${fx.baseUrl}/api/settings`, { headers: authHeader });
      assert.equal(resSet.status, 200);

      // 6. GET /api/session/status
      const resSess = await fetch(`${fx.baseUrl}/api/session/status`, { headers: authHeader });
      assert.equal(resSess.status, 200);
      const sess = (await resSess.json()) as { selfHeal?: { lockRollback: { afterMin: number | null }; reconnect: { afterMin: number | null } } };
      assert.deepEqual([sess.selfHeal?.lockRollback.afterMin, sess.selfHeal?.reconnect.afterMin], [null, null], "self-healing off: said so");

      // 7. Unknown GET endpoint -> 404
      const resUnk = await fetch(`${fx.baseUrl}/api/unknown_route`, { headers: authHeader });
      assert.equal(resUnk.status, 404);

      // 8. Without Bearer auth -> 401
      const resNoAuth = await fetch(`${fx.baseUrl}/api/telemetry`);
      assert.equal(resNoAuth.status, 401);

      // 9. Wrong Bearer token -> 401
      const resWrongToken = await fetch(`${fx.baseUrl}/api/telemetry`, {
        headers: { Authorization: "Bearer wrong_token_abc" },
      });
      assert.equal(resWrongToken.status, 401);
    } finally {
      await fx.cleanup();
    }
  });

  it("serves all protected POST control and refresh endpoints with Bearer authentication", async () => {
    const postedBodies: Array<{ path: string; body: string }> = [];
    const fx = await createTestHttpServer({
      onPost: (p, b) => {
        postedBodies.push({ path: p, body: b });
      },
    });
    try {
      const authHeaders = {
        Authorization: `Bearer ${fx.apiToken}`,
        "Content-Type": "application/json",
      };

      // 1. Refreshes: telemetry, neighbors, topology, settings
      const r1 = await fetch(`${fx.baseUrl}/api/telemetry/refresh`, { method: "POST", headers: authHeaders, body: "{}" });
      assert.equal(r1.status, 200);

      // Empty body "" with Content-Type: application/json (lines 386-387)
      const r1Empty = await fetch(`${fx.baseUrl}/api/telemetry/refresh`, { method: "POST", headers: authHeaders, body: "" });
      assert.equal(r1Empty.status, 200);

      const r2 = await fetch(`${fx.baseUrl}/api/neighbors/scan`, { method: "POST", headers: authHeaders, body: "{}" });
      assert.equal(r2.status, 200);

      const r3 = await fetch(`${fx.baseUrl}/api/topology/refresh`, { method: "POST", headers: authHeaders, body: "{}" });
      assert.equal(r3.status, 200);

      const r4 = await fetch(`${fx.baseUrl}/api/settings/refresh`, { method: "POST", headers: authHeaders, body: "{}" });
      assert.equal(r4.status, 200);

      // 2. Control: band-lock (valid and validation errors)
      const rBlOk = await fetch(`${fx.baseUrl}/api/control/band-lock`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ lteBands: ["B1", "B3"], nrBands: "all" }),
      });
      assert.equal(rBlOk.status, 200);

      const rBlBad1 = await fetch(`${fx.baseUrl}/api/control/band-lock`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ lteBands: "invalid" }),
      });
      assert.equal(rBlBad1.status, 400);

      const rBlBad2 = await fetch(`${fx.baseUrl}/api/control/band-lock`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ lteBands: [false] }),
      });
      assert.equal(rBlBad2.status, 400);

      const rBlBad3 = await fetch(`${fx.baseUrl}/api/control/band-lock`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ nrBands: 12345 }),
      });
      assert.equal(rBlBad3.status, 400);

      const rBlBad4 = await fetch(`${fx.baseUrl}/api/control/band-lock`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ nrBands: [null] }),
      });
      assert.equal(rBlBad4.status, 400);

      // 3. Control: cell-lock (valid and validation errors)
      const rClOk = await fetch(`${fx.baseUrl}/api/control/cell-lock`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ rat: "LTE", band: "B1", arfcn: 300, pci: 321 }),
      });
      assert.equal(rClOk.status, 200);

      // Explicit pci: null is treated as "no PCI" -> frequency lock (lock_mode=1)
      const rClFreqOnly = await fetch(`${fx.baseUrl}/api/control/cell-lock`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ rat: "LTE", band: "B1", arfcn: 300, pci: null }),
      });
      assert.equal(rClFreqOnly.status, 200);
      const rClFreqOnlyBody = (await rClFreqOnly.json()) as {
        lockState: { cellLock: { pci: number | null } | null };
      };
      assert.equal(rClFreqOnlyBody.lockState.cellLock?.pci, null);

      const rClBadRat = await fetch(`${fx.baseUrl}/api/control/cell-lock`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ rat: "GSM", band: "B1", arfcn: 300 }),
      });
      assert.equal(rClBadRat.status, 400);

      const rClBadBand = await fetch(`${fx.baseUrl}/api/control/cell-lock`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ rat: "LTE", arfcn: 300 }),
      });
      assert.equal(rClBadBand.status, 400);

      const rClBadArfcn = await fetch(`${fx.baseUrl}/api/control/cell-lock`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ rat: "LTE", band: "B1", arfcn: "invalid_num" }),
      });
      assert.equal(rClBadArfcn.status, 400);

      // 4. Control: unlock
      const rUnlock = await fetch(`${fx.baseUrl}/api/control/unlock`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({}),
      });
      assert.equal(rUnlock.status, 200);

      // 5. Control: reboot (confirm: false vs true)
      const rRebNo = await fetch(`${fx.baseUrl}/api/control/reboot`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ confirm: false }),
      });
      assert.equal(rRebNo.status, 400);

      const rRebYes = await fetch(`${fx.baseUrl}/api/control/reboot`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ confirm: true }),
      });
      assert.equal(rRebYes.status, 200);

      // 6. Control: reconnect (confirm: false vs true)
      const rRecNo = await fetch(`${fx.baseUrl}/api/control/reconnect`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ confirm: false }),
      });
      assert.equal(rRecNo.status, 400);

      const rRecYes = await fetch(`${fx.baseUrl}/api/control/reconnect`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ confirm: true }),
      });
      assert.equal(rRecYes.status, 200);

      // 7. Control: security
      const rSec = await fetch(`${fx.baseUrl}/api/control/security`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          upnpEnabled: true,
          dmz: { enabled: true, ipAddress: "192.168.8.50" },
          firewall: { mainSwitch: true, ipFilterSwitch: true },
        }),
      });
      assert.equal(rSec.status, 200);

      // 8. Control: wifi7
      const rWifi = await fetch(`${fx.baseUrl}/api/control/wifi7`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ mloEnable: true, dbhoEnable: false }),
      });
      assert.equal(rWifi.status, 200);

      // 9. Control: antenna
      const rAnt = await fetch(`${fx.baseUrl}/api/control/antenna`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ mode: "auto" }),
      });
      assert.equal(rAnt.status, 200);

      // 10. Control: mobile-data (boolean vs non-boolean)
      const rMobOk = await fetch(`${fx.baseUrl}/api/control/mobile-data`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ enabled: true }),
      });
      assert.equal(rMobOk.status, 200);

      const rMobBad = await fetch(`${fx.baseUrl}/api/control/mobile-data`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ enabled: "not_a_bool" }),
      });
      assert.equal(rMobBad.status, 400);

      // 11. Reset breaker via /api/session/reset-breaker
      const rBreaker = await fetch(`${fx.baseUrl}/api/session/reset-breaker`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({}),
      });
      assert.equal(rBreaker.status, 200);
      const breakerData = (await rBreaker.json()) as { ok: boolean; circuitBreaker: unknown };
      assert.equal(breakerData.ok, true);

      // 12. Non-JSON Content-Type on POST control -> 415
      const rNonJson = await fetch(`${fx.baseUrl}/api/control/unlock`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${fx.apiToken}`,
          "Content-Type": "text/plain",
        },
        body: "not_json",
      });
      assert.equal(rNonJson.status, 415);

      // 13. Oversized body > 64KiB socket teardown test
      const largeBody = JSON.stringify({ big: "x".repeat(65 * 1024) });
      await assert.rejects(
        async () => {
          await rawHttpRequest({
            host: "127.0.0.1",
            port: fx.port,
            method: "POST",
            path: "/api/control/unlock",
            headers: {
              Authorization: `Bearer ${fx.apiToken}`,
              "Content-Type": "application/json",
            },
            body: largeBody,
          });
        },
        (err: unknown) => err instanceof Error
      );

      // 14. Unknown POST endpoint -> 404
      const rUnk = await fetch(`${fx.baseUrl}/api/unknown_post`, {
        method: "POST",
        headers: authHeaders,
        body: "{}",
      });
      assert.equal(rUnk.status, 404);

      // 15. Method not allowed (PUT /api/telemetry) -> 405
      const rPut = await fetch(`${fx.baseUrl}/api/telemetry`, {
        method: "PUT",
        headers: authHeaders,
        body: "{}",
      });
      assert.equal(rPut.status, 405);
    } finally {
      await fx.cleanup();
    }
  });

  it("maps BrowserSessionYieldedError to 409, SchedulerQueueFullError to 503, and generic Error to 502", async () => {
    // 1. BrowserSessionYieldedError -> 409
    const fxYield = await createTestHttpServer({
      loginStateXml: "<response><State>0</State><lockstatus>0</lockstatus><remainwaittime>0</remainwaittime></response>",
    });
    try {
      const res409 = await fetch(`${fxYield.baseUrl}/api/control/unlock`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${fxYield.apiToken}`,
          "Content-Type": "application/json",
        },
        body: "{}",
      });
      assert.equal(res409.status, 409);
      const data409 = (await res409.json()) as { errorCode: string };
      assert.equal(data409.errorCode, "BROWSER_SESSION_YIELDED");
    } finally {
      await fxYield.cleanup();
    }

    // 2. Queue full -> 503 and Upstream error -> 502
    const fxErr = await createTestHttpServer();
    try {
      fxErr.core.controls.unlockAllLocks = async () => {
        throw new SchedulerQueueFullError(32);
      };
      const res503 = await fetch(`${fxErr.baseUrl}/api/control/unlock`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${fxErr.apiToken}`,
          "Content-Type": "application/json",
        },
        body: "{}",
      });
      assert.equal(res503.status, 503);
      assert.equal(((await res503.json()) as { errorCode: string }).errorCode, "QUEUE_FULL");

      fxErr.core.controls.unlockAllLocks = async () => {
        throw new Error("Baseband socket dropped");
      };
      const res502 = await fetch(`${fxErr.baseUrl}/api/control/unlock`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${fxErr.apiToken}`,
          "Content-Type": "application/json",
        },
        body: "{}",
      });
      assert.equal(res502.status, 502);
      assert.equal(((await res502.json()) as { errorCode: string }).errorCode, "CPE_UPSTREAM_ERROR");
    } finally {
      await fxErr.cleanup();
    }
  });

  it("subscribes to live GET /api/events SSE stream, receives hello and broadcasts, and rejects when limit reached", async () => {
    const fx = await createTestHttpServer({ sseMaxClients: 1 });
    try {
      const res1 = await fetch(`${fx.baseUrl}/api/events`, {
        headers: { Authorization: `Bearer ${fx.apiToken}` },
      });
      assert.equal(res1.status, 200);
      assert.equal(res1.headers.get("content-type"), "text/event-stream; charset=utf-8");

      const reader = res1.body?.getReader();
      assert.ok(reader);

      // Read hello frame
      const chunk1 = await reader.read();
      const text1 = Buffer.from(chunk1.value ?? new Uint8Array()).toString("utf8");
      assert.match(text1, /event: hello/);

      // Broadcast an event from the server
      fx.sseBus.broadcast("telemetry", { rfPci: 321 });

      // Read broadcast frame
      const chunk2 = await reader.read();
      const text2 = Buffer.from(chunk2.value ?? new Uint8Array()).toString("utf8");
      assert.match(text2, /event: telemetry/);
      assert.match(text2, /"rfPci":321/);

      // Second client exceeds sseMaxClients: 1 -> 429 SSE_LIMIT_REACHED
      const res2 = await fetch(`${fx.baseUrl}/api/events`, {
        headers: { Authorization: `Bearer ${fx.apiToken}` },
      });
      assert.equal(res2.status, 429);
      const data2 = (await res2.json()) as { errorCode: string };
      assert.equal(data2.errorCode, "SSE_LIMIT_REACHED");

      await reader.cancel();
    } finally {
      await fx.cleanup();
    }
  });

  it("handles Streamable HTTP POST /mcp endpoint with auth, notifications, tools and origin protection", async () => {
    const fx = await createTestHttpServer({ mcpHttpEnabled: true });
    try {
      const url = new URL(fx.baseUrl);
      const validHost = url.host;

      // 1. GET /mcp is rejected with 405
      const resGet = await fetch(`${fx.baseUrl}/mcp`);
      assert.equal(resGet.status, 405);

      // 2. Cross-origin /mcp Origin guard: null Origin -> 403
      const resNullOrigin = await fetch(`${fx.baseUrl}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "null",
          Authorization: `Bearer ${fx.apiToken}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
      });
      assert.equal(resNullOrigin.status, 403);

      // Cross-origin /mcp Origin guard: evil Origin -> 403
      const resEvilOrigin = await fetch(`${fx.baseUrl}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://evil.com",
          Authorization: `Bearer ${fx.apiToken}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
      });
      assert.equal(resEvilOrigin.status, 403);

      // Malformed Origin on /mcp -> 403
      const resBadOrigin = await fetch(`${fx.baseUrl}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "not_a_valid_url",
          Authorization: `Bearer ${fx.apiToken}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
      });
      assert.equal(resBadOrigin.status, 403);

      // Origin protocol mismatch (https Origin on http server) -> 403
      const resHttpsOrigin = await fetch(`${fx.baseUrl}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: `https://${validHost}`,
          Authorization: `Bearer ${fx.apiToken}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
      });
      assert.equal(resHttpsOrigin.status, 403);

      // 3. Unauthorized /mcp without Bearer token -> 401
      const resNoAuth = await fetch(`${fx.baseUrl}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
      });
      assert.equal(resNoAuth.status, 401);
      assert.doesNotMatch(await resNoAuth.text(), /API_TOKEN/, "tokens come from the console, not .env");

      // 4. Content-Type not application/json -> 415
      const resCt = await fetch(`${fx.baseUrl}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
          Authorization: `Bearer ${fx.apiToken}`,
        },
        body: "ping",
      });
      assert.equal(resCt.status, 415);

      // 5. Unsupported MCP-Protocol-Version -> 400 with JSON-RPC error
      const resBadVer = await fetch(`${fx.baseUrl}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${fx.apiToken}`,
          "MCP-Protocol-Version": "1999-01-01",
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
      });
      assert.equal(resBadVer.status, 400);

      // 6. Valid notification -> 202 Accepted with empty body
      const resNotif = await fetch(`${fx.baseUrl}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${fx.apiToken}`,
          Origin: `http://${validHost}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      });
      assert.equal(resNotif.status, 202);
      const textNotif = await resNotif.text();
      assert.equal(textNotif, "");

      // 7. Valid initialize -> 200 OK
      const resInit = await fetch(`${fx.baseUrl}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${fx.apiToken}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "initialize",
          id: 10,
          params: { protocolVersion: "2025-06-18" },
        }),
      });
      assert.equal(resInit.status, 200);
      const initData = (await resInit.json()) as { id: number; result: { protocolVersion: string } };
      assert.equal(initData.id, 10);
      assert.equal(initData.result.protocolVersion, "2025-06-18");

      // 8. Valid tools/call -> 200 OK
      const resCall = await fetch(`${fx.baseUrl}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${fx.apiToken}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "tools/call",
          id: 11,
          params: { name: "get_cpe_telemetry", arguments: { refresh: false } },
        }),
      });
      assert.equal(resCall.status, 200);
      const callData = (await resCall.json()) as { id: number; result: { isError: boolean } };
      assert.equal(callData.id, 11);
      assert.equal(callData.result.isError, false);
    } finally {
      await fx.cleanup();
    }

    // Disabled MCP HTTP endpoint -> 404
    const fxDisabled = await createTestHttpServer({ mcpHttpEnabled: false });
    try {
      const resDisabled = await fetch(`${fxDisabled.baseUrl}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${fxDisabled.apiToken}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
      });
      assert.equal(resDisabled.status, 404);
    } finally {
      await fxDisabled.cleanup();
    }
  });

  it("serves static assets with strict Content-Security-Policy, handles MIME types and directory index", async () => {
    const fx = await createTestHttpServer();
    try {
      // 1. GET / -> index.html with strict CSP
      const resRoot = await fetch(`${fx.baseUrl}/`);
      assert.equal(resRoot.status, 200);
      assert.equal(resRoot.headers.get("content-type"), "text/html; charset=utf-8");
      assert.match(resRoot.headers.get("content-security-policy") ?? "", /default-src 'self'/);
      const bodyHtml = await resRoot.text();
      assert.match(bodyHtml, /FengSui WebUI/);

      // 2. HEAD / -> empty body
      const resHead = await fetch(`${fx.baseUrl}/`, { method: "HEAD" });
      assert.equal(resHead.status, 200);
      assert.equal(await resHead.text(), "");

      // 3. Static assets with various MIME types
      const resCss = await fetch(`${fx.baseUrl}/style.css`);
      assert.equal(resCss.status, 200);
      assert.equal(resCss.headers.get("content-type"), "text/css; charset=utf-8");

      const resSvg = await fetch(`${fx.baseUrl}/icon.svg`);
      assert.equal(resSvg.status, 200);
      assert.equal(resSvg.headers.get("content-type"), "image/svg+xml");

      const resJson = await fetch(`${fx.baseUrl}/data.json`);
      assert.equal(resJson.status, 200);
      assert.equal(resJson.headers.get("content-type"), "application/json; charset=utf-8");

      // The license notices the build puts next to the console read as text, not a download
      const resTxt = await fetch(`${fx.baseUrl}/THIRD_PARTY_NOTICES.txt`);
      assert.equal(resTxt.status, 200);
      assert.equal(resTxt.headers.get("content-type"), "text/plain; charset=utf-8");

      const resBin = await fetch(`${fx.baseUrl}/blob.bin`);
      assert.equal(resBin.status, 200);
      assert.equal(resBin.headers.get("content-type"), "application/octet-stream");

      // 4. Directory serving: creates subfolder with index.html
      const subDir = path.join(fx.staticDir, "sub");
      fs.mkdirSync(subDir, { recursive: true });
      fs.writeFileSync(path.join(subDir, "index.html"), "subdir content", "utf8");
      const resSub = await fetch(`${fx.baseUrl}/sub`);
      assert.equal(resSub.status, 200);
      assert.equal(await resSub.text(), "subdir content");

      // 5. POST on static asset is rejected with 405
      const resPostStatic = await fetch(`${fx.baseUrl}/index.html`, { method: "POST" });
      assert.equal(resPostStatic.status, 405);

      // 6. Non-existent asset -> 404
      const resMissing = await fetch(`${fx.baseUrl}/nonexistent.js`);
      assert.equal(resMissing.status, 404);
    } finally {
      await fx.cleanup();
    }
  });

  it("blocks symlink escape from static directory with 403 SYMLINK_ESCAPE_BLOCKED", async () => {
    const fx = await createTestHttpServer();
    try {
      const outsideFile = path.join(fx.tmpDir, "outside_secret.txt");
      fs.writeFileSync(outsideFile, "outside secret content", "utf8");
      const symlinkPath = path.join(fx.staticDir, "escaped_symlink.txt");
      fs.symlinkSync(outsideFile, symlinkPath);

      const resSymlink = await fetch(`${fx.baseUrl}/escaped_symlink.txt`);
      assert.equal(resSymlink.status, 403);
      const symlinkData = (await resSymlink.json()) as { errorCode: string };
      assert.equal(symlinkData.errorCode, "SYMLINK_ESCAPE_BLOCKED");
    } finally {
      await fx.cleanup();
    }
  });

  it("handles missing static root directory with 404 STATIC_ROOT_NOT_FOUND", async () => {
    const fxNoStatic = await createTestHttpServer({ nonExistentStaticDir: true });
    try {
      const resNoRoot = await fetch(`${fxNoStatic.baseUrl}/`);
      assert.equal(resNoRoot.status, 404);
      const dataNoRoot = (await resNoRoot.json()) as { errorCode: string };
      assert.equal(dataNoRoot.errorCode, "STATIC_ROOT_NOT_FOUND");
    } finally {
      await fxNoStatic.cleanup();
    }
  });

  it("ends an event stream when the token that opened it expires, as a console session's stream ends with the session", async () => {
    const fx = await createTestHttpServer();
    try {
      const validHost = new URL(fx.baseUrl).host;
      const consoleHeaders = (cookie: string) => ({ "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest", Origin: `http://${validHost}`, Cookie: cookie });
      const login = await fetch(`${fx.baseUrl}/api/auth/login`, { method: "POST", headers: consoleHeaders(""), body: JSON.stringify({ password: fx.apiToken }) });
      assert.equal(login.status, 200);
      const cookie = `fengsui_sid=${/fengsui_sid=([0-9a-f]{64})/.exec(login.headers.get("set-cookie") ?? "")?.[1] ?? ""}`;
      const mint = await fetch(`${fx.baseUrl}/api/console/tokens`, { method: "POST", headers: consoleHeaders(cookie), body: JSON.stringify({ name: "wall", scope: "read", lifetimeDays: 7 }) });
      const minted = (await mint.json()) as { token: string; record: { expiresAtIso: string } };
      // What the bus is told: it closes a stream once its expiry passes (bus-level test above)
      const seen: Array<number | null | undefined> = [];
      const subscribe = fx.sseBus.subscribe.bind(fx.sseBus);
      fx.sseBus.subscribe = (params) => {
        seen.push(params.expiresAtMs);
        return subscribe(params);
      };
      const stream = await fetch(`${fx.baseUrl}/api/events`, { headers: { Authorization: `Bearer ${minted.token}` } });
      assert.equal(stream.status, 200);
      await stream.body?.cancel().catch(() => undefined);
      assert.deepEqual(seen, [Date.parse(minted.record.expiresAtIso)]);
    } finally {
      await fx.cleanup();
    }
  });

  it("enforces Opus security audit regressions: status Bearer rate-limit, cookie IP-bucket binding, strict security validation, breaker 108006 guard, token-rotation revocation, and dotfile/@eaDir blocking", async () => {
    const fx = await createTestHttpServer({ rateLimitMaxAuthFailures: 3 });
    try {
      const url = new URL(fx.baseUrl);
      const validHost = url.host;
      const authHeaders = {
        Authorization: `Bearer ${fx.apiToken}`,
        "Content-Type": "application/json",
      };

      // 1. Public scheduler status omits passwordFingerprintHex
      const st = fx.scheduler.getStatus();
      assert.equal(st.circuitBreaker.passwordFingerprintHex, undefined);

      // 2. Hidden dotfiles and Synology @eaDir inside staticDir return 404 ASSET_NOT_FOUND
      fs.writeFileSync(path.join(fx.staticDir, ".env"), "SECRET=1", "utf8");
      fs.mkdirSync(path.join(fx.staticDir, "@eaDir"), { recursive: true });
      fs.writeFileSync(path.join(fx.staticDir, "@eaDir", "thumb.jpg"), "meta", "utf8");
      assert.equal((await fetch(`${fx.baseUrl}/.env`)).status, 404);
      assert.equal((await fetch(`${fx.baseUrl}/@eaDir/thumb.jpg`)).status, 404);

      // 3. Unauthenticated POST /api/auth/logout without CSRF headers is rejected with 403
      const logoutNoCsrf = await fetch(`${fx.baseUrl}/api/auth/logout`, { method: "POST" });
      assert.equal(logoutNoCsrf.status, 403);

      // Invalid Bearer on POST /api/auth/logout returns 401 (from XFF IP 192.168.8.91)
      const logoutBadBearer = await fetch(`${fx.baseUrl}/api/auth/logout`, {
        method: "POST",
        headers: {
          Authorization: "Bearer bad_token_guess",
          "X-Forwarded-For": "192.168.8.91",
        },
      });
      assert.equal(logoutBadBearer.status, 401);

      // 4. GET /api/auth/status with invalid Bearer counts failures and rate-limits (429) on 4th attempt
      for (let i = 0; i < 3; i++) {
        const sRes = await fetch(`${fx.baseUrl}/api/auth/status`, {
          headers: {
            Authorization: "Bearer brute_guess",
            "X-Forwarded-For": "192.168.8.92",
          },
        });
        assert.equal(sRes.status, 200);
        assert.equal(((await sRes.json()) as { authenticated: boolean }).authenticated, false);
      }
      const sLimited = await fetch(`${fx.baseUrl}/api/auth/status`, {
        headers: {
          Authorization: `Bearer ${fx.apiToken}`,
          "X-Forwarded-For": "192.168.8.92",
        },
      });
      assert.equal(sLimited.status, 429);

      // 5. Cookie session is bound to client IP bucket (rejected if replayed from different XFF IP)
      const loginRes = await fetch(`${fx.baseUrl}/api/auth/login`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Requested-With": "XMLHttpRequest",
          Origin: `http://${validHost}`,
          "X-Forwarded-For": "192.168.8.50",
        },
        body: JSON.stringify({ token: fx.apiToken }),
      });
      assert.equal(loginRes.status, 200);
      const sid = (loginRes.headers.get("set-cookie") ?? "").match(/fengsui_sid=([0-9a-f]{64})/)?.[1];
      assert.ok(sid);
      const replayDiffIp = await fetch(`${fx.baseUrl}/api/telemetry`, {
        headers: {
          Cookie: `fengsui_sid=${sid}`,
          "X-Forwarded-For": "192.168.8.51",
        },
      });
      assert.equal(replayDiffIp.status, 401);

      // 6. Strict /api/control/security validation: string "false" must return 400 (never enable DMZ!)
      for (const badBody of [
        { dmz: { enabled: "false" } },
        { dmz: "not_an_object" },
        { dmz: { enabled: true, ipAddress: "not_an_ip" } },
        { upnpEnabled: "yes" },
        { firewall: "not_an_object" },
        { firewall: { unknownSwitch: true } },
        { firewall: { mainSwitch: "true" } },
      ]) {
        const secBad = await fetch(`${fx.baseUrl}/api/control/security`, {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify(badBody),
        });
        assert.equal(secBad.status, 400);
      }

      // Non-numeric pci on cell-lock and non-boolean flags on wifi7 must return 400 VALIDATION_ERROR
      // before any CPE session (never silently downgrade to a frequency lock or a partial Wi-Fi 7 write)
      const sessionsBeforeTyped = fx.scheduler.getStatus().totalSessionsCompleted;
      const badCellPci = await fetch(`${fx.baseUrl}/api/control/cell-lock`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ rat: "NR", band: "N78", arfcn: 650000, pci: "not_a_number" }),
      });
      assert.equal(badCellPci.status, 400);
      const badCellPciBody = (await badCellPci.json()) as { errorCode: string; message: string };
      assert.equal(badCellPciBody.errorCode, "VALIDATION_ERROR");
      assert.match(badCellPciBody.message, /pci/);

      for (const badWifi of [
        { mloEnable: true, dbhoEnable: "false" },
        { mloEnable: "true", dbhoEnable: false },
        { dbhoEnable: 1 },
      ]) {
        const wRes = await fetch(`${fx.baseUrl}/api/control/wifi7`, {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify(badWifi),
        });
        assert.equal(wRes.status, 400);
        const wBody = (await wRes.json()) as { errorCode: string; message: string };
        assert.equal(wBody.errorCode, "VALIDATION_ERROR");
        assert.match(wBody.message, /mloEnable|dbhoEnable/);
        assert.doesNotMatch(wBody.message, /^Specify/);
      }
      assert.equal(fx.scheduler.getStatus().totalSessionsCompleted, sessionsBeforeTyped);

      // 7. Circuit breaker 108006 latch refuses reset-breaker when CPE_PASSWORD is unchanged in .env
      fx.cpeClient.hydrateCircuitBreaker({
        tripped: true,
        code: "108006",
        reason: "Wrong password",
        trippedAtIso: new Date().toISOString(),
        remainCount: 2,
        waitTime: null,
        passwordFingerprintHex: fx.cpeClient.getPasswordFingerprint(),
      });
      const resetUnchanged = await fetch(`${fx.baseUrl}/api/session/reset-breaker`, {
        method: "POST",
        headers: authHeaders,
        body: "{}",
      });
      assert.equal(resetUnchanged.status, 400);
      assert.equal(fx.scheduler.getStatus().circuitBreaker.tripped, true);
      // While latched, writes get their own error (no login attempt) and reads keep serving the cache
      const latchedWrite = await fetch(`${fx.baseUrl}/api/control/unlock`, { method: "POST", headers: authHeaders, body: "{}" });
      assert.equal(latchedWrite.status, 423);
      const latchedBody = (await latchedWrite.json()) as { errorCode: string; circuitBreaker: { tripped: boolean; code: string } };
      assert.equal(latchedBody.errorCode, "CIRCUIT_BREAKER_OPEN");
      assert.deepEqual([latchedBody.circuitBreaker.tripped, latchedBody.circuitBreaker.code], [true, "108006"]);
      const latchedRead = await fetch(`${fx.baseUrl}/api/telemetry/refresh`, { method: "POST", headers: authHeaders, body: "{}" });
      assert.equal(latchedRead.status, 200);

      // 8. The router password is fixed in the console, not in .env. A Bearer token may not touch it; a
      //    console session proves the new password with one test login, which also clears the latch.
      const viaToken = await fetch(`${fx.baseUrl}/api/console/cpe`, { method: "POST", headers: authHeaders, body: JSON.stringify({ url: "http://192.168.8.1", password: "x" }) });
      assert.equal(viaToken.status, 403);
      assert.equal(((await viaToken.json()) as { errorCode: string }).errorCode, "CONSOLE_ONLY");
      const consoleHeaders = (cookie: string) => ({ "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest", Origin: `http://${validHost}`, Cookie: cookie });
      const consoleLogin = await fetch(`${fx.baseUrl}/api/auth/login`, { method: "POST", headers: consoleHeaders(""), body: JSON.stringify({ password: fx.apiToken }) });
      assert.equal(consoleLogin.status, 200);
      const consoleCookie = `fengsui_sid=${/fengsui_sid=([0-9a-f]{64})/.exec(consoleLogin.headers.get("set-cookie") ?? "")?.[1] ?? ""}`;
      const fixed = await fetch(`${fx.baseUrl}/api/console/cpe`, {
        method: "POST",
        headers: consoleHeaders(consoleCookie),
        body: JSON.stringify({ url: "http://192.168.8.1", username: "admin", password: "sched_test_password" }),
      });
      assert.equal(fixed.status, 200);
      assert.equal(fx.scheduler.getStatus().circuitBreaker.tripped, false);

      // A revoked token loses its SSE stream at once; a password change signs the other sessions out
      const minted = (await (await fetch(`${fx.baseUrl}/api/console/tokens`, { method: "POST", headers: consoleHeaders(consoleCookie), body: JSON.stringify({ name: "dash", scope: "read", lifetimeDays: 7 }) })).json()) as { token: string; record: { id: string } };
      const sseRes = await fetch(`${fx.baseUrl}/api/events`, { headers: { Authorization: `Bearer ${minted.token}` } });
      assert.equal(sseRes.status, 200);
      assert.equal(fx.sseBus.getClientCount(), 1);
      const revoked = await fetch(`${fx.baseUrl}/api/console/tokens/revoke`, { method: "POST", headers: consoleHeaders(consoleCookie), body: JSON.stringify({ id: minted.record.id }) });
      assert.equal(revoked.status, 200);
      assert.equal(fx.sseBus.getClientCount(), 0);
      await sseRes.body?.cancel().catch(() => undefined);
      assert.equal((await fetch(`${fx.baseUrl}/api/telemetry`, { headers: { Authorization: `Bearer ${minted.token}` } })).status, 401);

      const changed = await fetch(`${fx.baseUrl}/api/console/password`, { method: "POST", headers: consoleHeaders(consoleCookie), body: JSON.stringify({ current: fx.apiToken, next: "a new console passphrase" }) });
      assert.equal(changed.status, 200);
      // The old cookie session from 192.168.8.50 is signed out; the one that changed the password stays
      const oldCookieAfterChange = await fetch(`${fx.baseUrl}/api/telemetry`, { headers: { Cookie: `fengsui_sid=${sid}`, "X-Forwarded-For": "192.168.8.50" } });
      assert.equal(oldCookieAfterChange.status, 401);
      assert.equal((await fetch(`${fx.baseUrl}/api/console`, { headers: { Cookie: consoleCookie } })).status, 200);
    } finally {
      await fx.cleanup();
    }
  });
});

describe("src/cli.ts command parsing, help formatter & runtime factory", () => {
  it("parseCliCommand parses serve, mcp, --env and help flags and warns about the retired --poll", () => {
    // Default serve
    const cmd1 = parseCliCommand(["node", "cli.ts", "serve"]);
    assert.equal(cmd1.mode, "serve");
    assert.deepEqual(cmd1.warnings, []);
    assert.equal(cmd1.envPath, undefined);

    // MCP with the retired --poll flag (accepted with a warning) and env=
    const cmd2 = parseCliCommand(["node", "cli.ts", "mcp", "--poll", "--env=/tmp/custom.env"]);
    assert.equal(cmd2.mode, "mcp");
    assert.equal(cmd2.warnings.length, 1);
    assert.match(cmd2.warnings[0] ?? "", /"--poll" is ignored/);
    assert.equal(cmd2.envPath, "/tmp/custom.env");

    // MCP with --env path separated
    const cmd3 = parseCliCommand(["node", "cli.ts", "mcp", "--env", "/tmp/other.env"]);
    assert.equal(cmd3.mode, "mcp");
    assert.equal(cmd3.envPath, "/tmp/other.env");

    // Help variations
    assert.equal(parseCliCommand(["node", "cli.ts", "--help"]).mode, "help");
    assert.equal(parseCliCommand(["node", "cli.ts", "-h"]).mode, "help");
    assert.equal(parseCliCommand(["node", "cli.ts", "help"]).mode, "help");

    // Unknown argument throws Error
    assert.throws(() => parseCliCommand(["node", "cli.ts", "--unknown-flag"]), /Unknown CLI argument/);
  });

  it("formatCliHelp returns clear usage text referencing FengSui", () => {
    const help = formatCliHelp();
    assert.match(help, /FengSui/);
    assert.match(help, /Usage:/);
    assert.match(help, /cpe-dash mcp/);
  });

  it("createFengSuiRuntime wires all 8 subsystems with custom fetchImpl", () => {
    const tmpDir = tempDir("fengsui-cli-test-");
    try {
      const config = loadConfig({
        overrides: {
          CPE_PASSWORD: "sched_test_password",
          API_TOKEN: "test_api_token_abc",
          STATE_FILE: path.join(tmpDir, "state.json"),
        },
        ignoreProcessEnv: true,
        envPath: path.join(tmpDir, "absent.env"),
      });

      const mockFetch = createMockCpeFetch();
      const stack = createFengSuiRuntime({
        config,
        fetchImpl: mockFetch,
      });

      assert.ok(stack.config);
      assert.ok(stack.stateStore);
      assert.ok(stack.timeseries);
      assert.ok(stack.cpeClient);
      assert.ok(stack.scheduler);
      assert.ok(stack.sseBus);
      assert.ok(stack.mcpServer);
      assert.ok(stack.httpServer);
    } finally {
      removeTempDir(tmpDir);
    }
  });

  it("createFengSuiRuntime honors RESPECT_BROWSER_SESSION=false end-to-end (config -> client -> scheduler)", async () => {
    const tmpDir = tempDir("fengsui-cli-rbs-");
    try {
      const config = loadConfig({
        overrides: {
          CPE_PASSWORD: "sched_test_password",
          API_TOKEN: "test_api_token_abc",
          STATE_FILE: path.join(tmpDir, "state.json"),
          RESPECT_BROWSER_SESSION: "false",
        },
        ignoreProcessEnv: true,
        envPath: path.join(tmpDir, "absent.env"),
      });
      assert.equal(config.respectBrowserSession, false);

      // state-login reports an active admin session (State=0): with avoidance disabled the poll must proceed
      const stack = createFengSuiRuntime({
        config,
        fetchImpl: createMockCpeFetch({
          loginStateXml:
            "<response><State>0</State><lockstatus>0</lockstatus><remainwaittime>0</remainwaittime></response>",
        }),
      });
      stack.core.monitor.init();
      const snap = await stack.core.monitor.refreshTelemetry();
      assert.ok(snap);
      assert.equal(stack.scheduler.getStatus().avoidance.active, false);
      assert.equal(stack.scheduler.getStatus().browserYieldCount, 0);
      await stack.scheduler.stop();
    } finally {
      removeTempDir(tmpDir);
    }
  });

  it("runs as an npm-linked bin: shebang on line 1 and entry detection through a symlink", () => {
    const cliPath = path.resolve(process.cwd(), "src", "cli.ts");
    assert.ok(fs.readFileSync(cliPath, "utf8").startsWith("#!/usr/bin/env node\n"));

    // npm links `bin.cpe-dash` as a symlink, so process.argv[1] is the link path, not the real module path
    const tmpDir = tempDir("fengsui-cli-bin-");
    try {
      const binLink = path.join(tmpDir, "cpe-dash");
      fs.symlinkSync(cliPath, binLink);
      const proc = spawnSync(process.execPath, ["--experimental-strip-types", binLink, "--help"], {
        encoding: "utf8",
        timeout: 5000,
      });
      assert.equal(proc.status, 0);
      assert.match(proc.stdout, /Usage:/);

      // Unit-level: symlink resolves to the module; absent, missing, or unrelated argv[1] never matches
      const cliUrl = pathToFileURL(cliPath).href;
      assert.equal(isCliEntryPoint(binLink, cliUrl), true);
      assert.equal(isCliEntryPoint(undefined, cliUrl), false);
      assert.equal(isCliEntryPoint(path.join(tmpDir, "missing-entry"), cliUrl), false);
      assert.equal(isCliEntryPoint(path.resolve(process.cwd(), "src", "config.ts"), cliUrl), false);
    } finally {
      removeTempDir(tmpDir);
    }
  });

  it("executes runCli --help and the stdio bridge subprocess, which forwards to the daemon instead of the CPE", async () => {
    await runCli(["node", "cli.ts", "--help"]);

    // A stand-in daemon: the subprocess must reach the CPE only through /mcp, never directly
    const seen: Array<{ auth: string | undefined; body: string }> = [];
    const fakeDaemon = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
      req.on("end", () => {
        seen.push({ auth: req.headers.authorization, body });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: 77, result: { forwarded: true } }));
      });
    });
    await new Promise<void>((resolve) => fakeDaemon.listen(0, "127.0.0.1", resolve));
    const address = fakeDaemon.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const tmpDir = tempDir("fengsui-cli-mcp-");
    try {
      const envPath = path.join(tmpDir, ".env");
      fs.writeFileSync(
        envPath,
        [
          "CPE_URL=http://127.0.0.1:65534",
          "CPE_PASSWORD=sched_test_password",
          "API_TOKEN=cli_bridge_token",
          `MCP_DAEMON_URL=http://127.0.0.1:${port}/mcp`,
          `STATE_FILE=${path.join(tmpDir, "state.json")}`,
        ].join("\n"),
        "utf8"
      );

      const cliPath = path.resolve(process.cwd(), "src", "cli.ts");
      const child = spawn(process.execPath, ["--experimental-strip-types", cliPath, "mcp", "--poll", `--env=${envPath}`], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
      child.stdin.end(`${JSON.stringify({ jsonrpc: "2.0", id: 77, method: "ping" })}\n`);
      const [code] = (await once(child, "exit")) as [number | null];
      assert.equal(code, 0, stderr);
      assert.match(stdout, /"id":77/);
      assert.match(stdout, /"forwarded":true/);
      assert.match(stderr, /\[fengsui-mcp\] stdio bridge ready -> http:\/\/127\.0\.0\.1:\d+\/mcp/);
      assert.match(stderr, /"--poll" is ignored/);
      assert.equal(seen.length, 1);
      assert.equal(seen[0]?.auth, "Bearer cli_bridge_token");
      assert.equal(fs.existsSync(path.join(tmpDir, "state.json")), false, "the bridge never creates state");
    } finally {
      await new Promise<void>((resolve) => fakeDaemon.close(() => resolve()));
      removeTempDir(tmpDir);
    }
  });
});
