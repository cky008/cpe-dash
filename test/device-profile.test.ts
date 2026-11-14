import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ApiErrorTally,
  DEVICE_PROBE_PATHS,
  type DeviceProbePath,
  PROBE_REQUEST_TIMEOUT_MS,
  type ProbeSession,
  buildDeviceReport,
  deviceProfileOf,
  endpointState,
  maskToBands,
  probeDevice,
  readStructure,
  valueShape,
} from "../src/device-profile.ts";
import { DEVICE_FEATURES, isStatusReadFeature } from "../src/features.ts";

/**
 * The device profile's pure core: what the probe asks the router (a fixed list of GETs), how answers
 * become endpoint states, identity and capabilities, and the report's structure-only view of them.
 * Every identifier in these fixtures is an RFC / reserved placeholder (AGENTS.md 铁律二).
 */

const NOW = "2026-11-02T08:00:00.000Z";

/** H168-383-like answers, salted with every placeholder identifier the report must never carry. */
const H168_BODIES: Readonly<Partial<Record<DeviceProbePath, string>>> = {
  "/api/user/state-login":
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?><response><password_type>4</password_type><State>0</State><lockstatus>0</lockstatus><username>admin</username></response>",
  "/api/device/information":
    "<response><DeviceName>H168-383</DeviceName><SerialNumber>SN00000000000000</SerialNumber><Imei>860000000000000</Imei><Imsi>272010000000000</Imsi><Iccid>8935301000000000000</Iccid><Msisdn>+353830000000</Msisdn><HardwareVersion>WL1H168M</HardwareVersion><SoftwareVersion>4.4.0.1&#40;H1006SP19C00&#41;</SoftwareVersion><WebUIVersion>WEBUI 4.4.0.1(W2SP24C03)</WebUIVersion><MacAddress1>02:00:5E:10:00:01</MacAddress1><MacAddress2/><WanIPAddress>198.51.100.42</WanIPAddress><WanIPv6Address>2001:db8::42</WanIPv6Address></response>",
  "/api/device/basic_information":
    "<response><classify>cpe</classify><devicename>H168-383</devicename><spreadname_en>HUAWEI 5G CPE Ultra 6</spreadname_en><spreadname_zh>华为 5G CPE Ultra 6</spreadname_zh></response>",
  "/api/net/net-feature-switch":
    "<response><net_premode_switch>2</net_premode_switch><lteband_switch>0</lteband_switch><select_band_switch>1</select_band_switch><lock_freq_switch>3</lock_freq_switch><antenna_select_switch>0</antenna_select_switch><reconnect_switch>1</reconnect_switch><net_mode_enable>1</net_mode_enable></response>",
  "/api/wlan/wifi-feature-switch":
    "<response><wifimaxmacfilternum>64</wifimaxmacfilternum><wifimacfilterextendenable>1</wifimacfilterextendenable><wifissid>FengSui_Lab_WiFi</wifissid></response>",
  "/api/device/device-feature-switch": "<response><tac>10001</tac><cell_id>134217758</cell_id><sms_enabled>1</sms_enabled></response>",
  "/api/net/net-mode-list":
    "<response><AccessList><Access>00</Access><Access>03</Access></AccessList><LTEBandList><LTEBand><Name>LTE BC1/LTE BC3</Name><Value>5</Value></LTEBand><LTEBand><Name>LTE BC20</Name><Value>80000</Value></LTEBand></LTEBandList></response>",
};

class FakeCpeError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`[CPE ${code}]`);
    this.name = "CpeApiError";
    this.code = code;
  }
}

function named(name: string): Error {
  const err = new Error(name);
  err.name = name;
  return err;
}

/** Errors that end the session itself, as `EphemeralCpeSession` reports them: it is no longer open. */
const SESSION_ENDING: ReadonlySet<string> = new Set(["CpeSessionDeadlineError", "CpeSessionClosedError", "SchedulerStoppedError", "AbortError"]);

/** A logged-in session answering from `bodies`; anything else is `100002`, like the H168-383. */
function fakeSession(
  bodies: Readonly<Partial<Record<string, string>>>,
  faults: Readonly<Record<string, Error>> = {},
  facts: Partial<Pick<ProbeSession, "loginScheme" | "eccVerified" | "tokenFlow">> = {}
): ProbeSession & { asked: string[]; timeouts: Array<number | undefined> } {
  const asked: string[] = [];
  const timeouts: Array<number | undefined> = [];
  let open = true;
  return {
    asked,
    timeouts,
    loginScheme: facts.loginScheme === undefined ? "scram" : facts.loginScheme,
    eccVerified: facts.eccVerified ?? true,
    tokenFlow: facts.tokenFlow === undefined ? "webserver-token" : facts.tokenFlow,
    get open(): boolean {
      return open;
    },
    async get(apiPath: string, _headers?: Record<string, string>, timeoutMs?: number): Promise<string> {
      asked.push(apiPath);
      timeouts.push(timeoutMs);
      const fault = faults[apiPath];
      if (fault && SESSION_ENDING.has(fault.name)) open = false;
      if (fault) throw fault;
      const body = bodies[apiPath];
      if (body === undefined) throw new FakeCpeError("100002");
      return body;
    },
  };
}

describe("device profile: the probe", () => {
  it("asks exactly the listed GETs, once each, in order", async () => {
    assert.equal(DEVICE_PROBE_PATHS.length, new Set(DEVICE_PROBE_PATHS).size);
    for (const p of DEVICE_PROBE_PATHS) assert.match(p, /^\/api\/[a-z_-]+\/[a-z_-]+$/);
    assert.ok(!DEVICE_PROBE_PATHS.some((p) => p.includes("plmn-list")), "the manual network scan is never probed");
    const session = fakeSession(H168_BODIES);
    await probeDevice(session, { nowIso: NOW, origin: "startup" });
    assert.deepEqual(session.asked, [...DEVICE_PROBE_PATHS]);
    assert.equal(PROBE_REQUEST_TIMEOUT_MS, 5000);
    assert.deepEqual(new Set(session.timeouts), new Set([PROBE_REQUEST_TIMEOUT_MS]), "a router that never answers holds the slot for at most 10 × 5 s, inside the 90 s session budget");
  });

  it("names each endpoint supported, unsupported (100002), restricted (100003, not unsupported) or unknown", async () => {
    assert.equal(endpointState("100002"), "unsupported");
    assert.equal(endpointState("100003"), "restricted");
    assert.equal(endpointState("125002"), "unknown");
    const session = fakeSession(H168_BODIES, {
      "/api/system/devcapacity": new FakeCpeError("100003"),
      "/api/global/module-switch": new FakeCpeError("125002"),
      "/api/device/basicinformation": named("CpeTransportError"),
    });
    const profile = deviceProfileOf(await probeDevice(session, { nowIso: NOW, origin: "startup" }));
    const states = Object.fromEntries(profile.capabilities.endpoints.map((e) => [e.path, [e.state, e.code]]));
    assert.deepEqual(states, {
      "/api/user/state-login": ["supported", null],
      "/api/device/information": ["supported", null],
      "/api/device/basic_information": ["supported", null],
      "/api/device/basicinformation": ["unknown", null],
      "/api/device/device-feature-switch": ["supported", null],
      "/api/net/net-feature-switch": ["supported", null],
      "/api/wlan/wifi-feature-switch": ["supported", null],
      "/api/system/devcapacity": ["restricted", "100003"],
      "/api/net/net-mode-list": ["supported", null],
      "/api/global/module-switch": ["unknown", "125002"],
    });
  });

  it("gives up on the whole probe when its session ends (deadline, logout, stop), recording nothing guessed", async () => {
    for (const name of ["CpeSessionDeadlineError", "CpeSessionClosedError", "SchedulerStoppedError", "AbortError"]) {
      const session = fakeSession(H168_BODIES, { "/api/net/net-feature-switch": named(name) });
      await assert.rejects(probeDevice(session, { nowIso: NOW, origin: "startup" }), (err: unknown) => err instanceof Error && err.name === name);
    }
    const timedOut = fakeSession(H168_BODIES, { "/api/net/net-mode-list": named("TimeoutError") });
    const profile = deviceProfileOf(await probeDevice(timedOut, { nowIso: NOW, origin: "startup" }));
    assert.equal(profile.capabilities.endpoints.find((e) => e.path === "/api/net/net-mode-list")?.state, "unknown", "one slow endpoint is unknown");
    assert.equal(profile.capabilities.lteBands, null);
  });

  it("records an answer it cannot read as that endpoint's unknown, and goes on while the session is open", async () => {
    const session = fakeSession(H168_BODIES, {
      "/api/device/basicinformation": new FakeCpeError("ERR"),
      "/api/system/devcapacity": new Error("Response exceeds 2097152 bytes (maximum allowed size)"),
      "/api/global/module-switch": new TypeError("terminated"),
    });
    const probe = await probeDevice(session, { nowIso: NOW, origin: "connection-test" });
    assert.deepEqual(session.asked, [...DEVICE_PROBE_PATHS], "every listed GET still went out, once");
    const states = Object.fromEntries(probe.endpoints.map((e) => [e.path, [e.state, e.code]]));
    assert.deepEqual(states["/api/device/basicinformation"], ["unknown", null], "an error code that is no number is not recorded");
    assert.deepEqual(states["/api/system/devcapacity"], ["unknown", null], "an answer too big to read");
    assert.deepEqual(states["/api/global/module-switch"], ["unknown", null], "an answer cut off");
    assert.deepEqual(states["/api/net/net-mode-list"], ["supported", null]);
    assert.deepEqual(
      probe.observations.filter((o) => o.format === null).map((o) => o.path),
      ["/api/device/basicinformation", "/api/system/devcapacity", "/api/global/module-switch"],
      "nothing of an unreadable answer is observed"
    );
    assert.deepEqual([probe.identity.model, probe.identity.softwareVersion, probe.lteBands], ["H168-383", "4.4.0.1(H1006SP19C00)", [1, 3, 20]]);
  });

  it("identifies model, builds and login from the answers and the session", async () => {
    const profile = deviceProfileOf(await probeDevice(fakeSession(H168_BODIES), { nowIso: NOW, origin: "connection-test" }));
    assert.deepEqual(profile.identity, {
      model: "H168-383",
      marketingName: "HUAWEI 5G CPE Ultra 6",
      softwareVersion: "4.4.0.1(H1006SP19C00)",
      webUiVersion: "WEBUI 4.4.0.1(W2SP24C03)",
      passwordType: "4",
      loginScheme: "scram",
      ecc: true,
      tokenFlow: "webserver-token",
      detectedAtIso: NOW,
    });
    assert.equal(profile.origin, "connection-test");
    assert.equal(profile.capabilities.probedAtIso, NOW);
    assert.deepEqual(profile.capabilities.lteBands, [1, 3, 20]);
    assert.equal(profile.verification, "verified");
    // What the verified model's verification covers; the status reads came later and are not part of it
    for (const feature of DEVICE_FEATURES) assert.deepEqual(profile.capabilities.features[feature], isStatusReadFeature(feature) ? { state: "unknown", source: "none" } : { state: "supported", source: "verified" }, feature);
  });

  it("falls back to basic_information, and leaves what nobody answered null", async () => {
    const other = {
      "/api/device/basicinformation": "<response><devicename>B535-232</devicename><SoftwareVersion>11.0.1.2(H192SP1C983)</SoftwareVersion><WebUIVersion>21.100.44.00.03</WebUIVersion></response>",
    };
    const profile = deviceProfileOf(await probeDevice(fakeSession(other, {}, { loginScheme: null, eccVerified: false, tokenFlow: null }), { nowIso: NOW, origin: "startup" }));
    assert.deepEqual(profile.identity, {
      model: "B535-232",
      marketingName: null,
      softwareVersion: "11.0.1.2(H192SP1C983)",
      webUiVersion: "21.100.44.00.03",
      passwordType: null,
      loginScheme: "unknown",
      ecc: false,
      tokenFlow: "unknown",
      detectedAtIso: NOW,
    });
    assert.equal(profile.verification, "unverified-model");
    assert.equal(profile.capabilities.lteBands, null, "no net-mode-list, no band list");
    for (const feature of DEVICE_FEATURES) assert.deepEqual(profile.capabilities.features[feature], { state: "unknown", source: "none" }, feature);

    const silent = deviceProfileOf(await probeDevice(fakeSession({}), { nowIso: NOW, origin: "startup" }));
    assert.equal(silent.identity.model, null);
    assert.equal(silent.verification, "unknown");
  });

  it("keeps an allowlisted value only when all of it fits the alphabet and 64 characters, else drops it whole (R0-04)", async () => {
    const odd = { "/api/device/information": `<response><DeviceName>H168&lt;script&gt;</DeviceName><SoftwareVersion>${"9".repeat(10)}${"x".repeat(80)}</SoftwareVersion><WebUIVersion>  WEBUI   1.0\n</WebUIVersion></response>` };
    const { identity, observations } = await probeDevice(fakeSession(odd), { nowIso: NOW, origin: "startup" });
    assert.equal(identity.model, null, "a character outside the alphabet drops the value instead of becoming ?");
    assert.equal(identity.softwareVersion, null, "a value over 64 characters is dropped, not cut");
    assert.equal(identity.webUiVersion, "WEBUI 1.0", "whitespace still collapses");
    const kept = (observations.find((o) => o.path === "/api/device/information")?.fields ?? []).filter((f) => f.value !== undefined);
    assert.deepEqual(kept.map((f) => [f.tag, f.value]), [["WebUIVersion", "WEBUI 1.0"]], "the report keeps a dropped value's shape, never a part of it");

    // A cut used to leave 9 digits of an identifier, too few for the second pass; markup hidden in CDATA used to survive as ?
    const hidden = {
      "/api/device/information": `<response><DeviceName>${"M".repeat(55)}860000000000000</DeviceName><WebUIVersion><![CDATA[<b>134217758</b>]]></WebUIVersion></response>`,
      "/api/device/basic_information": "<response><devicename>H168-383</devicename><spreadname_en>HUAWEI 5G CPE Ultra 6</spreadname_en></response>",
    };
    const probe = await probeDevice(fakeSession(hidden), { nowIso: NOW, origin: "startup" });
    assert.deepEqual([probe.identity.model, probe.identity.webUiVersion, probe.identity.marketingName], ["H168-383", null, "HUAWEI 5G CPE Ultra 6"], "a dropped model falls back to basic_information");
    const json = JSON.stringify(probe);
    assert.ok(!json.includes("860000000") && !json.includes("134217758"), json);
  });

  it("counts only a router answer as supported: an HTML page or plain text is unknown (R0-07)", async () => {
    const odd = {
      ...H168_BODIES,
      "/api/system/devcapacity": "<!DOCTYPE html><html><head><title>Login 134217758</title></head><body>redirect</body></html>",
      "/api/global/module-switch": "OK",
      "/api/device/device-feature-switch": '{"sms_enabled":1}',
      "/api/device/basicinformation": "<html><response><devicename>B535-232</devicename></response></html>",
    };
    const probe = await probeDevice(fakeSession(odd), { nowIso: NOW, origin: "startup" });
    const states = Object.fromEntries(probe.endpoints.map((e) => [e.path, [e.state, e.code]]));
    assert.deepEqual(
      [states["/api/system/devcapacity"], states["/api/global/module-switch"], states["/api/device/device-feature-switch"], states["/api/device/basicinformation"], states["/api/device/information"]],
      [["unknown", null], ["unknown", null], ["supported", null], ["unknown", null], ["supported", null]],
      "JSON is an answer; HTML and plain text are not"
    );
    const observed = (path: DeviceProbePath) => probe.observations.find((o) => o.path === path);
    assert.deepEqual([observed("/api/system/devcapacity")?.format, observed("/api/system/devcapacity")?.fields], ["xml", []], "a page that is no answer leaves no fields");
    assert.equal(probe.identity.model, "H168-383", "and nothing of it reaches the identity");
    assert.ok(!JSON.stringify(probe).includes("134217758"));
  });

  it("reads quoted attributes and CDATA as XML does (R0-05)", async () => {
    assert.deepEqual(readStructure(`<response><DeviceName note="a>134217758">H168-383</DeviceName><b x='>' y="'">1</b><c/></response>`).leaves, [
      { path: "DeviceName", raw: "H168-383" },
      { path: "b", raw: "1" },
      { path: "c", raw: "" },
    ]);
    const cdata = {
      "/api/device/information": "<response><DeviceName><![CDATA[H168-383]]></DeviceName><SoftwareVersion>4.4.0.1<![CDATA[(H1006SP19C00)]]></SoftwareVersion><WebUIVersion><![CDATA[a&lt;b]]></WebUIVersion></response>",
    };
    const { identity, observations } = await probeDevice(fakeSession(cdata), { nowIso: NOW, origin: "startup" });
    assert.deepEqual([identity.model, identity.softwareVersion, identity.webUiVersion], ["H168-383", "4.4.0.1(H1006SP19C00)", null], "CDATA text is literal (and `a&lt;b` does not fit the alphabet)");
    assert.equal(deviceProfileOf(await probeDevice(fakeSession(cdata), { nowIso: NOW, origin: "startup" })).verification, "verified");
    assert.deepEqual(observations.find((o) => o.path === "/api/device/information")?.fields.map((f) => f.shape), ["text(8)", "text(21)", "text(6)"]);
    assert.doesNotThrow(() => readStructure(`<response><a x="unterminated>1</a></response>`));
    assert.deepEqual(readStructure(`<response><a><![CDATA[never closed</a></response>`).leaves, [], "an unclosed CDATA swallows the rest, like XML");
  });

  it("observes structure only: tag paths and value shapes, values just for the allowlist", async () => {
    const { observations } = await probeDevice(fakeSession(H168_BODIES), { nowIso: NOW, origin: "startup" });
    const fields = (path: DeviceProbePath) => observations.find((o) => o.path === path)?.fields ?? [];
    assert.deepEqual(
      fields("/api/device/information").map((f) => [f.tag, f.shape, f.value ?? null]),
      [
        ["DeviceName", "text(8)", "H168-383"],
        ["SerialNumber", "text(16)", null],
        ["Imei", "int", null],
        ["Imsi", "int", null],
        ["Iccid", "int", null],
        ["Msisdn", "text(13)", null],
        ["HardwareVersion", "text(8)", null],
        ["SoftwareVersion", "text(21)", "4.4.0.1(H1006SP19C00)"],
        ["WebUIVersion", "text(24)", "WEBUI 4.4.0.1(W2SP24C03)"],
        ["MacAddress1", "mac", null],
        ["MacAddress2", "empty", null],
        ["WanIPAddress", "ipv4", null],
        ["WanIPv6Address", "ipv6", null],
      ]
    );
    assert.deepEqual(fields("/api/user/state-login").map((f) => [f.tag, f.value ?? null]), [["password_type", "4"], ["State", null], ["lockstatus", null], ["username", null]]);
    assert.deepEqual(
      fields("/api/net/net-feature-switch").map((f) => `${f.tag}=${f.value}`),
      ["net_premode_switch=2", "lteband_switch=0", "select_band_switch=1", "lock_freq_switch=3", "antenna_select_switch=0", "reconnect_switch=1", "net_mode_enable=1"],
      "small switch values are kept"
    );
    assert.deepEqual(fields("/api/device/device-feature-switch").map((f) => [f.tag, f.shape, f.value ?? null]), [["tac", "int", null], ["cell_id", "int", null], ["sms_enabled", "int", "1"]], "a TAC is no switch");
    assert.deepEqual(fields("/api/wlan/wifi-feature-switch").find((f) => f.tag === "wifissid"), { tag: "wifissid", shape: "text(16)", count: 1 });
    assert.deepEqual(fields("/api/net/net-mode-list"), [
      { tag: "AccessList.Access", shape: "int", count: 2 },
      { tag: "LTEBandList.LTEBand.Name", shape: "text(15)|text(8)", count: 2 },
      { tag: "LTEBandList.LTEBand.Value", shape: "int", count: 2 },
    ]);
    assert.deepEqual(fields("/api/system/devcapacity"), [], "an unsupported endpoint has no fields");
    const stored = JSON.stringify(observations);
    for (const id of ["860000000000000", "272010000000000", "8935301000000000000", "+353830000000", "02:00:5E:10:00:01", "198.51.100.42", "2001:db8::42", "10001", "134217758", "FengSui_Lab_WiFi", "SN00000000000000", "admin"]) {
      assert.ok(!stored.includes(id), `observations carry ${id}`);
    }
  });
});

describe("device profile: structure and shapes", () => {
  it("names a value's shape without its characters", () => {
    assert.equal(valueShape(""), "empty");
    assert.equal(valueShape("  "), "empty");
    assert.equal(valueShape("-1"), "int");
    assert.equal(valueShape("860000000000000"), "int");
    assert.equal(valueShape("-5.5"), "decimal");
    assert.equal(valueShape("02:00:5e:10:00:01"), "mac");
    assert.equal(valueShape("198.51.100.42"), "ipv4");
    assert.equal(valueShape("2001:db8::42"), "ipv6");
    assert.equal(valueShape("fe80::1"), "ipv6");
    assert.equal(valueShape("10:00:01"), "text(8)", "a time is no address");
    assert.equal(valueShape("40000007a0880800d5"), "hex(18)");
    assert.equal(valueShape("-87dBm"), "text(6)");
    assert.equal(valueShape("华为 5G"), "text(5)");
  });

  it("reads leaf paths linearly and never throws on odd markup", () => {
    assert.deepEqual(readStructure('<?xml version="1.0"?><!-- note --><response><a>1</a><b><c x="1">t</c><d/></b><![CDATA[<x>]]></response>').leaves, [
      { path: "a", raw: "1" },
      { path: "b.c", raw: "t" },
      { path: "b.d", raw: "" },
    ]);
    assert.deepEqual(readStructure("<error><code>100002</code><message></message></error>").leaves, [
      { path: "code", raw: "100002" },
      { path: "message", raw: "" },
    ]);
    for (const odd of ["", "plain text", "<response><a>1</b></response>", "<<<>>>", "<response><a>", "<response><__proto__>1</__proto__><1bad>2</1bad></response>", "[1,2]"]) {
      assert.doesNotThrow(() => readStructure(odd), odd);
    }
    assert.deepEqual(readStructure("[1,2]"), { kind: "json", leaves: [], truncated: false });
    assert.deepEqual(readStructure("plain text"), { kind: "text", leaves: [], truncated: false });
    assert.deepEqual(readStructure("<response><__proto__>1</__proto__></response>").leaves, [], "dangerous names are skipped");
    const many = `<response>${"<x>1</x>".repeat(1000)}</response>`;
    const read = readStructure(many);
    assert.equal(read.leaves.length, 400);
    assert.equal(read.truncated, true);
    const deep = `<response>${"<n>".repeat(20)}v${"</n>".repeat(20)}</response>`;
    assert.ok(readStructure(deep).leaves.every((leaf) => leaf.path.split(".").length <= 8));
  });

  it("turns LTE band masks into band numbers", () => {
    assert.deepEqual(maskToBands("40000007a0880800d5"), [1, 3, 5, 7, 8, 20, 28, 32, 38, 40, 41, 42, 43, 71]);
    assert.deepEqual(maskToBands("0"), []);
    assert.equal(maskToBands("zz"), null);
    assert.equal(maskToBands("f".repeat(70)), null, "longer than any band mask");
  });
});

describe("device profile: API error tally", () => {
  it("counts CPE error codes per method, endpoint and code, without query strings", () => {
    let now = Date.parse(NOW);
    const tally = new ApiErrorTally(() => now);
    tally.record("GET", "/api/monitoring/daily-data-limit", "100002");
    now += 5000;
    tally.record("GET", "/api/monitoring/daily-data-limit", "100002");
    tally.record("POST", "/api/sms/sms-list-contact?ecc-client-pubkey=00&enc-type=1", "100005");
    tally.record("GET", "/not-api", "100002");
    tally.record("GET", "/api/x", "1e9");
    tally.record("PUT", "/api/device/control", "100003");
    assert.deepEqual(tally.snapshot(), {
      sinceIso: NOW,
      entries: [
        { method: "GET", path: "/api/monitoring/daily-data-limit", code: "100002", count: 2, lastAtIso: "2026-11-02T08:00:05.000Z" },
        { method: "POST", path: "/api/sms/sms-list-contact", code: "100005", count: 1, lastAtIso: "2026-11-02T08:00:05.000Z" },
      ],
    });
  });

  it("stays bounded", () => {
    const tally = new ApiErrorTally();
    for (let i = 0; i < 500; i++) tally.record("GET", `/api/x/e${i}`, "100002");
    assert.equal(tally.snapshot().entries.length, 100);
  });
});

describe("device profile: report", () => {
  it("carries versions, verification, identity, capabilities, endpoint structure and error counts", async () => {
    const probe = await probeDevice(fakeSession(H168_BODIES), { nowIso: NOW, origin: "startup" });
    const tally = new ApiErrorTally(() => Date.parse(NOW));
    tally.record("GET", "/api/device/ri", "100002");
    const profile = deviceProfileOf(probe);
    const report = buildDeviceReport({ probe, apiErrors: tally.snapshot(), fengsuiVersion: "1.5.0", generatedAtIso: NOW });
    assert.equal(report.reportVersion, 1);
    assert.equal(report.fengsuiVersion, "1.5.0");
    assert.equal(report.generatedAtIso, NOW);
    assert.equal(report.verification, "verified");
    assert.deepEqual(report.identity, profile.identity);
    assert.deepEqual(report.capabilities, { probedAtIso: NOW, lteBands: [1, 3, 20], features: profile.capabilities.features });
    assert.deepEqual(
      report.endpoints.map((e) => [e.path, e.state, e.code, e.fields.length > 0]),
      profile.capabilities.endpoints.map((e) => [e.path, e.state, e.code, e.state === "supported"])
    );
    assert.deepEqual(report.apiErrors.entries.map((e) => `${e.method} ${e.path} ${e.code} ×${e.count}`), ["GET /api/device/ri 100002 ×1"]);

    const empty = buildDeviceReport({ probe: null, apiErrors: tally.snapshot(), fengsuiVersion: "1.5.0", generatedAtIso: NOW });
    assert.deepEqual([empty.verification, empty.identity, empty.capabilities, empty.endpoints], ["unknown", null, null, []]);
  });
});
