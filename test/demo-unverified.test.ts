import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionStatusResponse, TopologyEndpointResponse } from "../src/api-contract.ts";
import { startDemoDaemon } from "../scripts/demo-router.ts";

/**
 * `DEMO_SCENARIO=unverified npm run demo`: the real daemon against an LTE-only router of another
 * Huawei model from the phase-1 mock family (legacy SHA-256 login). It must come up read-only with
 * what that model provides, for screenshots and for trying the console. Placeholders only.
 */

const TOKEN = "fengsui-demo-unverified";

describe("demo world: an unverified model", () => {
  it("identifies the router, reads what it provides and writes nothing", async () => {
    const demo = await startDemoDaemon({ port: 0, token: TOKEN, scenario: "unverified" });
    const headers = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" };
    const get = async <T>(p: string): Promise<T> => (await (await fetch(`${demo.baseUrl}${p}`, { headers })).json()) as T;
    try {
      assert.equal(demo.router.cpe, null, "no strict H168-383 in this world");
      const deadline = Date.now() + 8000;
      while ((await get<SessionStatusResponse>("/api/session/status")).status.device.writes !== "read_only") {
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

      const refused = await fetch(`${demo.baseUrl}/api/control/reconnect`, { method: "POST", headers, body: JSON.stringify({ confirm: true }) });
      assert.deepEqual([refused.status, ((await refused.json()) as { errorCode: string }).errorCode], [409, "DEVICE_UNVERIFIED_READ_ONLY"]);

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
