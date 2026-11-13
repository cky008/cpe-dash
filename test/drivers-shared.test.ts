import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CpeAnswerFormatError, CpeApiError, CpeSessionDeadlineError, CpeTransportError, ReentrantCpeSessionError } from "../src/session-errors.ts";
import { CpeControlValidationError } from "../src/control-error.ts";
import type { WriteCheck } from "../src/device-access.ts";
import { bandsToHex, bandsToList, bandsToMask, checkCellLock, checkLockBands, defaultSpacing, hexToBands, isSubcarrierSpacing, listToBands, maskToBands } from "../src/drivers/bands.ts";
import { bandOfChannel, carrierOf, carriersFromRows, channelInBand, neighbourOf, ratOf, ratOfChannel, servingModeOf } from "../src/drivers/cells.ts";
import { DriverCpeClient, type DriverProtocol, isInsideDriverSession } from "../src/drivers/client.ts";
import { DriverLoginMethodError, DriverSessionClosedError, hmacMd5Hex, loginLocked, loginUnplaced, md5Hex, signedInElsewhere, wrongPassword } from "../src/drivers/login.ts";
import { noteSent, settleBandLock, settleCellLock, settleRestart, settleUnlock } from "../src/drivers/readback.ts";
import { CounterRates, cellHasData, driverNeighbourSnapshot, driverRfSnapshot, driverTelemetrySnapshot, emptyCell } from "../src/drivers/snapshot.ts";
import { LanHttp, jsonAnswer, parseJsonText } from "../src/drivers/transport.ts";
import type { DriverLockState, DriverSessionHandle, DriverTelemetry } from "../src/drivers/types.ts";
import {
  arfcnOf,
  bandOf,
  channelBandwidthOf,
  counterOf,
  decOrHexIntOf,
  fieldOf,
  firstField,
  firstOf,
  hexIntOf,
  identityOf,
  intOf,
  ipv4Of,
  ipv6Of,
  labelOf,
  megabytesToBytes,
  mhzOf,
  nonNegativeOf,
  numberOf,
  operatorOfPlmn,
  pciOf,
  plmnCodeOf,
  plmnOf,
  rowsOf,
  rsrpOf,
  rsrqOf,
  rssiOf,
  sinrOf,
  smallIntOf,
  temperatureOf,
  textOf,
} from "../src/drivers/values.ts";
import { parseFiberhomeTelemetry } from "../src/drivers/fiberhome.ts";
import { parsePinsuTelemetry } from "../src/drivers/pinsu.ts";
import { parseTozedTelemetry } from "../src/drivers/tozed.ts";
import { LanRouterMock } from "./helpers/lan-router.ts";

function newCheck(): WriteCheck {
  return { endpoints: [], readback: "none", reason: null };
}

describe("drivers: values", () => {
  it("reads numbers, hexadecimal and sentinels without guessing", () => {
    assert.equal(textOf("  a\u0000b "), "ab");
    assert.equal(textOf(42), "42");
    assert.equal(textOf(12n), "12");
    assert.equal(textOf(Number.NaN), null);
    assert.equal(textOf({}), null);
    assert.equal(intOf("-7"), -7);
    assert.equal(intOf("7.5"), null);
    assert.equal(intOf("--"), null);
    assert.equal(intOf("1".repeat(16)), null);
    assert.equal(hexIntOf("0xd3"), 211);
    assert.equal(hexIntOf("zz"), null);
    assert.equal(decOrHexIntOf("d3"), 211);
    assert.equal(decOrHexIntOf("211"), 211);
    assert.equal(decOrHexIntOf("0x10"), 16);
    assert.equal(numberOf("-79 dBm"), -79);
    assert.equal(numberOf("dBm"), null);
    assert.equal(rsrpOf("-156"), null);
    assert.equal(rsrpOf("-80"), -80);
    assert.equal(rsrqOf("-43"), null);
    assert.equal(sinrOf("41"), null);
    assert.equal(rssiOf("-54"), -54);
    assert.equal(temperatureOf("0"), null);
    assert.equal(temperatureOf("46.5"), 46.5);
    assert.equal(pciOf("d3", "LTE", 16), 211);
    assert.equal(pciOf("600", "LTE"), null);
    assert.equal(pciOf("600", "NR"), 600);
    assert.equal(pciOf("8e", "NR", "auto"), 142);
    assert.equal(arfcnOf("0", "LTE"), null);
    assert.equal(arfcnOf("0", "LTE", { zeroIsNone: false }), 0);
    assert.equal(arfcnOf("3279166", "NR"), null);
    assert.equal(mhzOf("20MHz"), 20);
    assert.equal(channelBandwidthOf("20.0", "LTE"), 20);
    assert.equal(channelBandwidthOf("100", "LTE"), null);
    assert.equal(channelBandwidthOf("100", "NR"), 100);
    assert.equal(channelBandwidthOf("x", "NR"), null);
    assert.equal(smallIntOf("16", 15), null);
    assert.equal(counterOf("85899345920"), 85899345920n);
    assert.equal(counterOf("-1"), null);
    assert.equal(nonNegativeOf("12.6"), 13);
    assert.equal(nonNegativeOf("-1"), null);
    assert.equal(megabytesToBytes("1.5"), 1572864n);
    assert.equal(megabytesToBytes("-1"), null);
  });

  it("reads bands, identities, addresses and packed rows", () => {
    for (const text of ["3", "B3", "b3", "LTE BAND 3", "LTE B3"]) assert.equal(bandOf(text), 3, text);
    for (const text of ["n78", "N78", "NR5G BAND 78", "78"]) assert.equal(bandOf(text), 78, text);
    assert.equal(bandOf("B999"), null);
    assert.equal(identityOf("0800001e", 16), "134217758");
    assert.equal(identityOf("2711", 16), "10001");
    assert.equal(identityOf("134217758", 10), "134217758");
    assert.equal(identityOf("0x2711", "auto"), "10001");
    assert.equal(identityOf("0", 10), null);
    assert.equal(identityOf("fffffffff0", 16), null);
    assert.equal(labelOf("x".repeat(80))?.length, 64);
    assert.equal(ipv4Of("198.51.100.42"), "198.51.100.42");
    assert.equal(ipv4Of("0.0.0.0"), null);
    assert.equal(ipv4Of("256.1.1.1"), null);
    assert.equal(ipv6Of("2001:db8::42/64"), "2001:db8::42");
    assert.equal(ipv6Of("::"), null);
    assert.equal(ipv6Of("not-v6"), null);
    assert.deepEqual(rowsOf("a,b;;c,d;"), [
      ["a", "b"],
      ["c", "d"],
    ]);
    assert.deepEqual(rowsOf(42), []);
    const record = Object.assign(Object.create(null) as Record<string, unknown>, { a: "", b: "x" });
    assert.equal(fieldOf(record, "b"), "x");
    assert.equal(fieldOf([], "length"), undefined);
    assert.equal(firstField(record, "a", "b"), "x");
    assert.equal(firstField(record, "a"), undefined);
    assert.equal(firstOf(intOf, "x", "7"), 7);
    assert.equal(firstOf(intOf, "x"), null);
    assert.equal(plmnOf("272", "01"), "27201");
    assert.equal(plmnOf("27", "01"), null);
  });
});

describe("drivers: bands and cells", () => {
  it("converts band masks and lists both ways", () => {
    assert.equal(bandsToMask([1, 3, 8]), 0x85n);
    assert.deepEqual(maskToBands(0x85n), [1, 3, 8]);
    assert.throws(() => bandsToMask([0]), CpeControlValidationError);
    assert.equal(bandsToHex([1, 3, 8]), "85");
    assert.equal(bandsToHex([1, 3, 8], { prefix: "0x", upper: true }), "0x85");
    assert.equal(bandsToHex([], { zero: "0" }), "0");
    assert.equal(bandsToHex([]), "");
    assert.deepEqual(hexToBands("0X85"), [1, 3, 8]);
    assert.equal(hexToBands("xyz"), null);
    assert.equal(hexToBands(null), null);
    assert.deepEqual(listToBands("N78:n41, B1;3"), [1, 3, 41, 78]);
    assert.equal(listToBands("1,x"), null);
    assert.equal(listToBands(null), null);
    assert.equal(bandsToList([78, 41], ":", "N"), "N41:N78");
  });

  it("checks a lock against the 3GPP tables and the bands a router names", () => {
    assert.deepEqual(checkLockBands("LTE", [3, 1, 3], null), [1, 3]);
    assert.throws(() => checkLockBands("LTE", [], null), CpeControlValidationError);
    assert.throws(() => checkLockBands("LTE", [99], null), /not a 3GPP band/);
    assert.throws(() => checkLockBands("NR", [41], [78]), /not one this router supports/);
    assert.equal(defaultSpacing(1), 15);
    assert.equal(defaultSpacing(78), 30);
    assert.equal(defaultSpacing(257), 120);
    assert.ok(isSubcarrierSpacing(30));
    assert.ok(!isSubcarrierSpacing(31));
    assert.deepEqual(checkCellLock({ rat: "NR", band: 78, arfcn: 650000, pci: 142, scsKhz: null }), { rat: "NR", band: 78, arfcn: 650000, pci: 142, scsKhz: 30 });
    assert.deepEqual(checkCellLock({ rat: "LTE", band: 1, arfcn: 300, pci: 211, scsKhz: 30 }), { rat: "LTE", band: 1, arfcn: 300, pci: 211, scsKhz: null });
    assert.throws(() => checkCellLock({ rat: "LTE", band: 1, arfcn: 1850, pci: 1, scsKhz: null }), /outside B1/);
    assert.throws(() => checkCellLock({ rat: "LTE", band: 1, arfcn: 300, pci: 504, scsKhz: null }), /PCI 504/);
    assert.throws(() => checkCellLock({ rat: "NR", band: 999, arfcn: 1, pci: 1, scsKhz: null }), /not a 3GPP band/);
    assert.throws(() => checkCellLock({ rat: "NR", band: 78, arfcn: 650000, pci: 1, scsKhz: 7 as never }), /Subcarrier spacing/);
  });

  it("names serving modes and RATs, and checks channels against bands", () => {
    const modes: Array<[string, string | null]> = [
      ["SA", "SA"],
      ["NR5G-SA", "SA"],
      ["ENDC", "NSA"],
      ["NR5G_NSA", "NSA"],
      ["LTE", "LTE"],
      ["FDD_LTE", "LTE"],
      ["HSPA+", "WCDMA"],
      ["NO_SERVICE", "NONE"],
      ["LIMITED_SERVICE_X", "NONE"],
      ["GSM", null],
    ];
    for (const [text, mode] of modes) assert.equal(servingModeOf(text), mode, text);
    assert.equal(servingModeOf(""), null);
    assert.equal(ratOf("4G"), "LTE");
    assert.equal(ratOf("16"), "NR");
    assert.equal(ratOf("x"), null);
    assert.equal(ratOf(null), null);
    assert.equal(ratOfChannel(1850), "LTE");
    assert.equal(ratOfChannel(650000), "NR");
    assert.equal(ratOfChannel(null), null);
    assert.equal(ratOfChannel(3279165), null);
    assert.ok(channelInBand("LTE", 1, 300));
    assert.ok(!channelInBand("LTE", 1, 1850));
    assert.ok(!channelInBand("NR", null, 1));
    assert.equal(bandOfChannel("LTE", 1850), 3);
    assert.equal(bandOfChannel("NR", 650000), 78);
    assert.equal(bandOfChannel("NR", null), null);
    assert.equal(carrierOf("LTE", { band: "1", arfcn: "1850" }), null);
    assert.equal(carrierOf("LTE", {}), null);
    assert.equal(carrierOf("NR", { arfcn: "650000" })?.band, 78);
    assert.equal(neighbourOf("LTE", { arfcn: "300" }), null);
    assert.deepEqual(carriersFromRows("LTE", "x,y;", [{ band: 0, arfcn: 1 }]), []);
    assert.deepEqual(carriersFromRows("LTE", "", [{ band: 0, arfcn: 1 }]), []);
    // No layout fits every row: the rows the first one reads stay
    assert.deepEqual(
      carriersFromRows("LTE", "3,1850;9,9", [{ band: 0, arfcn: 1 }]).map((c) => c.arfcn),
      [1850]
    );
    assert.deepEqual(carriersFromRows("LTE", "3,1850", []), []);
  });
});

describe("drivers: login outcomes and read-backs", () => {
  it("maps login outcomes to the codes the breaker acts on", () => {
    assert.equal(wrongPassword("x", 2).code, "108006");
    assert.equal(wrongPassword("x").remainCount, null);
    assert.equal(loginLocked("x", 30).waitTime, 30);
    assert.equal(loginLocked("x").isLocked, true);
    assert.equal(signedInElsewhere("x").isSessionOccupied, true);
    assert.equal(loginUnplaced("x").isCircuitBreakerFatal, true);
    assert.match(new DriverLoginMethodError("why").message, /no password was sent/);
    assert.equal(new DriverSessionClosedError().name, "DriverSessionClosedError");
    assert.equal(md5Hex("a"), "0cc175b9c0f1b6a831c399e269772661");
    assert.equal(hmacMd5Hex("key", "The quick brown fox jumps over the lazy dog"), "80070713463e7749b90c2dc24911e275");
  });

  it("records commands and settles read-backs", () => {
    const check = newCheck();
    noteSent(check, "tozed", "cmd161");
    noteSent(check, "tozed", "cmd161");
    assert.deepEqual(check.endpoints, ["tozed:cmd161"]);
    assert.throws(() => noteSent(check, "tozed", "bad command"), /Refusing/);
    const state = (over: Partial<DriverLockState>): DriverLockState => ({ lteBands: [1, 3], nrBands: [78], lteCell: { locked: false }, nrCell: { locked: false }, networkMode: "lte", supportedLte: null, supportedNr: null, ...over });
    settleBandLock(check, { lte: [3, 1], nr: [78], networkMode: "lte" }, state({}));
    assert.deepEqual([check.readback, check.reason], ["match", null]);
    settleBandLock(check, { lte: [1], nr: null, networkMode: null }, state({}));
    assert.deepEqual([check.readback, check.reason], ["mismatch", "differs"]);
    settleBandLock(check, { lte: "all", nr: null, networkMode: "auto" }, state({ lteBands: "all", networkMode: null }));
    assert.deepEqual([check.readback, check.reason], ["unknown", "unreadable"]);
    settleBandLock(check, { lte: [1], nr: null, networkMode: null }, null);
    assert.equal(check.readback, "unknown");
    settleCellLock(check, { rat: "NR", band: 78, arfcn: 650000, pci: 142, scsKhz: 30 }, state({ nrCell: { locked: true, arfcn: 650000, pci: 142, band: 78 } }));
    assert.equal(check.readback, "match");
    settleCellLock(check, { rat: "LTE", band: 1, arfcn: 300, pci: 211, scsKhz: null }, state({}));
    assert.equal(check.readback, "mismatch");
    settleCellLock(check, { rat: "LTE", band: 1, arfcn: 300, pci: 211, scsKhz: null }, state({ lteCell: { locked: true, arfcn: null, pci: 211, band: null } }));
    assert.equal(check.readback, "unknown");
    settleCellLock(check, { rat: "LTE", band: 1, arfcn: 300, pci: 211, scsKhz: null }, state({ lteCell: null }));
    assert.equal(check.readback, "unknown");
    settleUnlock(check, state({ lteBands: "all", nrBands: "all", networkMode: "auto" }), { nr: true, mode: true });
    assert.equal(check.readback, "match");
    settleUnlock(check, state({ lteBands: "all", nrBands: "all", nrCell: { locked: true, arfcn: 1, pci: 1, band: 78 } }), { nr: true, mode: false });
    assert.equal(check.readback, "mismatch");
    settleUnlock(check, null, { nr: false, mode: false });
    assert.equal(check.readback, "unknown");
    settleRestart(check);
    assert.deepEqual([check.readback, check.reason], ["pending", null]);
  });
});

describe("drivers: LAN transport", () => {
  const http = (mock: LanRouterMock, signal = new AbortController().signal) => new LanHttp({ baseUrl: "http://192.168.0.1/", fetchImpl: mock.fetchImpl, timeoutMs: 1000, signal });

  it("stays on the router's address and keeps the cookies it sets", async () => {
    const mock = new LanRouterMock((req) => (req.path === "/login" ? { json: { ok: 1 }, setCookie: ["sid=abc; Path=/", "bad name=1", "gone=x"] } : req.path === "/drop" ? { json: {}, setCookie: ["sid=; Max-Age=0", "gone=deleted"] } : { json: { cookie: req.headers["cookie"] ?? null } }));
    const lan = http(mock);
    assert.equal(lan.origin, "http://192.168.0.1");
    assert.throws(() => lan.url("//evil.example/x"), /Refusing/);
    assert.throws(() => lan.url("relative"), /Refusing/);
    assert.throws(() => lan.url("/a@b"), /Refusing/);
    assert.match(lan.url("/x", [["a", "1,2"]]), /\/x\?a=1%2C2$/);
    await lan.postForm("/login", [["u", "a b"]], { referer: "/index.html" });
    assert.equal(mock.requests[0]?.body, "u=a+b");
    assert.equal(mock.requests[0]?.headers["referer"], "http://192.168.0.1/index.html");
    assert.equal(lan.cookie("sid"), "abc");
    assert.ok(lan.hasCookies);
    assert.deepEqual({ ...(await lan.getJson("/echo") as object) }, { cookie: "sid=abc; gone=x" });
    await lan.getJson("/drop");
    assert.equal(lan.cookie("sid"), undefined);
    assert.equal(lan.cookie("gone"), undefined);
    lan.clearCookies();
    assert.ok(!lan.hasCookies);
    const posted = await lan.postJson("/rpc", { a: 1 });
    assert.deepEqual({ ...(posted as object) }, { cookie: null });
    assert.equal(mock.requests.at(-1)?.headers["content-type"], "application/json; charset=UTF-8");
  });

  it("fails on answers it cannot read, and retries a GET on a stale socket only", async () => {
    let calls = 0;
    const flaky = new LanRouterMock(() => {
      calls += 1;
      if (calls === 1) throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }) });
      return { json: { ok: true } };
    });
    assert.deepEqual({ ...((await http(flaky).getJson("/x")) as object) }, { ok: true });
    assert.equal(calls, 2);
    const dead = new LanRouterMock(() => {
      throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("refused"), { code: "ECONNREFUSED" }) });
    });
    await assert.rejects(http(dead).getJson("/x"), CpeTransportError);
    const notJson = new LanRouterMock(() => ({ text: "<html>" }));
    await assert.rejects(http(notJson).getJson("/x"), CpeAnswerFormatError);
    const denied = new LanRouterMock(() => ({ status: 403, text: "{}" }));
    await assert.rejects(http(denied).getJson("/x"), /HTTP 403/);
    assert.throws(() => jsonAnswer({ status: 500, text: "", location: null }, "x"), CpeAnswerFormatError);
    assert.throws(() => parseJsonText("{", "x"), CpeAnswerFormatError);
    const redirect = new LanRouterMock(() => ({ status: 302, text: "", headers: { location: "/home" } }));
    const res = await http(redirect).request({ method: "POST", path: "/login", redirect: "manual" });
    assert.equal(res.location, "/home");
  });

  it("ends a request with the session's signal", async () => {
    const controller = new AbortController();
    const hang = new LanRouterMock(() => new Promise(() => undefined));
    const lan = http(hang, controller.signal);
    const pending = lan.getJson("/x");
    controller.abort(new CpeSessionDeadlineError(10));
    await assert.rejects(pending, CpeSessionDeadlineError);
    const big = new LanRouterMock(() => ({ text: "x".repeat(1024 * 1024 + 1) }));
    await assert.rejects(http(big).getJson("/x"), CpeAnswerFormatError);
  });
});

/** A protocol whose precheck and login do what a test says, and whose session counts logouts. */
function fakeProtocol(opts: { precheck?: () => Promise<{ occupied: boolean; locked: { waitSec: number | null } | null } | null>; login?: () => Promise<void>; logout?: () => Promise<void> } = {}) {
  const counts = { logins: 0, logouts: 0 };
  const protocol: DriverProtocol = {
    family: "tozed",
    detect: async () => true,
    precheck: opts.precheck,
    async login(): Promise<DriverSessionHandle> {
      counts.logins += 1;
      await opts.login?.();
      let open = true;
      const unsupported = async (): Promise<never> => {
        throw new Error("unused");
      };
      return {
        family: "tozed",
        get open() {
          return open;
        },
        identify: async () => ({ model: "MZ-X", softwareVersion: null, hardwareVersion: null }),
        telemetry: unsupported,
        neighbours: unsupported,
        lockState: unsupported,
        setBandLock: unsupported,
        setCellLock: unsupported,
        unlockAll: unsupported,
        reboot: unsupported,
        async logout() {
          counts.logouts += 1;
          open = false;
          await opts.logout?.();
        },
      };
    },
  };
  return { protocol, counts };
}

describe("drivers: session client", () => {
  const make = (protocol: DriverProtocol, extra: Partial<ConstructorParameters<typeof DriverCpeClient>[0]> = {}) =>
    new DriverCpeClient({ protocol, cpeUrl: "http://192.168.0.1", cpePassword: "pw", fetchImpl: new LanRouterMock(() => ({ json: {} })).fetchImpl, ...extra });

  it("runs one session at a time, logs out in finally and refuses nesting", async () => {
    const { protocol, counts } = fakeProtocol();
    const client = make(protocol, { cpeUsername: "admin" });
    assert.equal(client.family, "tozed");
    assert.equal(client.username, "admin");
    assert.ok(client.configured);
    assert.equal(client.baseUrl, "http://192.168.0.1");
    const model = await client.withSession(async (s) => {
      assert.ok(isInsideDriverSession(client));
      await assert.rejects(client.withSession(async () => 1), ReentrantCpeSessionError);
      return (await s.identify()).model;
    });
    assert.equal(model, "MZ-X");
    await assert.rejects(
      client.withSession(async () => {
        throw new Error("boom");
      }),
      /boom/
    );
    assert.deepEqual(counts, { logins: 2, logouts: 2 });
    const telemetry = client.getTelemetry();
    assert.equal(telemetry.totalSessionsCompleted, 2);
    assert.ok(telemetry.lastSessionHoldMs !== null);
    assert.equal(await client.waitForIdle(100), true);
  });

  it("yields to a person before the password and after it, without retrying", async () => {
    const before = fakeProtocol({ precheck: async () => ({ occupied: true, locked: null }) });
    const c1 = make(before.protocol);
    const outcome = await c1.withSessionDetailed(async () => 1);
    assert.deepEqual([outcome.status, outcome.status === "yielded" ? outcome.layer : null], ["yielded", 1]);
    assert.equal(before.counts.logins, 0);
    // With respectBrowserSession off, someone on the page does not stop it
    assert.equal(await c1.withSession(async () => 2, { respectBrowserSession: false }), 2);
    const after = fakeProtocol({
      login: async () => {
        throw signedInElsewhere("busy");
      },
    });
    const c2 = make(after.protocol);
    assert.equal(await c2.withSession(async () => 1), null);
    assert.equal(c2.getTelemetry().browserYieldCount, 1);
    assert.equal(after.counts.logouts, 0);
  });

  it("latches the breaker on a refused password or a locked login, until the password changes", async () => {
    const wrong = fakeProtocol({
      login: async () => {
        throw wrongPassword("no", 2);
      },
    });
    const client = make(wrong.protocol);
    await assert.rejects(client.withSession(async () => 1), (err: unknown) => err instanceof CpeApiError && err.code === "108006");
    await assert.rejects(client.withSession(async () => 1), (err: unknown) => err instanceof CpeApiError && err.code === "108006");
    assert.equal(wrong.counts.logins, 1);
    const saved = client.getCircuitBreakerState();
    assert.equal(saved.remainCount, 2);
    assert.equal(client.reloadCredentials("pw"), false);
    assert.ok(client.getCircuitBreakerState().tripped);
    // A restart with the same password keeps the latch; another password drops it
    const restarted = make(fakeProtocol().protocol);
    assert.ok(restarted.hydrateCircuitBreaker(saved));
    assert.ok(!make(fakeProtocol().protocol, { cpePassword: "new" }).hydrateCircuitBreaker(saved));
    assert.ok(!restarted.hydrateCircuitBreaker(null));
    assert.equal(client.reloadCredentials("other", "root"), true);
    assert.ok(!client.getCircuitBreakerState().tripped);
    client.reconfigure({ cpeUrl: "http://192.168.0.2", cpeUsername: "admin", cpePassword: "x" });
    assert.equal(client.baseUrl, "http://192.168.0.2");
    const locked = fakeProtocol({ precheck: async () => ({ occupied: false, locked: { waitSec: 60 } }) });
    const c2 = make(locked.protocol);
    await assert.rejects(c2.withSession(async () => 1), (err: unknown) => err instanceof CpeApiError && err.code === "108007" && err.waitTime === 60);
    assert.equal(locked.counts.logins, 0);
    const lockedNoWait = fakeProtocol({ precheck: async () => ({ occupied: false, locked: { waitSec: null } }) });
    await assert.rejects(make(lockedNoWait.protocol).withSession(async () => 1), (err: unknown) => err instanceof CpeApiError && err.code === "108007");
  });

  it("ends a hung session at its deadline and still logs out", async () => {
    const { protocol, counts } = fakeProtocol({ logout: async () => new Promise(() => undefined) });
    const client = make(protocol, { sessionMaxHoldMs: 60, logoutTimeoutMs: 30 });
    await assert.rejects(
      client.withSession(() => new Promise(() => undefined)),
      CpeSessionDeadlineError
    );
    assert.equal(counts.logouts, 1);
    const second = fakeProtocol();
    const c2 = make(second.protocol);
    const running = c2.withSession(() => new Promise(() => undefined));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(c2.abortActiveSession(new Error("stop")));
    await assert.rejects(running, /stop/);
    assert.ok(!c2.abortActiveSession(new Error("again")));
    assert.equal(second.counts.logouts, 1);
  });

  it("waits for a running session only so long", async () => {
    const { protocol } = fakeProtocol();
    const client = make(protocol);
    let release: () => void = () => undefined;
    const running = client.withSession(() => new Promise<void>((resolve) => (release = resolve)));
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(await client.waitForIdle(20), false);
    release();
    await running;
    assert.ok(!client.configured === false);
  });
});

describe("drivers: snapshots", () => {
  const base = (over: Partial<DriverTelemetry>): DriverTelemetry => ({
    model: "MC888",
    softwareVersion: "V1",
    hardwareVersion: "HW1",
    operatorName: "Three",
    plmn: "27201",
    mode: "NSA",
    lte: { ...emptyCell(), band: 1, arfcn: 300, pci: 211, rsrpDbm: -80, sinrDb: 20, bandwidthMhz: 20, cellId: "134217758", tac: "10001", mimoLayers: 2, cqi: 12, dlMcs: 27, ulMcs: 20 },
    nr: { ...emptyCell(), band: 78, arfcn: 650000, pci: 142, rsrpDbm: -85, bandwidthMhz: 100 },
    carriers: [{ rat: "LTE", band: 3, arfcn: 1850, pci: 142, bandwidthMhz: 20, rsrpDbm: -90, rsrqDb: -10, rssiDbm: null, sinrDb: 5 }],
    wan: { connected: true, ipv4: "198.51.100.42", ipv6: "2001:db8::42", uptimeSec: 600 },
    traffic: {
      downloadBytesPerSec: 1000,
      uploadBytesPerSec: 100,
      totalDownloadBytes: null,
      totalUploadBytes: null,
      sessionDownloadBytes: 10n,
      sessionUploadBytes: 5n,
      sessionSeconds: 600,
      monthDownloadBytes: 1000n,
      monthUploadBytes: 500n,
      monthTotalBytes: null,
      monthSeconds: 3600,
    },
    temperatureC: 45,
    signalBars: 4,
    ...over,
  });

  it("lays out an EN-DC poll the way the H168-383 reports one", () => {
    const rf = driverRfSnapshot(base({}));
    assert.equal(rf.pccBand, "B1");
    assert.equal(rf.earfcnRaw, "DL:300");
    assert.equal(rf.nrArfcnRaw, "650000");
    assert.deepEqual(
      rf.nrScc.map((c) => c.band),
      ["N78"]
    );
    assert.deepEqual(
      rf.lteScc.map((c) => c.band),
      ["B3"]
    );
    assert.equal(rf.caComponentCount, 3);
    assert.equal(rf.totalAggregatedBandwidthMhz, 140);
    assert.equal(rf.caBannerRaw, "20MHz@300(B1) + 20MHz@1850(B3) + 100MHz@650000(N78)");
    assert.equal(rf.eNodeBDisplay, "524288");
    assert.equal(rf.lteDlMcs[0]?.index, 27);
    assert.equal(rf.identityVerification.sectorIdBitWidthOk, true);
  });

  it("lays out a standalone poll with the NR cell first", () => {
    const rf = driverRfSnapshot(base({ mode: "SA", lte: null, carriers: [{ rat: "NR", band: 41, arfcn: 504990, pci: 1, bandwidthMhz: 100, rsrpDbm: null, rsrqDb: null, rssiDbm: null, sinrDb: null }], nr: { ...emptyCell(), band: 78, arfcn: 650000, pci: 142, bandwidthMhz: 100, cellId: "4096" } }));
    assert.equal(rf.pccBand, "N78");
    assert.equal(rf.earfcnRaw, "");
    assert.equal(rf.eNodeBDisplay, "1");
    assert.deepEqual(
      rf.nrScc.map((c) => c.band),
      ["N41"]
    );
    const bare = driverRfSnapshot(base({ mode: null, lte: { ...emptyCell(), band: 1, arfcn: 300 }, nr: null, carriers: [{ rat: "LTE", band: 3, arfcn: null, pci: null, bandwidthMhz: 10, rsrpDbm: null, rsrqDb: null, rssiDbm: null, sinrDb: null }] }));
    assert.equal(bare.caComponentCount, 2);
    assert.equal(bare.totalAggregatedBandwidthMhz, 10);
    const empty = driverRfSnapshot(base({ mode: null, lte: null, nr: null, carriers: [] }));
    assert.equal(empty.caComponentCount, 0);
    assert.equal(empty.pccBand, "");
  });

  it("lists what the router did not report as unavailable instead of zero", () => {
    const full = driverTelemetrySnapshot(base({}), 1_000);
    // No uptime of the router's own: shown as not available, never as a router that just started
    assert.deepEqual(full.unavailable, ["uptime"]);
    assert.deepEqual(driverTelemetrySnapshot(base({ status: { system: { uptimeSec: 7200, cpuPercent: null, memoryPercent: null } } }), 1_000).unavailable, []);
    assert.equal(full.device.connectionStatus, "901");
    assert.equal(full.traffic.monthTotalBytes, 1500);
    assert.equal(full.thermal.temperatureSupported, true);
    const bare = driverTelemetrySnapshot(base({ mode: null, lte: null, nr: null, wan: { connected: null, ipv4: null, ipv6: null, uptimeSec: null }, traffic: null, temperatureC: null, signalBars: null }), 2_000);
    assert.deepEqual(bare.unavailable, ["signal", "status", "traffic", "month", "uptime"]);
    assert.equal(bare.device.connectionStatus, "");
    assert.equal(bare.traffic.sessionConnectTimeSec, 0);
    const down = driverTelemetrySnapshot(base({ wan: { connected: false, ipv4: null, ipv6: null, uptimeSec: null } }));
    assert.equal(down.device.connectionStatus, "902");
    const neighbours = driverNeighbourSnapshot([
      { rat: "LTE", band: 3, arfcn: 1850, pci: 142, rsrpDbm: -95, rsrqDb: null, rssiDbm: null, sinrDb: null },
      { rat: "NR", band: null, arfcn: 650000, pci: 1, rsrpDbm: null, rsrqDb: null, rssiDbm: null, sinrDb: null },
    ]);
    assert.equal(neighbours.totalCount, 2);
    assert.equal(neighbours.nrNeighbors[0]?.band, "--");
    assert.ok(cellHasData({ ...emptyCell(), sinrDb: 1 }));
    assert.ok(!cellHasData(emptyCell()));
  });

  it("derives rates from counters, never across a reset or a long gap", () => {
    const rates = new CounterRates();
    const withCounters = (down: bigint, up: bigint): DriverTelemetry =>
      base({ traffic: { ...(base({}).traffic as NonNullable<DriverTelemetry["traffic"]>), downloadBytesPerSec: null, uploadBytesPerSec: null, totalDownloadBytes: down, totalUploadBytes: up } });
    assert.equal(rates.apply(withCounters(1000n, 100n), 0).traffic?.downloadBytesPerSec, null);
    assert.equal(rates.apply(withCounters(6000n, 600n), 5000).traffic?.downloadBytesPerSec, 1000);
    assert.equal(rates.apply(withCounters(10n, 10n), 10000).traffic?.downloadBytesPerSec, null);
    assert.equal(rates.apply(withCounters(20n, 20n), 700000).traffic?.downloadBytesPerSec, null);
    assert.equal(rates.apply(base({}), 700001).traffic?.downloadBytesPerSec, 1000);
    rates.reset();
    assert.equal(rates.apply(withCounters(30n, 30n), 700002).traffic?.downloadBytesPerSec, null);
  });

  it("takes no rate across two of a router's counters (a module that counts 4G and 5G apart)", () => {
    const rates = new CounterRates();
    const counted = (down: bigint, source: string): DriverTelemetry =>
      base({ traffic: { ...(base({}).traffic as NonNullable<DriverTelemetry["traffic"]>), downloadBytesPerSec: null, uploadBytesPerSec: null, totalDownloadBytes: down, totalUploadBytes: 0n, counterSource: source } });
    assert.equal(rates.apply(counted(1000n, "AT+QGDCNT?"), 0).traffic?.downloadBytesPerSec, null);
    assert.equal(rates.apply(counted(9_000_000n, "AT+QGDNRCNT?"), 5000).traffic?.downloadBytesPerSec, null, "the 5G counter is not a delta of the 4G one");
    assert.equal(rates.apply(counted(9_005_000n, "AT+QGDNRCNT?"), 10000).traffic?.downloadBytesPerSec, 1000);
  });
});

describe("drivers: fields the notes name that a router leaves out", () => {
  it("names the operator of a mainland PLMN from the notes' table, and nothing for any other code", () => {
    assert.deepEqual(["46000", "46020", "46001", "46010", "46003", "46012", "46015"].map(operatorOfPlmn), ["CMCC", "CMCC", "CUCC", "CUCC", "CTCC", "CTCC", "CBN"]);
    assert.equal(operatorOfPlmn("27201"), null);
    assert.equal(operatorOfPlmn("constructor"), null, "own keys only");
    assert.equal(operatorOfPlmn(null), null);
    assert.deepEqual([plmnCodeOf("46000"), plmnCodeOf("272010"), plmnCodeOf("CMCC"), plmnCodeOf("4600"), plmnCodeOf(46001)], ["46000", "272010", null, null, "46001"]);
  });

  it("fills the operator where the router names its PLMN only (Tozed, FiberHome)", () => {
    assert.equal(parseTozedTelemetry({ network_operator: "46001" }, null).operatorName, "CUCC");
    assert.equal(parseTozedTelemetry({ network_operator: "27201" }, null).operatorName, null);
    const fiber = parseFiberhomeTelemetry({ WorkMode: "SA", PLMN: "46000", todayRxBytes: "1073741824", todayTxBytes: "52428800" }).telemetry;
    assert.deepEqual([fiber.operatorName, fiber.plmn, fiber.traffic?.todayBytes], ["CMCC", "46000", 1_126_170_624n]);
    assert.equal(parseFiberhomeTelemetry({ WorkMode: "SA" }).telemetry.traffic?.todayBytes, null);
    // Today's traffic reaches the console's snapshot
    assert.equal(driverTelemetrySnapshot(fiber, 0).traffic.todayUsedBytes, 1_126_170_624);
  });

  it("takes a PLMN where the router writes one in place of the operator's name (NRadio, Pinsu)", () => {
    const pinsu = parsePinsuTelemetry({ mnet_operator_name: "46011" });
    assert.deepEqual([pinsu.operatorName, pinsu.plmn], ["CTCC", "46011"]);
    const named = parsePinsuTelemetry({ mnet_operator_name: "CHINA MOBILE" });
    assert.deepEqual([named.operatorName, named.plmn], ["CHINA MOBILE", null]);
  });
});
