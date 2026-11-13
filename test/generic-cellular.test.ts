import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CpeControlValidationError } from "../src/control-error.ts";
import { HuaweiCpeClient } from "../src/cpe-client.ts";
import { CpeAnswerFormatError } from "../src/session-errors.ts";
import { NETWORK_MODE_TIMEOUT_MS, OPERATOR_SCAN_TIMEOUT_MS, OPERATOR_SELECT_TIMEOUT_MS, genericUssd, hilinkApnOf, hilinkModeOf, hilinkModesOffered, modeOptionOf, optionModeOf, optionModesOffered, usesModeOption } from "../src/generic-writes.ts";
import { CONTROL_HOLD_MS, DeviceReadOnlyError } from "../src/scheduler.ts";
import { type CpeFamilyOptions, type FamilyCellular, createCpeFamily } from "./helpers/cpe-family.ts";
import { daemonOn, newCheck } from "./helpers/driver-daemon.ts";

/**
 * The cellular settings on a HiLink model nobody verified (appendix A.12 of the protocol spec): the
 * network mode, the operator, data roaming, the traffic counters and USSD, each in the request form
 * the notes give, sent once and read back. A strict mock router only: a body in any other form is
 * refused. Placeholder operator codes and a made-up USSD answer.
 */

const MODEL = "B535-232";
const NET_MODE_LIST =
  "<response><AccessList><Access>00</Access><Access>01</Access><Access>02</Access><Access>03</Access></AccessList><BandList></BandList><LTEBandList><LTEBand><Name>LTE</Name><Value>800800C5</Value></LTEBand></LTEBandList></response>";
const MODULE_SWITCH = "<response><ussd_enabled>1</ussd_enabled><sms_enabled>1</sms_enabled><statistic_enabled>1</statistic_enabled></response>";
const NETWORKS =
  "<Network><Index>0</Index><State>2</State><FullName>Demo Mobile</FullName><ShortName>Demo</ShortName><Numeric>27201</Numeric><Rat>7</Rat></Network>" +
  "<Network><Index>1</Index><State>1</State><FullName>Other Net</FullName><ShortName>Other</ShortName><Numeric>27202</Numeric><Rat>2</Rat></Network>" +
  "<Network><Index>2</Index><State>3</State><FullName>Third</FullName><ShortName>Third</ShortName><Numeric>27203</Numeric><Rat>0</Rat></Network>";
const CONNECTION = { RoamAutoConnectEnable: "0", MaxIdelTime: "600", ConnectMode: "0", MTU: "1500", auto_dial_switch: "1", pdp_always_on: "0" };

function router(cellular: FamilyCellular = { networks: NETWORKS, connection: CONNECTION, ussd: { content: "Balance: 5.00 EUR" } }, extra: Partial<CpeFamilyOptions> = {}) {
  const cpe = createCpeFamily({
    login: "sha256",
    tokenFlow: "token",
    model: MODEL,
    endpoints: {
      "/api/net/net-mode-list": NET_MODE_LIST,
      "/api/net/net-mode": "<response><NetworkMode>00</NetworkMode><NetworkBand>3FFFFFFF</NetworkBand><LTEBand>800800C5</LTEBand></response>",
      "/api/global/module-switch": MODULE_SWITCH,
    },
    writes: { cellular },
    ...extra,
  });
  const fx = daemonOn("huawei", cpe.fetchImpl, "http://192.168.8.1", cpe.password);
  const bodies = (path: string): string[] => cpe.stats.writes.filter((w) => w.path === path).map((w) => w.body.replace(/^<\?xml[^>]*\?>/, ""));
  return { cpe, ...fx, bodies };
}

describe("generic HiLink: which network modes a router offers", () => {
  it("names a mode by its access codes, and offers a pair only when both of its halves are listed", () => {
    assert.deepEqual(["00", "08", "0803", "03", "0302", "02", "01", "0201", "", null].map(hilinkModeOf), ["auto", "nr_sa", "nr_lte", "lte", "lte_wcdma", "wcdma", "gsm", null, null, null]);
    assert.deepEqual(hilinkModesOffered(NET_MODE_LIST), ["auto", "lte", "lte_wcdma", "wcdma", "gsm"]);
    assert.deepEqual(hilinkModesOffered("<response><AccessList><Access>00</Access><Access>03</Access><Access>08</Access></AccessList></response>"), ["auto", "nr_sa", "nr_lte", "lte"]);
    assert.deepEqual(hilinkModesOffered("<response><LTEBandList></LTEBandList></response>"), [], "no list, no mode");
    assert.deepEqual(hilinkModesOffered(null), []);
  });
});

describe("generic HiLink: the cellular settings of a model nobody verified", () => {
  it("opens the five whose requests the notes give, where the probe found their module, and no other", async () => {
    const fx = router();
    try {
      assert.ok(await fx.core.monitor.identifyDevice());
      const { features } = fx.core.scheduler.getStatus().device;
      assert.deepEqual(
        [features.networkMode, features.operatorSelect, features.roaming, features.trafficReset, features.ussd, features.simSlot, features.simPin, features.airplaneSwitch, features.apn, features.dataLimit],
        ["enabled", "enabled", "enabled", "enabled", "enabled", "not_implemented", "not_implemented", "not_implemented", "not_implemented", "not_implemented"]
      );
      await assert.rejects(fx.core.controls.setSimSlot({ kind: "embedded", index: 1 }, { confirm: true }), DeviceReadOnlyError);
      await assert.rejects(fx.core.controls.setApn({ mode: "auto" }, { confirm: true }), DeviceReadOnlyError);
    } finally {
      await fx.cleanup();
    }
    // A router whose module switches name neither USSD nor statistics: those two are not offered
    const bare = router(undefined, { endpoints: { "/api/net/net-mode-list": NET_MODE_LIST, "/api/net/net-mode": "<response><NetworkMode>00</NetworkMode><NetworkBand>3FFFFFFF</NetworkBand><LTEBand>800800C5</LTEBand></response>" } });
    try {
      assert.ok(await bare.core.monitor.identifyDevice());
      const { features } = bare.core.scheduler.getStatus().device;
      assert.deepEqual([features.networkMode, features.trafficReset, features.ussd], ["enabled", "unsupported", "unsupported"]);
      const sent = bare.cpe.stats.writes.length;
      await assert.rejects(bare.core.controls.sendUssd({ kind: "send", code: "*100#" }, { confirm: true }), DeviceReadOnlyError);
      assert.equal(bare.cpe.stats.writes.length, sent);
    } finally {
      await bare.cleanup();
    }
  });

  it("reads the mode and the modes on offer, how the operator is chosen and the roaming switch", async () => {
    const fx = router();
    try {
      assert.ok(await fx.core.monitor.identifyDevice());
      const snapshot = await fx.core.controls.readCellular();
      assert.deepEqual(snapshot?.networkMode, { current: "auto", options: ["auto", "lte", "lte_wcdma", "wcdma", "gsm"] });
      assert.deepEqual([snapshot?.operator, snapshot?.dataRoaming, snapshot?.simSlots, snapshot?.apn, snapshot?.dataLimit], [{ selection: "auto", plmn: null }, false, null, null, null]);
    } finally {
      await fx.cleanup();
    }
    // What the router does not answer is null, and the rest still reads
    const partial = router({});
    try {
      assert.ok(await partial.core.monitor.identifyDevice());
      const snapshot = await partial.core.controls.readCellular();
      assert.deepEqual([snapshot?.networkMode?.current, snapshot?.dataRoaming, snapshot?.operator?.selection], ["auto", null, "auto"]);
    } finally {
      await partial.cleanup();
    }
  });

  it("switches the mode with the bands sent back as reported, and takes only a mode the router lists", async () => {
    const fx = router();
    try {
      assert.ok(await fx.core.monitor.identifyDevice());
      const result = await fx.core.controls.setNetworkMode("lte", { confirm: true });
      assert.deepEqual(fx.bodies("/api/net/net-mode"), ["<request><NetworkMode>03</NetworkMode><NetworkBand>3FFFFFFF</NetworkBand><LTEBand>800800C5</LTEBand></request>"]);
      assert.deepEqual([result.networkMode, result.cellular?.networkMode?.current], ["lte", "lte"]);
      assert.deepEqual(fx.linkChanges.at(-1)?.change, { kind: "network_mode", previous: "auto" });
      const record = fx.core.scheduler.genericWrites.at(-1);
      assert.deepEqual([record?.action, record?.feature, record?.endpoints, record?.readback], ["set_network_mode", "networkMode", ["/api/net/net-mode"], "match"]);
      await assert.rejects(fx.core.controls.setNetworkMode("nr_sa", { confirm: true }), /offers no "nr_sa" network mode \(it offers auto, lte, lte_wcdma, wcdma, gsm\)/);
      assert.equal(fx.bodies("/api/net/net-mode").length, 1);
      // The way back: skipped while the WAN is up, written once it is down
      assert.deepEqual(await fx.core.controls.revertLinkChange({ kind: "network_mode", previous: "auto" }), { applied: false, skipped: "wan_up" });
      fx.cpe.setConnectionStatus("902");
      assert.deepEqual(await fx.core.controls.revertLinkChange({ kind: "network_mode", previous: "auto" }), { applied: true });
      assert.equal(fx.cpe.settings.netMode.NetworkMode, "00");
      assert.equal(fx.applied.at(-1)?.action, "auto_restore_network_mode");
      await assert.rejects(fx.core.controls.revertLinkChange({ kind: "sim_slot", previous: { kind: "physical", index: 1 } }), DeviceReadOnlyError);
    } finally {
      await fx.cleanup();
    }
  });

  it("searches for networks, keeps the router on one, and hands the choice back", async () => {
    const fx = router();
    try {
      assert.ok(await fx.core.monitor.identifyDevice());
      assert.deepEqual(await fx.core.controls.scanOperators({ confirm: true }), [
        { plmn: "27201", name: "Demo Mobile", rat: "4G", state: "current" },
        { plmn: "27202", name: "Other Net", rat: "3G", state: "available" },
        { plmn: "27203", name: "Third", rat: "2G", state: "forbidden" },
      ]);
      assert.equal(fx.applied.at(-1)?.summaryEn, "Searched for networks in range (3 found) (experimental write)");
      assert.deepEqual(fx.core.scheduler.genericWrites.at(-1)?.endpoints, ["/api/net/plmn-list"]);
      await fx.core.controls.selectOperator({ mode: "manual", plmn: "27202", rat: "3G" }, { confirm: true });
      assert.deepEqual(fx.bodies("/api/net/register"), ["<request><Mode>1</Mode><Plmn>27202</Plmn><Rat>2</Rat></request>"]);
      assert.deepEqual(fx.linkChanges.at(-1)?.change, { kind: "operator", previous: { mode: "auto" } });
      assert.equal(fx.core.scheduler.genericWrites.at(-1)?.readback, "match");
      // A technology the notes give no number for is left to the router
      await fx.core.controls.selectOperator({ mode: "manual", plmn: "27201", rat: "5G" }, { confirm: true });
      assert.equal(fx.bodies("/api/net/register").at(-1), "<request><Mode>1</Mode><Plmn>27201</Plmn><Rat></Rat></request>");
      const watched = fx.linkChanges.length;
      const back = await fx.core.controls.selectOperator({ mode: "auto" }, { confirm: true });
      assert.equal(fx.bodies("/api/net/register").at(-1), "<request><Mode>0</Mode><Plmn></Plmn><Rat></Rat></request>");
      assert.deepEqual([back.cellular?.operator, fx.linkChanges.length], [{ selection: "auto", plmn: null }, watched], "handing the choice back is not watched");
      fx.cpe.setConnectionStatus("902");
      assert.deepEqual(await fx.core.controls.revertLinkChange({ kind: "operator", previous: { mode: "manual", plmn: "27202", rat: null } }), { applied: true });
      assert.deepEqual(fx.cpe.settings.register, { Mode: "1", Plmn: "27202", Rat: "" });
    } finally {
      await fx.cleanup();
    }
  });

  it("writes the roaming switch with the connection's other settings as the router reported them", async () => {
    const fx = router();
    try {
      assert.ok(await fx.core.monitor.identifyDevice());
      // With nothing read yet there is no copy to bring up to date; with one, the switch shows in it at once
      assert.equal(fx.core.monitor.getCachedCellular(), null);
      assert.equal((await fx.core.monitor.refreshCellular({ ignoreCooldown: true }))?.dataRoaming, false);
      const sessions = fx.core.scheduler.getStatus().totalSessionsCompleted;
      assert.deepEqual(await fx.core.controls.setRoaming(true, { confirm: true }), { dataRoaming: true });
      assert.equal(fx.core.monitor.getCachedCellular()?.dataRoaming, true, "the settings last read show the switch the router took");
      assert.equal(fx.core.scheduler.getStatus().totalSessionsCompleted, sessions + 1, "without a session of its own");
      assert.deepEqual(fx.bodies("/api/dialup/connection"), [
        "<request><RoamAutoConnectEnable>1</RoamAutoConnectEnable><MaxIdelTime>600</MaxIdelTime><ConnectMode>0</ConnectMode><MTU>1500</MTU><auto_dial_switch>1</auto_dial_switch><pdp_always_on>0</pdp_always_on></request>",
      ]);
      assert.equal(fx.core.scheduler.genericWrites.at(-1)?.readback, "match");
      assert.equal(fx.linkChanges.length, 0);
    } finally {
      await fx.cleanup();
    }
    // An older firmware reports five of them: those five go back
    const five = router({ connection: { RoamAutoConnectEnable: "1", MaxIdelTime: "600", ConnectMode: "0", MTU: "1500", auto_dial_switch: "1" } });
    try {
      assert.ok(await five.core.monitor.identifyDevice());
      await five.core.controls.setRoaming(false, { confirm: true });
      assert.deepEqual(five.bodies("/api/dialup/connection"), ["<request><RoamAutoConnectEnable>0</RoamAutoConnectEnable><MaxIdelTime>600</MaxIdelTime><ConnectMode>0</ConnectMode><MTU>1500</MTU><auto_dial_switch>1</auto_dial_switch></request>"]);
    } finally {
      await five.cleanup();
    }
    // Without the settings to send back, nothing is written
    const short = router({ connection: { RoamAutoConnectEnable: "0" } });
    try {
      assert.ok(await short.core.monitor.identifyDevice());
      await assert.rejects(short.core.controls.setRoaming(true, { confirm: true }), CpeAnswerFormatError);
      assert.deepEqual(short.bodies("/api/dialup/connection"), []);
    } finally {
      await short.cleanup();
    }
  });

  it("clears the traffic counters and sends a USSD code, keeping neither the code nor the answer", async () => {
    const fx = router();
    try {
      assert.ok(await fx.core.monitor.identifyDevice());
      assert.deepEqual(await fx.core.controls.resetTraffic({ confirm: true }), { reset: true });
      assert.deepEqual([fx.cpe.stats.trafficClears, fx.bodies("/api/monitoring/clear-traffic")], [1, ["<request><ClearTraffic>1</ClearTraffic></request>"]]);
      assert.equal(fx.applied.at(-1)?.summaryEn, "The router's traffic counters were cleared (experimental write, read back: matches)", "the total connected time started over");
      assert.deepEqual(await fx.core.controls.sendUssd({ kind: "send", code: "*100#" }, { confirm: true }), { state: "answered", text: "Balance: 5.00 EUR", awaitsReply: false });
      assert.deepEqual(fx.cpe.settings.ussdSent, ["*100#"]);
      // A reply inside a session is another send; there is no call on record that ends one
      await fx.core.controls.sendUssd({ kind: "reply", code: "1" }, { confirm: true });
      assert.deepEqual(fx.cpe.settings.ussdSent, ["*100#", "1"]);
      await assert.rejects(fx.core.controls.sendUssd({ kind: "cancel" }, { confirm: true }), (err: unknown) => err instanceof CpeControlValidationError && /no way to end a USSD session/.test(err.message));
      const trail = fx.trail();
      assert.ok(!trail.includes("*100#") && !trail.includes("Balance"), "neither the code nor the answer is kept");
    } finally {
      await fx.cleanup();
    }
  });

  it("sends no USSD code to a router that reports USSD off, and gives up on an operator that never answers", async () => {
    const off = createCpeFamily({ login: "sha256", tokenFlow: "token", model: MODEL, endpoints: { "/api/global/module-switch": "<response><ussd_enabled>0</ussd_enabled></response>" }, writes: { cellular: { ussd: { content: "x" } } } });
    const client = new HuaweiCpeClient({ cpeUrl: "http://192.168.8.1", cpePassword: off.password, fetchImpl: off.fetchImpl, requestTimeoutMs: 2000 });
    await assert.rejects(client.withSession((session) => genericUssd(session, newCheck(), { kind: "send", code: "*100#" }, async () => undefined)), /reports USSD as switched off/);
    assert.deepEqual(off.settings.ussdSent, []);

    const silent = createCpeFamily({ login: "sha256", tokenFlow: "token", model: MODEL, endpoints: { "/api/global/module-switch": MODULE_SWITCH }, writes: { cellular: { ussd: { content: "late", busyPolls: "never" } } } });
    const waiting = new HuaweiCpeClient({ cpeUrl: "http://192.168.8.1", cpePassword: silent.password, fetchImpl: silent.fetchImpl, requestTimeoutMs: 2000 });
    let sleeps = 0;
    const check = newCheck();
    assert.deepEqual(await waiting.withSession((session) => genericUssd(session, check, { kind: "send", code: "*100#" }, async () => void (sleeps += 1))), { state: "no_answer", text: null, awaitsReply: false });
    assert.deepEqual([silent.settings.ussdSent, sleeps > 0, check], [["*100#"], true, { endpoints: ["/api/ussd/send"], readback: "none", reason: null }], "sent once, asked a bounded number of times");

    const slow = createCpeFamily({ login: "sha256", tokenFlow: "token", model: MODEL, endpoints: { "/api/global/module-switch": MODULE_SWITCH }, writes: { cellular: { ussd: { content: "1. Top up\n2. Exit", busyPolls: 2 } } } });
    const patient = new HuaweiCpeClient({ cpeUrl: "http://192.168.8.1", cpePassword: slow.password, fetchImpl: slow.fetchImpl, requestTimeoutMs: 2000 });
    assert.deepEqual(await patient.withSession((session) => genericUssd(session, newCheck(), { kind: "send", code: "*100#" }, async () => undefined)), { state: "answered", text: "1. Top up\n2. Exit", awaitsReply: false });
  });
});

describe("generic HiLink: the access point and the secondary carriers a model nobody verified reports", () => {
  const PROFILES =
    "<response><CurrentProfile>2</CurrentProfile><Profiles>" +
    "<Profile><Index>1</Index><IsValid>1</IsValid><Name>Default</Name><ApnIsStatic>0</ApnIsStatic><ApnName></ApnName><Username></Username><Password></Password><AuthMode>0</AuthMode><iptype>0</iptype><ReadOnly>1</ReadOnly></Profile>" +
    "<Profile><Index>2</Index><IsValid>1</IsValid><Name>Mine</Name><ApnIsStatic>1</ApnIsStatic><ApnName>example.apn</ApnName><Username>demo-user</Username><Password>demo-secret</Password><AuthMode>2</AuthMode><iptype>2</iptype><ReadOnly>0</ReadOnly></Profile>" +
    "</Profiles></response>";

  it("reads the profile in use, keeping only whether a user name is set", () => {
    assert.deepEqual(hilinkApnOf(PROFILES), { mode: "manual", apn: "example.apn", ipType: "ipv4v6", auth: "chap", hasUsername: true });
    // No current one named: the first valid profile; AuthMode 0 is the router's choice, not a mode
    assert.deepEqual(hilinkApnOf(PROFILES.replace("<CurrentProfile>2</CurrentProfile>", "")), { mode: "auto", apn: null, ipType: "ipv4", auth: null, hasUsername: false });
    assert.equal(hilinkApnOf("<response><Profiles></Profiles></response>"), null);
    assert.equal(hilinkApnOf(null), null);
    assert.doesNotMatch(JSON.stringify(hilinkApnOf(PROFILES)), /demo-user|demo-secret/);
  });

  it("serves it with the other cellular settings, and reads LTE carriers from ca-scell-info when seccellinfo lists none", async () => {
    const scells = "<response><scells><scell><scell_index>1</scell_index><scell_band>3</scell_band><scell_dl_bw>20MHz</scell_dl_bw><scell_pci>142</scell_pci><scell_earfcn>1850</scell_earfcn><scell_rsrp>-85dBm</scell_rsrp><scell_rsrq>-9dB</scell_rsrq><scell_sinr>15dB</scell_sinr><scell_rssi>-60dBm</scell_rssi></scell></scells></response>";
    const fx = router(undefined, {
      endpoints: {
        "/api/net/net-mode-list": NET_MODE_LIST,
        "/api/net/net-mode": "<response><NetworkMode>00</NetworkMode><NetworkBand>3FFFFFFF</NetworkBand><LTEBand>800800C5</LTEBand></response>",
        "/api/global/module-switch": MODULE_SWITCH,
        "/api/dialup/profiles": PROFILES,
        "/api/net/ca-scell-info": scells,
      },
    });
    try {
      assert.ok(await fx.core.monitor.identifyDevice());
      const snapshot = await fx.core.controls.readCellular();
      assert.deepEqual(snapshot?.apn, { mode: "manual", apn: "example.apn", ipType: "ipv4v6", auth: "chap", hasUsername: true });
      assert.doesNotMatch(fx.trail() + JSON.stringify(snapshot), /demo-user|demo-secret/);
      const telemetry = await fx.core.monitor.refreshTelemetry();
      assert.deepEqual(
        telemetry?.rf.lteScc.map(({ band, arfcn, pci, bandwidthMhz, rsrpDbm }) => ({ band, arfcn, pci, bandwidthMhz, rsrpDbm })),
        [{ band: "B3", arfcn: 1850, pci: 142, bandwidthMhz: 20, rsrpDbm: -85 }]
      );
    } finally {
      await fx.cleanup();
    }
  });
});

describe("generic HiLink: a 5G router whose net-mode reports networkOption (what the H168-383 did on 2026-11-13)", () => {
  const FIVE_G_MODE = "<response><NetworkMode>00</NetworkMode><NetworkBand>3FFFFFFF</NetworkBand><LTEBand>800800C5</LTEBand><networkOption>2</networkOption><LTEBandOption>0</LTEBandOption></response>";
  const FIVE_G_LIST =
    "<response><AccessList><Access>00</Access><Access>08</Access><Access>03</Access></AccessList><BandList></BandList><LTEBandList><LTEBand><Name>LTE</Name><Value>800800C5</Value></LTEBand></LTEBandList></response>";
  const PAGE_LIST = "<config><net_mode_list>0;1;2;3;4;5</net_mode_list></config>";
  const fiveG = (extra: Readonly<Record<string, string>> = {}) =>
    router(undefined, {
      endpoints: {
        "/api/net/net-mode-list": FIVE_G_LIST,
        "/api/net/net-mode": FIVE_G_MODE,
        "/api/global/module-switch": MODULE_SWITCH,
        "/config/network/net-mode.xml": PAGE_LIST,
        "/api/net/net-feature-switch": "<response><net_mode_enable>1</net_mode_enable><plmn_list_combine_enable>1</plmn_list_combine_enable></response>",
        ...extra,
      },
    });

  it("names the mode by the field its code goes with, and offers what the router's page lists", () => {
    const answer = (mode: string, option: string, bandOption: string) => `<response><NetworkMode>${mode}</NetworkMode><networkOption>${option}</networkOption><LTEBandOption>${bandOption}</LTEBandOption></response>`;
    assert.deepEqual(
      [answer("00", "1", "0"), answer("00", "0", "0"), answer("00", "2", "1"), answer("03", "2", "0"), answer("03", "2", "2"), answer("03", "2", "1"), answer("08", "2", "0")].map(optionModeOf),
      ["nr_sa", "nr_nsa", "auto", "lte", "lte_tdd", "lte_fdd", null]
    );
    assert.deepEqual(optionModesOffered(PAGE_LIST), ["nr_sa", "nr_nsa", "auto", "lte", "lte_tdd", "lte_fdd"]);
    assert.deepEqual(optionModesOffered("<config><net_mode_list>2;3</net_mode_list></config>"), ["auto", "lte"]);
    assert.deepEqual(optionModesOffered("<config></config>"), [], "no list, no mode");
    assert.deepEqual(optionModesOffered(null), []);
    assert.deepEqual([usesModeOption(FIVE_G_MODE), usesModeOption(FIVE_G_MODE.replace(/<networkOption>.*<\/LTEBandOption>/, "")), usesModeOption(null)], [true, false, false]);
    assert.deepEqual([modeOptionOf(FIVE_G_MODE), modeOptionOf(answer("03", "2", "1")), modeOptionOf("<response><NetworkMode>00</NetworkMode></response>")], [{ networkOption: "2" }, { LTEBandOption: "1" }, {}]);
  });

  it("reads and switches the mode with the two fields its page sends, and puts it back the same way", async () => {
    const fx = fiveG();
    try {
      assert.ok(await fx.core.monitor.identifyDevice());
      assert.deepEqual((await fx.core.controls.readCellular())?.networkMode, { current: "auto", options: ["nr_sa", "nr_nsa", "auto", "lte", "lte_tdd", "lte_fdd"] });
      const result = await fx.core.controls.setNetworkMode("lte", { confirm: true });
      assert.deepEqual(fx.bodies("/api/net/net-mode"), ["<request><NetworkMode>03</NetworkMode><LTEBandOption>0</LTEBandOption></request>"]);
      assert.deepEqual([result.networkMode, result.cellular?.networkMode?.current, fx.core.scheduler.genericWrites.at(-1)?.readback], ["lte", "lte", "match"]);
      assert.deepEqual(fx.linkChanges.at(-1)?.change, { kind: "network_mode", previous: "auto" });
      await fx.core.controls.setNetworkMode("nr_sa", { confirm: true });
      assert.equal(fx.bodies("/api/net/net-mode").at(-1), "<request><NetworkMode>00</NetworkMode><networkOption>1</networkOption></request>");
      await assert.rejects(fx.core.controls.setNetworkMode("gsm", { confirm: true }), /offers no "gsm" network mode \(it offers nr_sa, nr_nsa, auto, lte, lte_tdd, lte_fdd\)/);
      fx.cpe.setConnectionStatus("902");
      assert.deepEqual(await fx.core.controls.revertLinkChange({ kind: "network_mode", previous: "auto" }), { applied: true });
      assert.equal(fx.bodies("/api/net/net-mode").at(-1), "<request><NetworkMode>00</NetworkMode><networkOption>2</networkOption></request>");
      assert.deepEqual([fx.cpe.settings.netMode.NetworkMode, fx.cpe.settings.netMode.networkOption], ["00", "2"]);
    } finally {
      await fx.cleanup();
    }
    // A page without its list offers no mode: nothing is written
    const bare = fiveG({ "/config/network/net-mode.xml": "<config></config>" });
    try {
      assert.ok(await bare.core.monitor.identifyDevice());
      await assert.rejects(bare.core.controls.setNetworkMode("lte", { confirm: true }), /offers no "lte" network mode \(it offers none FengSui can read\)/);
      assert.deepEqual(bare.bodies("/api/net/net-mode"), []);
    } finally {
      await bare.cleanup();
    }
  });

  it("locks LTE bands with the mode's own field after the bands, so the mode stays", async () => {
    const fx = fiveG();
    try {
      assert.ok(await fx.core.monitor.identifyDevice());
      await fx.core.controls.lockBands({ lteBands: [1, 3] });
      assert.deepEqual(fx.bodies("/api/net/net-mode"), ["<request><NetworkMode>00</NetworkMode><NetworkBand>3FFFFFFF</NetworkBand><LTEBand>5</LTEBand><networkOption>2</networkOption></request>"]);
      await fx.core.controls.setNetworkMode("lte_fdd", { confirm: true });
      await fx.core.controls.lockBands({ lteBands: [3] });
      assert.equal(fx.bodies("/api/net/net-mode").at(-1), "<request><NetworkMode>03</NetworkMode><NetworkBand>3FFFFFFF</NetworkBand><LTEBand>4</LTEBand><LTEBandOption>1</LTEBandOption></request>");
      assert.deepEqual([fx.cpe.settings.netMode.NetworkMode, fx.cpe.settings.netMode.LTEBandOption, fx.cpe.settings.netMode.LTEBand], ["03", "1", "4"], "the mode stayed 4G FDD only");
    } finally {
      await fx.cleanup();
    }
  });

  it("holds the session of a write the router answers once done for longer than the router may take", () => {
    // The H168-383's own page waits 240 s for a scan and a selection, 90 s for a mode; it took 76 s, 27 s and about one
    assert.deepEqual([OPERATOR_SCAN_TIMEOUT_MS, OPERATOR_SELECT_TIMEOUT_MS, NETWORK_MODE_TIMEOUT_MS], [240_000, 240_000, 90_000]);
    for (const action of ["scan_operators", "select_operator", "auto_restore_operator"] as const) assert.ok((CONTROL_HOLD_MS[action] ?? 0) > OPERATOR_SCAN_TIMEOUT_MS, action);
    for (const action of ["set_network_mode", "auto_restore_network_mode"] as const) assert.ok((CONTROL_HOLD_MS[action] ?? 0) > NETWORK_MODE_TIMEOUT_MS, action);
    assert.equal(CONTROL_HOLD_MS.reboot_cpe, undefined, "every other write keeps the client's bound");
  });

  it("selects an operator with Rat 255 where the router lists each operator once, and reads the clear back", async () => {
    const fx = fiveG();
    try {
      assert.ok(await fx.core.monitor.identifyDevice());
      await fx.core.controls.selectOperator({ mode: "manual", plmn: "27202", rat: "3G" }, { confirm: true });
      assert.deepEqual(fx.bodies("/api/net/register"), ["<request><Mode>1</Mode><Plmn>27202</Plmn><Rat>255</Rat></request>"]);
      await fx.core.controls.selectOperator({ mode: "auto" }, { confirm: true });
      assert.equal(fx.bodies("/api/net/register").at(-1), "<request><Mode>0</Mode><Plmn></Plmn><Rat></Rat></request>");
      await fx.core.controls.resetTraffic({ confirm: true });
      assert.deepEqual([fx.cpe.stats.trafficClears, fx.core.scheduler.genericWrites.at(-1)?.readback], [1, "match"]);
    } finally {
      await fx.cleanup();
    }
  });
});
