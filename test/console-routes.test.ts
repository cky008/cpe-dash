import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import type { TelegramChatRecord } from "../src/api-contract.ts";
import { ConsoleSettings } from "../src/console-settings.ts";
import { createFengSuiCore, stopFengSuiCore } from "../src/core.ts";
import { HuaweiCpeClient } from "../src/cpe-client.ts";
import type { GlobalTelemetrySnapshot } from "../src/cpe-domain.ts";
import { StorageCipher } from "../src/encrypted-file.ts";
import { SettingsHttpRoutes } from "../src/http-settings.ts";
import { RuntimeSampler, renderMetrics } from "../src/metrics.ts";
import { EncryptedStateStore } from "../src/state-store.ts";
import { TimeSeriesRingBuffer } from "../src/timeseries.ts";
import { createStrictCpe } from "./helpers/strict-cpe.ts";
import { removeTempDir, tempDir } from "./helpers/temp-dir.ts";

function routesFixture(telegramConfigured: boolean) {
  const cpe = createStrictCpe();
  const dir = tempDir("fengsui-routes-");
  const unlinkedFor: string[] = [];
  const chat = (chatId: string, fromEnv: boolean, linkedWith: TelegramChatRecord["linkedWith"]): TelegramChatRecord => ({
    chatId,
    kind: chatId.startsWith("-") ? "group" : "private",
    fromEnv,
    linkedWith,
    tokenName: null,
    linkedBy: null,
    topic: null,
    linkedAtIso: linkedWith ? "2026-11-08T10:00:00.000Z" : null,
  });
  const chats = [chat("2002", false, "code"), chat("-1003", true, "group-code"), chat("1001", true, null)];
  const core = createFengSuiCore({
    client: new HuaweiCpeClient({ cpeUrl: "http://192.168.8.1", cpePassword: cpe.password, fetchImpl: cpe.fetchImpl }),
    stateStore: new EncryptedStateStore({ filePath: path.join(dir, "state.json"), encryptionKey: "routes_key" }),
    timeseries: new TimeSeriesRingBuffer({ retentionHours: 1 }),
  });
  const settings = new ConsoleSettings({ filePath: path.join(dir, "settings.json"), cipher: new StorageCipher("routes_key"), scryptCost: { N: 2 ** 10, r: 8, p: 1 } });
  settings.importFromEnv({ cpeUrl: "http://192.168.8.1", cpeUsername: "admin", cpePassword: cpe.password, apiToken: "t0ken_for_routes", apiTokenReadonly: "" });
  const routes = new SettingsHttpRoutes({
    settings,
    scheduler: core.scheduler,
    audit: null,
    metricsFromEnv: true,
    telegramConfigured,
    onConnectionReady: () => undefined,
    revokeSessions: () => undefined,
    disconnectToken: () => undefined,
    unlinkTelegram: () => 2,
    unlinkTelegramToken: (tokenId) => {
      unlinkedFor.push(tokenId);
      return 1;
    },
    telegramChats: () => chats.map((c) => ({ ...c })),
    // Like the bot: a linked chat loses its link (one .env also lists stays in the list, as from .env only)
    unlinkTelegramChat: (chatId) => {
      const linked = chats.find((c) => c.chatId === chatId && c.linkedWith !== null);
      if (!linked) return false;
      if (linked.fromEnv) linked.linkedWith = null;
      else chats.splice(chats.indexOf(linked), 1);
      return true;
    },
    telegramUsername: () => "FengSuiBot",
  });
  const call = async (method: string, pathname: string, body: Record<string, unknown> = {}) => {
    let status = 0;
    let payload: unknown = null;
    const handled = await routes.handle(
      { method, pathname, query: Object.create(null) as Record<string, string>, readJsonBody: async () => body, sendJson: (code, json) => ((status = code), (payload = json)) },
      "session-1",
      async (candidate) => ((await settings.verifyLogin(candidate)) ? { ok: true } : { ok: false, statusCode: 401 })
    );
    return { handled, status, payload: payload as Record<string, unknown> };
  };
  return {
    cpe,
    settings,
    call,
    unlinkedFor,
    cleanup: async () => {
      await stopFengSuiCore(core);
      // Settings saves are queued in the background: removing the dir under one fails with ENOTEMPTY
      await settings.flush();
      removeTempDir(dir);
    },
  };
}

describe("console routes", () => {
  it("hands out pairing codes with a bot, validates input and leaves unknown routes to the 404", async () => {
    const fx = routesFixture(true);
    try {
      const pairing = await fx.call("POST", "/api/console/telegram/pairing-code");
      assert.match(String(pairing.payload["code"]), /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
      assert.equal(fx.settings.consumeCode("pair", String(pairing.payload["code"])), true);
      assert.deepEqual([pairing.payload["group"], pairing.payload["command"]], [false, `/auth ${String(pairing.payload["code"])}`]);
      const group = await fx.call("POST", "/api/console/telegram/pairing-code", { group: true });
      assert.equal(group.payload["group"], true);
      assert.equal(group.payload["command"], `/auth@FengSuiBot ${String(group.payload["code"])}`, "names the bot, so a group with other bots routes it here");
      assert.equal(fx.settings.consumeCode("pair", String(group.payload["code"])), false);
      assert.equal(fx.settings.consumeCode("pair-group", String(group.payload["code"])), true);
      await assert.rejects(fx.call("POST", "/api/console/telegram/pairing-code", { group: "yes" }), /"group" must be true or false/);
      assert.equal((await fx.call("POST", "/api/console/telegram/unlink-all")).payload["unlinked"], 2);
      assert.deepEqual((await fx.call("GET", "/api/console")).payload["metrics"], { enabled: true, source: "env", envEnabled: true });
      assert.deepEqual((await fx.call("POST", "/api/console/switches", { metricsEnabled: false })).payload["metrics"], { enabled: false, source: "console", envEnabled: true });

      assert.equal((await fx.call("GET", "/api/console/nope")).handled, false);
      assert.equal((await fx.call("POST", "/api/console/nope")).handled, false);
      assert.equal((await fx.call("DELETE", "/api/console/tokens")).handled, false);
      await assert.rejects(fx.call("POST", "/api/console/cpe/test", { url: " ", password: "x" }), /"url" is required/);
      await assert.rejects(fx.call("POST", "/api/console/cpe/test", { url: "http://192.168.8.1", password: 12 }), /"password" must be text/);
      await assert.rejects(fx.call("POST", "/api/console/switches", { metricsEnabled: "on" }), /"metricsEnabled" must be/);
      await assert.rejects(fx.call("POST", "/api/console/tokens/revoke", { id: 7 }), /"id" must be text/);
      for (let i = fx.settings.listTokens().length; i < 50; i++) fx.settings.createToken({ name: `t${i}`, permissions: ["sms-read"], lifetimeDays: 1 });
      await assert.rejects(fx.call("POST", "/api/console/tokens", { name: "one more", scope: "read", lifetimeDays: null }), /At most 50 tokens/);
    } finally {
      await fx.cleanup();
    }
  });

  it("lists the Telegram chats and unlinks one at a time, naming .env for a chat only it authorizes", async () => {
    const fx = routesFixture(true);
    try {
      const ids = (payload: Record<string, unknown>) => (payload["chats"] as TelegramChatRecord[]).map((c) => `${c.chatId}:${c.linkedWith ?? "env"}`);
      const listed = await fx.call("GET", "/api/console/telegram/chats");
      assert.deepEqual([listed.status, ids(listed.payload)], [200, ["2002:code", "-1003:group-code", "1001:env"]]);
      const unlinked = await fx.call("POST", "/api/console/telegram/unlink", { chatId: " 2002 " });
      assert.deepEqual([unlinked.status, ids(unlinked.payload)], [200, ["-1003:group-code", "1001:env"]], "answers with the chats that are left");
      assert.deepEqual(ids((await fx.call("POST", "/api/console/telegram/unlink", { chatId: "-1003" })).payload), ["-1003:env", "1001:env"], ".env still authorizes it");
      for (const [chatId, message] of [
        ["2002", "No chat linked with /auth has this ID"],
        ["-1003", "TELEGRAM_CHAT_IDS in .env authorizes this chat: remove it there"],
        ["1001", "TELEGRAM_CHAT_IDS in .env authorizes this chat: remove it there"],
      ] as const) {
        const refused = await fx.call("POST", "/api/console/telegram/unlink", { chatId });
        assert.deepEqual([refused.status, refused.payload["errorCode"], refused.payload["message"]], [404, "NOT_FOUND", message], chatId);
      }
      for (const chatId of ["", " ", "abc", "12 34", "-", "+1001", "1".repeat(21)]) {
        await assert.rejects(fx.call("POST", "/api/console/telegram/unlink", { chatId }), /"chatId" must be a Telegram chat ID/, JSON.stringify(chatId));
      }
      await assert.rejects(fx.call("POST", "/api/console/telegram/unlink", { chatId: 1001 }), /"chatId" must be text/);
      await assert.rejects(fx.call("POST", "/api/console/telegram/unlink", {}), /"chatId" must be a Telegram chat ID/);
    } finally {
      await fx.cleanup();
    }
  });

  it("saves a router address typed without a scheme in the form the client uses", async () => {
    const fx = routesFixture(false);
    try {
      const saved = await fx.call("POST", "/api/console/cpe", { url: " 192.168.8.1/ ", password: fx.cpe.password });
      assert.equal(saved.status, 200);
      assert.deepEqual((saved.payload["settings"] as { cpe: unknown }).cpe, { url: "http://192.168.8.1", username: "admin", passwordSet: true });
      assert.equal(fx.settings.cpe?.url, "http://192.168.8.1");
    } finally {
      await fx.cleanup();
    }
  });

  it("unlinks the Telegram chats a revoked token linked", async () => {
    const fx = routesFixture(true);
    try {
      const created = await fx.call("POST", "/api/console/tokens", { name: "Phone", scope: "full", lifetimeDays: 7 });
      const id = String((created.payload["record"] as { id: string }).id);
      assert.equal((await fx.call("POST", "/api/console/tokens/revoke", { id })).status, 200);
      assert.deepEqual(fx.unlinkedFor, [id]);
      assert.equal((await fx.call("POST", "/api/console/tokens/revoke", { id })).status, 404);
      assert.deepEqual(fx.unlinkedFor, [id], "nothing more for an unknown token");
    } finally {
      await fx.cleanup();
    }
  });

  it("tries the stored router password only on the stored address", async () => {
    const fx = routesFixture(false);
    try {
      // Another host would see the password (a legacy login) or a proof it can crack offline (SCRAM)
      const before = fx.cpe.stats.requests.length;
      await assert.rejects(fx.call("POST", "/api/console/cpe/test", { url: "http://192.168.8.66" }), /"password" is required to try another router address/);
      await assert.rejects(fx.call("POST", "/api/console/cpe", { url: "192.168.8.66", username: "root" }), /"password" is required to try another router address/);
      assert.equal(fx.cpe.stats.requests.length, before, "nothing went anywhere");
      assert.equal(fx.settings.cpe?.url, "http://192.168.8.1", "nothing saved");

      // The stored address keeps its password however it is written, and with another user name
      for (const body of [{}, { url: " 192.168.8.1/ " }, { url: "http://192.168.8.1", username: "admin" }]) {
        const kept = await fx.call("POST", "/api/console/cpe/test", body);
        assert.equal((kept.payload["result"] as { ok: boolean }).ok, true, JSON.stringify(body));
      }
      // Another address is tried once its password is typed
      const typed = await fx.call("POST", "/api/console/cpe/test", { url: "http://192.168.8.66", password: fx.cpe.password });
      assert.equal((typed.payload["result"] as { ok: boolean }).ok, true);
    } finally {
      await fx.cleanup();
    }
  });

  it("renders metrics with and without telemetry, never with identifiers", () => {
    const scheduler = {
      mode: "polling",
      running: true,
      queueDepth: 1,
      circuitBreaker: { tripped: true, code: "108006", reason: null, trippedAtIso: null },
      totalSessionsCompleted: 42,
      browserYieldCount: 3,
      lastSessionHoldMs: 120,
    } as unknown as Parameters<typeof renderMetrics>[0]["scheduler"];
    const empty = renderMetrics({ version: "1.5.0", daemonUptimeSec: 5, scheduler, telemetry: null });
    assert.match(empty, /^fengsui_circuit_breaker_tripped 1$/m);
    assert.match(empty, /^fengsui_scheduler_mode\{mode="polling"\} 1$/m);
    assert.doesNotMatch(empty, /^fengsui_wan_connected /m, "no telemetry, no value");
    const telemetry = {
      capturedAtMs: 1_793_000_000_000,
      device: { connectionStatus: "901", uptimeSec: 86400, imei: "860000000000000" },
      rf: { lteRsrpDbm: -87, nrRsrpDbm: -95, lteRsrqDb: -7, nrRsrqDb: -10, lteSinrDb: 13, nrSinrDb: 9, caComponentCount: 3, totalAggregatedBandwidthMhz: 140, cellId: "134217758" },
      traffic: { downloadBps: 8_000_000, uploadBps: 700_000, monthDownloadBytes: 10, monthUploadBytes: 5, todayUsedBytes: 3 },
      sms: { localUnread: 2, localInbox: 5, localOutbox: 1, localDraft: 0, localMax: 500 },
    } as unknown as GlobalTelemetrySnapshot;
    const full = renderMetrics({ version: "1.5.0", daemonUptimeSec: 5, scheduler, telemetry });
    for (const line of [
      'fengsui_signal_rsrp_dbm{rat="nr"} -95',
      'fengsui_signal_sinr_db{rat="lte"} 13',
      "fengsui_wan_connected 1",
      "fengsui_carrier_components 3",
      'fengsui_throughput_bits_per_second{direction="down"} 8000000',
      "fengsui_sms_storage_used 6",
      "fengsui_sms_storage_capacity 500",
      "fengsui_telemetry_timestamp_seconds 1793000000",
    ]) {
      assert.ok(full.split("\n").includes(line), line);
    }
    assert.equal(full.includes("860000000000000") || full.includes("134217758"), false);
    assert.doesNotMatch(full, /^fengsui_battery_percent /m, "a CPE reports no battery");
    // The router's own status, its sensors by kind (never the router's own sensor names), no ICCID
    const mobile = renderMetrics({
      version: "1.9.0",
      daemonUptimeSec: 5,
      scheduler,
      telemetry: {
        ...telemetry,
        device: { ...telemetry.device, iccid: "8935301000000000000" },
        unavailable: ["uptime"],
        thermal: { temperatureCelsius: 46, temperatureSupported: true, sensors: [{ kind: "modem", name: null, celsius: 44 }, { kind: "modem", name: null, celsius: 46 }, { kind: "other", name: "aoss-0-usr", celsius: 38 }] },
        status: {
          battery: { percent: 64, charging: true, temperatureC: 36, minutesToFull: 92, minutesToEmpty: null },
          sim: { state: "pin_required", pinLockEnabled: true, pinAttemptsLeft: 3, pukAttemptsLeft: 10, slot: null },
          airplaneMode: false,
          roaming: { active: true, dataAllowed: null },
          system: { uptimeSec: null, cpuPercent: 12, memoryPercent: 40 },
          firmwareUpdate: null,
          wifi: null,
        },
      } as unknown as GlobalTelemetrySnapshot,
    });
    for (const line of [
      "fengsui_router_temperature_celsius 46",
      'fengsui_router_temperature_celsius{sensor="modem"} 46',
      'fengsui_router_temperature_celsius{sensor="other"} 38',
      "fengsui_battery_percent 64",
      "fengsui_battery_charging 1",
      "fengsui_battery_temperature_celsius 36",
      "fengsui_sim_locked 1",
      "fengsui_airplane_mode 0",
      "fengsui_roaming 1",
      "fengsui_router_cpu_percent 12",
      "fengsui_router_memory_percent 40",
    ]) {
      assert.ok(mobile.split("\n").includes(line), line);
    }
    assert.doesNotMatch(mobile, /aoss|8935301000000000000/);
    assert.doesNotMatch(mobile, /^fengsui_router_uptime_seconds /m, "no uptime of the router's own: none here");
    assert.match(renderMetrics({ version: 'x"y', daemonUptimeSec: 1, scheduler, telemetry: null }), /fengsui_info\{version="x_y"\} 1/, "label values cannot break the format");
  });

  it("reports the daemon process itself: memory, CPU, event-loop delay, streams and queued notifications", async () => {
    const scheduler = { mode: "idle", queueDepth: 0, circuitBreaker: { tripped: false } } as unknown as Parameters<typeof renderMetrics>[0]["scheduler"];
    const runtime = { residentBytes: 134_217_728, heapUsedBytes: 20_971_520, cpuSeconds: 12.5, eventLoopDelayP99Sec: 0.012, eventLoopDelayMaxSec: 0.05, sseClients: 3, telegramPending: 0 };
    const text = renderMetrics({ version: "1.6.3", daemonUptimeSec: 60, scheduler, telemetry: null, runtime });
    for (const line of [
      "process_resident_memory_bytes 134217728",
      "process_cpu_seconds_total 12.5",
      "nodejs_heap_size_used_bytes 20971520",
      "nodejs_eventloop_lag_p99_seconds 0.012",
      "nodejs_eventloop_lag_max_seconds 0.05",
      "fengsui_sse_clients 3",
      "fengsui_telegram_outbox_pending 0",
    ]) {
      assert.ok(text.split("\n").includes(line), line);
    }
    assert.match(text, /^# TYPE process_cpu_seconds_total counter$/m);
    const quiet = renderMetrics({ version: "1.6.3", daemonUptimeSec: 1, scheduler, telemetry: null, runtime: { ...runtime, eventLoopDelayP99Sec: null, eventLoopDelayMaxSec: null, telegramPending: null } });
    assert.doesNotMatch(quiet, /^nodejs_eventloop_lag_p99_seconds /m, "no full window yet, no value");
    assert.doesNotMatch(quiet, /^fengsui_telegram_outbox_pending /m, "no bot, no value");

    // The sampler measures the event loop in whole windows, whatever the scrape rate
    const sampler = new RuntimeSampler({ windowMs: 30 });
    assert.equal(sampler.sample({ sseClients: 0, telegramPending: null }).eventLoopDelayP99Sec, null);
    sampler.start();
    try {
      await new Promise((resolve) => setTimeout(resolve, 120));
      const sample = sampler.sample({ sseClients: 1, telegramPending: 2 });
      assert.ok(sample.residentBytes > 0 && sample.heapUsedBytes > 0 && sample.cpuSeconds > 0);
      assert.ok(typeof sample.eventLoopDelayP99Sec === "number" && sample.eventLoopDelayP99Sec >= 0);
      assert.ok(typeof sample.eventLoopDelayMaxSec === "number" && sample.eventLoopDelayMaxSec >= (sample.eventLoopDelayP99Sec ?? 0));
      assert.deepEqual([sample.sseClients, sample.telegramPending], [1, 2]);
    } finally {
      sampler.stop();
    }
  });
});
