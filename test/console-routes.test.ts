import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { ConsoleSettings } from "../src/console-settings.ts";
import { createFengSuiCore, stopFengSuiCore } from "../src/core.ts";
import { HuaweiCpeClient } from "../src/cpe-client.ts";
import type { GlobalTelemetrySnapshot } from "../src/cpe-domain.ts";
import { StorageCipher } from "../src/encrypted-file.ts";
import { SettingsHttpRoutes } from "../src/http-settings.ts";
import { renderMetrics } from "../src/metrics.ts";
import { EncryptedStateStore } from "../src/state-store.ts";
import { TimeSeriesRingBuffer } from "../src/timeseries.ts";
import { createStrictCpe } from "./helpers/strict-cpe.ts";

function routesFixture(telegramConfigured: boolean) {
  const cpe = createStrictCpe();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fengsui-routes-"));
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
  });
  const call = async (method: string, pathname: string, body: Record<string, unknown> = {}) => {
    let status = 0;
    let payload: unknown = null;
    const handled = await routes.handle(
      { method, pathname, query: Object.create(null) as Record<string, string>, readJsonBody: async () => body, sendJson: (code, json) => ((status = code), (payload = json)) },
      "session-1"
    );
    return { handled, status, payload: payload as Record<string, unknown> };
  };
  return {
    cpe,
    settings,
    call,
    cleanup: async () => {
      await stopFengSuiCore(core);
      fs.rmSync(dir, { recursive: true, force: true });
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
      for (let i = fx.settings.listTokens().length; i < 50; i++) fx.settings.createToken({ name: `t${i}`, scope: "read", lifetimeDays: 1 });
      await assert.rejects(fx.call("POST", "/api/console/tokens", { name: "one more", scope: "read", lifetimeDays: null }), /At most 50 tokens/);
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
    assert.match(renderMetrics({ version: 'x"y', daemonUptimeSec: 1, scheduler, telemetry: null }), /fengsui_info\{version="x_y"\} 1/, "label values cannot break the format");
  });
});
