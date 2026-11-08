import assert from "node:assert/strict";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { createFengSuiCore, stopFengSuiCore } from "../src/core.ts";
import { CpeApiError, HuaweiCpeClient } from "../src/cpe-client.ts";
import { CpeControlValidationError, type GlobalTelemetrySnapshot } from "../src/cpe-domain.ts";
import { CONTROL_FEATURES, type ControlAction, type WriteFeature, type WriteResultRecord, isWriteResultRecord } from "../src/device-access.ts";
import { StorageCipher } from "../src/encrypted-file.ts";
import { type ControlAppliedEvent, type ControlAuditEvent, DeviceReadOnlyError } from "../src/scheduler.ts";
import { ContactBook } from "../src/sms/contacts.ts";
import { SmsMirrorStore } from "../src/sms/mirror.ts";
import { SmsService } from "../src/sms/service.ts";
import { type AlertEventRecord, EncryptedStateStore } from "../src/state-store.ts";
import { TimeSeriesRingBuffer } from "../src/timeseries.ts";
import { type FamilySms, type FamilyWrites, blockNetwork, createCpeFamily } from "./helpers/cpe-family.ts";
import { createStrictCpe } from "./helpers/strict-cpe.ts";
import { removeTempDir, tempDir } from "./helpers/temp-dir.ts";

/**
 * Multi-model phase 3: on a model nobody verified, the write gate opens a write only when its owner
 * consented to that feature for that model, and then the write goes the generic way (appendix A.11),
 * is read back, recorded without any value and alerted on when the read-back differs. Everything
 * else stays refused before any session; the H168-383 needs no consent and writes as it always did.
 * Mocks and placeholders only, no network.
 */

const MODEL = "B535-232";
/** B1/B3/B7/B8/B20/B32 and B66, a band the H168-383 does not have. */
const ADVERTISED_MASK = "200000000800800C5";
const ENDPOINTS: Readonly<Record<string, string>> = {
  "/api/net/net-mode-list": `<response><LTEBandList><LTEBand><Name>LTE</Name><Value>${ADVERTISED_MASK}</Value></LTEBand></LTEBandList></response>`,
  "/api/net/net-mode": `<response><NetworkMode>00</NetworkMode><NetworkBand>3FFFFFFF</NetworkBand><LTEBand>${ADVERTISED_MASK}</LTEBand></response>`,
  "/api/monitoring/traffic-statistics": "<response><CurrentConnectTime>3600</CurrentConnectTime></response>",
};
const MAILBOX: ReadonlyArray<FamilySms> = [
  { index: 40001, phone: "+353830000001", content: "Dinner at 7?", date: "2026-11-02 18:00:00", smstat: "0", box: 1 },
  { index: 40002, phone: "DemoBank", content: "Your DemoBank code is 482913", date: "2026-11-02 19:00:00", smstat: "0", box: 1 },
  { index: 39001, phone: "+353830000001", content: "See you there", date: "2026-11-02 18:05:00", smstat: "3", box: 2 },
];

function fixture(router: { fetchImpl: typeof fetch; password: string }) {
  const dir = tempDir("fengsui-xgate-");
  const stateStore = new EncryptedStateStore({ filePath: path.join(dir, "state.json"), encryptionKey: "xgate_key" });
  const core = createFengSuiCore({
    client: new HuaweiCpeClient({ cpeUrl: "http://192.168.8.1", cpePassword: router.password, fetchImpl: router.fetchImpl, requestTimeoutMs: 2000 }),
    stateStore,
    timeseries: new TimeSeriesRingBuffer({ retentionHours: 1 }),
    pollIntervalMs: 600_000,
    neighborScanIntervalMs: 600_000,
  });
  core.monitor.init();
  const cipher = StorageCipher.fromSecret("xgate_key");
  const contacts = new ContactBook({ filePath: path.join(dir, "contacts.json"), cipher, defaultCountryCode: "+353" });
  const mirror = new SmsMirrorStore({ filePath: path.join(dir, "sms.json"), cipher, defaultCountryCode: "+353", contacts });
  const sms = new SmsService({ scheduler: core.scheduler, monitor: core.monitor, mirror, contacts, defaultCountryCode: "+353", sleep: async () => undefined });
  const audits: ControlAuditEvent[] = [];
  const applied: ControlAppliedEvent[] = [];
  const alerts: AlertEventRecord[] = [];
  core.scheduler.on("control:audit", (event: ControlAuditEvent) => audits.push(event));
  core.scheduler.on("control:applied", (event: ControlAppliedEvent) => applied.push(event));
  core.scheduler.on("alert", (alert: AlertEventRecord) => alerts.push(alert));
  return {
    core,
    sms,
    audits,
    applied,
    alerts,
    consent: (...features: WriteFeature[]) => core.scheduler.device.setConsents(features.map((feature) => ({ model: MODEL, feature }))),
    cleanup: async () => {
      await sms.stop();
      await stopFengSuiCore(core);
      removeTempDir(dir);
    },
  };
}

type Fixture = ReturnType<typeof fixture>;

async function identified(writes: FamilyWrites = {}) {
  const cpe = createCpeFamily({ login: "sha256", tokenFlow: "token", model: MODEL, firmware: "11.0.1.2(H7SP2C00)", endpoints: ENDPOINTS, sms: MAILBOX, writes });
  const fx = fixture(cpe);
  assert.ok(await fx.core.monitor.identifyDevice());
  assert.ok(await fx.sms.sync("full"));
  return { cpe, fx };
}

const unread = (fx: Fixture): string[] => fx.sms.mirror.list().filter((m) => m.isUnread).map((m) => m.uid);

/** Every write the scheduler runs, through the service an adapter calls. */
const WRITES: ReadonlyArray<[ControlAction, (fx: Fixture) => Promise<unknown>]> = [
  ["lock_band", (fx) => fx.core.controls.lockBands({ lteBands: [1, 3] })],
  ["lock_cell", (fx) => fx.core.controls.lockCell({ rat: "LTE", band: 1, arfcn: 100, pci: 1 })],
  ["unlock_rf_locks", (fx) => fx.core.controls.unlockAllLocks()],
  ["auto_unlock_rf_locks", (fx) => fx.core.controls.rollBackLocks(fx.core.controls.getPersistedLockState().updatedAtIso)],
  ["reboot_cpe", (fx) => fx.core.controls.rebootRouter({ confirm: true })],
  ["reconnect_cellular", (fx) => fx.core.controls.reconnectCellular()],
  ["auto_reconnect_cellular", (fx) => fx.core.controls.reconnectWan()],
  ["set_security_switches", (fx) => fx.core.controls.setSecuritySwitches({ upnpEnabled: false })],
  ["set_wifi7_mlo", (fx) => fx.core.controls.setWifi7Settings({ mloEnable: false })],
  ["set_antenna_mode", (fx) => fx.core.controls.setAntennaMode("auto")],
  ["set_mobile_data", (fx) => fx.core.controls.setMobileData(false)],
  ["set_wifi_access", (fx) => fx.core.controls.setWifiAccess({ kind: "block", macAddress: "02:00:5E:10:00:03", name: "phone" }, { requesterIp: null, confirm: true })],
  [
    "manage_time_rule",
    (fx) =>
      fx.core.controls.manageTimeRule(
        { kind: "create", rule: { macAddress: "02:00:5E:10:00:03", name: "phone", weekMask: "1111100", startTime: "07:00", endTime: "21:00" } },
        { requesterIp: null, confirm: true }
      ),
  ],
  ["sms_send", (fx) => fx.sms.send({ phones: ["+353830000001"], content: "gate check", source: "web" })],
  ["sms_mark_read", (fx) => fx.sms.markRead({ uids: unread(fx) })],
  ["sms_delete", (fx) => fx.sms.deleteMessages({ uids: fx.sms.mirror.list().slice(0, 1).map((m) => m.uid) })],
];

const refused = (action: ControlAction) => (err: unknown) => err instanceof DeviceReadOnlyError && err.feature === CONTROL_FEATURES[action] && err.model === MODEL;

const posts = (cpe: ReturnType<typeof createCpeFamily>): string[] => cpe.stats.writes.map((w) => `${w.path} ${w.body.replace(/^<\?xml[^>]*\?>/, "")}`);

const blockedFetch: typeof fetch = async () => {
  throw new Error("no router in this test");
};

let restore: () => void;
before(() => {
  restore = blockNetwork();
});
after(() => restore());

describe("experimental gate: without a consent", () => {
  it("refuses every write, those FengSui could do here too, before any session: the router gets no write", async () => {
    const { cpe, fx } = await identified();
    try {
      const { features } = fx.core.scheduler.getStatus().device;
      assert.deepEqual([features.bandLock, features.reboot, features.reconnect, features.mobileData, features.smsWrite], ["available", "available", "available", "available", "available"]);
      const sent = cpe.stats.requests.length;
      for (const [action, run] of WRITES) await assert.rejects(run(fx), refused(action), action);
      assert.deepEqual(cpe.stats.writes, []);
      assert.equal(cpe.stats.requests.length, sent, "not even a login");
      assert.deepEqual(fx.core.scheduler.genericWrites, [], "nothing to record");
    } finally {
      await fx.cleanup();
    }
  });

  it("has a second line: a write with no generic implementation stops before the H168-383's request, should one ever get past the gate", async () => {
    const { cpe, fx } = await identified();
    try {
      // A gate that let every write through on this model (it never does: these stay not_implemented)
      fx.core.scheduler.device.writeAccess = () => "experimental";
      const verifiedOnly = WRITES.filter(([action]) => ["cellLock", "securitySwitches", "wifi", "antenna", "accessControl"].includes(CONTROL_FEATURES[action]));
      assert.equal(verifiedOnly.length, 6);
      for (const [action, run] of verifiedOnly) {
        await assert.rejects(run(fx), (err) => err instanceof CpeControlValidationError && /has no implementation for a model FengSui was not verified on/.test(err.message), action);
      }
      assert.deepEqual(cpe.stats.writes, [], "the router got no write");
    } finally {
      await fx.cleanup();
    }
  });
});

describe("experimental gate: one consent", () => {
  it("opens that one write, the generic way, and nothing else", async () => {
    const { cpe, fx } = await identified();
    try {
      fx.consent("bandLock");
      const lock = await fx.core.controls.lockBands({ lteBands: ["B66", 1] });
      assert.deepEqual([lock.mode, lock.lteBands, lock.nrBands, lock.cellLock], ["band_lock", [1, 66], [], null]);
      assert.deepEqual(posts(cpe), ["/api/net/net-mode <request><NetworkMode>00</NetworkMode><NetworkBand>3FFFFFFF</NetworkBand><LTEBand>20000000000000001</LTEBand></request>"]);
      assert.deepEqual(fx.core.controls.getPersistedLockState().lteBands, [1, 66]);

      for (const [action, run] of WRITES.filter(([action]) => CONTROL_FEATURES[action] !== "bandLock")) await assert.rejects(run(fx), refused(action), action);
      assert.equal(cpe.stats.writes.length, 1, "no other write reached the router");

      const unlocked = await fx.core.controls.unlockAllLocks();
      assert.deepEqual([unlocked.mode, unlocked.lteBands], ["unlocked", "all"]);
      assert.equal(posts(cpe).at(-1), "/api/net/net-mode <request><NetworkMode>00</NetworkMode><NetworkBand>3FFFFFFF</NetworkBand><LTEBand>7fffffffffffffff</LTEBand></request>");
      assert.ok(!cpe.stats.writes.some((w) => w.path === "/api/net/lock-freq"), "never the H168-383's lock-freq");

      const records = fx.core.scheduler.genericWrites;
      assert.deepEqual(
        records.map((r) => [r.action, r.feature, r.model, r.endpoints, r.outcome, r.code, r.readback, r.reason]),
        [
          ["lock_band", "bandLock", MODEL, ["/api/net/net-mode"], "applied", null, "match", null],
          ["unlock_rf_locks", "bandLock", MODEL, ["/api/net/net-mode"], "applied", null, "match", null],
        ]
      );
      const json = JSON.stringify(records);
      for (const value of ["20000000000000001", "7fffffffffffffff", "3FFFFFFF", '"66"', "B66"]) assert.ok(!json.includes(value), `no payload value: ${value}`);
      assert.match(fx.audits.find((a) => a.action === "lock_band" && a.outcome === "applied")?.detail ?? "", /experimental.*read back: match/);
      assert.deepEqual(fx.applied.find((e) => e.action === "lock_band")?.check, { endpoints: ["/api/net/net-mode"], readback: "match", reason: null });
      assert.match(fx.applied.find((e) => e.action === "lock_band")?.summaryEn ?? "", /experimental/);
    } finally {
      await fx.cleanup();
    }
  });

  it("refuses a band net-mode-list does not advertise, an NR band and a cell lock before any session", async () => {
    const { cpe, fx } = await identified();
    try {
      fx.consent("bandLock", "cellLock" as WriteFeature);
      const sent = cpe.stats.requests.length;
      await assert.rejects(fx.core.controls.lockBands({ lteBands: [28] }), CpeControlValidationError, "B28 is the H168-383's, not this router's");
      await assert.rejects(fx.core.controls.lockBands({ lteBands: [2] }), CpeControlValidationError);
      await assert.rejects(fx.core.controls.lockBands({ nrBands: ["N78"] }), CpeControlValidationError);
      await assert.rejects(fx.core.controls.lockBands({ lteBands: [1], nrBands: "all" }), CpeControlValidationError);
      await assert.rejects(fx.core.controls.lockCell({ rat: "LTE", band: 1, arfcn: 100, pci: 1 }), refused("lock_cell"), "a consent for an unimplemented write opens nothing");
      assert.equal(cpe.stats.requests.length, sent);
      assert.deepEqual(cpe.stats.writes, []);
    } finally {
      await fx.cleanup();
    }
  });

  it("closes again at once when it is turned off or the router turns out to be another model", async () => {
    const { cpe, fx } = await identified();
    try {
      fx.consent("mobileData");
      await fx.core.controls.setMobileData(false);
      fx.consent();
      await assert.rejects(fx.core.controls.setMobileData(true), refused("set_mobile_data"));
      fx.consent("mobileData");
      fx.core.scheduler.noteRouterModel("E5576-320", null);
      await assert.rejects(fx.core.controls.setMobileData(true), (err) => err instanceof DeviceReadOnlyError && err.model === "E5576-320");
      assert.equal(cpe.stats.writes.length, 1);
    } finally {
      await fx.cleanup();
    }
  });
});

describe("experimental gate: every generic write", () => {
  const cases: ReadonlyArray<{ feature: WriteFeature; action: ControlAction; run: (fx: Fixture) => Promise<unknown>; post: RegExp; readback: string }> = [
    { feature: "mobileData", action: "set_mobile_data", run: (fx) => fx.core.controls.setMobileData(false), post: /^\/api\/dialup\/mobile-dataswitch <request><dataswitch>0<\/dataswitch><\/request>$/, readback: "match" },
    { feature: "reconnect", action: "reconnect_cellular", run: (fx) => fx.core.controls.reconnectCellular(), post: /^\/api\/net\/reconnect <request><ReconnectAction>1<\/ReconnectAction><\/request>$/, readback: "pending" },
    { feature: "reboot", action: "reboot_cpe", run: (fx) => fx.core.controls.rebootRouter({ confirm: true }), post: /^\/api\/device\/control <request><Control>1<\/Control><\/request>$/, readback: "pending" },
    { feature: "smsWrite", action: "sms_send", run: (fx) => fx.sms.send({ phones: ["+353830000002"], content: "On my way", source: "web" }), post: /^\/api\/sms\/send-sms <request><Index>-1<\/Index><Phones><Phone>\+353830000002<\/Phone><\/Phones><Sca><\/Sca><Content>On my way<\/Content><Length>9<\/Length><Reserved>1<\/Reserved><Date>[\d :-]+<\/Date><\/request>$/, readback: "match" },
    { feature: "smsWrite", action: "sms_mark_read", run: (fx) => fx.sms.markRead({ uids: unread(fx).slice(0, 1) }), post: /^\/api\/sms\/set-read <request><Index>4000[12]<\/Index><\/request>$/, readback: "match" },
    { feature: "smsWrite", action: "sms_delete", run: (fx) => fx.sms.deleteMessages({ uids: fx.sms.mirror.list().filter((m) => m.index === 39001).map((m) => m.uid) }), post: /^\/api\/sms\/delete-sms <request><Index>39001<\/Index><\/request>$/, readback: "match" },
  ];

  for (const c of cases) {
    it(`${c.action}: the reference form, read back, recorded`, async () => {
      const { cpe, fx } = await identified();
      try {
        fx.consent(c.feature);
        await c.run(fx);
        assert.equal(cpe.stats.writes.length, 1);
        assert.match(posts(cpe)[0] ?? "", c.post);
        const record = fx.core.scheduler.genericWrites.at(-1);
        assert.deepEqual([record?.action, record?.outcome, record?.readback], [c.action, "applied", c.readback]);
        assert.deepEqual(fx.alerts.filter((a) => a.code === "WRITE_READBACK_MISMATCH"), []);
      } finally {
        await fx.cleanup();
      }
    });
  }

  it("alerts when the read-back differs, and names neither value nor content", async () => {
    const { fx } = await identified({ ignore: true });
    try {
      fx.consent("bandLock", "mobileData", "smsWrite");
      await fx.core.controls.lockBands({ lteBands: [3] });
      await fx.core.controls.setMobileData(false);
      await fx.sms.deleteMessages({ uids: fx.sms.mirror.list().filter((m) => m.index === 39001).map((m) => m.uid) });
      assert.deepEqual(
        fx.core.scheduler.genericWrites.map((r) => [r.action, r.readback, r.reason]),
        [
          ["lock_band", "mismatch", "differs"],
          ["set_mobile_data", "mismatch", "differs"],
          ["sms_delete", "mismatch", "no_change"],
        ]
      );
      const mismatches = fx.alerts.filter((a) => a.code === "WRITE_READBACK_MISMATCH");
      assert.equal(mismatches.length, 3);
      assert.ok(mismatches.every((a) => a.severity === "warning" && a.messageEn.includes(MODEL) && !/\+3538|See you|B3\b/.test(`${a.messageZh}${a.messageEn}`)));
      assert.equal(fx.applied.find((e) => e.action === "lock_band")?.check?.readback, "mismatch");
    } finally {
      await fx.cleanup();
    }
  });

  it("never retries: a refused write is one request, recorded with the router's code", async () => {
    const { cpe, fx } = await identified({ errors: { "/api/net/net-mode": "100003", "/api/device/control": "100002" } });
    try {
      fx.consent("bandLock", "reboot");
      await assert.rejects(fx.core.controls.lockBands({ lteBands: [1] }), (err) => err instanceof CpeApiError && err.code === "100003");
      await assert.rejects(fx.core.controls.rebootRouter({ confirm: true }), (err) => err instanceof CpeApiError && err.code === "100002");
      assert.deepEqual(cpe.stats.writes.map((w) => w.path), ["/api/net/net-mode", "/api/device/control"], "one request each");
      assert.deepEqual(
        fx.core.scheduler.genericWrites.map((r) => [r.action, r.endpoints, r.outcome, r.code, r.readback]),
        [
          ["lock_band", ["/api/net/net-mode"], "failed", "100003", "none"],
          ["reboot_cpe", ["/api/device/control"], "failed", "100002", "none"],
        ]
      );
      assert.ok(fx.audits.filter((a) => a.outcome === "failed").length === 2);
    } finally {
      await fx.cleanup();
    }
  });

  it("keeps only a router code that is a code: router text in its place is not recorded", async () => {
    const { cpe, fx } = await identified({ errors: { "/api/dialup/mobile-dataswitch": "busy 860000000000000", "/api/device/control": "860000000000000" } });
    try {
      fx.consent("mobileData", "reboot");
      await assert.rejects(fx.core.controls.setMobileData(false), CpeApiError);
      await assert.rejects(fx.core.controls.rebootRouter({ confirm: true }), CpeApiError);
      assert.equal(cpe.stats.writes.length, 2, "one request each");
      const kept = fx.core.scheduler.genericWrites;
      assert.deepEqual(kept.map((r) => [r.action, r.outcome, r.code]), [
        ["set_mobile_data", "failed", null],
        ["reboot_cpe", "failed", null],
      ]);
      // What this version stores, it can read back after a restart
      assert.ok(kept.every(isWriteResultRecord));
    } finally {
      await fx.cleanup();
    }
  });

  it("repairs the WAN the generic way once the owner consented, and stays refused otherwise", async () => {
    const { cpe, fx } = await identified();
    try {
      cpe.setConnectionStatus("902");
      await assert.rejects(fx.core.controls.rollBackLocks(fx.core.controls.getPersistedLockState().updatedAtIso), refused("auto_unlock_rf_locks"));
      await assert.rejects(fx.core.controls.reconnectWan(), refused("auto_reconnect_cellular"));
      fx.consent("bandLock", "reconnect");
      assert.deepEqual(await fx.core.controls.rollBackLocks(fx.core.controls.getPersistedLockState().updatedAtIso), { applied: true, lockState: fx.core.controls.getPersistedLockState() });
      assert.deepEqual(await fx.core.controls.reconnectWan(), { applied: true });
      assert.deepEqual(posts(cpe), [
        "/api/net/net-mode <request><NetworkMode>00</NetworkMode><NetworkBand>3FFFFFFF</NetworkBand><LTEBand>7fffffffffffffff</LTEBand></request>",
        "/api/net/reconnect <request><ReconnectAction>1</ReconnectAction></request>",
      ]);
      cpe.setConnectionStatus("901");
      assert.deepEqual(await fx.core.controls.reconnectWan(), { applied: false, skipped: "wan_up" });
      assert.equal(cpe.stats.writes.length, 2, "a WAN that came back is left alone");
    } finally {
      await fx.cleanup();
    }
  });
});

describe("experimental gate: a redial and a reboot are checked by the polls that follow", () => {
  const poll = (record: WriteResultRecord, afterSec: number, parts: { uptime?: number; connect?: number | null; wan?: string }): GlobalTelemetrySnapshot =>
    ({
      capturedAtMs: Date.parse(record.atIso) + afterSec * 1000,
      device: { uptimeSec: parts.uptime ?? 0, connectionStatus: parts.wan ?? "901" },
      traffic: { sessionConnectTimeSec: parts.connect ?? 0 },
      unavailable: parts.connect === null ? ["traffic"] : [],
    }) as unknown as GlobalTelemetrySnapshot;

  it("calls a reboot done when the uptime starts again, and alerts when the router kept running", async () => {
    const { fx } = await identified();
    try {
      fx.consent("reboot");
      await fx.core.controls.rebootRouter({ confirm: true });
      const first = fx.core.scheduler.genericWrites.at(-1) as WriteResultRecord;
      fx.core.scheduler.notePollForWrites(poll(first, 30, { uptime: 100_000 }));
      assert.equal(fx.core.scheduler.genericWrites.at(-1)?.readback, "pending", "too early to tell");
      fx.core.scheduler.notePollForWrites(poll(first, 95, { uptime: 40 }));
      assert.deepEqual([fx.core.scheduler.genericWrites.at(-1)?.readback, fx.core.scheduler.genericWrites.at(-1)?.reason], ["match", null]);

      await fx.core.controls.rebootRouter({ confirm: true });
      const second = fx.core.scheduler.genericWrites.at(-1) as WriteResultRecord;
      fx.core.scheduler.notePollForWrites(poll(second, 200, { uptime: 100_200 }));
      assert.deepEqual([fx.core.scheduler.genericWrites.at(-1)?.readback, fx.core.scheduler.genericWrites.at(-1)?.reason], ["mismatch", "no_restart"]);
      assert.equal(fx.alerts.filter((a) => a.code === "WRITE_READBACK_MISMATCH").length, 1);
    } finally {
      await fx.cleanup();
    }
  });

  it("calls a redial done when the connection starts again, and unknown when no poll could tell", async () => {
    const { fx } = await identified();
    try {
      fx.consent("reconnect");
      await fx.core.controls.reconnectCellular();
      const redial = fx.core.scheduler.genericWrites.at(-1) as WriteResultRecord;
      fx.core.scheduler.notePollForWrites(poll(redial, 20, { connect: 5, wan: "902" }));
      assert.equal(fx.core.scheduler.genericWrites.at(-1)?.readback, "pending", "not back yet");
      fx.core.scheduler.notePollForWrites(poll(redial, 40, { connect: 12 }));
      assert.equal(fx.core.scheduler.genericWrites.at(-1)?.readback, "match");

      await fx.core.controls.reconnectCellular();
      const blind = fx.core.scheduler.genericWrites.at(-1) as WriteResultRecord;
      fx.core.scheduler.notePollForWrites(poll(blind, 300, { connect: null }));
      assert.equal(fx.core.scheduler.genericWrites.at(-1)?.readback, "pending");
      fx.core.scheduler.notePollForWrites(poll(blind, 16 * 60, { connect: null }));
      assert.deepEqual([fx.core.scheduler.genericWrites.at(-1)?.readback, fx.core.scheduler.genericWrites.at(-1)?.reason], ["unknown", "no_evidence"]);
      assert.deepEqual(fx.alerts.filter((a) => a.code === "WRITE_READBACK_MISMATCH"), [], "no evidence is not a mismatch");
    } finally {
      await fx.cleanup();
    }
  });

  it("takes a connection time of 0 for no evidence: traffic statistics without CurrentConnectTime read as 0", async () => {
    const { fx } = await identified();
    try {
      fx.consent("reconnect", "reboot");
      await fx.core.controls.reconnectCellular();
      const redial = fx.core.scheduler.genericWrites.at(-1) as WriteResultRecord;
      fx.core.scheduler.notePollForWrites(poll(redial, 30, { connect: 0 }));
      assert.equal(fx.core.scheduler.genericWrites.at(-1)?.readback, "pending", "a counter at 0 may be one the router never named");
      fx.core.scheduler.notePollForWrites(poll(redial, 5 * 60, { connect: 0 }));
      assert.equal(fx.core.scheduler.genericWrites.at(-1)?.readback, "pending", "nor does it show the redial did not happen");
      fx.core.scheduler.notePollForWrites(poll(redial, 16 * 60, { connect: 0 }));
      assert.deepEqual([fx.core.scheduler.genericWrites.at(-1)?.readback, fx.core.scheduler.genericWrites.at(-1)?.reason], ["unknown", "no_evidence"]);

      // A reboot on a model naming no uptime falls back to the connection time, with the same rule
      await fx.core.controls.rebootRouter({ confirm: true });
      const reboot = fx.core.scheduler.genericWrites.at(-1) as WriteResultRecord;
      fx.core.scheduler.notePollForWrites(poll(reboot, 90, { uptime: 0, connect: 0 }));
      assert.equal(fx.core.scheduler.genericWrites.at(-1)?.readback, "pending");
      fx.core.scheduler.notePollForWrites(poll(reboot, 95, { uptime: 0, connect: 20 }));
      assert.equal(fx.core.scheduler.genericWrites.at(-1)?.readback, "match", "a counter that started again still counts");
      assert.deepEqual(fx.alerts.filter((a) => a.code === "WRITE_READBACK_MISMATCH"), []);
    } finally {
      await fx.cleanup();
    }
  });
});

describe("experimental gate: the results kept", () => {
  it("keeps the last 20 across a restart and drops one it cannot read", async () => {
    const dir = tempDir("fengsui-xresults-");
    try {
      const file = path.join(dir, "state.json");
      const valid = (i: number): WriteResultRecord => ({
        id: `id-${i}`,
        atIso: new Date(Date.UTC(2026, 10, 3, 8, 0, i)).toISOString(),
        action: "set_mobile_data",
        feature: "mobileData",
        model: MODEL,
        endpoints: ["/api/dialup/mobile-dataswitch"],
        outcome: "applied",
        code: null,
        readback: "match",
        reason: null,
      });
      const store = new EncryptedStateStore({ filePath: file, encryptionKey: "results_key" });
      const odd = [
        { ...valid(90), action: "rm_rf" },
        { ...valid(91), feature: "reboot" },
        { ...valid(92), endpoints: ["https://cpe.example.com/x"] },
        { ...valid(93), code: "8935301000000000000x" },
        { ...valid(94), readback: "great" },
        { ...valid(95), reason: "because" },
        { ...valid(96), outcome: "maybe" },
        "nonsense",
      ];
      store.update({ genericWrites: [...Array.from({ length: 25 }, (_, i) => valid(i)), ...(odd as unknown as WriteResultRecord[])] });
      await store.flushAsync();
      const loaded = new EncryptedStateStore({ filePath: file, encryptionKey: "results_key" }).load();
      assert.deepEqual(loaded.genericWrites.map((r) => r.id), Array.from({ length: 20 }, (_, i) => `id-${i + 5}`));
    } finally {
      removeTempDir(dir);
    }
  });
});

describe("experimental gate: a check left pending by a restart", () => {
  it("is closed as unknown at the next start: no poll of the old run can decide it any more", async () => {
    const dir = tempDir("fengsui-xpending-");
    try {
      const file = path.join(dir, "state.json");
      const pending: WriteResultRecord = { id: "p1", atIso: "2026-11-03T08:00:00.000Z", action: "reboot_cpe", feature: "reboot", model: MODEL, endpoints: ["/api/device/control"], outcome: "applied", code: null, readback: "pending", reason: null };
      const done: WriteResultRecord = { ...pending, id: "d1", action: "set_mobile_data", feature: "mobileData", endpoints: ["/api/dialup/mobile-dataswitch"], readback: "match" };
      const before = new EncryptedStateStore({ filePath: file, encryptionKey: "pending_key" });
      before.update({ genericWrites: [pending, done] });
      await before.flushAsync();
      const stateStore = new EncryptedStateStore({ filePath: file, encryptionKey: "pending_key" });
      const core = createFengSuiCore({ client: new HuaweiCpeClient({ cpeUrl: "http://192.168.8.1", cpePassword: "x", fetchImpl: blockedFetch }), stateStore, timeseries: new TimeSeriesRingBuffer({ retentionHours: 1 }) });
      core.monitor.init();
      assert.deepEqual(
        core.scheduler.genericWrites.map((r) => [r.id, r.readback, r.reason]),
        [
          ["p1", "unknown", "no_evidence"],
          ["d1", "match", null],
        ]
      );
      await stopFengSuiCore(core);
    } finally {
      removeTempDir(dir);
    }
  });
});

describe("experimental gate: the H168-383", () => {
  it("writes as it always did, with no consent and nothing recorded", async () => {
    const cpe = createStrictCpe();
    const fx = fixture(cpe);
    try {
      assert.ok(await fx.core.monitor.identifyDevice());
      assert.deepEqual(new Set(Object.values(fx.core.scheduler.getStatus().device.features)), new Set(["verified"]));
      await fx.core.controls.lockBands({ lteBands: [1, 3], nrBands: ["N78"] });
      await fx.core.controls.setMobileData(true);
      await fx.core.controls.reconnectCellular();
      assert.deepEqual(fx.core.scheduler.genericWrites, []);
      assert.ok(fx.applied.every((e) => e.check === undefined), "no read-back of its own on the verified model");
      assert.ok(fx.audits.every((a) => !/experimental/.test(a.detail ?? "")));
    } finally {
      await fx.cleanup();
    }
  });
});
