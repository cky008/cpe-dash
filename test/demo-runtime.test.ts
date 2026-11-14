import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { TimeSeriesRingBuffer } from "../src/timeseries.ts";
import { HOUSEHOLD_LTE, HOUSEHOLD_NR, UNLOCKED, dbm, servingFor } from "../web/src/demo/radio.ts";
import { type DemoRuntime, type DemoWorld, startDemoRuntime } from "../web/src/demo/runtime.ts";
import { REBOOT_OFFLINE_MS, createDemoRouter } from "../web/src/demo/worlds.ts";
import { TICK_MS, activityAt, backfillHistory, seriesInput, worldSample } from "../web/src/demo/world.ts";
import { removeTempDir, tempDir } from "./helpers/temp-dir.ts";

/**
 * The live demo's back end in Node: the daemon's own services (src/services.ts) and REST API
 * (src/http-api.ts) in front of each demo router, reached through the page's transport. What is the
 * demo's own is tested here: the household it starts with, the transport (its sign-in, the event
 * stream), and the routers' side of the world (the radio under a lock, mobile data, a reboot, replies).
 * test/ui/demo.test.ts runs the built demo in a browser, on the Node stand-ins.
 */

type Json = Record<string, unknown> & { ok?: boolean; errorCode?: string };

const running: Array<{ runtime: DemoRuntime; dir: string }> = [];
after(async () => {
  for (const { runtime, dir } of running.splice(0)) {
    await runtime.stop();
    removeTempDir(dir);
  }
});

/** A demo on `world` with a clock the test moves (the household's; the services keep real time). */
async function demo(world: DemoWorld, clock = { ms: Date.now() }): Promise<{ runtime: DemoRuntime; clock: { ms: number } }> {
  const dir = tempDir("fengsui-demo-runtime-");
  const runtime = await startDemoRuntime({ world, dataDir: dir, background: false, autoReply: true, replyAfterMs: 5, now: () => clock.ms });
  running.push({ runtime, dir });
  return { runtime, clock };
}

async function get(runtime: DemoRuntime, route: string): Promise<{ status: number; json: Json }> {
  const res = await runtime.transport.fetch(route);
  return { status: res.status, json: (await res.json()) as Json };
}

async function post(runtime: DemoRuntime, route: string, body: unknown = {}, raw?: string): Promise<{ status: number; json: Json }> {
  const res = await runtime.transport.fetch(route, { method: "POST", body: raw ?? JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as Json };
}

const write = (runtime: DemoRuntime, route: string, body: Record<string, unknown> = {}): Promise<{ status: number; json: Json }> => post(runtime, route, { ...body, confirm: true });

async function telemetry(runtime: DemoRuntime): Promise<{ rf: { pccBand: string | null; earfcnRaw: string; pci: number | null }; device: { connectionStatus: string }; traffic: { downloadBytesPerSec: number }; lock: { status: string; issues: string[] } }> {
  await write(runtime, "/api/telemetry/refresh");
  const answer = (await get(runtime, "/api/telemetry")).json;
  const t = answer["telemetry"] as { rf: { pccBand: string | null; earfcnRaw: string; pci: number | null }; device: { connectionStatus: string }; traffic: { downloadBytesPerSec: number } };
  return { ...t, lock: answer["lockVerification"] as { status: string; issues: string[] } };
}

async function until(condition: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

describe("the live demo's back end", () => {
  it("starts each router's household: readings, the identified model, the console set up, tokens, contacts, Telegram and a day of history", async () => {
    for (const [world, model] of [["verified", "H168-383"], ["other", "B535-232"], ["zte", "MU5001"]] as const) {
      const { runtime } = await demo(world);
      assert.equal((await get(runtime, "/api/health")).json["codename"], "FengSui");
      assert.equal((await get(runtime, "/api/auth/status")).json["authenticated"], true);
      assert.ok((await get(runtime, "/api/telemetry")).json["telemetry"], `${world}: telemetry at once`);
      assert.equal(((await get(runtime, "/api/device/profile")).json["profile"] as { identity: { model: string } }).identity.model, model);
      const console = (await get(runtime, "/api/console")).json;
      assert.equal(console["reviewPending"], false);
      assert.deepEqual(((await get(runtime, "/api/console/tokens")).json["tokens"] as Array<{ name: string }>).map((token) => token.name).sort(), ["Claude Code", "Grafana"]);
      assert.equal((await get(runtime, "/api/sms/contacts?search=&limit=50")).json["total"], 3);
      assert.equal(((await get(runtime, "/api/console/telegram/chats")).json["chats"] as unknown[]).length, 3);
      const history = (await get(runtime, "/api/timeseries?preset=24h")).json;
      assert.ok((history["points"] as unknown[]).length > 100, `${world}: the day's history is there`);
      const audit = ((await get(runtime, "/api/audit?limit=5")).json["entries"] as Array<{ action: string; channel: string }>)[0];
      assert.deepEqual([audit?.action, audit?.channel], ["login", "web"]);
    }
  });

  it("signs in with any password, refuses the API signed out, and reads bodies as the daemon does", async () => {
    const { runtime } = await demo("other");
    assert.equal((await post(runtime, "/api/auth/logout")).json["authenticated"], false);
    assert.equal((await get(runtime, "/api/telemetry")).status, 401);
    assert.equal((await get(runtime, "/api/health")).status, 200, "liveness needs no sign-in");
    assert.equal((await post(runtime, "/api/auth/login", { password: "" })).status, 401);
    assert.equal((await post(runtime, "/api/auth/login", { token: "anything" })).status, 200);
    assert.equal((await get(runtime, "/api/telemetry")).status, 200);
    assert.equal(((await get(runtime, "/api/i18n/en")).json["catalog"] as Record<string, unknown>)["app"] !== undefined, true);
    assert.equal((await get(runtime, "/api/i18n/fr")).json.errorCode, "LOCALE_NOT_FOUND");
    assert.deepEqual([(await post(runtime, "/api/control/unlock", {}, "{not json")).json.errorCode], ["BAD_PAYLOAD"]);
    assert.equal((await post(runtime, "/api/control/unlock", {}, "[1]")).json.errorCode, "BAD_PAYLOAD");
    assert.equal((await post(runtime, "/api/control/unlock", {}, `{"x":"${"a".repeat(70_000)}"}`)).status, 413);
    assert.equal((await post(runtime, "/api/control/unlock", {}, "")).json.errorCode, "VALIDATION_ERROR", "an empty body has no confirm");
    assert.equal((await get(runtime, "/api/nothing-here")).status, 404);
    assert.equal((await post(runtime, "/api/console/nothing-here")).status, 404);
    // The visitor does not know the demo router's password: a connection test uses it
    const tested = await post(runtime, "/api/console/cpe/test", { url: "http://192.168.8.1", username: "admin", password: "whatever-they-typed", family: "huawei" });
    assert.equal((tested.json["result"] as { ok: boolean }).ok, true, JSON.stringify(tested.json));
  });

  it("streams the daemon's events to the console's EventSource, and none signed out", async () => {
    const { runtime } = await demo("verified");
    const events: string[] = [];
    const source = runtime.transport.createEventSource("/api/events");
    source.addEventListener("hello", () => void events.push("hello"));
    source.addEventListener("telemetry", (event) => void events.push(`telemetry ${typeof event.data}`));
    await until(async () => events.includes("hello"), "the hello frame");
    await write(runtime, "/api/telemetry/refresh");
    await until(async () => events.filter((name) => name.startsWith("telemetry")).length >= 2, "a telemetry event");
    assert.equal(events.at(-1), "telemetry string");
    source.close();
    source.close();
    await post(runtime, "/api/auth/logout");
    let refused = false;
    runtime.transport.createEventSource("/api/events").addEventListener("error", () => {
      refused = true;
    });
    await until(async () => refused, "the refusal");
    const closedEarly = runtime.transport.createEventSource("/api/events");
    closedEarly.close();
    await sleep(5);
  });

  it("moves the H168-383's serving cells under band and cell locks and back, and the daemon's check agrees", async () => {
    const { runtime } = await demo("verified");
    assert.equal((await write(runtime, "/api/control/band-lock", { lteBands: [3], nrBands: [78] })).status, 200);
    let t = await telemetry(runtime);
    assert.deepEqual([t.rf.pccBand, t.lock.status, t.lock.issues], ["B3", "consistent", []]);
    assert.equal((await write(runtime, "/api/control/band-lock", { lteBands: [20], nrBands: [41] })).status, 200);
    t = await telemetry(runtime);
    assert.deepEqual([t.rf.pccBand, t.lock.issues], ["B20", []]);
    assert.equal((await write(runtime, "/api/control/cell-lock", { rat: "LTE", band: "B7", arfcn: 3050, pci: 288 })).status, 200);
    t = await telemetry(runtime);
    assert.deepEqual([t.rf.pccBand, t.rf.pci], ["B7", 288]);
    assert.equal((await write(runtime, "/api/control/cell-lock", { rat: "NR", band: "N78", arfcn: 636666, pci: 88 })).status, 200);
    assert.equal((await write(runtime, "/api/control/unlock")).status, 200);
    t = await telemetry(runtime);
    assert.deepEqual([t.rf.pccBand, t.lock.status], ["B1", "consistent"]);
  });

  it("holds the H168-383's switches, stops traffic without mobile data, and drops off the network while it reboots", async () => {
    const { runtime, clock } = await demo("verified");
    assert.equal((await write(runtime, "/api/control/antenna", { mode: "external" })).status, 200);
    assert.equal(((await write(runtime, "/api/control/security", { upnpEnabled: false })).json["settings"] as { upnpEnabled: boolean }).upnpEnabled, false);
    assert.equal((await write(runtime, "/api/control/mobile-data", { enabled: false })).status, 200);
    runtime.router.advance();
    let t = await telemetry(runtime);
    assert.deepEqual([t.device.connectionStatus, t.traffic.downloadBytesPerSec], ["902", 0]);
    assert.equal((await write(runtime, "/api/control/mobile-data", { enabled: true })).status, 200);
    runtime.router.advance();
    t = await telemetry(runtime);
    assert.equal(t.device.connectionStatus, "901");
    assert.equal((await write(runtime, "/api/control/reconnect")).status, 200);
    assert.equal((await write(runtime, "/api/control/reboot")).status, 200);
    await assert.rejects(runtime.router.fetchImpl("http://192.168.8.1/api/monitoring/status"), /fetch failed/);
    clock.ms += REBOOT_OFFLINE_MS + 1;
    assert.equal((await runtime.router.fetchImpl("http://192.168.8.1/api/user/state-login")).ok, true, "back after the reboot");
  });

  it("answers a message the router sends, marks read and deletes on the H168-383's mailbox, and brings one-time codes", async () => {
    const { runtime } = await demo("verified");
    const codes = async (): Promise<number> => ((await get(runtime, "/api/sms/thread?key=DemoBank")).json["thread"] as { messages: unknown[] }).messages.length;
    const before = await codes();
    assert.equal((await write(runtime, "/api/sms/send", { phone: "+353830000001", content: "收到了吗" })).status, 200);
    await sleep(20);
    await write(runtime, "/api/sms/sync", { mode: "full" });
    const thread = (await get(runtime, "/api/sms/thread?key=%2B353830000001")).json["thread"] as { messages: Array<{ content: string; direction: string }> };
    assert.ok(thread.messages.some((m) => m.direction === "in" && m.content.includes("演示页自动回复")), "the reply came in Chinese");
    assert.equal((await write(runtime, "/api/sms/read", { threadKey: "+353830000001" })).status, 200);
    const uid = thread.messages.find((m) => m.direction === "in") as { uid?: string } | undefined;
    assert.ok(uid?.uid);
    assert.equal((await write(runtime, "/api/sms/delete", { uids: [uid.uid] })).status, 200);
    runtime.router.pushOtp();
    await write(runtime, "/api/sms/sync", { mode: "full" });
    assert.equal(await codes(), before + 1, "a new one-time code came in");
  });

  it("runs another Huawei model's generic writes on its household: mobile data, a reboot, a reply in English", async () => {
    const { runtime, clock } = await demo("other");
    assert.equal((await write(runtime, "/api/control/band-lock", { lteBands: [3] })).status, 200);
    assert.equal((await write(runtime, "/api/control/mobile-data", { enabled: false })).status, 200);
    runtime.router.advance();
    let t = await telemetry(runtime);
    assert.deepEqual([t.device.connectionStatus, t.traffic.downloadBytesPerSec], ["902", 0]);
    assert.equal((await write(runtime, "/api/control/mobile-data", { enabled: true })).status, 200);
    runtime.router.advance();
    t = await telemetry(runtime);
    assert.ok(t.traffic.downloadBytesPerSec > 0);
    assert.equal((await write(runtime, "/api/sms/send", { phone: "+353830000001", content: "Home soon" })).status, 200);
    await sleep(20);
    await write(runtime, "/api/sms/sync", { mode: "full" });
    const thread = (await get(runtime, "/api/sms/thread?key=%2B353830000001")).json["thread"] as { messages: Array<{ content: string }> };
    assert.ok(thread.messages.some((m) => m.content.includes("automatic demo reply")));
    runtime.router.pushOtp();
    assert.equal((await write(runtime, "/api/control/reconnect")).status, 200);
    assert.equal((await write(runtime, "/api/control/reboot")).status, 200);
    await assert.rejects(runtime.router.fetchImpl("http://192.168.8.1/api/monitoring/status"), /fetch failed/);
    clock.ms += REBOOT_OFFLINE_MS + 1;
  });

  it("moves the ZTE router's cells under its own locks, runs its battery, stops traffic without data and reboots", async () => {
    const { runtime, clock } = await demo("zte");
    assert.equal((await write(runtime, "/api/control/band-lock", { lteBands: [3], nrBands: [78] })).status, 200);
    let t = await telemetry(runtime);
    assert.deepEqual([t.rf.pccBand, t.lock.issues], ["B3", []]);
    assert.equal((await write(runtime, "/api/control/cell-lock", { rat: "LTE", band: "B20", arfcn: 6300, pci: 133 })).status, 200);
    t = await telemetry(runtime);
    assert.equal(t.rf.pccBand, "B20");
    assert.equal((await write(runtime, "/api/control/cell-lock", { rat: "NR", band: "N78", arfcn: 636666, pci: 88 })).status, 200);
    assert.equal((await write(runtime, "/api/control/unlock")).status, 200);
    t = await telemetry(runtime);
    assert.equal(t.rf.pccBand, "B1");
    for (let i = 0; i < 200; i++) runtime.router.advance();
    const status = ((await get(runtime, "/api/telemetry")).json["telemetry"] as { status: { battery: { percent: number | null } | null } }).status;
    assert.ok(status.battery?.percent !== null);
    assert.equal((await write(runtime, "/api/control/mobile-data", { enabled: false })).status, 200);
    runtime.router.advance();
    t = await telemetry(runtime);
    assert.equal(t.traffic.downloadBytesPerSec, 0);
    assert.equal((await write(runtime, "/api/control/mobile-data", { enabled: true })).status, 200);
    assert.equal((await write(runtime, "/api/sms/send", { phone: "+353830000001", content: "On my way" })).status, 200);
    await sleep(20);
    runtime.router.pushOtp();
    await write(runtime, "/api/sms/sync", { mode: "full" });
    const thread = (await get(runtime, "/api/sms/thread?key=%2B353830000001")).json["thread"] as { messages: Array<{ content: string }> };
    assert.ok(thread.messages.some((m) => m.content.includes("automatic demo reply")));
    assert.equal((await write(runtime, "/api/control/reboot")).status, 200);
    await assert.rejects(runtime.router.fetchImpl("http://192.168.0.1/goform/goform_get_cmd_process?cmd=loginfo"), /fetch failed/);
    clock.ms += REBOOT_OFFLINE_MS + 1;
  });

  it("starts the household's own clock: a step every 5 s and a code now and then, stopped with the page", async () => {
    const dir = tempDir("fengsui-demo-runtime-");
    const runtime = await startDemoRuntime({ world: "other", dataDir: dir });
    await runtime.stop();
    removeTempDir(dir);
    // A router answers slower once the page has started (the latency it skipped while starting)
    const router = createDemoRouter();
    router.setLatencyScale(-1);
    const started = Date.now();
    await router.fetchImpl("http://192.168.8.1/api/user/state-login");
    assert.ok(Date.now() - started < 1000);
    const aborted = new AbortController();
    router.setLatencyScale(1000);
    const slow = router.fetchImpl("http://192.168.8.1/api/user/state-login", { signal: aborted.signal });
    aborted.abort(new Error("gone"));
    await assert.rejects(slow, /gone/);
  });
});

describe("the demo household's radio and rhythm", () => {
  it("serves from the strongest allowed cell, its carrier pair, a far cell on a band without one, and the locked cell", () => {
    assert.deepEqual(servingFor(UNLOCKED, UNLOCKED), { lte: HOUSEHOLD_LTE[0], lteScc: [HOUSEHOLD_LTE[1]], nr: HOUSEHOLD_NR[0] });
    assert.deepEqual(servingFor({ kind: "bands", bands: [3] }, null).lteScc, []);
    assert.equal(servingFor({ kind: "bands", bands: [3] }, null).nr, null);
    const far = servingFor({ kind: "bands", bands: [28] }, { kind: "bands", bands: [41] });
    assert.deepEqual([far.lte.band, far.lte.arfcn, far.lte.offsetDb, far.nr?.band], [28, 9435, -18, 41]);
    assert.equal(servingFor({ kind: "bands", bands: [99] }, { kind: "bands", bands: [] }).lte.arfcn, 0);
    assert.equal(servingFor({ kind: "bands", bands: [] }, { kind: "bands", bands: [] }).nr, null);
    assert.deepEqual(servingFor({ kind: "cell", band: 20, arfcn: 6300, pci: 133 }, { kind: "cell", band: 78, arfcn: 636666, pci: null }), { lte: HOUSEHOLD_LTE[2], lteScc: [], nr: HOUSEHOLD_NR[1] });
    assert.equal(servingFor({ kind: "cell", band: 3, arfcn: 1300, pci: 7 }, UNLOCKED).lte.pci, 7);
    assert.equal(dbm(-87.04), "-87");
    assert.equal(dbm(-87.06), "-87.1");
  });

  it("follows the household's day, fills the history with the same curve, and leaves out what a router lacks", () => {
    const base = { lteRsrpDbm: -90, lteRsrqDb: -9, lteSinrDb: 12, lteRssiDbm: -65, nr: null, temperatureCelsius: null };
    const night = new Date();
    night.setHours(3, 0, 0, 0);
    const evening = new Date();
    evening.setHours(21, 0, 0, 0);
    assert.ok(activityAt(evening.getTime()) > activityAt(night.getTime()) * 3);
    const sample = worldSample(evening.getTime(), base, () => 0.5);
    assert.deepEqual([sample.nrRsrpDbm, sample.temperatureCelsius], [null, null]);
    assert.equal(seriesInput(sample).downloadBps, sample.downloadBytesPerSec * 8);
    const warm = worldSample(evening.getTime(), { ...base, nr: { rsrpDbm: -95, rsrqDb: -10, sinrDb: 9 }, temperatureCelsius: 45 }, () => 0.5);
    assert.ok(warm.nrRsrpDbm !== null && warm.temperatureCelsius !== null);
    const series = new TimeSeriesRingBuffer();
    backfillHistory(series, base, Date.now(), Math.random);
    const day = series.query({ preset: "24h", nowMs: Date.now() });
    assert.ok(day.points.length > 100 && TICK_MS === 5_000);
  });
});
