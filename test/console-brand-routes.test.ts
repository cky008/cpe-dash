import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { ConsoleSettings } from "../src/console-settings.ts";
import { createFengSuiCore, stopFengSuiCore } from "../src/core.ts";
import { StorageCipher } from "../src/encrypted-file.ts";
import { SettingsHttpRoutes } from "../src/http-settings.ts";
import { EncryptedStateStore } from "../src/state-store.ts";
import { TimeSeriesRingBuffer } from "../src/timeseries.ts";
import { OPENWRT_PASSWORD, openwrtRouter } from "./helpers/openwrt-router.ts";
import { createStrictCpe } from "./helpers/strict-cpe.ts";
import { removeTempDir, tempDir } from "./helpers/temp-dir.ts";
import { mockConnection } from "./helpers/connection.ts";

/**
 * The router's brand through `/api/console/cpe` and `/api/console/cpe/test`: left to FengSui
 * (`family: "auto"`), named by the owner, or kept as stored. Mock routers only, no network.
 */

function brandFixture(fetchImpl: typeof fetch, stored?: { url: string; username: string; password: string }) {
  const dir = tempDir("fengsui-brand-routes-");
  const core = createFengSuiCore({
    connection: mockConnection({ password: stored?.password ?? "", fetchImpl }, { cpeUrl: stored?.url ?? "http://192.168.8.1", requestTimeoutMs: 1000 }),
    stateStore: new EncryptedStateStore({ filePath: path.join(dir, "state.json"), encryptionKey: "brand_key" }),
    timeseries: new TimeSeriesRingBuffer({ retentionHours: 1 }),
    pollIntervalMs: 600_000,
    neighborScanIntervalMs: 600_000,
  });
  const settings = new ConsoleSettings({ filePath: path.join(dir, "settings.json"), cipher: new StorageCipher("brand_key"), scryptCost: { N: 2 ** 10, r: 8, p: 1 } });
  if (stored) settings.importFromEnv({ cpeUrl: stored.url, cpeUsername: stored.username, cpePassword: stored.password, apiToken: "t0ken_for_brand_routes", apiTokenReadonly: "" });
  const audits: string[] = [];
  const routes = new SettingsHttpRoutes({
    settings,
    scheduler: core.scheduler,
    audit: { record: (entry: { action: string; outcome: string; detail?: string | null }) => void audits.push(`${entry.action} ${entry.outcome} ${entry.detail ?? ""}`) } as never,
    metricsFromEnv: false,
    telegramConfigured: false,
    onConnectionReady: () => undefined,
    revokeSessions: () => undefined,
    disconnectToken: () => undefined,
    unlinkTelegram: () => 0,
  });
  const call = async (pathname: string, body: Record<string, unknown> = {}) => {
    let status = 0;
    let payload: unknown = null;
    await routes.handle(
      { method: "POST", pathname, query: Object.create(null) as Record<string, string>, readJsonBody: async () => body, sendJson: (code, json) => ((status = code), (payload = json)) },
      "session-1",
      async () => ({ ok: true })
    );
    return { status, payload: payload as Record<string, unknown> };
  };
  return {
    core,
    settings,
    routes,
    audits,
    call,
    cleanup: async () => {
      await stopFengSuiCore(core);
      await settings.flush();
      removeTempDir(dir);
    },
  };
}

/** An OpenWrt router as a whole web server: its ubus, and a 404 for every path it does not have. */
function openwrtServer() {
  const router = openwrtRouter();
  const ubus = router.mock.handler;
  router.mock.handler = (req) => (req.method === "POST" && req.path === "/ubus" ? ubus(req) : { status: 404, text: "<html>404</html>" });
  return router;
}

describe("console routes: the router's brand", () => {
  it("tells the brand of a new router, signs in with that brand's usual user, and stores the brand it found", async () => {
    const router = openwrtServer();
    const fx = brandFixture(router.mock.fetchImpl);
    try {
      const test = await fx.call("/api/console/cpe/test", { url: "192.168.1.1", password: OPENWRT_PASSWORD, family: "auto" });
      assert.equal(test.status, 200);
      assert.equal(test.payload["family"], "openwrt");
      const result = test.payload["result"] as { ok: boolean; model: string | null };
      assert.deepEqual([result.ok, result.model], [true, "RM520N-GL"]);
      assert.equal(router.calls.find((c) => c.object === "session" && c.method === "login")?.args["username"], "root", "the brand's usual user, not the verified router's");
      assert.equal(fx.settings.cpe, null, "a test stores nothing");
      assert.equal(fx.core.scheduler.getFamily(), "huawei", "and leaves the live connection alone");
      // Every request before the login was one of the brands' login-free reads
      const firstLogin = router.mock.requests.findIndex((r) => r.path === "/ubus" && r.body.includes('"login"'));
      assert.ok(router.mock.requests.slice(0, firstLogin).every((r) => !r.body.includes(OPENWRT_PASSWORD)), "no password before the brand was told");

      const saved = await fx.call("/api/console/cpe", { url: "192.168.1.1", password: OPENWRT_PASSWORD, family: "auto" });
      assert.equal(saved.status, 200);
      assert.deepEqual(fx.settings.cpe, { url: "http://192.168.1.1", username: "root", password: OPENWRT_PASSWORD, family: "openwrt" });
      assert.deepEqual((saved.payload["settings"] as { cpe: unknown }).cpe, { url: "http://192.168.1.1", username: "root", passwordSet: true, family: "openwrt" });
      assert.equal(fx.core.scheduler.getFamily(), "openwrt");
      assert.equal(fx.core.scheduler.getStatus().device.family, "openwrt", "the status names the brand to every adapter");
      assert.ok(fx.audits.some((line) => line === "settings.cpe applied router 192.168.1.1 as root (openwrt)"));

      // The stored brand and user are kept when a later test names neither
      const again = await fx.call("/api/console/cpe/test", {});
      assert.equal(again.payload["family"], "openwrt");
      assert.equal((again.payload["result"] as { ok: boolean }).ok, true);
    } finally {
      await fx.cleanup();
    }
  });

  it("finds the verified router's brand the same way, and keeps naming no brand for it", async () => {
    const cpe = createStrictCpe();
    const fx = brandFixture(cpe.fetchImpl, { url: "http://192.168.8.1", username: "admin", password: cpe.password });
    try {
      const test = await fx.call("/api/console/cpe/test", { family: "auto" });
      assert.equal(test.payload["family"], "huawei");
      assert.equal((test.payload["result"] as { ok: boolean }).ok, true);
      const saved = await fx.call("/api/console/cpe", { family: "auto" });
      assert.equal(saved.status, 200);
      assert.equal(fx.settings.cpe?.family, "huawei");
      assert.deepEqual((saved.payload["settings"] as { cpe: unknown }).cpe, { url: "http://192.168.8.1", username: "admin", passwordSet: true });
      assert.equal(fx.core.scheduler.getStatus().device.family, "huawei");
    } finally {
      await fx.cleanup();
    }
  });

  it("uses the stored user only for the stored brand", async () => {
    const router = openwrtServer();
    const fx = brandFixture(router.mock.fetchImpl, { url: "http://192.168.1.1", username: "admin", password: OPENWRT_PASSWORD });
    try {
      // Stored as the HiLink brand with its "admin": naming OpenWrt signs in as OpenWrt's "root"
      const named = await fx.call("/api/console/cpe/test", { family: "openwrt" });
      assert.equal((named.payload["result"] as { ok: boolean }).ok, true);
      assert.equal(router.calls.find((c) => c.object === "session" && c.method === "login")?.args["username"], "root");
      // A user the owner typed is theirs to choose, for any brand
      await fx.call("/api/console/cpe/test", { family: "openwrt", username: "operator" });
      assert.equal(router.calls.filter((c) => c.object === "session" && c.method === "login").at(-1)?.args["username"], "operator");
    } finally {
      await fx.cleanup();
    }
  });

  it("refuses a brand it does not know, and sends no password to a router it cannot place", async () => {
    const seen: string[] = [];
    const silent: typeof fetch = async (input) => {
      seen.push(String(input));
      return new Response("<html>hello</html>", { status: 200 });
    };
    const fx = brandFixture(silent);
    try {
      for (const family of ["cisco", "", 7, "HUAWEI", "__proto__"]) {
        await assert.rejects(fx.call("/api/console/cpe/test", { url: "http://192.168.8.1", password: "typed-password", family }), /"family" must be "auto" or one of huawei, zte-goform/, String(family));
      }
      assert.equal(seen.length, 0, "a bad brand reaches no router");

      const test = await fx.call("/api/console/cpe/test", { url: "http://192.168.8.1", password: "typed-password", family: "auto" });
      assert.equal(test.status, 200);
      assert.equal(test.payload["family"], undefined);
      assert.deepEqual([(test.payload["result"] as { ok: boolean; reason: string }).ok, (test.payload["result"] as { reason: string }).reason], [false, "unknown_brand"]);
      const saved = await fx.call("/api/console/cpe", { url: "http://192.168.8.1", password: "typed-password", family: "auto" });
      assert.equal(saved.status, 400);
      assert.equal(saved.payload["errorCode"], "CPE_TEST_FAILED");
      assert.equal((saved.payload["connectionTest"] as { reason: string }).reason, "unknown_brand");
      assert.equal(fx.settings.cpe, null);
      assert.ok(fx.audits.includes("settings.cpe refused test failed: unknown_brand"));
      assert.ok(seen.length > 0 && seen.every((url) => !url.includes("typed-password")));

      // An address FengSui would not talk to is said to be one, before anything is sent
      const before = seen.length;
      const outside = await fx.call("/api/console/cpe/test", { url: "http://203.0.113.10", password: "typed-password", family: "auto" });
      assert.equal((outside.payload["result"] as { reason: string }).reason, "invalid_url");
      assert.equal(seen.length, before);
    } finally {
      await fx.cleanup();
    }
  });
});
