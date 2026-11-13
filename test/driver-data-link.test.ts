import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { createFengSuiCore, stopFengSuiCore } from "../src/core.ts";
import { HuaweiCpeClient } from "../src/cpe-client.ts";
import { CpeApiError } from "../src/session-errors.ts";
import type { WriteCheck } from "../src/device-access.ts";
import { CONNECTION_POLLS } from "../src/drivers/readback.ts";
import type { RouterFamily } from "../src/router-family.ts";
import type { ControlAppliedEvent, ControlAuditEvent } from "../src/scheduler.ts";
import { EncryptedStateStore } from "../src/state-store.ts";
import { TimeSeriesRingBuffer } from "../src/timeseries.ts";
import { LanRouterMock } from "./helpers/lan-router.ts";
import { OPENWRT_PASSWORD, openwrtRouter } from "./helpers/openwrt-router.ts";
import { removeTempDir, tempDir } from "./helpers/temp-dir.ts";
import { ZTE_PASSWORD, zteRouter } from "./helpers/zte-goform-router.ts";
import { ZWRT_PASSWORD, zwrtRouter } from "./helpers/zte-zwrt-router.ts";

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

describe("zte-zwrt: the data connection", () => {
  it("switches the data call the way the router's app does, keeping its roaming setting, and reads the switch back", async () => {
    const { calls, state, client } = zwrtRouter();
    assert.equal(await client.withSession((s) => s.data!.enabled()), true);
    const off = newCheck();
    await client.withSession((s) => s.data!.set(false, off, noWait));
    const sent = calls.find((c) => c.method === "set_wwaniface");
    assert.deepEqual(sent?.args, { source_module: "web", cid: 1, connect_mode: 1, roam_enable: 1, enable: 0 });
    assert.deepEqual([off.endpoints, off.readback], [["zte-zwrt:zwrt_data.set_wwaniface"], "match"]);
    assert.equal(state.wwan["roam_enable"], "1", "roaming kept");
    const on = newCheck();
    await client.withSession((s) => s.data!.set(true, on, noWait));
    assert.deepEqual(calls.filter((c) => c.method === "set_wwaniface").at(-1)?.args, { source_module: "web", cid: 1, connect_mode: 1, roam_enable: 1, enable: 1 });
    assert.equal(on.readback, "match");
  });

  it("falls back to the notes' plain write when the call cannot be read, and then cannot tell", async () => {
    const { calls, client } = zwrtRouter({ fail: "get_wwaniface" });
    const check = newCheck();
    await client.withSession((s) => s.data!.set(true, check, noWait));
    assert.deepEqual(calls.find((c) => c.method === "set_wwaniface")?.args, { source_module: "web", cid: 1, enable: 1 });
    assert.deepEqual([check.readback, check.reason], ["unknown", "no_evidence"]);
  });

  it("leaves a router whose data was switched off on purpose alone when self-healing would redial", async () => {
    const router = zwrtRouter();
    const fx = daemonOn("zte-zwrt", router.mock.fetchImpl, "http://192.168.0.1", ZWRT_PASSWORD);
    try {
      await fx.core.controls.setMobileData(false);
      assert.deepEqual(await fx.core.controls.reconnectWan(), { applied: false, skipped: "mobile_data_off" });
      assert.equal(router.calls.filter((c) => c.method === "set_wwaniface").length, 1, "only the switch-off went out");
      await fx.core.controls.setMobileData(true);
      router.state.wwan["connect_status"] = "disconnected";
      assert.deepEqual(await fx.core.controls.reconnectWan(), { applied: true });
      assert.deepEqual(router.calls.filter((c) => c.method === "set_wwaniface").map((c) => c.args["enable"]), [0, 1, 0, 1]);
      assert.equal(router.state.wwan["connect_status"], "ipv4_ipv6_connected");
    } finally {
      await fx.cleanup();
    }
  });
});

/** An NRadio router: LuCI's login and pages, and the module's bridge with its data switch. */
function nradioRouter() {
  const state = { dataswitch: "1", up: true, antenna: "0", antennaReadable: true, posts: [] as Array<{ path: string; body: string; token: string | null }> };
  const mock = new LanRouterMock((req) => {
    if (req.method === "POST" && req.path === "/cgi-bin/luci") {
      const form = LanRouterMock.form(req);
      if (form.get("luci_password") !== "test-password") return { status: 200, text: "<p>密码错误</p>" };
      return { status: 302, headers: { location: "/cgi-bin/luci" }, setCookie: ["sysauth=0123456789abcdef0123456789abcdef; path=/cgi-bin/luci"] };
    }
    if (!req.headers["cookie"]?.includes("sysauth=")) return { status: 403, text: "" };
    if (req.path === "/cgi-bin/luci/nradio/system/overview") return { text: `<div>设备型号: C2000 MAX</div><div>系统版本:1.9.2.n6</div><script>a['token']='a8f5f167f44f4964e6c998dee827110c';</script>` };
    if (req.path === "/cgi-bin/luci/nradio/status/runtime/wan,cpe_4") return { json: { wan: { up: false }, cpe_4: { up: state.up, mode: "NR", band: "78", earfcn: "650000", pci: "142", rsrp: "-79 dBm" } } };
    if (req.path === "/api/dialup/mobile-dataswitch" && req.method === "GET") return { text: `<?xml version="1.0" encoding="UTF-8"?><response><dataswitch>${state.dataswitch}</dataswitch></response>` };
    if (req.path === "/api/dialup/mobile-dataswitch" && req.method === "POST") {
      const body = req.body;
      state.posts.push({ path: req.path, body, token: req.query.get("token") });
      state.dataswitch = body.includes("<dataswitch>1</dataswitch>") ? "1" : "0";
      state.up = state.dataswitch === "1";
      return { text: `<?xml version="1.0" encoding="UTF-8"?><response>OK</response>` };
    }
    if (req.path === "/api/device/antenna_set_type" && req.method === "GET") return state.antennaReadable ? { text: `<response><antennasettype>${state.antenna}</antennasettype></response>` } : { status: 404, text: "" };
    if (req.path === "/api/device/antenna_set_type" && req.method === "POST") {
      state.posts.push({ path: req.path, body: req.body, token: req.query.get("token") });
      state.antenna = /<antennasettype>(\d)<\/antennasettype>/.exec(req.body)?.[1] ?? "?";
      return { text: `<?xml version="1.0" encoding="UTF-8"?><response>OK</response>` };
    }
    if (req.path === "/cgi-bin/luci/nradio/logout") return { status: 302, headers: { location: "/" } };
    return { status: 404, text: "" };
  });
  return { mock, state };
}

describe("nradio: the data connection", () => {
  it("toggles the module's data switch with the page's token, reads it back, and redials as off then on", async () => {
    const router = nradioRouter();
    const fx = daemonOn("nradio", router.mock.fetchImpl, "http://192.168.66.1", "test-password", "root");
    try {
      await fx.core.controls.setMobileData(false);
      assert.deepEqual(router.state.posts.map((p) => [p.body.includes("<dataswitch>0</dataswitch>"), p.token]), [[true, "a8f5f167f44f4964e6c998dee827110c"]]);
      assert.equal(fx.core.scheduler.genericWrites.at(-1)?.readback, "match");
      assert.deepEqual(await fx.core.controls.reconnectWan(), { applied: false, skipped: "mobile_data_off" }, "switched off on purpose");
      await fx.core.controls.setMobileData(true);
      await fx.core.controls.reconnectCellular();
      assert.deepEqual(router.state.posts.map((p) => /<dataswitch>(\d)<\/dataswitch>/.exec(p.body)?.[1]), ["0", "1", "0", "1"]);
      assert.equal(router.state.dataswitch, "1");
      assert.deepEqual(fx.core.scheduler.genericWrites.at(-1)?.endpoints, ["nradio:/api/dialup/mobile-dataswitch"]);
    } finally {
      await fx.cleanup();
    }
  });
});

describe("nradio: the antenna", () => {
  it("switches the antenna with the codes of its own notes, reads the setting back, and says so when it cannot", async () => {
    const router = nradioRouter();
    const fx = daemonOn("nradio", router.mock.fetchImpl, "http://192.168.66.1", "test-password", "root");
    try {
      assert.equal(fx.core.scheduler.getStatus().device.features.antenna, "unknown", "no model seen yet");
      assert.deepEqual(await fx.core.controls.setAntennaMode("external"), { mode: "external", rawCode: 1 });
      assert.equal(router.state.antenna, "1", "external is 1 in the NRadio notes (the H168-383's 2)");
      assert.deepEqual([fx.core.scheduler.genericWrites.at(-1)?.feature, fx.core.scheduler.genericWrites.at(-1)?.readback], ["antenna", "match"]);
      assert.equal((await fx.core.controls.setAntennaMode("internal")).rawCode, 2);
      router.state.antennaReadable = false;
      await fx.core.controls.setAntennaMode("auto");
      assert.deepEqual([router.state.antenna, fx.core.scheduler.genericWrites.at(-1)?.readback], ["0", "unknown"]);
      assert.equal(fx.core.scheduler.getStatus().device.features.antenna, "enabled");
      assert.ok(router.state.posts.every((p) => p.token === "a8f5f167f44f4964e6c998dee827110c"));
    } finally {
      await fx.cleanup();
    }
  });
});

describe("openwrt: the data connection through QModem", () => {
  it("dials, hangs up and redials with QModem's own calls, and reads its dial worker back", async () => {
    const router = openwrtRouter({ qmodem: true, modemRpcObject: "qmodem" });
    const fx = daemonOn("openwrt", router.mock.fetchImpl, "http://192.168.1.1", OPENWRT_PASSWORD, "root");
    try {
      assert.deepEqual(await fx.core.controls.setMobileData(false), { mobileDataEnabled: false });
      assert.deepEqual(router.state.dial.calls, ["modem_hang"]);
      assert.deepEqual([fx.core.scheduler.genericWrites.at(-1)?.endpoints, fx.core.scheduler.genericWrites.at(-1)?.readback], [["openwrt:qmodem.modem_hang"], "match"]);
      // QModem's own report of the connection is the WAN state now
      assert.equal((await fx.core.monitor.refreshTelemetry())?.device.connectionStatus === "901", false);
      assert.deepEqual(await fx.core.controls.reconnectWan(), { applied: false, skipped: "mobile_data_off" }, "switched off on purpose");
      await fx.core.controls.setMobileData(true);
      await fx.core.controls.reconnectCellular();
      // QModem redials with a call of its own: no hang-up and dial pair
      assert.deepEqual(router.state.dial.calls, ["modem_hang", "modem_dial", "modem_redial"]);
      assert.equal(fx.core.scheduler.genericWrites.at(-1)?.readback, "pending");
      assert.deepEqual(await fx.core.controls.reconnectWan(), { applied: false, skipped: "wan_up" });
    } finally {
      await fx.cleanup();
    }
  });

  it("fails a dial QModem says did not run, and refuses on a router without QModem with nothing sent", async () => {
    const router = openwrtRouter({ qmodem: true, modemRpcObject: "qmodem" });
    router.state.dial.refuse.push("modem_hang");
    const fx = daemonOn("openwrt", router.mock.fetchImpl, "http://192.168.1.1", OPENWRT_PASSWORD, "root");
    try {
      await assert.rejects(fx.core.controls.setMobileData(false), (err: unknown) => err instanceof CpeApiError && err.code === "dial-refused");
      assert.equal(router.state.dial.running, true);
    } finally {
      await fx.cleanup();
    }
    const bare = openwrtRouter();
    const plain = daemonOn("openwrt", bare.mock.fetchImpl, "http://192.168.1.1", OPENWRT_PASSWORD, "root");
    try {
      await assert.rejects(plain.core.controls.reconnectCellular(), /no QModem/);
      assert.ok(!bare.calls.some((c) => c.object === "qmodem"), "nothing was sent");
    } finally {
      await plain.cleanup();
    }
  });
});
