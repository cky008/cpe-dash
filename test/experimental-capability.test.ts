import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEVICE_PROBE_PATHS, EXPERIMENTAL_FEATURES, EXPERIMENTAL_PROBE_PATHS, type ProbeSession, deviceProfileOf, experimentalEvidence, isDeviceProbeResult, probeDevice } from "../src/device-profile.ts";
import { DEVICE_FEATURES, WRITE_FEATURES, isStatusReadFeature } from "../src/features.ts";
import { FAMILY_WRITE_FEATURES, ROUTER_FAMILIES, ROUTER_FAMILY_FACTS } from "../src/router-family.ts";

/**
 * Multi-model phase 3: what a model nobody verified shows of the writes FengSui could do there once
 * its owner consents. The probe asks three more GETs, only for such a model, and each generic write
 * counts as supported when the probe found the endpoint it reads back, or for a write-only endpoint
 * the module it belongs to. Mocks and placeholders only.
 */

const NOW = "2026-11-03T08:00:00.000Z";

class FakeCpeError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`[CPE ${code}]`);
    this.name = "CpeApiError";
    this.code = code;
  }
}

function fakeSession(bodies: Readonly<Record<string, string>>): ProbeSession & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    loginScheme: "sha256",
    eccVerified: false,
    tokenFlow: "webserver-token",
    open: true,
    async get(apiPath: string): Promise<string> {
      asked.push(apiPath);
      const body = bodies[apiPath];
      if (body === undefined) throw new FakeCpeError("100002");
      return body;
    },
  };
}

/** An LTE router of another model, as the reference project's facts describe it (placeholders only). */
const B535: Readonly<Record<string, string>> = {
  "/api/user/state-login": "<response><State>-1</State><password_type>4</password_type></response>",
  "/api/device/information": "<response><DeviceName>B535-232</DeviceName><SoftwareVersion>11.0.1.2(H7SP2C00)</SoftwareVersion><Imei>860000000000000</Imei></response>",
  "/api/device/basic_information": "<response><devicename>B535-232</devicename></response>",
  "/api/net/net-feature-switch": "<response><reconnect_switch>1</reconnect_switch></response>",
  "/api/net/net-mode-list":
    "<response><LTEBandList><LTEBand><Name>All bands</Name><Value>7FFFFFFFFFFFFFFF</Value></LTEBand><LTEBand><Name>LTE BC1/BC3/BC7/BC8/BC20/BC32</Name><Value>800800C5</Value></LTEBand></LTEBandList></response>",
  "/api/net/net-mode": "<response><NetworkMode>00</NetworkMode><NetworkBand>3FFFFFFF</NetworkBand><LTEBand>800800C5</LTEBand></response>",
  "/api/dialup/mobile-dataswitch": "<response><dataswitch>1</dataswitch></response>",
  "/api/sms/sms-count": "<response><LocalUnread>1</LocalUnread><LocalInbox>2</LocalInbox><LocalOutbox>1</LocalOutbox><LocalDraft>0</LocalDraft><LocalMax>500</LocalMax></response>",
  "/api/global/module-switch": "<response><ussd_enabled>1</ussd_enabled><sms_enabled>1</sms_enabled><statistic_enabled>1</statistic_enabled></response>",
};

const H168: Readonly<Record<string, string>> = {
  "/api/user/state-login": "<response><State>-1</State><password_type>4</password_type></response>",
  "/api/device/information": "<response><DeviceName>H168-383</DeviceName><SoftwareVersion>4.4.0.1(H1006SP19C00)</SoftwareVersion></response>",
  "/api/net/net-mode-list": "<response><LTEBandList><LTEBand><Name>LTE BC1/LTE BC3</Name><Value>5</Value></LTEBand></LTEBandList></response>",
};

const without = (bodies: Readonly<Record<string, string>>, ...paths: string[]): Record<string, string> =>
  Object.fromEntries(Object.entries(bodies).filter(([p]) => !paths.includes(p)));

describe("experimental capability: the probe", () => {
  it("asks the three GETs of a write's read side only of a model nobody verified, after the fixed list", async () => {
    assert.deepEqual([...EXPERIMENTAL_PROBE_PATHS], ["/api/net/net-mode", "/api/dialup/mobile-dataswitch", "/api/sms/sms-count"]);
    for (const p of EXPERIMENTAL_PROBE_PATHS) assert.ok(!(DEVICE_PROBE_PATHS as ReadonlyArray<string>).includes(p));

    const other = fakeSession(B535);
    const probe = await probeDevice(other, { nowIso: NOW, origin: "startup" });
    assert.deepEqual(other.asked, [...DEVICE_PROBE_PATHS, ...EXPERIMENTAL_PROBE_PATHS]);
    assert.deepEqual(
      probe.endpoints.slice(-3).map((e) => [e.path, e.state]),
      EXPERIMENTAL_PROBE_PATHS.map((p) => [p, "supported"])
    );
    assert.ok(isDeviceProbeResult(JSON.parse(JSON.stringify(probe))), "a stored probe with them reads back");

    const verified = fakeSession(H168);
    await probeDevice(verified, { nowIso: NOW, origin: "startup" });
    assert.deepEqual(verified.asked, [...DEVICE_PROBE_PATHS], "the H168-383 gets exactly the fixed list");

    const nameless = fakeSession(without(B535, "/api/device/information", "/api/device/basic_information"));
    await probeDevice(nameless, { nowIso: NOW, origin: "startup" });
    assert.deepEqual(nameless.asked, [...DEVICE_PROBE_PATHS], "a router that names no model gets nothing more");
  });

  it("keeps their structure but no value: a switch or a count is not allowlisted", async () => {
    const probe = await probeDevice(fakeSession(B535), { nowIso: NOW, origin: "startup" });
    const observed = probe.observations.filter((o) => (EXPERIMENTAL_PROBE_PATHS as ReadonlyArray<string>).includes(o.path));
    assert.equal(observed.length, 3);
    assert.ok(observed.every((o) => o.fields.length > 0 && o.fields.every((f) => f.value === undefined)));
    assert.deepEqual(observed.find((o) => o.path === "/api/dialup/mobile-dataswitch")?.fields, [{ tag: "dataswitch", shape: "int", count: 1 }]);
  });

  it("reads an entry that stands for all bands as no band at all", async () => {
    const probe = await probeDevice(fakeSession(B535), { nowIso: NOW, origin: "startup" });
    assert.deepEqual(probe.lteBands, [1, 3, 7, 8, 20, 32]);
    const allOnly = await probeDevice(
      fakeSession({ ...B535, "/api/net/net-mode-list": "<response><LTEBandList><LTEBand><Name>All</Name><Value>7fffffffffffffff</Value></LTEBand></LTEBandList></response>" }),
      { nowIso: NOW, origin: "startup" }
    );
    assert.equal(allOnly.lteBands, null, "a list that only says 'all' names no band FengSui could check a lock against");
  });
});

describe("experimental capability: evidence per write", () => {
  it("finds every generic write on a router that shows them all", async () => {
    assert.deepEqual([...EXPERIMENTAL_FEATURES], ["bandLock", "reboot", "reconnect", "mobileData", "smsWrite", "networkMode", "operatorSelect", "roaming", "trafficReset", "ussd"]);
    // The gate goes by the family's list; on a HiLink model it is these generic writes, and every family's are known write features
    assert.deepEqual([...ROUTER_FAMILY_FACTS.huawei.writes], [...EXPERIMENTAL_FEATURES]);
    for (const family of ROUTER_FAMILIES) for (const feature of ROUTER_FAMILY_FACTS[family].writes) assert.ok((FAMILY_WRITE_FEATURES as ReadonlyArray<string>).includes(feature) && (WRITE_FEATURES as ReadonlyArray<string>).includes(feature), `${family} ${feature}`);
    const probe = await probeDevice(fakeSession(B535), { nowIso: NOW, origin: "startup" });
    assert.deepEqual(experimentalEvidence(probe), { bandLock: true, reboot: true, reconnect: true, mobileData: true, smsWrite: true, networkMode: true, operatorSelect: true, roaming: true, trafficReset: true, ussd: true });
    const { features } = deviceProfileOf(probe).capabilities;
    for (const feature of DEVICE_FEATURES) {
      const expected = (EXPERIMENTAL_FEATURES as ReadonlyArray<string>).includes(feature) ? { state: "supported", source: "probe" } : { state: "unknown", source: "none" };
      assert.deepEqual(features[feature], expected, feature);
    }
  });

  it("asks each write for its own evidence", async () => {
    const evidence = async (bodies: Readonly<Record<string, string>>) => experimentalEvidence(await probeDevice(fakeSession(bodies), { nowIso: NOW, origin: "startup" }));
    // Band lock needs both the advertised bands and the mask it reads back
    assert.equal((await evidence(without(B535, "/api/net/net-mode-list"))).bandLock, false);
    assert.equal((await evidence(without(B535, "/api/net/net-mode"))).bandLock, false);
    assert.equal((await evidence({ ...B535, "/api/net/net-mode": "<response><NetworkMode>00</NetworkMode></response>" })).bandLock, false, "without an LTEBand to read back");
    assert.equal(
      (await evidence({ ...B535, "/api/net/net-mode-list": "<response><LTEBandList><LTEBand><Value>7FFFFFFFFFFFFFFF</Value></LTEBand></LTEBandList></response>" })).bandLock,
      false,
      "without a band to check a lock against"
    );
    // The net module answers either way for a redial
    assert.equal((await evidence(without(B535, "/api/net/net-mode-list"))).reconnect, true);
    assert.equal((await evidence(without(B535, "/api/net/net-mode-list", "/api/net/net-mode"))).reconnect, false);
    assert.equal((await evidence(without(B535, "/api/device/information"))).reboot, false, "device/control belongs to the device module");
    assert.equal((await evidence(without(B535, "/api/dialup/mobile-dataswitch"))).mobileData, false);
    assert.equal((await evidence({ ...B535, "/api/dialup/mobile-dataswitch": "<response><other>1</other></response>" })).mobileData, false);
    assert.equal((await evidence(without(B535, "/api/sms/sms-count"))).smsWrite, false);
    assert.equal((await evidence({ ...B535, "/api/sms/sms-count": "<response><LocalMax>500</LocalMax></response>" })).smsWrite, false);
    // The cellular settings: the mode needs what it sends back and the list it chooses from; the operator and
    // roaming writes go by their module; the traffic counters and USSD by the module switch that names them
    assert.equal((await evidence(without(B535, "/api/net/net-mode-list"))).networkMode, false);
    assert.equal((await evidence({ ...B535, "/api/net/net-mode": "<response><NetworkMode>00</NetworkMode></response>" })).networkMode, false);
    assert.equal((await evidence(without(B535, "/api/net/net-mode-list"))).operatorSelect, true);
    assert.equal((await evidence(without(B535, "/api/net/net-mode-list", "/api/net/net-mode"))).operatorSelect, false);
    assert.equal((await evidence(without(B535, "/api/dialup/mobile-dataswitch"))).roaming, false);
    const noSwitch = await evidence(without(B535, "/api/global/module-switch"));
    assert.deepEqual([noSwitch.trafficReset, noSwitch.ussd], [false, false]);
    const smsOnly = await evidence({ ...B535, "/api/global/module-switch": "<response><sms_enabled>1</sms_enabled></response>" });
    assert.deepEqual([smsOnly.trafficReset, smsOnly.ussd], [false, false], "a switch list that names neither");
  });

  it("leaves the verified model's features as they were", async () => {
    const probe = await probeDevice(fakeSession(H168), { nowIso: NOW, origin: "startup" });
    for (const feature of DEVICE_FEATURES) assert.deepEqual(deviceProfileOf(probe).capabilities.features[feature], isStatusReadFeature(feature) ? { state: "unknown", source: "none" } : { state: "supported", source: "verified" }, feature);
  });
});
