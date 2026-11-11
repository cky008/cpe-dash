import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import type { ApiErrorEnvelope, AuditResponse, ExperimentalWritesResponse } from "../src/api-contract.ts";
import { type FengSuiRuntimeStack, createFengSuiRuntime } from "../src/cli.ts";
import { loadConfig } from "../src/config.ts";
import { ConsoleSettings, MAX_DISABLED_WRITES } from "../src/console-settings.ts";
import { CONTROL_FEATURES, DeviceAccess, WRITE_FEATURES, gateRefuses } from "../src/device-access.ts";
import { type DeviceProbeResult, type ProbeSession, probeDevice } from "../src/device-profile.ts";
import { StorageCipher } from "../src/encrypted-file.ts";
import { type FamilySms, createCpeFamily } from "./helpers/cpe-family.ts";
import { removeTempDir, tempDir } from "./helpers/temp-dir.ts";

/**
 * On a model nobody verified, the writes FengSui implements for the router are on by default, and
 * its owner turns them off one feature at a time. What is off is kept encrypted per model and
 * feature, only a console session changes it (tokens get 403 CONSOLE_ONLY), both directions are
 * audited, and an entry counts only for the model it was made on. Mocks and placeholders only.
 */

const NOW = "2026-11-03T08:00:00.000Z";

/** What the B535-232 of the demo world answers to the identification (placeholders only). */
const B535_ANSWERS: Readonly<Record<string, string>> = {
  "/api/net/net-mode-list": "<response><LTEBandList><LTEBand><Name>LTE BC1/BC3/BC7/BC8/BC20/BC32</Name><Value>800800C5</Value></LTEBand></LTEBandList></response>",
  "/api/net/net-mode": "<response><NetworkMode>00</NetworkMode><NetworkBand>3FFFFFFF</NetworkBand><LTEBand>800800C5</LTEBand></response>",
};

const MAILBOX: ReadonlyArray<FamilySms> = [
  { index: 40001, phone: "+353830000001", content: "Dinner at 7?", date: "2026-11-02 18:00:00", smstat: "0", box: 1 },
];

async function probeOf(model: string, extra: Readonly<Record<string, string>> = {}): Promise<DeviceProbeResult> {
  const bodies: Record<string, string> = {
    "/api/device/information": `<response><DeviceName>${model}</DeviceName><SoftwareVersion>11.0.1.2(H7SP2C00)</SoftwareVersion></response>`,
    "/api/dialup/mobile-dataswitch": "<response><dataswitch>1</dataswitch></response>",
    "/api/sms/sms-count": "<response><LocalUnread>1</LocalUnread><LocalInbox>1</LocalInbox></response>",
    ...B535_ANSWERS,
    ...extra,
  };
  const session: ProbeSession = {
    open: true,
    loginScheme: "sha256",
    eccVerified: false,
    tokenFlow: "webserver-token",
    get: async (apiPath) => {
      const body = bodies[apiPath];
      if (body === undefined) throw Object.assign(new Error("[CPE 100002]"), { name: "CpeApiError", code: "100002" });
      return body;
    },
  };
  return await probeDevice(session, { nowIso: NOW, origin: "startup" });
}

describe("experimental switch: the store", () => {
  it("keeps what is off per model and feature, encrypted, and leaves another model's entries alone", async () => {
    const dir = tempDir("fengsui-switch-");
    try {
      const file = path.join(dir, "settings.json");
      const settings = new ConsoleSettings({ filePath: file, cipher: new StorageCipher("switch_key"), now: () => Date.parse(NOW) });
      assert.equal(settings.disabledWrites.length, 0, "nothing is off until its owner says so");
      assert.equal(settings.disableWrite("B535-232", "bandLock"), true);
      assert.equal(settings.disableWrite("B535-232", "bandLock"), false, "off already");
      assert.equal(settings.disableWrite("B535-232", "reboot"), true);
      assert.deepEqual(
        settings.disabledWrites.map((d) => `${d.model}:${d.feature}`),
        ["B535-232:bandLock", "B535-232:reboot"]
      );
      assert.equal(settings.disabledWrites[0]?.disabledAtIso, NOW);
      // Another router: its own entries, and the first router's stay for the day it is back
      settings.disableWrite("E5576-320", "reboot");
      assert.equal(settings.enableWrite("E5576-320", "bandLock"), false, "it was not off on that model");
      assert.equal(settings.enableWrite("B535-232", "reboot"), true);
      assert.equal(settings.enableWrite("B535-232", "reboot"), false);
      assert.deepEqual(
        settings.disabledWrites.map((d) => `${d.model}:${d.feature}`),
        ["B535-232:bandLock", "E5576-320:reboot"]
      );
      // A write a driver family implements is switched like a generic one (a cell lock is no generic write)
      settings.disableWrite("RM520N-GL", "cellLock");
      await settings.flush();

      assert.equal(fs.readFileSync(file, "utf8").includes("B535-232"), false, "encrypted at rest");
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      const again = new ConsoleSettings({ filePath: file, cipher: new StorageCipher("switch_key") });
      again.load();
      assert.deepEqual(again.disabledWrites.map((d) => `${d.model}:${d.feature}`), ["B535-232:bandLock", "E5576-320:reboot", "RM520N-GL:cellLock"]);

      // An entry this version cannot read is dropped, never half-honoured
      const cipher = new StorageCipher("switch_key");
      fs.writeFileSync(
        file,
        cipher.serializeJson({
          format: 1,
          disabledWrites: [
            { model: "B535-232", feature: "reboot", disabledAtIso: NOW },
            { model: "B535-232", feature: "teleport", disabledAtIso: NOW },
            { model: 5, feature: "bandLock", disabledAtIso: NOW },
            { model: "B535-232", feature: "bandLock" },
            { model: "", feature: "bandLock", disabledAtIso: NOW },
            "nonsense",
          ],
        })
      );
      const odd = new ConsoleSettings({ filePath: file, cipher });
      odd.load();
      assert.deepEqual(odd.disabledWrites.map((d) => `${d.model}:${d.feature}`), ["B535-232:reboot"]);

      // The list is bounded: the oldest entries go first
      const many = new ConsoleSettings({ filePath: path.join(dir, "many.json"), cipher });
      for (let i = 0; i < MAX_DISABLED_WRITES + 5; i += 1) many.disableWrite(`MODEL-${i}`, "reboot");
      assert.equal(many.disabledWrites.length, MAX_DISABLED_WRITES);
      assert.equal(many.disabledWrites[0]?.model, "MODEL-5");
    } finally {
      removeTempDir(dir);
    }
  });

  it("reads the settings an earlier version stored: its consents are read past, nothing is off, and the next save drops them", async () => {
    const dir = tempDir("fengsui-switch-old-");
    try {
      const file = path.join(dir, "settings.json");
      const cipher = new StorageCipher("switch_key");
      // What 1.8.3 wrote: the writes its owner had consented to, one model at a time
      fs.writeFileSync(
        file,
        cipher.serializeJson({
          format: 1,
          cpe: { url: "http://192.168.8.1", username: "admin", password: "placeholder-password" },
          telegramReset: false,
          experimental: [
            { model: "B535-232", feature: "bandLock", grantedAtIso: NOW },
            { model: "B535-232", feature: "smsWrite", grantedAtIso: NOW },
          ],
          agentTest: {
            model: "B535-232",
            startedAtIso: NOW,
            sms: true,
            settings: [{ key: "agentWrites", before: null }],
            features: [{ feature: "bandLock", grantedAtIso: NOW }],
            tokens: [],
            lastActivityAtIso: NOW,
            remindedAtIso: null,
            reminderAlertId: null,
            acknowledgedAtIso: null,
          },
        })
      );
      const settings = new ConsoleSettings({ filePath: file, cipher });
      assert.equal(settings.load(), true);
      assert.deepEqual(settings.disabledWrites, [], "a consent is no switch-off: every implemented write is on");
      assert.equal(settings.cpe?.url, "http://192.168.8.1", "the rest of the file is as it was");
      assert.equal(settings.telegramReset, false);
      // The test in progress carries over without the writes it had turned on
      assert.deepEqual(settings.agentTest?.settings, [{ key: "agentWrites", before: null }]);
      assert.equal(Object.hasOwn(settings.agentTest ?? {}, "features"), false);
      settings.disableWrite("B535-232", "reboot");
      await settings.flush();
      const stored = cipher.readJsonFile<Record<string, unknown>>(file);
      assert.equal(Object.hasOwn(stored ?? {}, "experimental"), false, "the old list is gone after a save");
      assert.equal((stored?.["disabledWrites"] as unknown[]).length, 1);
    } finally {
      removeTempDir(dir);
    }
  });
});

describe("experimental switch: what each write is on a router", () => {
  it("lists every write the scheduler runs", () => {
    assert.deepEqual([...new Set(Object.values(CONTROL_FEATURES))].sort(), [...WRITE_FEATURES].sort());
  });

  it("names each write's state from the model, the verified lists, the probe and what its owner turned off", async () => {
    const unknown = new DeviceAccess();
    assert.deepEqual(new Set(WRITE_FEATURES.map((f) => unknown.writeState(f))), new Set(["unknown"]));
    assert.equal(unknown.writeAccess("bandLock"), "unknown");

    const h168 = new DeviceAccess();
    h168.remember("H168-383", "4.4.0.1(H1006SP19C00)");
    h168.noteProbe(await probeOf("H168-383"));
    // Nothing is switched off on a verified model, whatever a list says
    h168.setDisabledWrites([{ model: "H168-383", feature: "reboot" }]);
    assert.deepEqual(new Set(WRITE_FEATURES.map((f) => h168.writeState(f))), new Set(["verified"]));
    assert.equal(h168.writeAccess("smsWrite"), "allowed");
    assert.equal(h168.generic, false);
    assert.equal(h168.snapshot().lteBands, null, "the verified model keeps its own band list");

    const b535 = new DeviceAccess();
    b535.remember("B535-232", "11.0.1.2(H7SP2C00)");
    b535.noteProbe(await probeOf("B535-232"));
    assert.equal(b535.generic, true);
    assert.equal(b535.writes, "experimental");
    // What FengSui implements for the model is on by default; what it does not is not
    assert.deepEqual(b535.snapshot().features, {
      bandLock: "enabled",
      cellLock: "not_implemented",
      reboot: "enabled",
      reconnect: "enabled",
      mobileData: "enabled",
      securitySwitches: "not_implemented",
      wifi: "not_implemented",
      antenna: "not_implemented",
      accessControl: "not_implemented",
      smsWrite: "enabled",
    });
    assert.deepEqual(b535.snapshot().lteBands, [1, 3, 7, 8, 20, 32]);
    assert.deepEqual(
      WRITE_FEATURES.filter((f) => b535.writeAccess(f) === "experimental"),
      ["bandLock", "reboot", "reconnect", "mobileData", "smsWrite"]
    );
    assert.ok(WRITE_FEATURES.filter((f) => b535.writeState(f) === "not_implemented").every((f) => b535.writeAccess(f) === "unavailable"));

    b535.setDisabledWrites([
      { model: "B535-232", feature: "bandLock" },
      { model: "E5576-320", feature: "reboot" },
      { model: "B535-232", feature: "wifi" },
    ]);
    assert.equal(b535.writeState("bandLock"), "disabled");
    assert.equal(b535.writeAccess("bandLock"), "disabled");
    assert.equal(b535.writeState("reboot"), "enabled", "what is off on another model says nothing here");
    assert.equal(b535.writeAccess("reboot"), "experimental");
    assert.equal(b535.writeState("wifi"), "not_implemented", "a write FengSui has nothing for is not one its owner turned off");
    assert.ok(gateRefuses(b535.writeAccess("bandLock")) && gateRefuses(b535.writeAccess("wifi")) && !gateRefuses(b535.writeAccess("reboot")));
    // Taking a lock off goes with the band lock on a HiLink model (it has no cell lock): off with it
    assert.equal(b535.actionAccess("unlock_rf_locks"), "disabled");
    assert.equal(b535.actionAccess("auto_unlock_rf_locks"), "disabled");

    // The router turns out to be another model: the probe of the old one does not count, so nothing is written yet
    b535.see("E5576-320", "21.0");
    assert.equal(b535.writeState("bandLock"), "unsupported");
    assert.equal(b535.writeState("reboot"), "unsupported");
    assert.equal(b535.writeAccess("bandLock"), "unavailable");
    assert.equal(b535.snapshot().lteBands, null);
    // Identified: its own switch-offs apply, the first router's do not
    b535.noteProbe(await probeOf("E5576-320"));
    assert.deepEqual([b535.writeState("bandLock"), b535.writeState("reboot")], ["enabled", "disabled"]);
    // And the first router is, when it is back, as its owner left it
    b535.see("B535-232", "11.0.1.2(H7SP2C00)");
    b535.noteProbe(await probeOf("B535-232"));
    assert.deepEqual([b535.writeState("bandLock"), b535.writeState("reboot")], ["disabled", "enabled"]);

    const lacking = new DeviceAccess();
    lacking.remember("B535-232", null);
    lacking.noteProbe(await probeOf("B535-232", { "/api/dialup/mobile-dataswitch": "<response><x>1</x></response>" }));
    assert.equal(lacking.writeState("mobileData"), "unsupported", "implemented for the family, but this router does not show what the write reads back");
    assert.equal(lacking.writeAccess("mobileData"), "unavailable");
    assert.equal(lacking.writeState("reboot"), "enabled");

    // No identification probe of this model yet (only its name is known): nothing is written on a guess
    const unprobed = new DeviceAccess();
    unprobed.remember("B535-232", null);
    assert.deepEqual(new Set(["bandLock", "reboot", "reconnect", "mobileData", "smsWrite"].map((f) => unprobed.writeState(f as "reboot"))), new Set(["unsupported"]));

    const reported = new DeviceAccess({ verifiedFeatures: [{ family: "huawei", model: "B535-232", softwareVersion: "11.0.1.2(H7SP2C00)", feature: "reboot", access: "write", issue: 12 }] });
    reported.remember("B535-232", null);
    assert.equal(reported.writeState("reboot"), "verified", "a write users verified on this model needs no sign from the probe");
    assert.equal(reported.writeAccess("reboot"), "allowed");
    assert.equal(reported.writes, "experimental", "the model as a whole stays unverified");
    assert.equal(reported.generic, true, "and is written the generic way that was verified");
    // Its owner may still turn it off
    reported.setDisabledWrites([{ model: "B535-232", feature: "reboot" }]);
    assert.deepEqual([reported.writeState("reboot"), reported.writeAccess("reboot")], ["disabled", "disabled"]);
  });

  it("counts a write someone verified on a router of another brand, for that brand and model only", () => {
    const entry = { family: "zte-zwrt", model: "MU5250", softwareVersion: "BD_ZTE_MU5250V1.0.0B05", feature: "cellLock", access: "write", issue: 41 } as const;
    const zwrt = new DeviceAccess({ family: "zte-zwrt", verifiedFeatures: [entry] });
    zwrt.see("MU5250", "BD_ZTE_MU5250V1.0.0B05");
    assert.deepEqual([zwrt.writeState("cellLock"), zwrt.writeAccess("cellLock")], ["verified", "allowed"]);
    assert.equal(zwrt.writeState("bandLock"), "enabled", "only the feature reported");
    assert.equal(zwrt.writes, "experimental", "the model as a whole stays unverified");
    zwrt.setDisabledWrites([{ model: "MU5250", feature: "cellLock" }]);
    assert.equal(zwrt.writeState("cellLock"), "disabled", "its owner may still turn it off");
    // The same name on the other ZTE interface, or another model, is another router
    const goform = new DeviceAccess({ family: "zte-goform", verifiedFeatures: [entry] });
    goform.see("MU5250", null);
    assert.equal(goform.writeState("cellLock"), "enabled");
    const other = new DeviceAccess({ family: "zte-zwrt", verifiedFeatures: [entry] });
    other.see("MC8530", null);
    assert.equal(other.writeState("cellLock"), "enabled");
    // A write the brand does not implement stays refused whatever a report says
    const unimplemented = new DeviceAccess({ family: "zte-zwrt", verifiedFeatures: [{ ...entry, feature: "accessControl" }] });
    unimplemented.see("MU5250", null);
    assert.equal(unimplemented.writeState("accessControl"), "not_implemented");
  });

  it("opens what a driver family's driver implements without a probe, and keeps an unlock open while either lock is", () => {
    const openwrt = new DeviceAccess({ family: "openwrt" });
    assert.equal(openwrt.writeState("bandLock"), "unknown");
    openwrt.see("RM520N-GL", "RM520NGLAAR01A07M4G");
    assert.deepEqual(
      WRITE_FEATURES.map((f) => [f, openwrt.writeState(f)]).filter(([, state]) => state !== "not_implemented"),
      [
        ["bandLock", "enabled"],
        ["cellLock", "enabled"],
        ["reboot", "enabled"],
        ["smsWrite", "enabled"],
      ]
    );
    assert.equal(openwrt.actionAccess("unlock_rf_locks"), "experimental");
    // The band lock off, the cell lock on: a cell that was locked can still be unlocked
    openwrt.setDisabledWrites([{ model: "RM520N-GL", feature: "bandLock" }]);
    assert.equal(openwrt.actionAccess("lock_band"), "disabled");
    assert.equal(openwrt.actionAccess("unlock_rf_locks"), "experimental");
    assert.equal(openwrt.actionAccess("auto_unlock_rf_locks"), "experimental");
    // Both off: an unlock is refused as turned off, like the locks
    openwrt.setDisabledWrites([
      { model: "RM520N-GL", feature: "bandLock" },
      { model: "RM520N-GL", feature: "cellLock" },
    ]);
    assert.equal(openwrt.actionAccess("unlock_rf_locks"), "disabled");
    // What no driver implements is refused as not implemented, never as turned off
    assert.equal(openwrt.actionAccess("reconnect_cellular"), "unavailable");
  });
});

async function startRuntime() {
  const cpe = createCpeFamily({ login: "sha256", tokenFlow: "token", model: "B535-232", endpoints: B535_ANSWERS, sms: MAILBOX, writes: {} });
  const dir = tempDir("fengsui-switch-rt-");
  const env: Record<string, string> = {
    CPE_URL: "http://192.168.8.1",
    CPE_PASSWORD: cpe.password,
    API_TOKEN: "switch_full_token",
    DATA_ENCRYPTION_KEY: "switch_data_key",
    WEB_HOST: "127.0.0.1",
    WEB_PORT: "0",
    ALLOWED_HOSTS: "127.0.0.1",
    STATE_FILE: path.join(dir, "data", "state.json"),
    POLL_INTERVAL_MS: "600000",
    NEIGHBOR_SCAN_INTERVAL_MS: "600000",
  };
  const envPath = path.join(dir, ".env");
  fs.writeFileSync(envPath, Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n"));
  const stack: FengSuiRuntimeStack = createFengSuiRuntime({ config: loadConfig({ envPath, ignoreProcessEnv: true }), envPath, fetchImpl: cpe.fetchImpl, log: () => undefined });
  const bound = await stack.httpServer.listen();
  const base = `http://${bound.host}:${bound.port}`;
  const send = (method: string, p: string, auth: { cookie?: string; token?: string }, body?: unknown) =>
    fetch(`${base}${p}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Requested-With": "XMLHttpRequest",
        Origin: base,
        ...(auth.cookie ? { Cookie: auth.cookie } : {}),
        ...(auth.token ? { Authorization: `Bearer ${auth.token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const login = await send("POST", "/api/auth/login", {}, { password: "switch_full_token" });
  const cookie = `fengsui_sid=${/fengsui_sid=([0-9a-f]{64})/.exec(login.headers.get("set-cookie") ?? "")?.[1] ?? ""}`;
  return {
    cpe,
    stack,
    cookie,
    send,
    cleanup: async () => {
      await stack.close();
      removeTempDir(dir);
    },
  };
}

describe("experimental switch: the console's switch", () => {
  it("is turned off and on only from a console session, only for a write FengSui implements here, and audited", async () => {
    const fx = await startRuntime();
    try {
      assert.ok(await fx.stack.monitor.identifyDevice());
      const view = (await (await fx.send("GET", "/api/console/experimental", { cookie: fx.cookie })).json()) as ExperimentalWritesResponse;
      assert.equal(view.device.model, "B535-232");
      assert.equal(view.device.writes, "experimental");
      assert.equal(view.device.features.bandLock, "enabled", "on by default");
      assert.deepEqual(view.disabled, []);

      for (const [method, body] of [["GET", undefined], ["POST", { feature: "bandLock", enabled: false }]] as const) {
        const refused = await fx.send(method, "/api/console/experimental", { token: "switch_full_token" }, body);
        assert.equal(refused.status, 403, `${method} with a token`);
        assert.equal(((await refused.json()) as ApiErrorEnvelope).errorCode, "CONSOLE_ONLY");
      }
      assert.equal(fx.stack.settings.disabledWrites.length, 0, "a token changed nothing");

      const unknownFeature = await fx.send("POST", "/api/console/experimental", { cookie: fx.cookie }, { feature: "teleport", enabled: false });
      assert.equal(unknownFeature.status, 400);
      assert.equal(((await unknownFeature.json()) as ApiErrorEnvelope).errorCode, "VALIDATION_ERROR");
      const notEnabled = await fx.send("POST", "/api/console/experimental", { cookie: fx.cookie }, { feature: "bandLock" });
      assert.equal(notEnabled.status, 400);
      // A write FengSui has nothing for on this router has no switch, in either direction
      for (const enabled of [true, false]) {
        const notImplemented = await fx.send("POST", "/api/console/experimental", { cookie: fx.cookie }, { feature: "cellLock", enabled });
        assert.equal(notImplemented.status, 409);
        const envelope = (await notImplemented.json()) as ApiErrorEnvelope;
        assert.deepEqual([envelope.errorCode, envelope.state], ["EXPERIMENTAL_UNAVAILABLE", "not_implemented"]);
      }
      assert.equal(fx.stack.settings.disabledWrites.length, 0);

      const off = await fx.send("POST", "/api/console/experimental", { cookie: fx.cookie }, { feature: "bandLock", enabled: false });
      assert.equal(off.status, 200);
      const offView = (await off.json()) as ExperimentalWritesResponse;
      assert.equal(offView.device.features.bandLock, "disabled");
      assert.deepEqual(offView.disabled.map((d) => [d.model, d.feature]), [["B535-232", "bandLock"]]);
      assert.equal(fx.stack.scheduler.getStatus().device.features.bandLock, "disabled", "off at once");
      // Refused before any session, and told apart from a write FengSui has no implementation of
      const logins = fx.cpe.stats.logins;
      const locked = await fx.send("POST", "/api/control/band-lock", { cookie: fx.cookie }, { lteBands: [1], confirm: true });
      const lockedBody = (await locked.json()) as ApiErrorEnvelope;
      assert.deepEqual([locked.status, lockedBody.errorCode, lockedBody.model, lockedBody.feature], [409, "DEVICE_WRITE_DISABLED", "B535-232", "bandLock"]);
      assert.match(lockedBody.message, /turned off for this router \(B535-232\) under Settings → Device/);
      assert.match(lockedBody.messageZh ?? "", /已经在「设置 → 设备」关闭/);
      const cell = await fx.send("POST", "/api/control/cell-lock", { cookie: fx.cookie }, { rat: "LTE", band: 1, arfcn: 300, pci: 211, confirm: true });
      assert.deepEqual([cell.status, ((await cell.json()) as ApiErrorEnvelope).errorCode], [409, "DEVICE_UNVERIFIED_READ_ONLY"]);
      assert.equal(fx.cpe.stats.logins, logins, "neither opened a session");

      const again = (await (await fx.send("POST", "/api/console/experimental", { cookie: fx.cookie }, { feature: "bandLock", enabled: false })).json()) as ExperimentalWritesResponse;
      assert.equal(again.disabled.length, 1, "off twice is off once");
      const on = (await (await fx.send("POST", "/api/console/experimental", { cookie: fx.cookie }, { feature: "bandLock", enabled: true })).json()) as ExperimentalWritesResponse;
      assert.equal(on.device.features.bandLock, "enabled");
      assert.equal(fx.stack.scheduler.getStatus().device.features.bandLock, "enabled", "back on at once, with no model to type");
      assert.deepEqual(fx.stack.settings.disabledWrites, []);

      const audit = (await (await fx.send("GET", "/api/audit", { cookie: fx.cookie })).json()) as AuditResponse;
      const switched = audit.entries.filter((e) => e.action === "settings.experimental").reverse();
      assert.deepEqual(
        switched.map((e) => [e.outcome, e.channel, e.detail]),
        [
          ["refused", "web", "cellLock on: not_implemented"],
          ["refused", "web", "cellLock off: not_implemented"],
          ["applied", "web", "bandLock off for B535-232"],
          ["applied", "web", "bandLock off for B535-232 (was off)"],
          ["applied", "web", "bandLock on for B535-232"],
        ]
      );
    } finally {
      await fx.cleanup();
    }
  });

  it("survives a restart, and waits for the identification when there is none to match it against", async () => {
    const fx = await startRuntime();
    const stateFile = fx.stack.config.stateFile;
    try {
      assert.ok(await fx.stack.monitor.identifyDevice());
      assert.equal((await fx.send("POST", "/api/console/experimental", { cookie: fx.cookie }, { feature: "reboot", enabled: false })).status, 200);
      await fx.stack.settings.flush();
    } finally {
      await fx.stack.close();
    }
    const envPath = path.join(path.dirname(path.dirname(stateFile)), ".env");
    const restart = (): FengSuiRuntimeStack => createFengSuiRuntime({ config: loadConfig({ envPath, ignoreProcessEnv: true }), envPath, fetchImpl: fx.cpe.fetchImpl, log: () => undefined });
    // A plain restart: the stored identification names the model the write was turned off on
    const same = restart();
    try {
      assert.equal(same.scheduler.device.current?.model, "B535-232");
      assert.deepEqual(same.settings.disabledWrites.map((d) => [d.model, d.feature]), [["B535-232", "reboot"]]);
      assert.equal(same.scheduler.device.writeAccess("reboot"), "disabled");
      assert.equal(same.scheduler.device.writeAccess("bandLock"), "experimental", "the rest is on, from the stored identification");
    } finally {
      await same.close();
    }
    // The identification is gone (state.json deleted): the switch-off is kept, and counts again once the router is identified
    fs.rmSync(stateFile, { force: true });
    const again = restart();
    try {
      assert.equal(again.scheduler.device.current, null);
      assert.equal(again.settings.disabledWrites.length, 1, "kept: a start that cannot see the router is no reason to turn a write back on");
      assert.ok(await again.monitor.identifyDevice());
      assert.equal(again.scheduler.device.writeAccess("reboot"), "disabled");
    } finally {
      await again.close();
      fs.rmSync(path.dirname(path.dirname(stateFile)), { recursive: true, force: true });
    }
  });

  it("counts only for the model it was made on: another router starts with its own, and the first is as its owner left it", async () => {
    const fx = await startRuntime();
    try {
      assert.ok(await fx.stack.monitor.identifyDevice());
      assert.equal((await fx.send("POST", "/api/console/experimental", { cookie: fx.cookie }, { feature: "reboot", enabled: false })).status, 200);
      assert.equal(fx.stack.scheduler.device.writeAccess("reboot"), "disabled");
      // A poll names another model (the router was replaced): nothing is written there before it is identified
      fx.stack.scheduler.noteRouterModel("E5576-320", "21.180.99.00.00");
      assert.equal(fx.stack.scheduler.device.writeAccess("reboot"), "unavailable");
      assert.equal(fx.stack.scheduler.device.writeState("reboot"), "unsupported");
      assert.deepEqual(fx.stack.settings.disabledWrites.map((d) => d.model), ["B535-232"], "kept for the router it was made on");
      // Back to the first router: off, as its owner left it
      fx.stack.scheduler.noteRouterModel("B535-232", "11.0.1.2(H7SP2C00)");
      assert.equal(fx.stack.scheduler.device.writeState("reboot"), "disabled");
      assert.equal(fx.stack.scheduler.device.writeState("bandLock"), "enabled");
    } finally {
      await fx.cleanup();
    }
  });
});
