import assert from "node:assert/strict";
import crypto from "node:crypto";
import { describe, it } from "node:test";
import { CpeControlValidationError } from "../src/control-error.ts";
import { SectionUnavailableError } from "../src/cpe-domain.ts";
import { DriverCpeClient } from "../src/drivers/client.ts";
import { DriverLoginMethodError } from "../src/drivers/login.ts";
import { TplinkEnvelope, eccSeal, rsaSign, usableKey } from "../src/drivers/tplink/crypto.ts";
import { tplinkProtocol } from "../src/drivers/tplink/driver.ts";
import { exRequest, instance, instances, mrFrame, mrText, mrValue, parseExAnswer, parseMrAnswer, returnCode, scriptVar } from "../src/drivers/tplink/frames.ts";
import { TPLINK_SENT_BASE, parseTplinkHosts, parseTplinkSmsPage, parseTplinkTelemetry } from "../src/drivers/tplink/parts.ts";
import type { DriverSms } from "../src/drivers/types.ts";
import { DeviceReadOnlyError } from "../src/scheduler.ts";
import { CpeAnswerFormatError, CpeApiError } from "../src/session-errors.ts";
import { cellularOf, daemonOn, fullSession, newCheck, noWait } from "./helpers/driver-daemon.ts";
import { LanRouterMock } from "./helpers/lan-router.ts";
import { TPLINK_HASHES, TPLINK_PASSWORD, TPLINK_URL, tplinkRouter } from "./helpers/tplink-router.ts";

/**
 * TP-Link's cellular routers on their own web interface, in both forms and every generation of its
 * encryption. Mocks only: the stand-in decrypts what FengSui sends the way the router does, so a
 * signature or a payload in the wrong form is refused, not accepted by a test that mirrors the code.
 */

const smsOf = (session: { sms?: DriverSms }): Required<DriverSms> => session.sms as Required<DriverSms>;
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
    const sa = parseTplinkTelemetry({ info, link: { networkType: "8" }, intf: null, net: null, prof: null, cells: [{ networkType: "8", cellConnectionStatus: "1", band: "78", ARFCN: "650000", PCI: "142", SSRSRP: "-90" }], wan: null });
    assert.deepEqual([sa.mode, sa.lte, sa.nr?.rsrpDbm, sa.traffic, sa.wan.connected], ["SA", null, -90, null, null]);
  });

  it("reads the MR series' signal without a band or a channel, and each state of the SIM card and the network", () => {
    const t = parseTplinkTelemetry({
      info: { modelName: "Archer MR600" },
      link: { enable: "1", connectStatus: "4", networkType: "7", roamingStatus: "1", simStatus: "4" },
      intf: { totalStatistics: "100", curRxSpeed: "0", curTxSpeed: "0" },
      net: { sigLevel: "3", rfInfoRsrp: "-101", rfInfoRsrq: "-12", rfInfoSnr: "65" },
      prof: { spn: "Three", ispName: "" },
      cells: null,
      wan: [{ enable: "0", connectionStatus: "Connected", externalIPAddress: "203.0.113.10" }, { enable: "1", connectionStatus: "Connecting", externalIPAddress: "0.0.0.0" }],
    });
    assert.deepEqual([t.mode, t.lte?.band, t.lte?.arfcn, t.lte?.rsrpDbm, t.lte?.rsrqDb, t.lte?.sinrDb, t.nr, t.operatorName], ["LTE", null, null, -101, -12, 6.5, null, "Three"]);
    assert.deepEqual([t.wan.connected, t.wan.ipv4], [false, null], "a connection that is switched off does not count");
    assert.deepEqual(t.status?.sim?.state, "pin_required");
    assert.deepEqual(t.status?.roaming, { active: true, dataAllowed: null });
    const state = (simStatus: string): unknown => parseTplinkTelemetry({ info: null, link: { simStatus }, intf: null, net: null, prof: null, cells: null, wan: null }).status?.sim?.state;
    assert.deepEqual(["0", "1", "2", "3", "5", "6", "7", "8", "x"].map(state), [null, "absent", "error", "ready", "ready", "puk_required", "error", null, null]);
    const mode = (networkType: string): unknown => parseTplinkTelemetry({ info: null, link: { networkType }, intf: null, net: { rfInfoRsrp: "-90" }, prof: null, cells: null, wan: null }).mode;
    assert.deepEqual(["0", "1", "2", "3", "7", "8", "9"].map(mode), ["NONE", null, "WCDMA", "LTE", "LTE", "SA", null]);
    const bare = parseTplinkTelemetry({ info: null, link: null, intf: null, net: null, prof: null, cells: null, wan: null });
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
    assert.deepEqual([t?.mode, t?.lte?.rsrpDbm, t?.lte?.sinrDb, t?.model, t?.wan.ipv4], ["LTE", -95, 14, "Archer MR600", "198.51.100.42"]);
    assert.deepEqual(mock.trail, ["GET /", "POST /cgi/getBusy", "POST /cgi/getGDPRParm", "POST /cgi/getParm", "GET /js/tpEncrypt.js", "POST /cgi/login", "GET /", "POST /cgi_gdpr", "POST /cgi_gdpr", "POST /cgi_gdpr", "POST /cgi_gdpr"]);
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
    for (const options of [{ form: "ex", cipher: "gcm" }, { form: "ex", cipher: "gcm", padding: "oaep" }, { form: "mr", padding: "oaep" }, { form: "mr", ecc: true }, { form: "ex", script: { status: 404, text: "" } }] as const) {
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
    for (const loginAnswer of ["$.ret=71234;\n", "$.ret=9001;\n"]) {
      for (const form of ["mr", "ex"] as const) {
        const odd = tplinkRouter({ form, loginAnswer });
        await assert.rejects(odd.client.withSession((s) => s.telemetry()), (err: unknown) => err instanceof CpeApiError && err.latchesBreaker, `${form} ${loginAnswer}`);
        assert.equal(odd.logins.length, 1);
      }
    }
  });

  it("fails a session whose page hands out no token, and a read the router no longer answers", async () => {
    const noToken = new LanRouterMock((req) => {
      const real = tplinkRouter();
      void real;
      return req.path === "/cgi/getParm" ? { text: `var ee="010001";\nvar nn="c${"0".repeat(126)}1";\nvar seq="1";\n$.ret=0;` } : req.path === "/cgi/login" ? { text: "$.ret=0;", setCookie: ["JSESSIONID=abc123; Path=/"] } : req.path === "/" ? { text: "<html>home</html>" } : { status: 404, text: "" };
    });
    const client = new DriverCpeClient({ protocol: tplinkProtocol, cpeUrl: TPLINK_URL, cpePassword: TPLINK_PASSWORD, fetchImpl: noToken.fetchImpl });
    await assert.rejects(client.withSession((s) => s.telemetry()), /no token for this session/);
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
  it("costs a poll only the part a firmware lacks, and has no nearby cells and no lock", async () => {
    const { client } = tplinkRouter({ form: "ex", missing: ["LTE_SERVING_CELL_INFO", "ADT_WAN", "DEV_INFO"] });
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
      assert.equal(s.cellular, undefined, "no USSD on record for this form");
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

  it("sends a USSD code on the MR series and waits for the network's answer", async () => {
    const answered = tplinkRouter({ ussdAnswer: "Your balance: 5.00\u0012Thank you" });
    await answered.client.withSession(async (s) => {
      const check = newCheck();
      assert.deepEqual(await cellularOf(s).ussd({ kind: "send", code: "*100#" }, check, noWait), { state: "answered", text: "Your balance: 5.00\nThank you", awaitsReply: false });
      assert.deepEqual([check.endpoints, check.readback], [["tplink:LTE_USSD.set"], "none"]);
      assert.deepEqual(await cellularOf(s).read(), {});
      await assert.rejects(cellularOf(s).ussd({ kind: "reply", code: "1" }, newCheck(), noWait), CpeControlValidationError);
      await assert.rejects(cellularOf(s).ussd({ kind: "cancel" }, newCheck(), noWait), CpeControlValidationError);
    });
    assert.deepEqual(answered.actions.filter((a) => a.operation === "set").map((a) => a.attrs), [{ action: "1", reqContent: "*100#" }]);
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

describe("tp-link: through the daemon, like every other brand", () => {
  it("opens the writes of the form the router speaks, and refuses the rest before any session", async () => {
    const mr = tplinkRouter();
    const fx = daemonOn("tplink", mr.mock.fetchImpl, TPLINK_URL, TPLINK_PASSWORD);
    try {
      const snap = await fx.core.monitor.refreshTelemetry();
      assert.ok(snap);
      assert.deepEqual([snap.device.deviceName, snap.rf.ratCode, snap.rf.lteRsrpDbm, snap.status?.sim?.state], ["Archer MR600", "LTE", -95, "ready"]);
      const features = fx.core.scheduler.getStatus().device.features;
      assert.deepEqual([features.reboot, features.smsWrite, features.ussd, features.bandLock, features.cellLock, features.mobileData, features.networkMode], ["enabled", "enabled", "enabled", "not_implemented", "not_implemented", "not_implemented", "not_implemented"]);
      const logins = mr.logins.length;
      await assert.rejects(fx.core.controls.lockBands({ lteBands: [1, 3] }), (err: unknown) => err instanceof DeviceReadOnlyError && err.feature === "bandLock");
      await assert.rejects(fx.core.controls.setMobileData(false), DeviceReadOnlyError);
      assert.equal(mr.logins.length, logins, "no session for a write the brand does not have");
      assert.equal(fx.core.scheduler.device.skips("neighbors"), true);
    } finally {
      await fx.cleanup();
    }
    // The EX and NX series: the driver says so, and the gate goes by that form's writes
    const ex = tplinkRouter({ form: "ex" });
    const fy = daemonOn("tplink", ex.mock.fetchImpl, TPLINK_URL, TPLINK_PASSWORD);
    try {
      const snap = await fy.core.monitor.refreshTelemetry();
      assert.deepEqual([snap?.device.deviceName, snap?.rf.ratCode, snap?.rf.pccBand], ["Archer NX200", "NSA", "B1"]);
      assert.equal(fy.core.scheduler.device.variant, "ex");
      const features = fy.core.scheduler.getStatus().device.features;
      assert.deepEqual([features.reboot, features.smsWrite, features.ussd], ["enabled", "enabled", "not_implemented"]);
      await assert.rejects(fy.core.controls.sendUssd({ kind: "send", code: "*100#" }, { confirm: true }), DeviceReadOnlyError);
    } finally {
      await fy.cleanup();
    }
  });
});
