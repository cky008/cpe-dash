import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { createFengSuiCore, stopFengSuiCore } from "../src/core.ts";
import { CpeApiError, HuaweiCpeClient } from "../src/cpe-client.ts";
import type { WriteCheck } from "../src/device-access.ts";
import { CONNECTION_POLLS } from "../src/drivers/readback.ts";
import type { RouterFamily } from "../src/router-family.ts";
import type { ControlAppliedEvent, ControlAuditEvent } from "../src/scheduler.ts";
import { EncryptedStateStore } from "../src/state-store.ts";
import { TimeSeriesRingBuffer } from "../src/timeseries.ts";
import { removeTempDir, tempDir } from "./helpers/temp-dir.ts";
import { ZTE_PASSWORD, zteRouter } from "./helpers/zte-goform-router.ts";

/**
 * The data connection of a driver family (redial, self-healing's redial, mobile data): the session
 * parts each driver implements, and the backend's redial built from them. Mock routers only.
 */

function newCheck(): WriteCheck {
  return { endpoints: [], readback: "none", reason: null };
}

const noWait = { sleep: () => Promise.resolve() };

/** A daemon on a router of a driver family, its writes audited and broadcast. */
function daemonOn(family: RouterFamily, fetchImpl: typeof fetch, url: string, password: string, username = "") {
  const dir = tempDir("fengsui-data-link-");
  const core = createFengSuiCore({
    client: new HuaweiCpeClient({ cpeUrl: url, cpeUsername: username, cpePassword: password, fetchImpl, requestTimeoutMs: 2000 }),
    stateStore: new EncryptedStateStore({ filePath: path.join(dir, "state.json"), encryptionKey: "data_link_key" }),
    timeseries: new TimeSeriesRingBuffer({ retentionHours: 1 }),
    family,
    pollIntervalMs: 600_000,
    neighborScanIntervalMs: 600_000,
  });
  core.monitor.init();
  const audits: ControlAuditEvent[] = [];
  const applied: ControlAppliedEvent[] = [];
  core.scheduler.on("control:audit", (event: ControlAuditEvent) => audits.push(event));
  core.scheduler.on("control:applied", (event: ControlAppliedEvent) => applied.push(event));
  return {
    core,
    audits,
    applied,
    cleanup: async () => {
      await stopFengSuiCore(core);
      removeTempDir(dir);
    },
  };
}

describe("zte-goform: the data connection", () => {
  it("switches data off and on with the page's writes and reads the connection back", async () => {
    const { state, client } = zteRouter();
    const off = newCheck();
    await client.withSession((s) => s.data!.set(false, off, noWait));
    const posted = state.posts.find((p) => p.goformId === "DISCONNECT_NETWORK");
    assert.equal(posted?.fields.get("notCallback"), "true");
    assert.ok(posted?.fields.has("AD"), "signed like every other write");
    assert.deepEqual([off.endpoints, off.readback, off.reason], [["zte-goform:DISCONNECT_NETWORK"], "match", null]);
    assert.equal(state.values["ppp_status"], "ppp_disconnected");
    const on = newCheck();
    await client.withSession((s) => s.data!.set(true, on, noWait));
    assert.deepEqual([on.endpoints, on.readback], [["zte-goform:CONNECT_NETWORK"], "match"]);
    // The router reports its connection, not a switch to read
    assert.equal(await client.withSession((s) => s.data!.enabled()), null);
  });

  it("leaves the read-back open when the connection does not follow in time, and never asks again after that", async () => {
    const { state, client } = zteRouter({ pppSticks: true });
    let slept = 0;
    const check = newCheck();
    await client.withSession((s) => s.data!.set(false, check, { sleep: () => Promise.resolve(void (slept += 1)) }));
    assert.deepEqual([check.readback, check.reason], ["unknown", "no_evidence"]);
    assert.equal(slept, CONNECTION_POLLS - 1);
    assert.equal(state.posts.filter((p) => p.goformId === "DISCONNECT_NETWORK").length, 1, "sent once");
  });

  it("redials as off then on through the daemon, audited, the polls left to tell", async () => {
    const { state, mock } = zteRouter();
    const fx = daemonOn("zte-goform", mock.fetchImpl, "http://192.168.0.1", ZTE_PASSWORD);
    try {
      const done = await fx.core.controls.reconnectCellular();
      assert.equal(done.reconnecting, true);
      assert.deepEqual(
        state.posts.map((p) => p.goformId).filter((id) => id.endsWith("_NETWORK")),
        ["DISCONNECT_NETWORK", "CONNECT_NETWORK"]
      );
      assert.equal(state.values["ppp_status"], "ppp_connected");
      const record = fx.core.scheduler.genericWrites.at(-1);
      assert.deepEqual([record?.action, record?.feature, record?.readback], ["reconnect_cellular", "reconnect", "pending"]);
      assert.deepEqual(record?.endpoints, ["zte-goform:DISCONNECT_NETWORK", "zte-goform:CONNECT_NETWORK"]);
      assert.deepEqual(fx.audits.map((a) => [a.action, a.outcome]), [["reconnect_cellular", "applied"]]);

      const data = await fx.core.controls.setMobileData(false);
      assert.deepEqual(data, { mobileDataEnabled: false });
      assert.equal(state.values["ppp_status"], "ppp_disconnected");
      assert.equal(fx.core.scheduler.genericWrites.at(-1)?.readback, "match");
      assert.equal(fx.core.scheduler.getStatus().device.features.mobileData, "enabled");
    } finally {
      await fx.cleanup();
    }
  });

  it("connects again when the disconnect was refused, and fails the redial without sending anything twice", async () => {
    const { state, mock } = zteRouter({ refuse: ["DISCONNECT_NETWORK"] });
    const fx = daemonOn("zte-goform", mock.fetchImpl, "http://192.168.0.1", ZTE_PASSWORD);
    try {
      await assert.rejects(fx.core.controls.reconnectCellular(), (err: unknown) => err instanceof CpeApiError && err.code === "failure");
      assert.deepEqual(
        state.posts.map((p) => p.goformId).filter((id) => id.endsWith("_NETWORK")),
        ["DISCONNECT_NETWORK", "CONNECT_NETWORK"]
      );
      assert.equal(state.values["ppp_status"], "ppp_connected");
      assert.deepEqual(fx.audits.map((a) => [a.action, a.outcome]), [["reconnect_cellular", "failed"]]);
    } finally {
      await fx.cleanup();
    }
  });

  it("lets self-healing redial only a router whose WAN reads as down", async () => {
    const { state, mock } = zteRouter();
    const fx = daemonOn("zte-goform", mock.fetchImpl, "http://192.168.0.1", ZTE_PASSWORD);
    try {
      assert.deepEqual(await fx.core.controls.reconnectWan(), { applied: false, skipped: "wan_up" });
      assert.ok(!state.posts.some((p) => p.goformId.endsWith("_NETWORK")), "nothing written while the WAN is up");
      state.values["ppp_status"] = "ppp_disconnected";
      assert.deepEqual(await fx.core.controls.reconnectWan(), { applied: true });
      assert.deepEqual(
        state.posts.map((p) => p.goformId).filter((id) => id.endsWith("_NETWORK")),
        ["DISCONNECT_NETWORK", "CONNECT_NETWORK"]
      );
      assert.equal(fx.applied.at(-1)?.action, "auto_reconnect_cellular");
    } finally {
      await fx.cleanup();
    }
  });
});
