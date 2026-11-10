import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExperimentalWritesResponse, LockStateResponse, SessionStatusResponse, TelemetryEndpointResponse, TopologyEndpointResponse } from "../src/api-contract.ts";
import { startDemoDaemon } from "../scripts/demo-router.ts";

/**
 * `DEMO_SCENARIO=unverified npm run demo`: the real daemon against an LTE-only router of another
 * Huawei model from the phase-1 mock family (legacy SHA-256 login). It must come up read-only with
 * what that model provides, for screenshots and for trying the console. Placeholders only.
 */

const TOKEN = "fengsui-demo-unverified";

describe("demo world: an unverified model", () => {
  it("identifies the router, reads what it provides, writes what FengSui implements for it, and nothing its owner turned off", async () => {
    const demo = await startDemoDaemon({ port: 0, token: TOKEN, scenario: "unverified" });
    const headers = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" };
    const get = async <T>(p: string): Promise<T> => (await (await fetch(`${demo.baseUrl}${p}`, { headers })).json()) as T;
    try {
      assert.equal(demo.router.cpe, null, "no strict H168-383 in this world");
      const deadline = Date.now() + 8000;
      while ((await get<SessionStatusResponse>("/api/session/status")).status.device.writes !== "experimental") {
        assert.ok(Date.now() < deadline, "identified after start");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const { device } = (await get<SessionStatusResponse>("/api/session/status")).status;
      assert.deepEqual([device.model, device.verification], ["B535-232", "unverified-model"]);

      const topology = (await (await fetch(`${demo.baseUrl}/api/topology/refresh`, { method: "POST", headers, body: "{}" })).json()) as TopologyEndpointResponse;
      assert.deepEqual([topology.topology?.source, topology.topology?.hosts.length], ["lan/HostInfo", 3]);

      assert.equal((await fetch(`${demo.baseUrl}/api/sms/sync`, { method: "POST", headers, body: JSON.stringify({ mode: "full" }) })).status, 200);
      const before = demo.stack.sms?.mirror.list().length ?? 0;
      demo.router.pushOtp();
      demo.router.advance();
      await fetch(`${demo.baseUrl}/api/sms/sync`, { method: "POST", headers, body: JSON.stringify({ mode: "full" }) });
      assert.equal(demo.stack.sms?.mirror.list().length, before + 1, "a new code arrives in the mailbox");

      // A write FengSui has no implementation of for this model stays refused
      const refused = await fetch(`${demo.baseUrl}/api/control/antenna`, { method: "POST", headers, body: JSON.stringify({ mode: "external" }) });
      assert.deepEqual([refused.status, ((await refused.json()) as { errorCode: string }).errorCode], [409, "DEVICE_UNVERIFIED_READ_ONLY"]);

      // The writes it implements are on with nothing asked of the owner, who can turn each off and back on
      const consoleHeaders = (cookie: string) => ({ "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest", Origin: demo.baseUrl, Cookie: cookie });
      const login = await fetch(`${demo.baseUrl}/api/auth/login`, { method: "POST", headers: { ...consoleHeaders(""), Cookie: "" }, body: JSON.stringify({ password: TOKEN }) });
      const cookie = `fengsui_sid=${/fengsui_sid=([0-9a-f]{64})/.exec(login.headers.get("set-cookie") ?? "")?.[1] ?? ""}`;
      const features = (await get<SessionStatusResponse>("/api/session/status")).status.device.features;
      assert.deepEqual([features.bandLock, features.reboot, features.reconnect, features.mobileData, features.smsWrite, features.cellLock], ["enabled", "enabled", "enabled", "enabled", "enabled", "not_implemented"]);
      const setWrite = (feature: string, enabled: boolean) => fetch(`${demo.baseUrl}/api/console/experimental`, { method: "POST", headers: consoleHeaders(cookie), body: JSON.stringify({ feature, enabled }) });
      assert.equal((await setWrite("reconnect", false)).status, 200);
      const off = await fetch(`${demo.baseUrl}/api/control/reconnect`, { method: "POST", headers, body: JSON.stringify({ confirm: true }) });
      assert.deepEqual([off.status, ((await off.json()) as { errorCode: string }).errorCode], [409, "DEVICE_WRITE_DISABLED"]);
      assert.equal((await setWrite("reconnect", true)).status, 200);
      // The band lock and the redial go the generic way and are read back
      const locked = (await (await fetch(`${demo.baseUrl}/api/control/band-lock`, { method: "POST", headers, body: JSON.stringify({ lteBands: ["B3"] }) })).json()) as LockStateResponse;
      assert.deepEqual([locked.lockState.mode, locked.lockState.lteBands], ["band_lock", [3]]);
      assert.equal((await fetch(`${demo.baseUrl}/api/control/band-lock`, { method: "POST", headers, body: JSON.stringify({ lteBands: ["B28"] }) })).status, 400, "not a band this router advertises");
      assert.equal((await fetch(`${demo.baseUrl}/api/control/reconnect`, { method: "POST", headers, body: JSON.stringify({ confirm: true }) })).status, 200);
      demo.router.advance();
      await fetch(`${demo.baseUrl}/api/telemetry/refresh`, { method: "POST", headers, body: "{}" });
      const view = (await (await fetch(`${demo.baseUrl}/api/console/experimental`, { headers: consoleHeaders(cookie) })).json()) as ExperimentalWritesResponse;
      assert.deepEqual(view.writes.map((w) => [w.action, w.readback]), [
        ["lock_band", "match"],
        ["reconnect_cellular", "match"],
      ]);
      assert.equal((await get<TelemetryEndpointResponse>("/api/telemetry")).lockVerification.status, "consistent");

      // A person on the router's own page: the daemon steps aside here too
      demo.router.human.loginSameIp();
      await fetch(`${demo.baseUrl}/api/telemetry/refresh`, { method: "POST", headers, body: "{}" });
      assert.equal((await get<SessionStatusResponse>("/api/session/status")).status.mode, "yielding_browser");
      demo.router.human.logout();
    } finally {
      await demo.close();
    }
  });
});
