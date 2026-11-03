import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { ApiErrorEnvelope, AuditResponse, ExperimentalWritesResponse } from "../src/api-contract.ts";
import { type FengSuiRuntimeStack, createFengSuiRuntime } from "../src/cli.ts";
import { loadConfig } from "../src/config.ts";
import { ConsoleSettings } from "../src/console-settings.ts";
import { CONTROL_FEATURES, DeviceAccess, WRITE_FEATURES } from "../src/device-access.ts";
import { type DeviceProbeResult, type ProbeSession, probeDevice } from "../src/device-profile.ts";
import { StorageCipher } from "../src/encrypted-file.ts";
import { type FamilySms, createCpeFamily } from "./helpers/cpe-family.ts";

/**
 * Multi-model phase 3: an owner of a model nobody verified turns experimental writes on one feature
 * at a time. The consent is kept encrypted per model and feature, only a console session changes it
 * (tokens get 403 CONSOLE_ONLY), both directions are audited, and it lapses when the router turns out
 * to be another model. Mocks and placeholders only.
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

describe("experimental consent: the store", () => {
  it("keeps one consent per model and feature, encrypted, and only for one model at a time", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fengsui-consent-"));
    try {
      const file = path.join(dir, "settings.json");
      const settings = new ConsoleSettings({ filePath: file, cipher: new StorageCipher("consent_key"), now: () => Date.parse(NOW) });
      assert.equal(settings.experimentalConsents.length, 0);
      settings.grantExperimental("B535-232", "bandLock");
      settings.grantExperimental("B535-232", "bandLock");
      settings.grantExperimental("B535-232", "reboot");
      assert.deepEqual(
        settings.experimentalConsents.map((c) => `${c.model}:${c.feature}`),
        ["B535-232:bandLock", "B535-232:reboot"]
      );
      assert.equal(settings.experimentalConsents[0]?.grantedAtIso, NOW);
      settings.grantExperimental("E5576-320", "reboot");
      assert.deepEqual(settings.experimentalConsents.map((c) => `${c.model}:${c.feature}`), ["E5576-320:reboot"], "a consent for another model ends the old model's");
      assert.equal(settings.revokeExperimental("reboot"), true);
      assert.equal(settings.revokeExperimental("reboot"), false);
      settings.grantExperimental("B535-232", "smsWrite");
      assert.equal(settings.retainExperimentalFor("B535-232"), 0);
      assert.equal(settings.retainExperimentalFor("E5576-320"), 1);
      settings.grantExperimental("B535-232", "mobileData");
      await settings.flush();

      assert.equal(fs.readFileSync(file, "utf8").includes("B535-232"), false, "encrypted at rest");
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      const again = new ConsoleSettings({ filePath: file, cipher: new StorageCipher("consent_key") });
      again.load();
      assert.deepEqual(again.experimentalConsents.map((c) => `${c.model}:${c.feature}`), ["B535-232:mobileData"]);

      // An entry this version cannot read is dropped, never half-honoured
      const cipher = new StorageCipher("consent_key");
      fs.writeFileSync(
        file,
        cipher.serializeJson({
          format: 1,
          experimental: [
            { model: "B535-232", feature: "reboot", grantedAtIso: NOW },
            { model: "B535-232", feature: "cellLock", grantedAtIso: NOW },
            { model: 5, feature: "bandLock", grantedAtIso: NOW },
            { model: "B535-232", feature: "bandLock" },
            "nonsense",
          ],
        })
      );
      const odd = new ConsoleSettings({ filePath: file, cipher });
      odd.load();
      assert.deepEqual(odd.experimentalConsents.map((c) => `${c.model}:${c.feature}`), ["B535-232:reboot"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("experimental consent: what each write is on a router", () => {
  it("lists every write the scheduler runs", () => {
    assert.deepEqual([...new Set(Object.values(CONTROL_FEATURES))].sort(), [...WRITE_FEATURES].sort());
  });

  it("names each write's state from the model, the verified lists, the probe and the consents", async () => {
    const unknown = new DeviceAccess();
    assert.deepEqual(new Set(WRITE_FEATURES.map((f) => unknown.writeState(f))), new Set(["unknown"]));
    assert.equal(unknown.writeAccess("bandLock"), "unknown");

    const h168 = new DeviceAccess();
    h168.remember("H168-383", "4.4.0.1(H1006SP19C00)");
    h168.noteProbe(await probeOf("H168-383"));
    assert.deepEqual(new Set(WRITE_FEATURES.map((f) => h168.writeState(f))), new Set(["verified"]));
    assert.equal(h168.writeAccess("smsWrite"), "allowed");
    assert.equal(h168.generic, false);
    assert.equal(h168.snapshot().lteBands, null, "the verified model keeps its own band list");

    const b535 = new DeviceAccess();
    b535.remember("B535-232", "11.0.1.2(H7SP2C00)");
    b535.noteProbe(await probeOf("B535-232"));
    assert.equal(b535.generic, true);
    assert.deepEqual(b535.snapshot().features, {
      bandLock: "available",
      cellLock: "not_implemented",
      reboot: "available",
      reconnect: "available",
      mobileData: "available",
      securitySwitches: "not_implemented",
      wifi: "not_implemented",
      antenna: "not_implemented",
      accessControl: "not_implemented",
      smsWrite: "available",
    });
    assert.deepEqual(b535.snapshot().lteBands, [1, 3, 7, 8, 20, 32]);
    assert.ok(WRITE_FEATURES.every((f) => b535.writeAccess(f) === "read_only"), "nothing is open without a consent");

    b535.setConsents([
      { model: "B535-232", feature: "bandLock" },
      { model: "E5576-320", feature: "reboot" },
    ]);
    assert.equal(b535.writeState("bandLock"), "consented");
    assert.equal(b535.writeAccess("bandLock"), "experimental");
    assert.equal(b535.writeState("reboot"), "available", "another model's consent counts for nothing");
    assert.equal(b535.writeAccess("reboot"), "read_only");

    // The router turns out to be another model: neither its consent nor the probe of the old one count
    b535.see("E5576-321", "21.0");
    assert.equal(b535.writeState("bandLock"), "unsupported");
    assert.equal(b535.writeState("reboot"), "unsupported");
    assert.equal(b535.writeAccess("bandLock"), "read_only");
    assert.equal(b535.snapshot().lteBands, null);

    const lacking = new DeviceAccess();
    lacking.remember("B535-232", null);
    lacking.noteProbe(await probeOf("B535-232", { "/api/dialup/mobile-dataswitch": "<response><x>1</x></response>" }));
    lacking.setConsents([{ model: "B535-232", feature: "mobileData" }]);
    assert.equal(lacking.writeState("mobileData"), "unsupported", "a consent without the router's evidence opens nothing");
    assert.equal(lacking.writeAccess("mobileData"), "read_only");

    const reported = new DeviceAccess({ verifiedFeatures: [{ model: "B535-232", softwareVersion: "11.0.1.2(H7SP2C00)", feature: "reboot", access: "write", issue: 12 }] });
    reported.remember("B535-232", null);
    assert.equal(reported.writeState("reboot"), "verified", "a write users verified on this model needs no consent");
    assert.equal(reported.writeAccess("reboot"), "allowed");
    assert.equal(reported.writes, "read_only", "the model as a whole stays unverified");
    assert.equal(reported.generic, true, "and is written the generic way that was verified");
  });
});

async function startRuntime() {
  const cpe = createCpeFamily({ login: "sha256", tokenFlow: "token", model: "B535-232", endpoints: B535_ANSWERS, sms: MAILBOX, writes: {} });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fengsui-consent-rt-"));
  const env: Record<string, string> = {
    CPE_URL: "http://192.168.8.1",
    CPE_PASSWORD: cpe.password,
    API_TOKEN: "consent_full_token",
    DATA_ENCRYPTION_KEY: "consent_data_key",
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
  const login = await send("POST", "/api/auth/login", {}, { password: "consent_full_token" });
  const cookie = `fengsui_sid=${/fengsui_sid=([0-9a-f]{64})/.exec(login.headers.get("set-cookie") ?? "")?.[1] ?? ""}`;
  return {
    cpe,
    stack,
    cookie,
    send,
    cleanup: async () => {
      await stack.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("experimental consent: the console's switch", () => {
  it("is turned on and off only from a console session, for the model the owner typed, and audited", async () => {
    const fx = await startRuntime();
    try {
      assert.ok(await fx.stack.monitor.identifyDevice());
      const view = (await (await fx.send("GET", "/api/console/experimental", { cookie: fx.cookie })).json()) as ExperimentalWritesResponse;
      assert.equal(view.device.model, "B535-232");
      assert.equal(view.device.features.bandLock, "available");
      assert.deepEqual(view.consents, []);

      for (const [method, body] of [["GET", undefined], ["POST", { feature: "bandLock", enabled: true, model: "B535-232" }]] as const) {
        const refused = await fx.send(method, "/api/console/experimental", { token: "consent_full_token" }, body);
        assert.equal(refused.status, 403, `${method} with a token`);
        assert.equal(((await refused.json()) as ApiErrorEnvelope).errorCode, "CONSOLE_ONLY");
      }
      assert.equal(fx.stack.settings.experimentalConsents.length, 0, "a token changed nothing");

      const typo = await fx.send("POST", "/api/console/experimental", { cookie: fx.cookie }, { feature: "bandLock", enabled: true, model: "H168-383" });
      assert.equal(typo.status, 400);
      assert.equal(((await typo.json()) as ApiErrorEnvelope).errorCode, "VALIDATION_ERROR");
      const missingModel = await fx.send("POST", "/api/console/experimental", { cookie: fx.cookie }, { feature: "bandLock", enabled: true });
      assert.equal(missingModel.status, 400);
      const unknownFeature = await fx.send("POST", "/api/console/experimental", { cookie: fx.cookie }, { feature: "teleport", enabled: true, model: "B535-232" });
      assert.equal(unknownFeature.status, 400);
      const notEnabled = await fx.send("POST", "/api/console/experimental", { cookie: fx.cookie }, { feature: "bandLock", model: "B535-232" });
      assert.equal(notEnabled.status, 400);
      const notImplemented = await fx.send("POST", "/api/console/experimental", { cookie: fx.cookie }, { feature: "cellLock", enabled: true, model: "B535-232" });
      assert.equal(notImplemented.status, 409);
      const envelope = (await notImplemented.json()) as ApiErrorEnvelope;
      assert.equal(envelope.errorCode, "EXPERIMENTAL_UNAVAILABLE");
      assert.equal(envelope.state, "not_implemented");

      const on = await fx.send("POST", "/api/console/experimental", { cookie: fx.cookie }, { feature: "bandLock", enabled: true, model: " b535-232 " });
      assert.equal(on.status, 200);
      const onView = (await on.json()) as ExperimentalWritesResponse;
      assert.equal(onView.device.features.bandLock, "consented");
      assert.deepEqual(onView.consents.map((c) => [c.model, c.feature]), [["B535-232", "bandLock"]]);
      assert.deepEqual(fx.stack.settings.experimentalConsents.map((c) => c.feature), ["bandLock"]);
      assert.equal(fx.stack.scheduler.getStatus().device.features.bandLock, "consented");

      const off = (await (await fx.send("POST", "/api/console/experimental", { cookie: fx.cookie }, { feature: "bandLock", enabled: false })).json()) as ExperimentalWritesResponse;
      assert.equal(off.device.features.bandLock, "available");
      assert.equal(fx.stack.scheduler.getStatus().device.features.bandLock, "available", "off at once");
      assert.deepEqual(fx.stack.settings.experimentalConsents, []);

      const audit = (await (await fx.send("GET", "/api/audit", { cookie: fx.cookie })).json()) as AuditResponse;
      const consentAudit = audit.entries.filter((e) => e.action === "settings.experimental").reverse();
      assert.deepEqual(
        consentAudit.map((e) => [e.outcome, e.channel]),
        [
          ["refused", "web"],
          ["refused", "web"],
          ["refused", "web"],
          ["applied", "web"],
          ["applied", "web"],
        ]
      );
      assert.match(consentAudit[3]?.detail ?? "", /bandLock on for B535-232/);
      assert.match(consentAudit[4]?.detail ?? "", /bandLock off/);
    } finally {
      await fx.cleanup();
    }
  });

  it("survives a restart, and is dropped at start when no identification is there to match it against", async () => {
    const fx = await startRuntime();
    const settingsFile = fx.stack.config.settingsFile;
    const stateFile = fx.stack.config.stateFile;
    try {
      assert.ok(await fx.stack.monitor.identifyDevice());
      assert.equal((await fx.send("POST", "/api/console/experimental", { cookie: fx.cookie }, { feature: "reboot", enabled: true, model: "B535-232" })).status, 200);
      await fx.stack.settings.flush();
    } finally {
      await fx.stack.close();
    }
    const envPath = path.join(path.dirname(path.dirname(stateFile)), ".env");
    const restart = (): FengSuiRuntimeStack => createFengSuiRuntime({ config: loadConfig({ envPath, ignoreProcessEnv: true }), envPath, fetchImpl: fx.cpe.fetchImpl, log: () => undefined });
    // A plain restart: the stored identification names the model the consent was given for
    const same = restart();
    try {
      assert.equal(same.scheduler.device.current?.model, "B535-232");
      assert.deepEqual(same.settings.experimentalConsents.map((c) => [c.model, c.feature]), [["B535-232", "reboot"]]);
      assert.equal(same.scheduler.device.writeAccess("reboot"), "experimental");
    } finally {
      await same.close();
    }
    // The identification is gone (state.json deleted), the consent is not
    fs.rmSync(stateFile, { force: true });
    const again = restart();
    try {
      assert.equal(again.scheduler.device.current, null);
      assert.equal(again.settings.experimentalConsents.length, 0);
      assert.ok(again.audit.list(10).some((e) => e.action === "settings.experimental" && e.channel === "system" && /no router identified/.test(e.detail ?? "")));
      assert.equal(fs.existsSync(settingsFile), true);
    } finally {
      await again.close();
      fs.rmSync(path.dirname(path.dirname(stateFile)), { recursive: true, force: true });
    }
  });

  it("lapses when the router turns out to be another model", async () => {
    const fx = await startRuntime();
    try {
      assert.ok(await fx.stack.monitor.identifyDevice());
      assert.equal((await fx.send("POST", "/api/console/experimental", { cookie: fx.cookie }, { feature: "reboot", enabled: true, model: "B535-232" })).status, 200);
      assert.equal(fx.stack.scheduler.device.writeAccess("reboot"), "experimental");
      // A poll names another model (the router was replaced)
      fx.stack.scheduler.noteRouterModel("E5576-320", "21.180.99.00.00");
      assert.equal(fx.stack.scheduler.device.writeAccess("reboot"), "read_only");
      assert.deepEqual(fx.stack.settings.experimentalConsents, [], "dropped for good, not just ignored");
      // Back to the first router: the consent does not come back with it
      fx.stack.scheduler.noteRouterModel("B535-232", "11.0.1.2(H7SP2C00)");
      assert.equal(fx.stack.scheduler.device.writeState("reboot"), "available");
    } finally {
      await fx.cleanup();
    }
  });
});
