import assert from "node:assert/strict";
import crypto from "node:crypto";
import { describe, it } from "node:test";
import { CpeControlValidationError } from "../src/control-error.ts";
import { SectionUnavailableError } from "../src/cpe-domain.ts";
import { DriverCpeClient } from "../src/drivers/client.ts";
import { DriverLoginMethodError } from "../src/drivers/login.ts";
import { TplinkEnvelope, eccSeal, rsaSign, usableKey } from "../src/drivers/tplink/crypto.ts";
import { lteBandOfIndex } from "../src/drivers/bands.ts";
import { bandsOfMask, maskOfBands, mrApnView, mrLockState, mrModeCode, mrModeOf, mrProfileCreate, mrProfileEdit, mrProfileUse, nxBandList, nxLockState, nxModeOf, nxModes, nxSelection, parseMrOperators, parseNxBands, parseNxOperators, parseProfileList, tplinkDataLimit, tplinkServingBands, tplinkSimLock } from "../src/drivers/tplink/cellular.ts";
import { tplinkProtocol } from "../src/drivers/tplink/driver.ts";
import { exRequest, instance, instances, mrFrame, mrText, mrValue, parseExAnswer, parseMrAnswer, returnCode, scriptVar } from "../src/drivers/tplink/frames.ts";
import { TPLINK_SENT_BASE, type TplinkReadings, parseTplinkHosts, parseTplinkSmsPage, parseTplinkTelemetry } from "../src/drivers/tplink/parts.ts";
import type { DriverSms } from "../src/drivers/types.ts";
import { DeviceReadOnlyError } from "../src/scheduler.ts";
import { CpeAnswerFormatError, CpeApiError } from "../src/session-errors.ts";
import { cellularOf, daemonOn, fullSession, newCheck, noWait } from "./helpers/driver-daemon.ts";
import { LanRouterMock } from "./helpers/lan-router.ts";
import { TPLINK_HASHES, TPLINK_PASSWORD, TPLINK_PIN, TPLINK_URL, tplinkRouter } from "./helpers/tplink-router.ts";

/**
 * TP-Link's cellular routers on their own web interface, in both forms and every generation of its
 * encryption. Mocks only: the stand-in decrypts what FengSui sends the way the router does, so a
 * signature or a payload in the wrong form is refused, not accepted by a test that mirrors the code.
 */

const smsOf = (session: { sms?: DriverSms }): Required<DriverSms> => session.sms as Required<DriverSms>;
/** A poll in which the router answered nothing. */
const none: TplinkReadings = { info: null, link: null, intf: null, net: null, prof: null, cells: null, wan: null, cell: null, cfg: null };
const sendOptions = (onAccepted: () => void = () => undefined) => ({ statusTimeoutMs: 3000, sleep: noWait.sleep, onAccepted });

describe("tp-link: the page's encryption", () => {
  // A 512-bit modulus as a router hands one out, written out as a number: no key is made for the test
  const modulusHex = `c${"0".repeat(126)}1`;
  const exponentHex = "010001";

  it("encrypts a signature in blocks as long as the router's key, the last one filled with zero bytes", () => {
    const text = "key=1234567890123456&iv=6543210987654321&h=0123456789abcdef0123456789abcdef&s=266656789";
    const sign = rsaSign(text, { modulusHex, exponentHex }, "none");
    assert.equal(sign.length, 256, "two blocks of a 512-bit key, each 128 hexadecimal digits");
    const n = BigInt(`0x${modulusHex}`);
    const modPow = (base: bigint, exp: bigint): bigint => {
      let result = 1n;
      for (let b = base % n, e = exp; e > 0n; e >>= 1n, b = (b * b) % n) if (e & 1n) result = (result * b) % n;
      return result;
    };
    const blocks = [Buffer.from(text.slice(0, 64), "utf8"), Buffer.concat([Buffer.from(text.slice(64), "utf8"), Buffer.alloc(128 - text.length)])];
    assert.equal(sign, blocks.map((block) => modPow(BigInt(`0x${block.toString("hex")}`), 0x10001n).toString(16).padStart(128, "0")).join(""));
    assert.equal(rsaSign("h=abc&s=1", { modulusHex, exponentHex }, "none").length, 128, "a request's signature is one block");
    // OAEP leaves 22 bytes of room in a 512-bit block: this signature takes four
    assert.equal(rsaSign(text, { modulusHex, exponentHex }, "oaep").length, Math.ceil(text.length / 22) * 128);
    assert.equal(Math.ceil(text.length / 22), 4);
    assert.throws(() => rsaSign("h=1", { modulusHex: "c".repeat(64), exponentHex }, "oaep"), /too short/);
  });

  it("knows a key its page could use from one it could not", () => {
    assert.equal(usableKey({ kind: "rsa", modulusHex, exponentHex }), true);
    assert.equal(usableKey({ kind: "rsa", modulusHex: "abc", exponentHex }), false);
    assert.equal(usableKey({ kind: "rsa", modulusHex: `${modulusHex}0`, exponentHex }), false);
    assert.equal(usableKey({ kind: "rsa", modulusHex, exponentHex: "x" }), false);
    assert.equal(usableKey({ kind: "ecc", xHex: "a".repeat(56), yHex: "b".repeat(56) }), true);
    assert.equal(usableKey({ kind: "ecc", xHex: "a".repeat(55), yHex: "b".repeat(56) }), false);
    assert.throws(() => new TplinkEnvelope({ key: { kind: "rsa", modulusHex: "abc", exponentHex }, scheme: { cipher: "cbc", padding: "none" }, seq: 1, username: "admin", password: "x" }), /not one its page could use/);
    assert.throws(() => new TplinkEnvelope({ key: { kind: "rsa", modulusHex, exponentHex }, scheme: { cipher: "cbc", padding: "none" }, seq: 1, username: "admin", password: "x", aes: { key: "short", iv: "1234567890123456" } }), /wrong length/);
  });

  it("seals a signature for a curve point so that only the point's owner opens it", () => {
    const router = crypto.createECDH("secp224r1");
    router.generateKeys();
    const pub = router.getPublicKey();
    const sealed = eccSeal("h=abc&s=42", { xHex: pub.subarray(1, 29).toString("hex"), yHex: pub.subarray(29).toString("hex") });
    assert.deepEqual([sealed.iv.length, sealed.tag.length], [32, 112]);
    const kem = crypto.createHash("sha256").update(router.computeSecret(Buffer.from(`04${sealed.tag}`, "hex"))).digest().subarray(0, 16);
    const decipher = crypto.createDecipheriv("aes-128-cbc", kem, Buffer.from(sealed.iv, "hex"));
    assert.equal(Buffer.concat([decipher.update(Buffer.from(sealed.ct, "hex")), decipher.final()]).toString("utf8"), "h=abc&s=42");
    assert.notEqual(eccSeal("h=abc&s=42", { xHex: pub.subarray(1, 29).toString("hex"), yHex: pub.subarray(29).toString("hex") }).ct, sealed.ct, "a key pair of its own every time");
  });

  it("wraps a payload in each cipher and reads its own answer form back", () => {
    const key = { kind: "rsa", modulusHex, exponentHex } as const;
    const aes = { key: "1234567890123456", iv: "6543210987654321" };
    const cbc = new TplinkEnvelope({ key, scheme: { cipher: "cbc", padding: "none" }, seq: 100, username: "admin", password: "pw", aes });
    const sealed = cbc.seal("hello", false);
    assert.deepEqual([sealed.tag, sealed.sign.length, cbc.cipher], [null, 128, "cbc"]);
    assert.equal(cbc.body(sealed), `sign=${sealed.sign}\r\ndata=${sealed.data}\r\n`);
    assert.equal(cbc.open(sealed.data), "hello", "CBC answers are the same wrapping");
    assert.throws(() => cbc.open("not-base64-of-a-block"));
    const gcm = new TplinkEnvelope({ key, scheme: { cipher: "gcm", padding: "none" }, seq: 100, username: "admin", password: "pw", aes: { key: aes.key, iv: "123456789012" } });
    const g = gcm.seal("hello", false);
    assert.equal(g.tag?.length, 24);
    assert.equal(gcm.body(g), `sign=${g.sign}\r\ndata=${g.data}\r\ntag=${g.tag}\r\n`);
    assert.equal(gcm.open(`${g.data}${g.tag}`), "hello", "a GCM answer carries its tag at the end");
    assert.throws(() => gcm.open(`${g.data}${"A".repeat(22)}==`), "a wrong tag is refused");
    assert.throws(() => gcm.open("short"), /shorter than its tag/);
    // Random by default: two sessions never share a key
    const one = new TplinkEnvelope({ key, scheme: { cipher: "cbc", padding: "none" }, seq: 1, username: "admin", password: "pw" });
    const two = new TplinkEnvelope({ key, scheme: { cipher: "cbc", padding: "none" }, seq: 1, username: "admin", password: "pw" });
    assert.notEqual(one.seal("same", false).data, two.seal("same", false).data);
  });
});

describe("tp-link: the two request forms", () => {
  it("writes the MR series' frame: the action numbers, then a numbered block each", () => {
    assert.equal(mrFrame([{ operation: "get", oid: "LTE_BANDINFO" }]), "1\r\n[LTE_BANDINFO#0,0,0,0,0,0#0,0,0,0,0,0]0,0\r\n");
    assert.equal(mrFrame([{ operation: "cgi", oid: "/cgi/logout" }]), "8\r\n[/cgi/logout#0,0,0,0,0,0#0,0,0,0,0,0]0,0\r\n");
    assert.equal(
      mrFrame([
        { operation: "set", oid: "LTE_SMS_RECVMSGBOX", attrs: { PageNumber: "1" } },
        { operation: "list", oid: "LTE_SMS_RECVMSGENTRY", attrs: ["index", "from"] },
        { operation: "set", oid: "LTE_SMS_SENDNEWMSG", stack: "2,1,0,0,0,0", attrs: { textContent: "a\r\nb" } },
      ]),
      "2&5&2\r\n[LTE_SMS_RECVMSGBOX#0,0,0,0,0,0#0,0,0,0,0,0]0,1\r\nPageNumber=1\r\n[LTE_SMS_RECVMSGENTRY#0,0,0,0,0,0#0,0,0,0,0,0]1,2\r\nindex\r\nfrom\r\n[LTE_SMS_SENDNEWMSG#2,1,0,0,0,0#0,0,0,0,0,0]2,1\r\ntextContent=a\u0011\u0012b\r\n"
    );
    assert.equal(mrText(mrValue("a\r\nb\nc")), "a\r\nb\nc");
    assert.throws(() => mrFrame([{ operation: "get", oid: "BAD OID" }]), /Refusing the action/);
    assert.throws(() => mrFrame([{ operation: "get", oid: "X", stack: "1,2" }]), /Refusing the action/);
    assert.throws(() => mrFrame([{ operation: "set", oid: "X", attrs: { "a=b": "1" } }]), /Refusing an attribute/);
  });

  it("reads an MR answer block by block: one instance, a list with each instance's stack, the error at the end", () => {
    const answer = parseMrAnswer("[2,1,0,0,0,0]0\nsigLevel=4\nrfInfoRsrp=-95\n[1,0,0,0,0,0]1\nindex=0\ncontent=a\u0012b=c\n[2,0,0,0,0,0]1\nindex=1\n[cgi]3\n$.ret=0;\nvar x=1;\n[9,0,0,0,0,0]7\nignored=1\n[error]0\n", 4);
    assert.equal(answer.error, 0);
    assert.deepEqual({ ...instance(answer.results[0]) }, { stack: "2,1,0,0,0,0", sigLevel: "4", rfInfoRsrp: "-95" });
    assert.deepEqual(instances(answer.results[1]).map((entry) => ({ ...entry })), [{ stack: "1,0,0,0,0,0", index: "0", content: "a\nb=c" }, { stack: "2,0,0,0,0,0", index: "1" }]);
    assert.deepEqual([answer.results[2], answer.results[3]], [null, null], "an action that answered nothing, and a script's own text");
    assert.deepEqual(parseMrAnswer("[error]9805\n", 1), { error: 9805, results: [null] });
    assert.deepEqual(parseMrAnswer("garbage", 2), { error: null, results: [null, null] });
    assert.deepEqual([instances(null), instances(undefined), instance(null)], [[], [], null]);
  });

  it("writes the EX and NX series' JSON, one action each, a write marked as someone's own", () => {
    assert.equal(exRequest({ operation: "get", oid: "DEV2_LTE_LINK_CFG" }), '{"data":{"stack":"0,0,0,0,0,0","pstack":"0,0,0,0,0,0"},"operation":"go","oid":"DEV2_LTE_LINK_CFG"}');
    assert.equal(
      exRequest({ operation: "list", oid: "DEV2_LTE_SMS_RECVMSGENTRY", attrs: ["index", "from"] }),
      '{"data":{"index":"","from":"","stack":"0,0,0,0,0,0","pstack":"0,0,0,0,0,0"},"operation":"gl","oid":"DEV2_LTE_SMS_RECVMSGENTRY"}'
    );
    assert.equal(
      exRequest({ operation: "set", oid: "DEV2_LTE_SMS_RECVMSGENTRY", stack: "3,0,0,0,0,0", attrs: { unread: "0" } }),
      '{"data":{"unread":"0","stack":"3,0,0,0,0,0","pstack":"0,0,0,0,0,0"},"operation":"so","oid":"DEV2_LTE_SMS_RECVMSGENTRY","isuseractive":true}'
    );
    assert.deepEqual(["del", "add", "run", "getSub", "cgi"].map((operation) => (JSON.parse(exRequest({ operation: operation as "del", oid: "X" })) as { operation: string }).operation), ["do", "ao", "op", "gs", "cgi"]);
  });

  it("reads an EX answer, its return codes and the page's script variables", () => {
    assert.deepEqual(parseExAnswer('{"success":true,"errorcode":0,"data":{"networkType":"3","n":7,"skip":{"a":1}}}'), { ok: true, code: 0, result: Object.assign(Object.create(null), { networkType: "3", n: "7" }) });
    const list = parseExAnswer('{"success":true,\r\n"data":[{"band":"3"},"junk",{"band":"78"}]}');
    assert.deepEqual(instances(list.result).map((entry) => entry["band"]), ["3", "78"]);
    assert.deepEqual(parseExAnswer(""), { ok: true, code: null, result: null });
    assert.deepEqual(parseExAnswer('{"success":true}').result, null);
    assert.deepEqual([parseExAnswer('{"success":false,"errorcode":9804}').ok, parseExAnswer('{"success":true,"errorcode":"71013"}').ok, parseExAnswer('{"errorcode":"71013"}').code], [false, false, 71013]);
    assert.throws(() => parseExAnswer("<html>"), CpeAnswerFormatError);
    assert.deepEqual([returnCode("$.ret=0;\n"), returnCode("$.ret=71233;\nvar currAuthTimes=2;"), returnCode('{"ret":0}'), returnCode('{"ret":"71233"}'), returnCode('{"ret":"x"}'), returnCode("{broken"), returnCode("<html>")], [0, 71233, 0, 71233, null, null, null]);
    const page = 'var ee="010001";\nvar nn="ABCDEF";\nvar seq="266656725";\nvar isLogined=1;\nvar forbidTime = 7200 ;\n';
    assert.deepEqual(["ee", "nn", "seq", "isLogined", "forbidTime", "absent"].map((name) => scriptVar(page, name)), ["010001", "ABCDEF", "266656725", "1", "7200", null]);
  });
});

describe("tp-link: what the router answers, read into FengSui's shapes", () => {
  const info = { modelName: "Archer NX200", hardwareVersion: "Archer v2.0", softwareVersion: "1.3.0" };

  it("reads the serving cells of the EX and NX series: the 4G anchor, its second carrier, and the 5G leg", () => {
    const t = parseTplinkTelemetry({
      ...none,
      info,
      link: { networkType: "8", simStatus: "3" },
      intf: { totalStatistics: "2948105728.0", curRxSpeed: "125000", curTxSpeed: "25000" },
      net: { sigLevel: "4", rfInfoRsrp: "-95", rfInfoRsrq: "-11", rfInfoSnr: "140" },
      prof: { ispName: "Three" },
      cells: [
        { networkType: "3", cellConnectionStatus: "1", band: "1", ARFCN: "300", PCI: "211", cid: "134217758", TAC: "10001", RSRP: "-95", RSRQ: "-11", SNR: "110", RSSI: "-65", upBandWidth: "15000", downBandWidth: "20000", CQI: "12", RI: "2" },
        { networkType: "3", cellConnectionStatus: "1", band: "3", ARFCN: "1850", PCI: "142", RSRP: "-99", RSSI: "268435455", downBandWidth: "15000" },
        { networkType: "8", cellConnectionStatus: "1", band: "78", ARFCN: "650000", PCI: "142", SSRSRP: "-88", SSRSRQ: "-10", SSSINR: "185", RSRP: "268435455", downBandWidth: "100000" },
        { networkType: "8", cellConnectionStatus: "0", band: "1", ARFCN: "428000", PCI: "5" },
      ],
      wan: [{ enable: "1", connIPv4Address: "198.51.100.42", connStatusV4: "Connected" }],
    });
    assert.equal(t.mode, "NSA");
    assert.deepEqual([t.lte?.band, t.lte?.arfcn, t.lte?.pci, t.lte?.rsrpDbm, t.lte?.rsrqDb, t.lte?.sinrDb, t.lte?.rssiDbm, t.lte?.bandwidthMhz, t.lte?.ulBandwidthMhz, t.lte?.cellId, t.lte?.tac, t.lte?.cqi, t.lte?.mimoLayers], [1, 300, 211, -95, -11, 11, -65, 20, 15, "134217758", "10001", 12, 2]);
    assert.deepEqual([t.nr?.band, t.nr?.arfcn, t.nr?.pci, t.nr?.rsrpDbm, t.nr?.rsrqDb, t.nr?.sinrDb, t.nr?.bandwidthMhz], [78, 650000, 142, -88, -10, 18.5, 100]);
    assert.deepEqual(t.carriers, [{ rat: "LTE", band: 3, arfcn: 1850, pci: 142, bandwidthMhz: 15, rsrpDbm: -99, rsrqDb: null, rssiDbm: null, sinrDb: null }]);
    assert.deepEqual([t.model, t.softwareVersion, t.hardwareVersion, t.operatorName, t.signalBars], ["Archer NX200", "1.3.0", "Archer v2.0", "Three", 4]);
    assert.deepEqual(t.wan, { connected: true, ipv4: "198.51.100.42", ipv6: null, uptimeSec: null });
    assert.deepEqual([t.traffic?.downloadBytesPerSec, t.traffic?.uploadBytesPerSec, t.traffic?.monthTotalBytes], [125000, 25000, 2948105728n]);
    assert.equal(t.status?.sim?.state, "ready");
    // 5G alone is standalone, and its cell is the NR one
    const sa = parseTplinkTelemetry({ ...none, info, link: { networkType: "8" }, intf: null, net: null, prof: null, cells: [{ networkType: "8", cellConnectionStatus: "1", band: "78", ARFCN: "650000", PCI: "142", SSRSRP: "-90" }], wan: null });
    assert.deepEqual([sa.mode, sa.lte, sa.nr?.rsrpDbm, sa.traffic, sa.wan.connected], ["SA", null, -90, null, null]);
  });

  it("reads the MR series' signal and band, the cell where the firmware names it, and each state of the SIM card and the network", () => {
    const t = parseTplinkTelemetry({
      info: { modelName: "Archer MR600" },
      link: { enable: "1", connectStatus: "4", networkType: "7", roamingStatus: "1", simStatus: "4" },
      intf: { totalStatistics: "100", curRxSpeed: "0", curTxSpeed: "0" },
      net: { sigLevel: "3", rfInfoRsrp: "-101", rfInfoRsrq: "-12", rfInfoSnr: "65" },
      prof: { spn: "Three", ispName: "" },
      cells: null,
      wan: [{ enable: "0", connectionStatus: "Connected", externalIPAddress: "203.0.113.10" }, { enable: "1", connectionStatus: "Connecting", externalIPAddress: "0.0.0.0" }],
      cell: null,
      cfg: null,
    });
    assert.deepEqual([t.mode, t.lte?.band, t.lte?.arfcn, t.lte?.rsrpDbm, t.lte?.rsrqDb, t.lte?.sinrDb, t.nr, t.operatorName], ["LTE", null, null, -101, -12, 6.5, null, "Three"]);
    // The status names the band (and a second one next to it); the cell lock, where the firmware has one, the cell itself
    const named = (networkType: string, regStat: string) =>
      parseTplinkTelemetry({
        ...none,
        link: { networkType },
        net: { regStat, rfInfoBand: String(122 | (120 << 8)), rfInfoRsrp: "-95", rfInfoRssi: "-65" },
        cell: { rfInfoCellIDLock: "0", rfInfoCellID: "134217758", rfInfoEARFCN: "300", rfInfoPCI: "211" },
        cfg: { roamingEnabled: "1" },
      });
    const plain = named("3", "1");
    assert.deepEqual([plain.lte?.band, plain.lte?.arfcn, plain.lte?.pci, plain.lte?.cellId, plain.lte?.rssiDbm], [3, 300, 211, "134217758", -65]);
    assert.deepEqual(plain.carriers.map((c) => [c.rat, c.band, c.arfcn]), [["LTE", 1, null]]);
    assert.equal(plain.status?.roaming?.dataAllowed, true);
    const plus = named("7", "1");
    assert.deepEqual([plus.lte?.band, plus.lte?.arfcn, plus.lte?.pci], [3, null, null], "the status page shows the cell on plain 4G only");
    assert.deepEqual([named("3", "0").lte?.arfcn, named("2", "1").lte], [null, null], "not registered, or on 3G: no 4G cell to name");
    const noBand = parseTplinkTelemetry({ ...none, link: { networkType: "3" }, net: { rfInfoBand: "-1", rfInfoRsrp: "-95" } });
    assert.deepEqual([noBand.lte?.band, noBand.carriers], [null, []]);
    assert.deepEqual([t.wan.connected, t.wan.ipv4], [false, null], "a connection that is switched off does not count");
    assert.deepEqual(t.status?.sim?.state, "pin_required");
    assert.deepEqual(t.status?.roaming, { active: true, dataAllowed: null });
    const state = (simStatus: string): unknown => parseTplinkTelemetry({ ...none, link: { simStatus } }).status?.sim?.state;
    assert.deepEqual(["0", "1", "2", "3", "5", "6", "7", "8", "x"].map(state), [null, "absent", "error", "ready", "ready", "puk_required", "error", null, null]);
    const mode = (networkType: string): unknown => parseTplinkTelemetry({ ...none, link: { networkType }, net: { rfInfoRsrp: "-90" } }).mode;
    assert.deepEqual(["0", "1", "2", "3", "7", "8", "9"].map(mode), ["NONE", null, "WCDMA", "LTE", "LTE", "SA", null]);
    const bare = parseTplinkTelemetry(none);
    assert.deepEqual([bare.mode, bare.lte, bare.nr, bare.model, bare.signalBars], [null, null, null, null, null]);
  });

  it("lists the devices that are there now, by how each is connected", () => {
    const hosts = parseTplinkHosts([
      { MACAddress: "02:00:5E:10:00:01", IPAddress: "192.168.1.100", hostName: "phone", X_TP_ConnType: "3", active: "1", leaseTimeRemaining: "3600" },
      { physAddress: "02:00:5E:10:00:02", IPAddress: "192.168.1.2", hostName: "nas", X_TP_LanConnType: "0", active: "1" },
      { MACAddress: "00:00:5E:00:53:01", X_TP_ConnType: "1", active: "0" },
      { MACAddress: "02:00:5E:10:00:03", X_TP_ConnType: "5", active: "1" },
      { hostName: "no address" },
    ]);
    assert.deepEqual(hosts.map((h) => [h.mac, h.name, h.ipv4, h.link, h.leaseSec]), [["02:00:5E:10:00:01", "phone", "192.168.1.100", "wifi_5", 3600], ["02:00:5E:10:00:02", "nas", "192.168.1.2", "lan", null], ["02:00:5E:10:00:03", null, null, "wifi", null]]);
    assert.deepEqual(parseTplinkHosts(null), []);
  });

  it("reads a page of a box, each message with where a write will find it", () => {
    const inbox = parseTplinkSmsPage([{ stack: "1,0,0,0,0,0", index: "0", from: "+353830000001", content: "Hello", receivedTime: "2026-10-10 04:07:40", unread: "1" }, { stack: "2,0,0,0,0,0", index: "x" }, { index: "3" }], 2, "in");
    assert.deepEqual(inbox.map((e) => [e.page, e.stack, e.message.index, e.message.phone, e.message.date, e.message.isUnread, e.message.direction]), [[2, "1,0,0,0,0,0", 1, "+353830000001", "2026-10-10 04:07:40", true, "in"]]);
    const outbox = parseTplinkSmsPage({ stack: "1,0,0,0,0,0", index: "4", to: "+353830000002", content: "Bye", sendTime: "2026-10-11T10:00:00", unread: "1" }, 1, "out");
    assert.deepEqual(outbox.map((e) => [e.message.index, e.message.phone, e.message.date, e.message.isUnread, e.message.direction]), [[TPLINK_SENT_BASE + 5, "+353830000002", "2026-10-11 10:00:00", false, "out"]]);
  });
});

describe("tp-link: signing in and out", () => {
  it("signs in to the MR series as its page does, reads in one frame, and signs out", async () => {
    const { mock, client, state, logins, actions } = tplinkRouter();
    const t = await client.withSession((s) => s.telemetry());
    assert.deepEqual([t?.mode, t?.lte?.band, t?.lte?.rsrpDbm, t?.lte?.sinrDb, t?.model, t?.wan.ipv4], ["LTE", 3, -95, 14, "Archer MR600", "198.51.100.42"]);
    assert.deepEqual(mock.trail, ["GET /", "POST /cgi/getBusy", "POST /cgi/getGDPRParm", "POST /cgi/getParm", "GET /js/tpEncrypt.js", "POST /cgi/login", "GET /", ...Array.from({ length: 6 }, () => "POST /cgi_gdpr")]);
    assert.deepEqual(logins.map((l) => [l.username, l.password, Object.keys(l.sign)]), [["admin", TPLINK_PASSWORD, ["key", "iv", "h", "s"]]]);
    assert.equal(logins[0]?.sign["h"], TPLINK_HASHES.md5["admin"]);
    const login = mock.requests[5];
    assert.deepEqual([login?.body, login?.query.get("Action"), login?.query.get("LoginStatus"), login?.query.get("isMobile"), login?.headers["referer"]], ["", "1", "0", "0", `${TPLINK_URL}/`]);
    const command = mock.requests[7];
    assert.match(command?.headers["cookie"] ?? "", /^JSESSIONID=c10ffee5e55104; loginErrorShow=1$/);
    assert.deepEqual([command?.headers["tokenid"], command?.headers["content-type"]], ["t0ken1abcdef0123", "text/plain"]);
    assert.match(command?.body ?? "", /^sign=[0-9a-f]+\r\ndata=[A-Za-z0-9+/=]+\r\n$/);
    assert.deepEqual(actions.map((a) => `${a.operation} ${a.oid} ${a.stack}`), [
      "get WAN_LTE_LINK_CFG 2,1,0,0,0,0",
      "get WAN_LTE_INTF_CFG 2,0,0,0,0,0",
      "get LTE_NET_STATUS 2,1,0,0,0,0",
      "get LTE_PROF_STAT 2,1,0,0,0,0",
      "getSub WAN_IP_CONN 0,0,0,0,0,0",
      "get LTE_CELL_LOCK 0,0,0,0,0,0",
      "get LTE_WAN_CFG 2,1,0,0,0,0",
      "get IGD_DEV_INFO 0,0,0,0,0,0",
      "cgi /cgi/logout 0,0,0,0,0,0",
    ]);
    assert.deepEqual([state.session, state.loggedOut], [null, 1], "the router's session is closed");
    const sent = mock.requests.map((r) => `${r.body} ${[...r.query.values()].join(" ")}`).join(" ");
    assert.ok(!sent.includes(TPLINK_PASSWORD), "the password never goes out as typed");
  });

  it("signs in to the EX and NX series with the login as an action, and says which form the router speaks", async () => {
    const { mock, client, logins, actions } = tplinkRouter({ form: "ex" });
    const identity = await client.withSession((s) => s.identify());
    assert.deepEqual(identity, { model: "Archer NX200", softwareVersion: "1.3.0 0.9.1 v0001.0 Build 250101", hardwareVersion: "Archer v2.0", variant: "ex" });
    assert.deepEqual(mock.trail, ["GET /", "POST /cgi/getBusy", "POST /cgi/getGDPRParm", "GET /js/tpEncrypt.js", "POST /cgi_gdpr", "GET /", "POST /cgi_gdpr", "POST /cgi_gdpr"]);
    assert.deepEqual(logins.map((l) => [l.username, l.password]), [["user", TPLINK_PASSWORD]], "the page's own user name where none was given");
    assert.equal(mock.requests[4]?.headers["x-requested-with"], "XMLHttpRequest");
    assert.equal(mock.requests[6]?.headers["cookie"], "JSESSIONID=c10ffee5e55104");
    assert.deepEqual(actions.map((a) => `${a.operation} ${a.oid}`), ["get DEV2_DEV_INFO", "cgi /cgi/logout"]);
    const t = await client.withSession((s) => s.telemetry());
    assert.deepEqual([t?.mode, t?.lte?.band, t?.lte?.pci, t?.nr?.band, t?.nr?.rsrpDbm, t?.carriers.length], ["NSA", 1, 211, 78, -88, 1]);
    // A user name the owner typed is the one sent
    const named = tplinkRouter({ form: "ex", username: "owner" });
    const withName = new DriverCpeClient({ protocol: tplinkProtocol, cpeUrl: TPLINK_URL, cpeUsername: "owner", cpePassword: TPLINK_PASSWORD, fetchImpl: named.mock.fetchImpl });
    assert.equal((await withName.withSession((s) => s.identify()))?.model, "Archer NX200");
  });

  it("speaks each generation of the encryption a router's own script and key name", async () => {
    for (const options of [{ form: "ex", cipher: "gcm" }, { form: "ex", cipher: "gcm", padding: "oaep" }, { form: "mr", padding: "oaep" }, { form: "mr", ecc: true }, { form: "ex", script: { status: 404, text: "<html>404</html>" } }] as const) {
      const { client, logins, mock } = tplinkRouter(options);
      const t = await client.withSession((s) => s.telemetry());
      assert.equal(t?.signalBars, 4, JSON.stringify(options));
      assert.equal(logins.length, 1, "one login, in the right form the first time");
      if ("ecc" in options) {
        assert.equal(logins[0]?.sign["h"], TPLINK_HASHES.sha256["admin"], "the curve generation hashes with SHA-256");
        assert.ok(!mock.trail.includes("GET /js/tpEncrypt.js"), "a curve point settles the form by itself");
      }
    }
  });

  it("sends no password where it cannot tell the form: no key, or a cipher nobody recorded a login for", async () => {
    const gcmOnMr = tplinkRouter({ form: "mr", cipher: "gcm" });
    await assert.rejects(gcmOnMr.client.withSession((s) => s.telemetry()), DriverLoginMethodError);
    assert.equal(gcmOnMr.logins.length, 0);
    assert.ok(!gcmOnMr.mock.trail.includes("POST /cgi/login"));
    assert.equal(gcmOnMr.client.getCircuitBreakerState().tripped, false, "nothing was tried, nothing latched");
    for (const keyAnswer of [{ text: "<html>Login</html>" }, { text: 'var ee="010001";\nvar nn="abc";\nvar seq="1";' }, { text: 'var ee="010001";\nvar nn="' + "ab".repeat(64) + '";\nvar seq="x";' }, { text: "{broken" }, { json: { eccPubKey_X_HEX: "ab", eccPubKey_Y_HEX: "cd", seq: "1" } }, { json: { ret: 0 } }]) {
      const other = new LanRouterMock((req) => (req.path.startsWith("/cgi/get") && req.path !== "/cgi/getBusy" ? keyAnswer : { status: 404, text: "" }));
      const client = new DriverCpeClient({ protocol: tplinkProtocol, cpeUrl: TPLINK_URL, cpePassword: TPLINK_PASSWORD, fetchImpl: other.fetchImpl });
      await assert.rejects(client.withSession((s) => s.telemetry()), DriverLoginMethodError);
      assert.equal(await tplinkProtocol.detect(new (await import("../src/protocols/transport.ts")).LanHttp({ baseUrl: TPLINK_URL, fetchImpl: other.fetchImpl, timeoutMs: 1000, signal: new AbortController().signal })), false);
    }
    // The script that names the cipher could not be read (an error, or a page in its place): which form applies is not settled
    for (const script of [{ status: 500, text: "" }, { status: 403, text: "Forbidden" }, { text: "<html><body>Login</body></html>" }]) {
      const unread = tplinkRouter({ form: "ex", cipher: "gcm", script });
      await assert.rejects(unread.client.withSession((s) => s.telemetry()), DriverLoginMethodError, JSON.stringify(script));
      assert.equal(unread.logins.length, 0, "no password in a form that may be the wrong one");
    }
    const lineBreak = tplinkRouter();
    const odd = new DriverCpeClient({ protocol: tplinkProtocol, cpeUrl: TPLINK_URL, cpePassword: "pass\nword", fetchImpl: lineBreak.mock.fetchImpl });
    await assert.rejects(odd.withSession((s) => s.telemetry()), DriverLoginMethodError);
    assert.equal(lineBreak.logins.length, 0);
  });

  it("yields to someone signed in to the router's page, and stays away from a login the page shows locked", async () => {
    const busy = tplinkRouter({ busy: true });
    assert.equal((await busy.client.withSessionDetailed((s) => s.telemetry())).status, "yielded");
    assert.deepEqual(busy.mock.trail, ["GET /", "POST /cgi/getBusy"], "nothing after the two login-free reads");
    const locked = tplinkRouter({ forbidSec: 7200 });
    await assert.rejects(locked.client.withSession((s) => s.telemetry()), (err: unknown) => err instanceof CpeApiError && err.code === "108007" && err.waitTime === 7200);
    assert.equal(locked.logins.length, 0, "no password goes to a locked login");
    // A router whose page shows neither is signed in to as usual
    const plain = new LanRouterMock(() => ({ status: 404, text: "" }));
    const client = new DriverCpeClient({ protocol: tplinkProtocol, cpeUrl: TPLINK_URL, cpePassword: TPLINK_PASSWORD, fetchImpl: plain.fetchImpl });
    await assert.rejects(client.withSession((s) => s.telemetry()), DriverLoginMethodError);
  });

  it("latches on a wrong password with the attempts the router says are left, on its lock, and on an answer it cannot place", async () => {
    for (const form of ["mr", "ex"] as const) {
      const wrong = tplinkRouter({ form });
      const client = new DriverCpeClient({ protocol: tplinkProtocol, cpeUrl: TPLINK_URL, cpePassword: "wrong-password", fetchImpl: wrong.mock.fetchImpl });
      await assert.rejects(client.withSession((s) => s.telemetry()), (err: unknown) => err instanceof CpeApiError && err.code === "108006" && err.remainCount === 4, form);
      assert.equal(client.getCircuitBreakerState().tripped, true);
      await assert.rejects(client.withSession((s) => s.telemetry()));
      assert.equal(wrong.logins.length, 1, "a latched breaker sends nothing");
      assert.equal(wrong.state.session, null);
    }
    const fifth = tplinkRouter();
    fifth.state.authTimes = 4;
    const last = new DriverCpeClient({ protocol: tplinkProtocol, cpeUrl: TPLINK_URL, cpePassword: "wrong-password", fetchImpl: fifth.mock.fetchImpl });
    await assert.rejects(last.withSession((s) => s.telemetry()), (err: unknown) => err instanceof CpeApiError && err.code === "108007" && err.waitTime === 7200);
    // Firmware that answers a wrong password like a right one, only without a session
    const silent = tplinkRouter({ silentRefusal: true });
    const quiet = new DriverCpeClient({ protocol: tplinkProtocol, cpeUrl: TPLINK_URL, cpePassword: "wrong-password", fetchImpl: silent.mock.fetchImpl });
    await assert.rejects(quiet.withSession((s) => s.telemetry()), (err: unknown) => err instanceof CpeApiError && err.code === "108006" && err.remainCount === null);
    for (const loginAnswer of ["$.ret=71234;\n", "$.ret=9001;\n", "<html>no return code</html>", ""]) {
      for (const form of ["mr", "ex"] as const) {
        const odd = tplinkRouter({ form, loginAnswer });
        await assert.rejects(odd.client.withSession((s) => s.telemetry()), (err: unknown) => err instanceof CpeApiError && err.latchesBreaker, `${form} ${loginAnswer}`);
        assert.equal(odd.logins.length, 1);
      }
    }
  });

  it("latches when the page hands out no token after a login, and fails a read the router no longer answers", async () => {
    const noToken = new LanRouterMock((req) => {
      const real = tplinkRouter();
      void real;
      return req.path === "/cgi/getParm" ? { text: `var ee="010001";\nvar nn="c${"0".repeat(126)}1";\nvar seq="1";\n$.ret=0;` } : req.path === "/cgi/login" ? { text: "$.ret=0;", setCookie: ["JSESSIONID=abc123; Path=/"] } : req.path === "/" ? { text: "<html>home</html>" } : { status: 404, text: "" };
    });
    const client = new DriverCpeClient({ protocol: tplinkProtocol, cpeUrl: TPLINK_URL, cpePassword: TPLINK_PASSWORD, fetchImpl: noToken.fetchImpl });
    // FengSui cannot tell whether it is signed in: it latches rather than send the password again on the next poll
    await assert.rejects(client.withSession((s) => s.telemetry()), (err: unknown) => err instanceof CpeApiError && err.latchesBreaker && /no token after the login/.test(err.message));
    assert.equal(client.getCircuitBreakerState().tripped, true);
    await assert.rejects(client.withSession((s) => s.telemetry()));
    assert.equal(noToken.requests.filter((r) => r.path === "/cgi/login").length, 1, "the password went out once");
    // The router may hold a session for the cookie it set: the page's logout is tried once so the seat is not kept
    const tried = noToken.requests.filter((r) => r.path === "/cgi_gdpr");
    assert.deepEqual([tried.length, tried[0]?.headers["cookie"], tried[0]?.headers["tokenid"]], [1, "JSESSIONID=abc123; loginErrorShow=1", undefined]);
    const { client: ok, state } = tplinkRouter();
    await ok.withSession(async (s) => {
      await s.telemetry();
      // Someone signed in to the page meanwhile: the router no longer knows this session
      state.session = null;
      await assert.rejects(s.telemetry(), (err: unknown) => err instanceof CpeApiError && err.code === "session");
    });
  });
});

describe("tp-link: reads and writes", () => {
  it("costs a poll only the part a firmware lacks, has no nearby cells, and refuses a lock its firmware has no form for", async () => {
    const { client } = tplinkRouter({ form: "ex", missing: ["LTE_SERVING_CELL_INFO", "ADT_WAN", "DEV_INFO", "LTE_WAN_CFG", "LTE_BAND_SEARCH", "LTE_4G_CELL_LOCK", "LTE_5G_CELL_LOCK"] });
    await client.withSession(async (s) => {
      const t = await s.telemetry();
      assert.deepEqual([t.mode, t.nr?.rsrpDbm, t.nr?.band, t.lte, t.wan.connected, t.model], ["SA", -95, null, null, null, null]);
      assert.equal((await fullSession(s).hosts()).length, 2);
      await assert.rejects(s.neighbours(), SectionUnavailableError);
      assert.deepEqual(await s.lockState(), { lteBands: null, nrBands: null, lteCell: null, nrCell: null, networkMode: null, supportedLte: null, supportedNr: null });
      const check = newCheck();
      await assert.rejects(s.setBandLock({ lte: [1], nr: null, networkMode: null }, check), CpeControlValidationError);
      await assert.rejects(s.setCellLock({ rat: "LTE", band: 1, arfcn: 300, pci: 211, scsKhz: null }, check), CpeControlValidationError);
      await assert.rejects(s.unlockAll(check), CpeControlValidationError);
      assert.deepEqual(check.endpoints, []);
    });
    const refusing = tplinkRouter({ missing: ["LTE_NET_STATUS"] });
    await assert.rejects(refusing.client.withSession((s) => s.telemetry()), (err: unknown) => err instanceof CpeApiError && err.code === "9804");
    const exRefusing = tplinkRouter({ form: "ex", missing: ["LTE_NET_STATUS"] });
    await assert.rejects(exRefusing.client.withSession((s) => s.telemetry()), (err: unknown) => err instanceof CpeApiError && err.code === "9804");
  });

  it("reboots once and ends the session", async () => {
    for (const form of ["mr", "ex"] as const) {
      const { client, state, actions } = tplinkRouter({ form });
      await client.withSession(async (s) => {
        const check = newCheck();
        await s.reboot(check);
        assert.deepEqual([check.endpoints, check.readback, s.open], [["tplink:ACT_REBOOT"], "pending", false]);
        await assert.rejects(s.telemetry(), /session is over/);
      });
      assert.equal(state.rebooted, true);
      assert.deepEqual(actions.map((a) => a.oid), ["ACT_REBOOT"], "no logout the restarting router could not answer");
    }
  });

  it("lists both boxes of the MR series page by page, with the router's own counts", async () => {
    const inbox = Array.from({ length: 11 }, (_, i) => ({ index: i, from: "+353830000001", content: `message ${i}`, time: "2026-10-10 04:07:40", unread: i < 3 }));
    const { client, actions } = tplinkRouter({ inbox });
    await client.withSession(async (s) => {
      const sms = smsOf(s);
      const messages = await sms.list();
      assert.equal(messages.length, 12);
      assert.deepEqual(messages.slice(0, 2).map((m) => [m.index, m.content, m.isUnread, m.direction]), [[1, "message 0", true, "in"], [2, "message 1", true, "in"]]);
      assert.deepEqual([messages.at(-1)?.index, messages.at(-1)?.phone, messages.at(-1)?.direction, messages.at(-1)?.isUnread], [TPLINK_SENT_BASE + 1, "+353830000002", "out", false]);
      assert.deepEqual(await sms.counters(), { localUnread: 3, localInbox: 11, localOutbox: 1, localDraft: 0, localMax: 0 });
      assert.equal(sms.keepsSent, true);
    });
    assert.deepEqual(actions.filter((a) => a.operation === "set").map((a) => [a.oid, a.attrs["PageNumber"]]), [["LTE_SMS_RECVMSGBOX", "1"], ["LTE_SMS_RECVMSGBOX", "2"], ["LTE_SMS_SENDMSGBOX", "1"]]);
  });

  it("reads the inbox alone on the EX and NX series, and keeps what it sends there itself", async () => {
    const { client, actions } = tplinkRouter({ form: "ex" });
    await client.withSession(async (s) => {
      const sms = smsOf(s);
      assert.deepEqual((await sms.list()).map((m) => [m.index, m.phone, m.content, m.isUnread]), [[1, "+353830000001", "Hello\nworld", true], [2, "DemoBank", "Balance ready", false]]);
      assert.deepEqual(await sms.counters(), { localUnread: 1, localInbox: 2, localOutbox: 0, localDraft: 0, localMax: 0 });
      assert.equal(sms.keepsSent, false);
    });
    assert.deepEqual(actions.filter((a) => a.operation === "set").map((a) => [a.oid, a.attrs["pageNumber"]]), [["DEV2_LTE_SMS_RECVMSGBOX", "1"]]);
    const none = tplinkRouter({ form: "ex", missing: ["LTE_SMS_RECVMSGENTRY"] });
    await none.client.withSession(async (s) => {
      await assert.rejects(smsOf(s).list(), CpeApiError);
    });
  });

  it("sends a message once and asks the MR series how it went", async () => {
    const sent = tplinkRouter();
    await sent.client.withSession(async (s) => {
      let accepted = 0;
      const check = newCheck();
      const outcome = await smsOf(s).send("+353830000003", "Line one\nLine two", check, sendOptions(() => (accepted += 1)));
      assert.deepEqual([outcome, accepted, check.endpoints], [{ state: "sent", code: null }, 1, ["tplink:LTE_SMS_SENDNEWMSG.set"]]);
    });
    assert.deepEqual(sent.state.outbox[0], { index: 1, to: "+353830000003", content: "Line one\nLine two", time: "2026-10-12 08:00:00" });
    assert.equal(sent.actions.filter((a) => a.operation === "set" && a.oid === "LTE_SMS_SENDNEWMSG").length, 1);
    const pending = tplinkRouter({ sendResult: 3 });
    await pending.client.withSession(async (s) => {
      assert.deepEqual(await smsOf(s).send("+353830000003", "Hello", newCheck(), sendOptions()), { state: "unconfirmed", code: null });
    });
    assert.equal(pending.actions.filter((a) => a.operation === "get" && a.oid === "LTE_SMS_SENDNEWMSG").length, 4, "asked until the wait is over, never sent again");
    assert.equal(pending.actions.filter((a) => a.operation === "set" && a.oid === "LTE_SMS_SENDNEWMSG").length, 1);
    const failed = tplinkRouter({ sendResult: 2 });
    await failed.client.withSession(async (s) => {
      assert.deepEqual(await smsOf(s).send("+353830000003", "Hello", newCheck(), sendOptions()), { state: "failed", code: "sms-2" });
    });
    const refused = tplinkRouter({ refuse: "LTE_SMS_SENDNEWMSG" });
    await refused.client.withSession(async (s) => {
      let accepted = 0;
      await assert.rejects(smsOf(s).send("+353830000003", "Hello", newCheck(), sendOptions(() => (accepted += 1))), (err: unknown) => err instanceof CpeApiError && err.code === "71013");
      assert.equal(accepted, 0);
    });
    // The other form has no read of the result on record
    const ex = tplinkRouter({ form: "ex" });
    await ex.client.withSession(async (s) => {
      const check = newCheck();
      assert.deepEqual(await smsOf(s).send("+353830000003", "Hello", check, sendOptions()), { state: "unconfirmed", code: null });
      assert.deepEqual(check.endpoints, ["tplink:DEV2_LTE_SMS_SENDNEWMSG.set"]);
    });
    assert.equal(ex.actions.at(-2)?.attrs["textContent"], "Hello");
  });

  it("marks read and deletes one message at a time, each found again on its page before the write", async () => {
    for (const form of ["mr", "ex"] as const) {
      const inbox = Array.from({ length: 10 }, (_, i) => ({ index: i, from: "+353830000001", content: `message ${i}`, time: "2026-10-10 04:07:40", unread: true }));
      const { client, state, actions } = tplinkRouter({ form, inbox, outbox: [{ index: 0, to: "+353830000002", content: "sent", time: "2026-10-11 10:00:00" }] });
      const entry = form === "mr" ? "LTE_SMS_RECVMSGENTRY" : "DEV2_LTE_SMS_RECVMSGENTRY";
      await client.withSession(async (s) => {
        const sms = smsOf(s);
        const read = newCheck();
        await sms.markRead([10, 999], read);
        assert.deepEqual([read.endpoints, read.readback], [[`tplink:${entry}.set`], "match"], form);
        assert.deepEqual(state.inbox.map((m) => m.unread), [true, true, true, true, true, true, true, true, true, false], "the tenth message is the second of page two");
        const gone = newCheck();
        await sms.delete([1, 2], gone);
        assert.deepEqual([gone.endpoints, gone.readback], [[`tplink:${entry}.del`], "match"]);
        assert.deepEqual(state.inbox.map((m) => m.index), [2, 3, 4, 5, 6, 7, 8, 9], "the second delete found its message where the first one moved it");
      });
      const writes = actions.filter((a) => a.oid.endsWith("RECVMSGENTRY") && (a.operation === "set" || a.operation === "del")).map((a) => [a.operation, a.stack]);
      assert.deepEqual(writes, [["set", "2,0,0,0,0,0"], ["del", "1,0,0,0,0,0"], ["del", "1,0,0,0,0,0"]]);
      if (form === "mr") {
        await client.withSession(async (s) => {
          const check = newCheck();
          await smsOf(s).delete([TPLINK_SENT_BASE + 1], check);
          assert.deepEqual([check.endpoints, check.readback, state.outbox.length], [["tplink:LTE_SMS_SENDMSGENTRY.del"], "match", 0]);
        });
      } else {
        await client.withSession(async (s) => {
          const check = newCheck();
          await smsOf(s).delete([TPLINK_SENT_BASE + 1], check);
          assert.deepEqual(check.endpoints, [], "no sent box on this form: nothing to write");
        });
      }
    }
  });

  it("sends a USSD code, waits for the network's answer, replies inside a session and ends one", async () => {
    const answered = tplinkRouter({ ussdAnswer: "Your balance: 5.00\u0012Thank you" });
    await answered.client.withSession(async (s) => {
      const check = newCheck();
      assert.deepEqual(await cellularOf(s).ussd({ kind: "send", code: "*100#" }, check, noWait), { state: "answered", text: "Your balance: 5.00\nThank you", awaitsReply: false });
      assert.deepEqual([check.endpoints, check.readback], [["tplink:LTE_USSD.set"], "none"]);
      const end = newCheck();
      assert.deepEqual(await cellularOf(s).ussd({ kind: "cancel" }, end, noWait), { state: "cancelled", text: null, awaitsReply: false });
      assert.deepEqual(end.endpoints, ["tplink:LTE_USSD.set"]);
    });
    assert.deepEqual(answered.actions.filter((a) => a.operation === "set").map((a) => a.attrs), [{ action: "1", reqContent: "*100#" }, { action: "2" }]);
    // An answer that leaves the session open awaits a reply, which is sent like a code; the other form has the same page
    const asking = tplinkRouter({ form: "ex", ussdAnswer: "1 Balance 2 Offers?" });
    await asking.client.withSession(async (s) => {
      assert.deepEqual(await cellularOf(s).ussd({ kind: "send", code: "*100#" }, newCheck(), noWait), { state: "answered", text: "1 Balance 2 Offers?", awaitsReply: true });
      assert.equal((await cellularOf(s).ussd({ kind: "reply", code: "1" }, newCheck(), noWait)).state, "answered");
    });
    assert.deepEqual(asking.actions.filter((a) => a.operation === "set").map((a) => [a.oid, a.attrs]), [["DEV2_LTE_USSD", { action: "1", reqContent: "*100#" }], ["DEV2_LTE_USSD", { action: "1", reqContent: "1" }]]);
    const failed = tplinkRouter({ ussdAnswer: null });
    await failed.client.withSession(async (s) => {
      assert.deepEqual(await cellularOf(s).ussd({ kind: "send", code: "*100#" }, newCheck(), noWait), { state: "no_answer", text: null, awaitsReply: false });
    });
    assert.equal(failed.actions.filter((a) => a.operation === "get" && a.oid === "LTE_USSD").length, 1, "the router gave up: no more asking");
    const silent = tplinkRouter();
    await silent.client.withSession(async (s) => {
      assert.equal((await cellularOf(s).ussd({ kind: "send", code: "*100#" }, newCheck(), noWait)).state, "no_answer");
    });
    assert.equal(silent.actions.filter((a) => a.operation === "get" && a.oid === "LTE_USSD").length, 30);
  });
});

describe("tp-link: the page's cellular forms, read", () => {
  it("names the band the status reports, and a second one next to it", () => {
    assert.deepEqual(tplinkServingBands(String(122 | (120 << 8))), { primary: 3, secondary: 1 });
    assert.deepEqual(tplinkServingBands("126"), { primary: 7, secondary: null });
    assert.deepEqual([tplinkServingBands("-1"), tplinkServingBands("0"), tplinkServingBands(undefined), tplinkServingBands("80")].map((b) => b.primary), [null, null, null, null], "none, or a 3G band");
    assert.deepEqual(tplinkServingBands(String(80 | (120 << 8))), { primary: null, secondary: null }, "no 4G band, no second one");
    assert.deepEqual([120, 133, 134, 149, 158, 119, 155, 1.5].map(lteBandOfIndex), [1, 14, 17, 41, 28, null, null, null]);
  });

  it("writes the MR series' band selection as the page's two masks, and reads them back", () => {
    assert.deepEqual(maskOfBands([1, 3, 20]), { low: 0b10000000000000000101, high: 0 });
    assert.deepEqual(maskOfBands([31, 38, 40]), { low: 0x40000000, high: 0b10100000 });
    assert.deepEqual([maskOfBands([32]), maskOfBands([64]), maskOfBands([0]), maskOfBands([1.5])], [null, null, null, null], "the sign bit is one the page's own form cannot write");
    assert.deepEqual(bandsOfMask("524293", "160"), [1, 3, 20, 38, 40]);
    assert.deepEqual([bandsOfMask("0", "0"), bandsOfMask("x", "0"), bandsOfMask("-2147483648", "0")], [[], null, null]);
    const locked = mrLockState({ bandSelectSwitch: "1", bandSelectedMaskL: "5", bandSelectedMaskH: "0", networkPreferredMode: "2" }, { rfInfoCellIDLock: "1", rfInfoEARFCN: "300", rfInfoPCI: "211" });
    assert.deepEqual(locked, { lteBands: [1, 3], nrBands: null, lteCell: { locked: true, arfcn: 300, pci: 211, band: null }, nrCell: null, networkMode: "lte", supportedLte: null, supportedNr: null });
    const open = mrLockState({ bandSelectSwitch: "0", networkPreferredMode: "3" }, { rfInfoCellIDLock: "0", rfInfoEARFCN: "300", rfInfoPCI: "211" });
    assert.deepEqual([open.lteBands, open.lteCell, open.networkMode], ["all", { locked: false }, "auto"]);
    assert.deepEqual(mrLockState(null, null), { lteBands: null, nrBands: null, lteCell: null, nrCell: null, networkMode: null, supportedLte: null, supportedNr: null });
    assert.deepEqual([mrLockState({ networkPreferredMode: "1" }, {}).networkMode, mrLockState({}, {}).lteCell], [null, null], "3G only is no mode a lock names; a lock that says nothing is not read");
    assert.deepEqual([mrModeOf("3"), mrModeOf("1"), mrModeOf("9"), mrModeCode("lte"), mrModeCode("nr_sa")], ["auto", "wcdma", null, "2", null]);
  });

  it("reads and writes the EX and NX series' band lists: 4G, 5G standalone, 5G next to 4G", () => {
    const supported = parseNxBands("W1;B1;B3;B7;N1;N28;N78S;N78N;N79N;junk;B0;");
    assert.deepEqual(supported, { lte: [1, 3, 7], nrSa: [1, 28, 78], nrNsa: [1, 28, 78, 79] });
    assert.equal(parseNxBands(undefined), null);
    assert.ok(supported);
    assert.equal(nxBandList({ lte: [1, 3], nrSa: [78], nrNsa: [78, 79] }), "B1;B3;N78S;N78N;N79N;");
    // 4G bands from the request; 5G bands it leaves alone stay as they are selected (all of them when nothing is)
    assert.deepEqual(nxSelection({ lte: [1, 3], nr: null }, supported, null), { lte: [1, 3], nrSa: [1, 28, 78], nrNsa: [1, 28, 78, 79] });
    assert.deepEqual(nxSelection({ lte: [3, 1], nr: null }, supported, { lte: [7], nrSa: [78], nrNsa: [] }), { lte: [1, 3], nrSa: [78], nrNsa: [] });
    assert.deepEqual(nxSelection({ lte: "all", nr: [78, 79] }, supported, null), { lte: [1, 3, 7], nrSa: [78], nrNsa: [78, 79] });
    assert.equal(nxSelection({ lte: "all", nr: "all" }, supported, { lte: [1], nrSa: [], nrNsa: [] }), null, "every band the router offers: the page's automatic");
    assert.equal(nxSelection({ lte: "all", nr: null }, supported, null), null);
    assert.throws(() => nxSelection({ lte: [], nr: [] }, supported, null), CpeControlValidationError);
    const state = nxLockState({ supportBandList: "B1;B3;N78S;N78N;", selectedMode: "2", selectedBand: "B1;N78S;N78N;" }, { lteCelllockEnable: "1", pci: "211", EARFCN: "300", band: "1" }, { nrCelllockEnable: "0", pci: "-1", NRARFCN: "-1", band: "0" }, { networkPreferredModeSelected: "5G SA Only", networkPreferredModeOptionList: "5G Preferred,5G SA Only" });
    assert.deepEqual(state, { lteBands: [1], nrBands: "all", lteCell: { locked: true, arfcn: 300, pci: 211, band: 1 }, nrCell: { locked: false }, networkMode: "nr_sa", supportedLte: [1, 3], supportedNr: [78] });
    const auto = nxLockState({ supportBandList: "B1;B3;", selectedMode: "1", selectedBand: "" }, null, null, null);
    assert.deepEqual([auto.lteBands, auto.nrBands, auto.lteCell, auto.supportedNr, auto.networkMode], ["all", null, null, null, null], "a 4G router has no 5G bands to report");
    assert.deepEqual(nxLockState(null, null, null, null).lteBands, null);
  });

  it("names the modes a router of the EX and NX series lists, and the widest of a 4G router as its automatic one", () => {
    const five = "5G Preferred,5G/4G,5G NSA/4G,5G SA Only,4G Preferred,4G Only,3G Only";
    assert.deepEqual([...nxModes(five).keys()], ["auto", "nr_lte", "nr_nsa", "nr_sa", "lte_wcdma", "lte", "wcdma"]);
    assert.deepEqual([nxModeOf("5G/4G", five), nxModeOf("4G Preferred", five), nxModeOf("6G", five), nxModeOf(undefined, five)], ["nr_lte", "lte_wcdma", null, null]);
    const four = "4G Preferred,4G Only,3G Only";
    assert.deepEqual([...nxModes(four)], [["lte", "4G Only"], ["wcdma", "3G Only"], ["auto", "4G Preferred"]]);
    assert.deepEqual([nxModeOf("4G Preferred", four), nxModes(undefined).size], ["auto", 0]);
  });

  it("reads the networks a search found, the data limit and the SIM lock", () => {
    const mr = parseMrOperators([
      { stack: "1,0,0,0,0,0", ispName: "Three", mcc: "272", mnc: "1", itemStat: "2" },
      { stack: "2,0,0,0,0,0", ispName: "DemoNet", mcc: "272", mnc: "002", itemStat: "1" },
      { stack: "3,0,0,0,0,0", ispName: "x", mcc: "27", mnc: "1", itemStat: "1" },
      { ispName: "no stack", mcc: "272", mnc: "5", itemStat: "1" },
    ]);
    assert.deepEqual(mr.map((o) => [o.choice.plmn, o.choice.name, o.choice.state, o.stack, o.mnc]), [["27201", "Three", "current", "1,0,0,0,0,0", "1"], ["272002", "DemoNet", "available", "2,0,0,0,0,0", "002"]]);
    const nx = parseNxOperators("Three,27201,2;DemoNet,27202,1;Barred,27203,3;bad;,,;");
    assert.deepEqual(nx.map((o) => [o.choice.plmn, o.choice.state, o.entry]), [["27201", "current", "Three,27201,2"], ["27202", "available", "DemoNet,27202,1"], ["27203", "forbidden", "Barred,27203,3"]]);
    assert.deepEqual(parseNxOperators(undefined), []);
    assert.deepEqual(tplinkDataLimit({ enableDataLimit: "1", limitation: "5368709120.0", warningPercent: "80" }), { enabled: true, bytes: 5368709120, alertPercent: 80 });
    assert.deepEqual(tplinkDataLimit({ enableDataLimit: "0", limitation: "0", warningPercent: "0" }), { enabled: false, bytes: null, alertPercent: null });
    assert.deepEqual([tplinkDataLimit(null), tplinkDataLimit({ limitation: "1" })], [null, null]);
    assert.deepEqual(tplinkSimLock({ pinState: "1", remainPinUnlockTime: "3" }), { pinState: 1, attemptsLeft: 3 });
    assert.deepEqual([tplinkSimLock(null), tplinkSimLock({ remainPinUnlockTime: "99" })], [{ pinState: null, attemptsLeft: null }, { pinState: null, attemptsLeft: null }]);
  });
});

describe("tp-link: band selection and cell lock", () => {
  const sets = (router: ReturnType<typeof tplinkRouter>) => router.actions.filter((a) => a.operation === "set").map((a) => [a.oid, a.stack, a.attrs]);

  it("selects bands on the MR series with the page's masks, reads them back, and clears them", async () => {
    const router = tplinkRouter();
    await router.client.withSession(async (s) => {
      assert.deepEqual([(await s.lockState()).lteBands, (await s.lockState()).lteCell], ["all", { locked: false }]);
      const check = newCheck();
      await s.setBandLock({ lte: [3, 1, 20], nr: "all", networkMode: null }, check);
      assert.deepEqual([check.endpoints, check.readback], [["tplink:LTE_WAN_CFG.set"], "match"]);
      assert.deepEqual((await s.lockState()).lteBands, [1, 3, 20]);
      const clear = newCheck();
      await s.unlockAll(clear);
      assert.deepEqual([clear.endpoints, clear.readback, (await s.lockState()).lteBands], [["tplink:LTE_WAN_CFG.set"], "match", "all"]);
      const again = newCheck();
      await s.unlockAll(again);
      assert.deepEqual([again.endpoints, again.readback], [[], "match"], "nothing is on: nothing to write");
      const all = newCheck();
      await s.setBandLock({ lte: "all", nr: null, networkMode: null }, all);
      assert.equal(all.readback, "match");
    });
    assert.deepEqual(sets(router), [
      ["LTE_WAN_CFG", "2,1,0,0,0,0", { bandSelectSwitch: "1", bandSelectedMaskL: "524293", bandSelectedMaskH: "0" }],
      ["LTE_WAN_CFG", "2,1,0,0,0,0", { bandSelectSwitch: "0", bandSelectedMaskL: "0", bandSelectedMaskH: "0" }],
      ["LTE_WAN_CFG", "2,1,0,0,0,0", { bandSelectSwitch: "0", bandSelectedMaskL: "0", bandSelectedMaskH: "0" }],
    ]);
  });

  it("refuses a band selection the MR series' page has no form for, before anything is sent", async () => {
    const router = tplinkRouter();
    await router.client.withSession(async (s) => {
      const check = newCheck();
      await assert.rejects(s.setBandLock({ lte: [1], nr: [78], networkMode: null }, check), /4G bands only/);
      await assert.rejects(s.setBandLock({ lte: [32], nr: null, networkMode: null }, check), /bands 1 to 31 and 33 to 63/);
      await assert.rejects(s.setBandLock({ lte: [1], nr: null, networkMode: "lte" }, check), /no way on record/);
      await assert.rejects(s.setBandLock({ lte: [999], nr: null, networkMode: null }, check), CpeControlValidationError);
      assert.deepEqual(check.endpoints, []);
    });
    const old = tplinkRouter({ settings: { bandSelectSwitch: undefined as unknown as string }, missing: ["LTE_CELL_LOCK"] });
    await old.client.withSession(async (s) => {
      delete old.state.settings["bandSelectSwitch"];
      const check = newCheck();
      await assert.rejects(s.setBandLock({ lte: [1], nr: null, networkMode: null }, check), /no band selection/);
      await assert.rejects(s.setCellLock({ rat: "LTE", band: 1, arfcn: 300, pci: 211, scsKhz: null }, check), /no cell lock/);
      await assert.rejects(s.unlockAll(check), /no band selection or cell lock/);
      assert.deepEqual(check.endpoints, []);
      const t = await s.telemetry();
      assert.deepEqual([t.lte?.band, t.lte?.arfcn, t.lte?.rsrpDbm], [3, null, -95], "the poll loses only the cell");
    });
    assert.deepEqual(sets(router).concat(sets(old)), []);
  });

  it("locks a 4G cell on MR firmware that has the form, as the page sends it, and unlocks it", async () => {
    const router = tplinkRouter({ networkType: "3" });
    await router.client.withSession(async (s) => {
      const t = await s.telemetry();
      assert.deepEqual([t.lte?.band, t.lte?.arfcn, t.lte?.pci, t.lte?.cellId], [3, 300, 211, "134217758"]);
      const check = newCheck();
      await s.setCellLock({ rat: "LTE", band: 3, arfcn: 1850, pci: 142, scsKhz: null }, check);
      assert.deepEqual([check.endpoints, check.readback], [["tplink:LTE_CELL_LOCK.set"], "match"]);
      assert.deepEqual((await s.lockState()).lteCell, { locked: true, arfcn: 1850, pci: 142, band: null });
      await assert.rejects(s.setCellLock({ rat: "NR", band: 78, arfcn: 650000, pci: 142, scsKhz: 30 }, newCheck()), /4G cells only/);
      await assert.rejects(s.setCellLock({ rat: "LTE", band: 66, arfcn: 66500, pci: 1, scsKhz: null }, newCheck()), /up to 65535/);
      const clear = newCheck();
      await s.unlockAll(clear);
      assert.deepEqual([clear.endpoints, clear.readback], [["tplink:LTE_CELL_LOCK.set"], "match"]);
    });
    assert.deepEqual(sets(router), [
      ["LTE_CELL_LOCK", "0,0,0,0,0,0", { rfInfoCellIDLock: "1", rfInfoCellID: "", rfInfoEARFCN: "1850", rfInfoPCI: "142" }],
      ["LTE_CELL_LOCK", "0,0,0,0,0,0", { rfInfoCellIDLock: "0" }],
    ]);
  });

  it("selects 4G and 5G bands together on the EX and NX series, from the bands the router offers", async () => {
    const router = tplinkRouter({ form: "ex" });
    await router.client.withSession(async (s) => {
      const before = await s.lockState();
      assert.deepEqual([before.lteBands, before.nrBands, before.supportedLte, before.supportedNr, before.networkMode], ["all", "all", [1, 3, 7, 20], [1, 28, 78], "auto"]);
      const check = newCheck();
      await s.setBandLock({ lte: [1, 3], nr: [78], networkMode: null }, check);
      assert.deepEqual([check.endpoints, check.readback], [["tplink:DEV2_LTE_BAND_SEARCH.set"], "match"]);
      const lteOnly = newCheck();
      await s.setBandLock({ lte: [7], nr: null, networkMode: null }, lteOnly);
      assert.deepEqual([lteOnly.readback, (await s.lockState()).nrBands], ["match", [78]], "the 5G bands stay as they were selected");
      await assert.rejects(s.setBandLock({ lte: [8], nr: null, networkMode: null }, newCheck()), /not one this router supports/);
      await assert.rejects(s.setBandLock({ lte: "all", nr: [79], networkMode: null }, newCheck()), /not one this router supports/);
      const all = newCheck();
      await s.setBandLock({ lte: "all", nr: "all", networkMode: null }, all);
      assert.deepEqual([all.readback, (await s.lockState()).lteBands], ["match", "all"]);
    });
    assert.deepEqual(sets(router), [
      ["DEV2_LTE_BAND_SEARCH", "1,0,0,0,0,0", { selectedMode: "2", selectedBand: "B1;B3;N78S;N78N;" }],
      ["DEV2_LTE_BAND_SEARCH", "1,0,0,0,0,0", { selectedMode: "2", selectedBand: "B7;N78S;N78N;" }],
      ["DEV2_LTE_BAND_SEARCH", "1,0,0,0,0,0", { selectedMode: "1" }],
    ]);
    const fourG = tplinkRouter({ form: "ex", bandSearch: { supportBandList: "B1;B3;" } });
    await fourG.client.withSession(async (s) => {
      await assert.rejects(s.setBandLock({ lte: [1], nr: [78], networkMode: null }, newCheck()), /no 5G bands/);
    });
  });

  it("locks a 4G or a 5G standalone cell on the EX and NX series, and clears every lock that is on", async () => {
    const router = tplinkRouter({ form: "ex", bandSearch: { supportBandList: "B1;B3;N78S;N78N;N79N;" } });
    await router.client.withSession(async (s) => {
      const lte = newCheck();
      await s.setCellLock({ rat: "LTE", band: 1, arfcn: 300, pci: 211, scsKhz: null }, lte);
      assert.deepEqual([lte.endpoints, lte.readback], [["tplink:DEV2_LTE_4G_CELL_LOCK.set"], "match"]);
      const nr = newCheck();
      await s.setCellLock({ rat: "NR", band: 78, arfcn: 650000, pci: 142, scsKhz: null }, nr);
      assert.deepEqual([nr.endpoints, nr.readback], [["tplink:DEV2_LTE_5G_CELL_LOCK.set"], "match"]);
      await assert.rejects(s.setCellLock({ rat: "NR", band: 79, arfcn: 700000, pci: 5, scsKhz: 30 }, newCheck()), /not one this router's page offers for a 5G standalone cell lock/);
      await assert.rejects(s.setCellLock({ rat: "LTE", band: 8, arfcn: 3500, pci: 5, scsKhz: null }, newCheck()), /not one this router's page offers for a 4G cell lock/);
      await s.setBandLock({ lte: [1], nr: null, networkMode: null }, newCheck());
      const clear = newCheck();
      await s.unlockAll(clear);
      assert.deepEqual(clear.endpoints, ["tplink:DEV2_LTE_BAND_SEARCH.set", "tplink:DEV2_LTE_4G_CELL_LOCK.set", "tplink:DEV2_LTE_5G_CELL_LOCK.set"]);
      assert.equal(clear.readback, "match");
    });
    assert.deepEqual(sets(router).filter(([oid]) => oid !== "DEV2_LTE_BAND_SEARCH"), [
      ["DEV2_LTE_4G_CELL_LOCK", "1,0,0,0,0,0", { pci: "211", EARFCN: "300", band: "1", lteCelllockEnable: "1" }],
      ["DEV2_LTE_5G_CELL_LOCK", "1,0,0,0,0,0", { pci: "142", NRARFCN: "650000", band: "78", scs: "30", nrCelllockEnable: "1" }],
      ["DEV2_LTE_4G_CELL_LOCK", "1,0,0,0,0,0", { lteCelllockEnable: "0" }],
      ["DEV2_LTE_5G_CELL_LOCK", "1,0,0,0,0,0", { nrCelllockEnable: "0" }],
    ]);
  });
});

describe("tp-link: mobile data and the cellular settings", () => {
  const sets = (router: ReturnType<typeof tplinkRouter>) => router.actions.filter((a) => a.operation === "set").map((a) => [a.oid, a.attrs]);

  for (const form of ["mr", "ex"] as const) {
    const cfg = form === "mr" ? "LTE_WAN_CFG" : "DEV2_LTE_WAN_CFG";

    it(`switches mobile data, roaming and the network mode on the ${form === "mr" ? "MR" : "EX and NX"} series as the page's own switches do`, async () => {
      const router = tplinkRouter({ form });
      await router.client.withSession(async (s) => {
        const data = fullSession(s).data;
        assert.equal(await data.enabled(), true);
        const off = newCheck();
        await data.set(false, off, noWait);
        assert.deepEqual([off.endpoints, off.readback, await data.enabled()], [[`tplink:${cfg}.set`], "match", false]);
        await data.set(true, newCheck(), noWait);
        const roam = newCheck();
        await cellularOf(s).setRoaming(true, roam);
        assert.deepEqual([roam.readback, (await s.telemetry()).status?.roaming?.dataAllowed], ["match", true]);
        const state = await cellularOf(s).read();
        assert.deepEqual([state.networkMode, state.operator, state.pinAttemptsLeft, state.dataLimit], ["auto", { selection: "auto", plmn: null }, 3, { enabled: false, bytes: null, alertPercent: 90 }]);
        assert.deepEqual(state.networkModes, form === "mr" ? ["auto", "lte", "wcdma"] : ["auto", "nr_lte", "nr_nsa", "nr_sa", "lte_wcdma", "lte", "wcdma"]);
        const mode = newCheck();
        await cellularOf(s).setNetworkMode("lte", mode, noWait);
        assert.deepEqual([mode.readback, (await cellularOf(s).read()).networkMode], ["match", "lte"]);
        await assert.rejects(cellularOf(s).setNetworkMode("gsm", newCheck(), noWait), /offers no "gsm" network mode/);
      });
      assert.deepEqual(sets(router), [
        [cfg, { dataSwitchStatusBackup: "0", profileAction: "0" }],
        [cfg, { dataSwitchStatusBackup: "1", profileAction: "0" }],
        [cfg, { roamingEnabled: "1", profileAction: "0" }],
        [cfg, form === "mr" ? { networkPreferredMode: "2" } : { networkPreferredModeSelected: "4G Only" }],
      ]);
    });

    it(`searches for networks and chooses one of them on the ${form === "mr" ? "MR" : "EX and NX"} series`, async () => {
      const router = tplinkRouter({ form, searchPolls: 3 });
      let slept = 0;
      const wait = { sleep: (): Promise<void> => Promise.resolve(void (slept += 1)) };
      await router.client.withSession(async (s) => {
        await assert.rejects(cellularOf(s).selectOperator({ mode: "manual", plmn: "27202", rat: null }, newCheck(), noWait), /search for networks first/);
        const scan = newCheck();
        const found = await cellularOf(s).scanOperators(scan, wait);
        assert.deepEqual(found.map((o) => [o.plmn, o.name, o.state, o.rat]), [["27201", "Three", "current", null], ["27202", "DemoNet", "available", null], ["27203", "Barred", "forbidden", null]]);
        assert.deepEqual([scan.endpoints.length, scan.readback, slept], [1, "none", 3]);
        const pick = newCheck();
        await cellularOf(s).selectOperator({ mode: "manual", plmn: "27202", rat: null }, pick, noWait);
        assert.deepEqual([pick.readback, (await cellularOf(s).read()).operator], ["match", { selection: "manual", plmn: "27202" }]);
        await assert.rejects(cellularOf(s).selectOperator({ mode: "manual", plmn: "27299", rat: null }, newCheck(), noWait), /search for networks first/);
        const auto = newCheck();
        await cellularOf(s).selectOperator({ mode: "auto" }, auto, noWait);
        assert.deepEqual([auto.readback, (await cellularOf(s).read()).operator], ["match", { selection: "auto", plmn: null }]);
      });
      assert.deepEqual(
        sets(router),
        form === "mr"
          ? [
              ["LTE_NET_SEL", { searchAction: "1" }],
              ["LTE_WAN_CFG", { networkSelectionMCC: "272", networkSelectionMNC: "2", networkSelectionISP: "DemoNet", networkSelectionMode: "1" }],
              ["LTE_WAN_CFG", { networkSelectionMode: "0", networkSelectionMCC: "0", networkSelectionMNC: "0", networkSelectionISP: "" }],
            ]
          : [
              ["DEV2_LTE_NETWORK_SEARCH", { action: "1" }],
              ["DEV2_LTE_NETWORK_SEARCH", { selectedMode: "2", selectedOperator: "DemoNet,27202,1" }],
              ["DEV2_LTE_NETWORK_SEARCH", { selectedMode: "1" }],
            ]
      );
    });

    it(`sets the data limit and corrects the used total with the whole form of the ${form === "mr" ? "MR" : "EX and NX"} series' page`, async () => {
      const oid = form === "mr" ? "WAN_LTE_INTF_CFG" : "DEV2_XTP_LTE_INTF_CFG";
      const router = tplinkRouter({ form });
      await router.client.withSession(async (s) => {
        const on = newCheck();
        await cellularOf(s).setDataLimit({ enabled: true, bytes: 5 * 1024 ** 3, alertPercent: 80 }, on);
        assert.deepEqual([on.endpoints, on.readback, (await cellularOf(s).read()).dataLimit], [[`tplink:${oid}.set`], "match", { enabled: true, bytes: 5 * 1024 ** 3, alertPercent: 80 }]);
        const reset = newCheck();
        await cellularOf(s).resetTraffic(reset);
        assert.deepEqual([reset.readback, (await s.telemetry()).traffic?.monthTotalBytes], ["match", 0n]);
        const off = newCheck();
        await cellularOf(s).setDataLimit({ enabled: false, bytes: null, alertPercent: null }, off);
        assert.equal(off.readback, "match");
        await assert.rejects(cellularOf(s).setDataLimit({ enabled: true, bytes: 1024, alertPercent: 80 }, newCheck()), /between 1 MB and 9999 GB/);
        await assert.rejects(cellularOf(s).setDataLimit({ enabled: true, bytes: 1024 ** 3, alertPercent: 100 }, newCheck()), /1 to 99 percent/);
      });
      assert.deepEqual(sets(router), [
        [oid, { adjustStatistics: "-1", enablePaymentDay: "1", paymentDay: "5", enableDataLimit: "1", limitation: "5368709120", warningPercent: "80" }],
        [oid, { adjustStatistics: "0", enableDataLimit: "1", limitation: "5368709120", warningPercent: "80", enablePaymentDay: "1", paymentDay: "5" }],
        [oid, { adjustStatistics: "-1", enablePaymentDay: "1", paymentDay: "5", enableDataLimit: "0" }],
      ]);
    });
  }

  it("changes the MR series' network mode only with a SIM card its page can use, and chooses an operator the older way where the settings have none", async () => {
    const locked = tplinkRouter({ simLock: { pinState: "1" } });
    await locked.client.withSession(async (s) => {
      const check = newCheck();
      await assert.rejects(cellularOf(s).setNetworkMode("lte", check, noWait), /only with a SIM card it can use/);
      assert.deepEqual(check.endpoints, []);
    });
    const old = tplinkRouter();
    for (const key of ["networkSelectionMode", "networkSelectionMCC", "networkSelectionMNC", "networkSelectionISP", "roamingEnabled", "dataSwitchStatusBackup"]) delete old.state.settings[key];
    await old.client.withSession(async (s) => {
      await cellularOf(s).scanOperators(newCheck(), noWait);
      const pick = newCheck();
      await cellularOf(s).selectOperator({ mode: "manual", plmn: "27202", rat: null }, pick, noWait);
      assert.deepEqual([pick.endpoints, pick.readback, pick.reason], [["tplink:LTE_NET_SEL_LIST.set"], "unknown", "unreadable"]);
      await cellularOf(s).selectOperator({ mode: "auto" }, newCheck(), noWait);
      assert.equal((await cellularOf(s).read()).operator, null);
      await assert.rejects(cellularOf(s).setRoaming(true, newCheck()), /no roaming switch/);
      await assert.rejects(fullSession(s).data.set(false, newCheck(), noWait), /no mobile data switch/);
    });
    assert.deepEqual(old.actions.filter((a) => a.operation === "set").map((a) => [a.oid, a.stack, a.attrs]), [
      ["LTE_NET_SEL", "0,0,0,0,0,0", { searchAction: "1" }],
      ["LTE_NET_SEL_LIST", "2,0,0,0,0,0", { itemStat: "10" }],
      ["LTE_NET_SEL", "0,0,0,0,0,0", { netSelType: "0" }],
    ]);
  });

  it("gives up a search the router says failed, or never finishes", async () => {
    const failing = tplinkRouter({ form: "ex", searchPolls: null });
    await failing.client.withSession(async (s) => {
      await assert.rejects(cellularOf(s).scanOperators(newCheck(), noWait), (err: unknown) => err instanceof CpeApiError && err.code === "search-failed");
    });
    const endless = tplinkRouter({ searchPolls: 1000 });
    await endless.client.withSession(async (s) => {
      await assert.rejects(cellularOf(s).scanOperators(newCheck(), noWait), (err: unknown) => err instanceof CpeApiError && err.code === "timeout");
    });
    assert.equal(endless.actions.filter((a) => a.oid === "LTE_NET_SEL" && a.operation === "get").length, 60);
  });

  it("sends a PIN once, reads the lock again after the page's wait, and says how many attempts are left", async () => {
    const router = tplinkRouter({ simLock: { pinState: "1", autoUnlockPin: "1" } });
    let waited = 0;
    const wait = { sleep: (ms: number): Promise<void> => Promise.resolve(void (waited += ms)) };
    await router.client.withSession(async (s) => {
      assert.equal((await s.telemetry()).status?.sim?.state, "pin_required");
      const wrong = newCheck();
      assert.deepEqual(await cellularOf(s).enterPin("0000", wrong, wait), { accepted: false, attemptsLeft: 2 });
      assert.deepEqual([wrong.endpoints, wrong.readback, waited], [["tplink:LTE_SIMLOCK.set"], "none", 3500]);
      const right = newCheck();
      assert.deepEqual(await cellularOf(s).enterPin(TPLINK_PIN, right, wait), { accepted: true, attemptsLeft: 3 });
      assert.equal(right.readback, "match");
      assert.deepEqual(await cellularOf(s).setPinLock(false, TPLINK_PIN, newCheck(), wait), { accepted: true, attemptsLeft: 3 });
      assert.deepEqual(await cellularOf(s).setPinLock(true, TPLINK_PIN, newCheck()), { accepted: true, attemptsLeft: 3 });
    });
    assert.deepEqual(router.actions.filter((a) => a.operation === "set").map((a) => [a.oid, a.stack, a.attrs]), [
      ["LTE_SIMLOCK", "2,1,0,0,0,0", { simAction: "4", pin: "0000", autoUnlockPin: "1" }],
      ["LTE_SIMLOCK", "2,1,0,0,0,0", { simAction: "4", pin: TPLINK_PIN, autoUnlockPin: "1" }],
      ["LTE_SIMLOCK", "2,1,0,0,0,0", { simAction: "2", pin: TPLINK_PIN }],
      ["LTE_SIMLOCK", "2,1,0,0,0,0", { simAction: "1", pin: TPLINK_PIN, autoUnlockPin: "1" }],
    ]);
    // A router that answers a wrong PIN with an error of its own: still one write, and the attempts it has left
    const refusing = tplinkRouter({ form: "ex", simLock: { pinState: "1" }, pinError: true });
    await refusing.client.withSession(async (s) => {
      assert.deepEqual(await cellularOf(s).enterPin("0000", newCheck(), noWait), { accepted: false, attemptsLeft: 2 });
    });
    assert.equal(refusing.actions.filter((a) => a.operation === "set").length, 1);
    const none = tplinkRouter({ missing: ["LTE_SIMLOCK"] });
    await none.client.withSession(async (s) => {
      assert.equal((await cellularOf(s).read()).pinAttemptsLeft, null);
      await assert.rejects(cellularOf(s).enterPin(TPLINK_PIN, newCheck(), noWait), /no SIM PIN form/);
    });
    assert.equal(none.actions.filter((a) => a.operation === "set").length, 0);
    const sent = [router, refusing].flatMap((r) => r.mock.requests.map((req) => `${req.body} ${[...req.query.values()].join(" ")}`)).join(" ");
    // The frame's `pin=` line and the JSON's "pin" key are what would show: a PIN's four digits turn up in ciphertext by chance
    assert.ok(!sent.includes("pin=") && !sent.includes('"pin"') && !sent.includes("simAction"), "a PIN travels encrypted only");
  });

  it("does not guess when the router stops saying whether it took the PIN", async () => {
    const router = tplinkRouter({ simLock: { pinState: "1" } });
    await router.client.withSession(async (s) => {
      const check = newCheck();
      const sent = cellularOf(s).enterPin(TPLINK_PIN, check, {
        sleep: () => {
          delete router.state.simLock["pinState"];
          return Promise.resolve();
        },
      });
      await assert.rejects(sent, CpeAnswerFormatError);
      assert.deepEqual(check.endpoints, ["tplink:LTE_SIMLOCK.set"]);
    });
    assert.equal(router.actions.filter((a) => a.operation === "set").length, 1, "sent once, never again");
  });

  it("writes an access point as a profile of its own on the MR series, and puts the router's profiles back as they are", async () => {
    const stored = { profileID: "0", profileName: "Three", pdpType: "2", ipv4ApnType: "0", ipv4Apn: "internet", ipv4Username: "web", ipv4Password: "stored-secret", ipv4AuthType: "1", ipv6ApnType: "0", ipv6Apn: "internet", ipv6Username: "web", ipv6Password: "stored-secret", ipv6AuthType: "1" };
    const router = tplinkRouter({ profiles: [{ ...stored }] });
    const sets = (): Array<Record<string, string>> => router.actions.filter((a) => a.operation === "set" && a.oid === "LTE_WAN_CFG").map((a) => a.attrs);
    await router.client.withSession(async (s) => {
      const before = await cellularOf(s).read();
      assert.deepEqual([before.apn, before.apnRestore], [{ mode: "auto", apn: "internet", ipType: "ipv4v6", auth: "pap", hasUsername: true }, { mode: "profile", id: "0" }]);
      assert.deepEqual(sets(), [], "a read opens no form");
      const check = newCheck();
      await cellularOf(s).setApn({ mode: "manual", apn: "example.apn", ipType: "ipv4", auth: "chap", username: "user", password: "0000" }, check, noWait);
      assert.deepEqual([check.endpoints, check.readback], [["tplink:LTE_WAN_CFG.set"], "match"]);
      const made = await cellularOf(s).read();
      assert.deepEqual([made.apn, made.apnRestore], [{ mode: "manual", apn: "example.apn", ipType: "ipv4", auth: "chap", hasUsername: true }, { mode: "profile", id: "1" }]);
      // Again: the profile is there, so it is saved and put in use, not made twice
      await cellularOf(s).setApn({ mode: "manual", apn: "internet", ipType: "ipv4v6", auth: "none", username: "", password: "" }, newCheck(), noWait);
      assert.equal(router.state.profiles.length, 2);
      // Back to what was in use before, by its number, with its own fields as the router handed them out
      const back = newCheck();
      await cellularOf(s).restoreApn({ mode: "profile", id: "0" }, back, noWait);
      assert.deepEqual([back.readback, (await cellularOf(s).read()).apn?.mode, router.state.settings["activeProfile"]], ["match", "auto", "0"]);
      await cellularOf(s).setApn({ mode: "manual", apn: "example.apn", ipType: "ipv6", auth: "none", username: "", password: "" }, newCheck(), noWait);
      const auto = newCheck();
      await cellularOf(s).setApn({ mode: "auto" }, auto, noWait);
      assert.deepEqual([auto.readback, router.state.settings["activeProfile"]], ["match", "0"]);
      await cellularOf(s).restoreApn({ mode: "auto" }, newCheck(), noWait);
      await assert.rejects(cellularOf(s).restoreApn({ mode: "profile", id: "7" }, newCheck(), noWait), /no longer lists/);
      await assert.rejects(cellularOf(s).restoreApn({ mode: "context", apn: "internet", ipType: "ipv4" }, newCheck(), noWait), /no way on record/);
      await assert.rejects(cellularOf(s).setApn({ mode: "manual", apn: "example.apn", ipType: "ipv4", auth: "pap", username: "u".repeat(32), password: "" }, newCheck(), noWait), /up to 31 characters/);
    });
    assert.deepEqual(router.state.profiles[0], stored, "the router's own profile is as it was");
    assert.deepEqual(sets().slice(0, 3), [
      { profileAction: "4" },
      { profileName: "FengSui", pdpType: "0", ipv4ApnType: "0", ipv4Apn: "example.apn", ipv4Username: "user", ipv4Password: "0000", ipv4AuthType: "2", profileAction: "2" },
      { profileID: "1", profileName: "FengSui", pdpType: "0", ipv4ApnType: "0", ipv4Apn: "example.apn", ipv4Username: "user", ipv4Password: "0000", ipv4AuthType: "2", profileAction: "1", activeProfile: "1" },
    ]);
    assert.deepEqual(sets().slice(3, 5), [
      { profileAction: "4" },
      { profileID: "1", profileName: "FengSui", pdpType: "2", ipv4ApnType: "0", ipv4Apn: "internet", ipv4Username: "", ipv4Password: "", ipv4AuthType: "0", ipv6ApnType: "0", ipv6Apn: "internet", ipv6Username: "", ipv6Password: "", ipv6AuthType: "0", profileAction: "1", activeProfile: "1" },
    ]);
    assert.deepEqual(sets()[6], { ...stored, profileAction: "1", activeProfile: "0" }, "the profile used before goes back with what the router stored for it");
    assert.deepEqual(sets()[8], { profileID: "1", profileName: "FengSui", pdpType: "1", ipv6ApnType: "0", ipv6Apn: "example.apn", ipv6Username: "", ipv6Password: "", ipv6AuthType: "0", profileAction: "1", activeProfile: "1" });
    assert.equal(sets().filter((attrs) => attrs["profileAction"] === "2").length, 1, "one profile made, once");
  });

  it("leaves the access point alone where the router's list gives no clear answer", async () => {
    // Two profiles of the router's own: which one is "automatic" is its owner's to say
    const two = tplinkRouter({ profiles: [{ profileID: "0", profileName: "Three", pdpType: "0", ipv4Apn: "internet" }, { profileID: "1", profileName: "Three IoT", pdpType: "0", ipv4Apn: "example.apn" }], settings: { defaultProfile: "2" } });
    await two.client.withSession(async (s) => {
      await assert.rejects(cellularOf(s).setApn({ mode: "auto" }, newCheck(), noWait), /several access point profiles of its own/);
    });
    const none = tplinkRouter({ profiles: [{ profileID: "0", profileName: "NONE", pdpType: "0" }] });
    await none.client.withSession(async (s) => {
      await assert.rejects(cellularOf(s).setApn({ mode: "auto" }, newCheck(), noWait), /no access point profile of its own/);
    });
    // The page counts the profiles its owner added, not the router's own for the SIM card: with the router's own one and eight more, it makes none
    const full = tplinkRouter({ profiles: Array.from({ length: 9 }, (_, i) => ({ profileID: String(i), profileName: `P${i}`, pdpType: "0", ipv4Apn: "internet" })) });
    await full.client.withSession(async (s) => {
      await assert.rejects(cellularOf(s).setApn({ mode: "manual", apn: "example.apn", ipType: "ipv4", auth: "none", username: "", password: "" }, newCheck(), noWait), /8 access point profiles besides its own at most/);
      await assert.rejects(cellularOf(s).setApn({ mode: "manual", apn: `a${".b".repeat(31)}`, ipType: "ipv4", auth: "none", username: "", password: "" }, newCheck(), noWait), /up to 62 characters/);
    });
    assert.equal(full.actions.filter((a) => a.operation === "set").length, 1, "the form opened once, and nothing made");
    const seven = tplinkRouter({ profiles: Array.from({ length: 8 }, (_, i) => ({ profileID: String(i), profileName: `P${i}`, pdpType: "0", ipv4Apn: "internet" })) });
    await seven.client.withSession(async (s) => {
      const check = newCheck();
      await cellularOf(s).setApn({ mode: "manual", apn: "example.apn", ipType: "ipv4", auth: "none", username: "", password: "" }, check, noWait);
      assert.equal(check.readback, "match");
    });
    assert.equal(seven.state.profiles.length, 9, "the eighth of the owner's own, as the page would make it");
    // A router that takes the new profile and does not list it: said, and never made a second time
    const dropping = tplinkRouter({ dropsNewProfile: true });
    await dropping.client.withSession(async (s) => {
      await assert.rejects(cellularOf(s).setApn({ mode: "manual", apn: "example.apn", ipType: "ipv4", auth: "none", username: "", password: "" }, newCheck(), noWait), CpeAnswerFormatError);
    });
    assert.equal(dropping.actions.filter((a) => a.operation === "set" && a.attrs["profileAction"] === "2").length, 1);
    const listless = tplinkRouter({ missing: ["LTE_PROFILE"] });
    await listless.client.withSession(async (s) => {
      const state = await cellularOf(s).read();
      assert.deepEqual([state.apn, state.apnRestore], [undefined, undefined]);
      await assert.rejects(cellularOf(s).setApn({ mode: "auto" }, newCheck(), noWait), /no list of access point profiles/);
    });
    // The other form's page manages several access points at once: not written here
    const ex = tplinkRouter({ form: "ex" });
    await ex.client.withSession(async (s) => {
      assert.deepEqual([s.cellular?.setApn, s.cellular?.restoreApn, (await cellularOf(s).read()).apn], [undefined, undefined, undefined]);
    });
  });

  it("reads the page's profile list by its own numbering, and writes each address type's half of a profile", () => {
    const profiles = parseProfileList([{ profileID: "0", profileName: "Three" }, { profileID: "1", profileName: "FengSui", pdpType: "1", ipv6Apn: "example.apn", ipv6AuthType: "3", ipv6Username: "" }, { profileID: "9", profileName: "out of place" }, { profileName: "no number" }]);
    assert.deepEqual(profiles.map((p) => [p.index, p.id, p.name]), [[0, "0", "Three"], [1, "1", "FengSui"]]);
    assert.ok(profiles[1]);
    assert.deepEqual(mrApnView(profiles[1], false), { mode: "manual", apn: "example.apn", ipType: "ipv6", auth: null, hasUsername: false }, "PAP or CHAP is no mode FengSui names");
    assert.deepEqual(mrApnView({ index: 0, id: "0", name: "x", fields: {} }, true), { mode: "auto", apn: null, ipType: null, auth: null, hasUsername: false });
    const setting = { apn: "example.apn", ipType: "ipv4v6", auth: "pap", username: "user", password: "0000" } as const;
    assert.deepEqual(Object.keys(mrProfileCreate("FengSui", setting)), ["profileName", "pdpType", "ipv4ApnType", "ipv4Apn", "ipv4Username", "ipv4Password", "ipv4AuthType"]);
    assert.deepEqual(mrProfileCreate("FengSui", { ...setting, ipType: "ipv6" }), { profileName: "FengSui", pdpType: "1", ipv6ApnType: "0", ipv6Apn: "example.apn", ipv6Username: "user", ipv6Password: "0000", ipv6AuthType: "1" });
    assert.deepEqual(Object.keys(mrProfileEdit({ id: "1", index: 1, name: "FengSui" }, setting)).filter((key) => key.startsWith("ipv6")).length, 5);
    assert.deepEqual(mrProfileUse({ index: 2, id: "2", name: "Mine", fields: { pdpType: "0", ipv4Apn: "internet", ipv4AuthType: "0" } }), { profileID: "2", profileName: "Mine", pdpType: "0", ipv4ApnType: "", ipv4Apn: "internet", ipv4Username: "", ipv4Password: "", ipv4AuthType: "0", profileAction: "1", activeProfile: "2" });
  });

  it("switches the antenna only where the page's own script says the firmware has the switch", async () => {
    const without = tplinkRouter();
    await without.client.withSession(async (s) => {
      const check = newCheck();
      await assert.rejects(fullSession(s).setAntennaMode("external", check), /no antenna switch/);
      await assert.rejects(fullSession(s).setAntennaMode("auto", check), /internal and its external antennas only/);
      assert.deepEqual(check.endpoints, []);
    });
    const restarting = tplinkRouter({ form: "ex", buildFlags: "var INCLUDE_LTE_ANTENNA_TYPE=1,INCLUDE_LTE_Q8RX_SWITCH=1;" });
    await restarting.client.withSession(async (s) => {
      await assert.rejects(fullSession(s).setAntennaMode("external", newCheck()), /restarts the router/);
    });
    const router = tplinkRouter({ form: "ex", buildFlags: "var INCLUDE_LTE_ANTENNA_TYPE=1,INCLUDE_LTE_Q8RX_SWITCH=0;" });
    await router.client.withSession(async (s) => {
      const check = newCheck();
      assert.equal(await fullSession(s).setAntennaMode("external", check), 1);
      assert.deepEqual([check.endpoints, check.readback], [["tplink:DEV2_LTE_WAN_CFG.set"], "match"]);
      assert.equal(await fullSession(s).setAntennaMode("internal", newCheck()), 0);
    });
    assert.deepEqual(sets(router), [["DEV2_LTE_WAN_CFG", { antennaType: "1", profileAction: "0" }], ["DEV2_LTE_WAN_CFG", { antennaType: "0", profileAction: "0" }]]);
    assert.deepEqual(router.mock.trail.filter((line) => line.includes("oid_str")), ["GET /js/oid_str.js", "GET /js/oid_str.js"]);
    assert.deepEqual([...sets(without), ...sets(restarting)], []);
  });
});

describe("tp-link: through the daemon, like every other brand", () => {
  it("opens the writes of the form the router speaks, and sends them the way that form does", async () => {
    const mr = tplinkRouter({ networkType: "3" });
    const fx = daemonOn("tplink", mr.mock.fetchImpl, TPLINK_URL, TPLINK_PASSWORD);
    try {
      const snap = await fx.core.monitor.refreshTelemetry();
      assert.ok(snap);
      assert.deepEqual([snap.device.deviceName, snap.rf.ratCode, snap.rf.lteRsrpDbm, snap.rf.pccBand, snap.rf.pci, snap.rf.earfcnRaw, snap.status?.sim?.state], ["Archer MR600", "LTE", -95, "B3", 211, "DL:300", "ready"]);
      const features = fx.core.scheduler.getStatus().device.features;
      for (const feature of ["reboot", "smsWrite", "ussd", "bandLock", "cellLock", "mobileData", "reconnect", "networkMode", "operatorSelect", "roaming", "apn", "dataLimit", "trafficReset", "simPin", "antenna"] as const) assert.equal(features[feature], "enabled", feature);
      assert.deepEqual([features.wifi, features.simSlot, features.airplaneSwitch], ["not_implemented", "not_implemented", "not_implemented"]);
      const locked = await fx.core.controls.lockBands({ lteBands: [1, 3] });
      assert.deepEqual([locked.mode, mr.state.settings["bandSelectSwitch"], mr.state.settings["bandSelectedMaskL"]], ["band_lock", "1", "5"]);
      await assert.rejects(fx.core.controls.lockBands({ lteBands: [1], networkMode: "03" }), CpeControlValidationError);
      await fx.core.controls.lockCell({ rat: "LTE", band: 3, arfcn: 1850, pci: 142 });
      assert.equal(mr.state.cellLock["rfInfoCellIDLock"], "1");
      await fx.core.controls.unlockAllLocks();
      assert.deepEqual([mr.state.settings["bandSelectSwitch"], mr.state.cellLock["rfInfoCellIDLock"]], ["0", "0"]);
      assert.deepEqual(await fx.core.controls.setMobileData(false), { mobileDataEnabled: false });
      await fx.core.controls.reconnectCellular();
      assert.equal(mr.state.settings["dataSwitchStatusBackup"], "1", "a redial ends connected");
      assert.deepEqual(await fx.core.controls.setRoaming(true, { confirm: true }), { dataRoaming: true });
      const logins = mr.logins.length;
      await assert.rejects(fx.core.controls.setAirplaneMode(true, { confirm: true }), (err: unknown) => err instanceof DeviceReadOnlyError && err.feature === "airplaneSwitch");
      assert.equal(mr.logins.length, logins, "no session for a write the brand does not have");
      const apn = await fx.core.controls.setApn({ mode: "manual", apn: "example.apn", ipType: "ipv4v6", auth: "none", username: "", password: "" }, { confirm: true });
      assert.deepEqual([apn.apnMode, apn.cellular?.apn?.apn, mr.state.settings["activeProfile"], mr.state.profiles[1]?.["profileName"]], ["manual", "example.apn", "1", "FengSui"]);
      assert.equal(fx.core.scheduler.device.skips("neighbors"), true);
    } finally {
      await fx.cleanup();
    }
    // The EX and NX series: the driver says so, and the gate goes by that form's writes
    const ex = tplinkRouter({ form: "ex", ussdAnswer: "Your balance: 5.00" });
    const fy = daemonOn("tplink", ex.mock.fetchImpl, TPLINK_URL, TPLINK_PASSWORD);
    try {
      const snap = await fy.core.monitor.refreshTelemetry();
      assert.deepEqual([snap?.device.deviceName, snap?.rf.ratCode, snap?.rf.pccBand], ["Archer NX200", "NSA", "B1"]);
      assert.equal((await fy.core.monitor.identifyDevice())?.identity.variant, "ex", "the identification every start runs names the form");
      assert.equal(fy.core.scheduler.device.variant, "ex");
      const features = fy.core.scheduler.getStatus().device.features;
      assert.deepEqual([features.reboot, features.smsWrite, features.ussd, features.bandLock, features.cellLock, features.apn], ["enabled", "enabled", "enabled", "enabled", "enabled", "not_implemented"]);
      assert.equal((await fy.core.controls.sendUssd({ kind: "send", code: "*100#" }, { confirm: true })).state, "answered");
      await fy.core.controls.lockBands({ lteBands: [1], nrBands: [78] });
      assert.deepEqual([ex.state.bandSearch["selectedMode"], ex.state.bandSearch["selectedBand"]], ["2", "B1;N78S;N78N;"]);
      await fy.core.controls.lockCell({ rat: "NR", band: 78, arfcn: 650000, pci: 142 });
      assert.deepEqual([ex.state.nrCellLock["nrCelllockEnable"], ex.state.nrCellLock["scs"]], ["1", "30"]);
    } finally {
      await fy.cleanup();
    }
  });
});
