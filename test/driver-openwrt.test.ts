import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CpeApiError } from "../src/session-errors.ts";
import type { WriteCheck } from "../src/device-access.ts";
import { OPENWRT_ANONYMOUS_SESSION, forgetOpenwrtSimReads, extractAtResponse, openwrtProtocol, parseSystemInfo } from "../src/drivers/openwrt.ts";
import { atValueLine, detectModemBrand, isAtError, modemBrandOf, parseCfun, parseOperatorName, parseSimPin, splitAtCsv } from "../src/protocols/at/common.ts";
import { parseQuectelCaInfo, parseQuectelCsi, parseQuectelDataCounter, parseQuectelNeighbours, parseQuectelRsrp, parseQuectelServingCell, parseQuectelTemp, parseQuectelTempSensors, quectelLteSinr } from "../src/protocols/at/quectel.ts";
import { parseFibocomAct, parseFibocomCaInfo, parseFibocomCcInfo } from "../src/protocols/at/fibocom.ts";
import { LanHttp } from "../src/drivers/transport.ts";
import { OPENWRT_SESSION_TOKEN as SESSION_TOKEN, openwrtRouter } from "./helpers/openwrt-router.ts";

function newCheck(): WriteCheck {
  return { endpoints: [], readback: "none", reason: null };
}

describe("openwrt: helpers and parsing", () => {
  it("extracts text responses from varied RPC reply shapes", () => {
    assert.equal(extractAtResponse("OK"), "OK");
    assert.equal(extractAtResponse(["line 1", "line 2"]), "line 1\nline 2");
    assert.equal(extractAtResponse({ response: "AT+QENG: ...\nOK" }), "AT+QENG: ...\nOK");
    assert.equal(extractAtResponse({ stdout: "ATI output" }), "ATI output");
    assert.equal(extractAtResponse({ output: ["part 1", "part 2"] }), "part 1\npart 2");
    assert.equal(extractAtResponse(null), "");
  });

  it("detects modem brand from ATI string", () => {
    assert.equal(detectModemBrand("Quectel\nRM520N-GL\nOK"), "quectel");
    assert.equal(detectModemBrand("Fibocom Wireless Inc.\nFM650-CN\nOK"), "fibocom");
    assert.equal(detectModemBrand("FM350-GL"), "fibocom");
    assert.equal(detectModemBrand("Generic Module"), "quectel");
  });

  it("splits AT csv line handling quoted strings correctly", () => {
    const fields = splitAtCsv('"servingcell","NOCONN","NR5G-SA","TDD",460,00');
    assert.deepEqual(fields, ["servingcell", "NOCONN", "NR5G-SA", "TDD", "460", "00"]);
  });

  it("calculates Quectel LTE SINR using 2*X - 20 formula", () => {
    assert.equal(quectelLteSinr(0), -20);
    assert.equal(quectelLteSinr(10), 0);
    assert.equal(quectelLteSinr(20), 20);
    assert.equal(quectelLteSinr(25), 30);
    assert.equal(quectelLteSinr(30), 40);
    // Values outside [0, 30] left as direct dB
    assert.equal(quectelLteSinr(-5), -5);
    assert.equal(quectelLteSinr(35), 35);
    assert.equal(quectelLteSinr(null), null);
  });

  it("parses Quectel 5G SA serving cell", () => {
    const text = '+QENG: "servingcell","NOCONN","NR5G-SA","TDD",460,00,01A2B3C,142,000A,627264,78,11,-82,-10,18,1,0';
    const parsed = parseQuectelServingCell(text);
    assert.equal(parsed.mode, "SA");
    assert.equal(parsed.plmn, "46000");
    assert.ok(parsed.nr !== null);
    assert.equal(parsed.nr.cellId, "1715004");
    assert.equal(parsed.nr.pci, 142);
    assert.equal(parsed.nr.tac, "10");
    assert.equal(parsed.nr.arfcn, 627264);
    assert.equal(parsed.nr.band, 78);
    assert.equal(parsed.nr.bandwidthMhz, 100);
    assert.equal(parsed.nr.rsrpDbm, -82);
    assert.equal(parsed.nr.rsrqDb, -10);
    assert.equal(parsed.nr.sinrDb, 18);
  });

  it("parses Quectel 5G NSA (EN-DC) serving cells with SINR conversion", () => {
    const text =
      '+QENG: "servingcell","CONNECT","LTE","FDD",460,00,1A2B3C,456,100,1,3,3,1A2B,-80,-10,-55,20,15\n' +
      '+QENG: "NR5G-NSA",460,00,142,-82,18,-10,627264,78,11,1';
    const parsed = parseQuectelServingCell(text);
    assert.equal(parsed.mode, "NSA");
    assert.equal(parsed.plmn, "46000");
    assert.ok(parsed.lte !== null);
    assert.equal(parsed.lte.pci, 456);
    assert.equal(parsed.lte.band, 1);
    assert.equal(parsed.lte.sinrDb, 20); // 2 * 20 - 20 = 20 dB
    assert.ok(parsed.nr !== null);
    assert.equal(parsed.nr.pci, 142);
    assert.equal(parsed.nr.band, 78);
    assert.equal(parsed.nr.bandwidthMhz, 100);
  });

  it("parses Quectel LTE only serving cell", () => {
    const text = '+QENG: "servingcell","CONNECT","LTE","FDD",460,00,1A2B3C,456,100,1,3,3,1A2B,-80,-10,-55,25,15';
    const parsed = parseQuectelServingCell(text);
    assert.equal(parsed.mode, "LTE");
    assert.equal(parsed.plmn, "46000");
    assert.ok(parsed.lte !== null);
    assert.equal(parsed.nr, null);
    assert.equal(parsed.lte.sinrDb, 30); // 2 * 25 - 20 = 30 dB
  });

  it("parses Quectel QCAINFO secondary carriers", () => {
    const text =
      '+QCAINFO: "PCC",627264,11,"NR5G BAND 78",1,142,-82,-10,-55,18\n' +
      '+QCAINFO: "SCC",634000,11,"NR5G BAND 78",1,143,-85,-11,-58,16\n' +
      '+QCAINFO: "SCC",1650,50,"LTE BAND 3",1,211,-88,-12,-62,12';
    const carriers = parseQuectelCaInfo(text);
    assert.equal(carriers.length, 2);
    assert.equal(carriers[0]?.rat, "NR");
    assert.equal(carriers[0]?.arfcn, 634000);
    assert.equal(carriers[0]?.bandwidthMhz, 100);
    assert.equal(carriers[0]?.pci, 143);
    assert.equal(carriers[1]?.rat, "LTE");
    assert.equal(carriers[1]?.arfcn, 1650);
    assert.equal(carriers[1]?.bandwidthMhz, 10); // 50 RB -> 10 MHz
    assert.equal(carriers[1]?.pci, 211);
  });

  it("parses Quectel neighbour cells", () => {
    const text =
      '+QENG: "neighbourcell","NR5G",627264,145,-88,-12,12\n' +
      '+QENG: "neighbourcell intra","LTE",1650,211,-90,-11,-60,15';
    const neighbours = parseQuectelNeighbours(text);
    assert.equal(neighbours.length, 2);
    assert.equal(neighbours[0]?.rat, "NR");
    assert.equal(neighbours[0]?.pci, 145);
    assert.equal(neighbours[0]?.rsrpDbm, -88);
    assert.equal(neighbours[1]?.rat, "LTE");
    assert.equal(neighbours[1]?.pci, 211);
    assert.equal(neighbours[1]?.sinrDb, 10); // 2 * 15 - 20 = 10 dB
  });

  it("parses Quectel QRSRP 4-antenna report", () => {
    const text = "+QRSRP: -82,-84,-85,-86,NR5G";
    const chains = parseQuectelRsrp(text);
    assert.deepEqual(chains, [-82, -84, -85, -86]);
    assert.equal(parseQuectelRsrp("invalid"), null);
  });

  it("parses Quectel QTEMP temperatures", () => {
    const text = '+QTEMP: "soc-thermal",42\n+QTEMP: "pa-thermal",51\n+QTEMP: "modem-thermal",45';
    assert.equal(parseQuectelTemp(text), 51);
    assert.equal(parseQuectelTemp("none"), null);
  });

  it("reads the operator's name from AT+COPS?, never a PLMN or a missing registration for one", () => {
    assert.equal(parseOperatorName('+COPS: 0,0,"Three",11\r\n\r\nOK\r\n'), "Three");
    assert.equal(parseOperatorName('+COPS: 1,1,"3 IRL",7\nOK\n'), "3 IRL");
    assert.equal(parseOperatorName('+COPS: 0,2,"27201",7\nOK\n'), null, "the numeric format is a PLMN, not a name");
    assert.equal(parseOperatorName("+COPS: 0\nOK\n"), null, "not registered");
    assert.equal(parseOperatorName("ERROR\n"), null);
    assert.equal(parseOperatorName(""), null);
    assert.equal(parseOperatorName(`+COPS: 0,0,"${"x".repeat(80)}",7`), null, "an over-long name is not one");
  });

  it("parses Fibocom GTCCINFO serving cells and neighbours with RSRP conversion", () => {
    // raw Rsrp 74: NR RSRP is 74 - 156 = -82 dBm; LTE raw Rsrp 60 is 60 - 140 = -80 dBm
    const text =
      "+GTCCINFO: 1,9,460,00,000A,01A2B3C,627264,142,-70,-10,74,18\n" +
      "+GTCCINFO: 1,4,460,00,000A,01A2B3D,1650,211,-65,-12,60,15\n" +
      "+GTCCINFO: 2,9,460,00,000A,01A2B3E,627264,143,-75,-14,68,12";
    const parsed = parseFibocomCcInfo(text);
    assert.equal(parsed.mode, "NSA");
    assert.equal(parsed.plmn, "46000");
    assert.ok(parsed.nr !== null);
    assert.equal(parsed.nr.rsrpDbm, -82);
    assert.ok(parsed.lte !== null);
    assert.equal(parsed.lte.rsrpDbm, -80);
    assert.equal(parsed.neighbours.length, 1);
    assert.equal(parsed.neighbours[0]?.rat, "NR");
    assert.equal(parsed.neighbours[0]?.pci, 323); // 0x143 = 323
    assert.equal(parsed.neighbours[0]?.rsrpDbm, -88); // 68 - 156 = -88 dBm
  });
});

describe("openwrt: Quectel's packet data counters", () => {
  it("reads bytes sent, then received, as the module's AT manual orders them", () => {
    assert.deepEqual(parseQuectelDataCounter("+QGDNRCNT: 3832,4618\r\n\r\nOK\r\n", "+QGDNRCNT:"), { sent: 3832n, received: 4618n });
    assert.deepEqual(parseQuectelDataCounter("AT+QGDCNT?\n+QGDCNT: 0,18446744073709551615\nOK", "+QGDCNT:"), { sent: 0n, received: 18446744073709551615n });
    assert.equal(parseQuectelDataCounter("+QGDCNT: 1,2\nOK", "+QGDNRCNT:"), null, "the other mode's counter is not this one");
    assert.equal(parseQuectelDataCounter("+QGDNRCNT: -1,2\nOK", "+QGDNRCNT:"), null);
    assert.equal(parseQuectelDataCounter("+QGDNRCNT: 1\nOK", "+QGDNRCNT:"), null);
    assert.equal(parseQuectelDataCounter("ERROR", "+QGDNRCNT:"), null);
  });

  it("reads the counter of the mode the module is in, and none when it has no service", async () => {
    const { client, state } = openwrtRouter({ brand: "quectel" });
    const sa = await client.withSession((s) => s.telemetry());
    assert.ok(sa);
    assert.deepEqual([sa.traffic?.totalDownloadBytes, sa.traffic?.totalUploadBytes, sa.traffic?.counterSource], [15_849_203_712n, 2_194_810_368n, "AT+QGDNRCNT?"]);
    assert.equal(sa.traffic?.downloadBytesPerSec, null, "a rate comes from two polls");
    assert.ok(!state.executedCommands.includes("AT+QGDCNT?"), "5G standalone counts on QGDNRCNT alone");
    state.serving = "none";
    const searching = await client.withSession((s) => s.telemetry());
    assert.equal(searching?.traffic, null);
  });

  it("leaves the traffic unread when the module answers the counter with an error", async () => {
    const { client } = openwrtRouter({ brand: "quectel", atErrors: ["AT+QGDNRCNT"] });
    assert.equal((await client.withSession((s) => s.telemetry()))?.traffic, null);
  });
});

describe("openwrt: session and Quectel integration", () => {
  it("performs precheck and logs in using anonymous session token", async () => {
    const { mock, calls, client } = openwrtRouter({ brand: "quectel" });
    const http = new LanHttp({
      baseUrl: "http://192.168.1.1",
      fetchImpl: mock.fetchImpl,
      timeoutMs: 2000,
      signal: new AbortController().signal,
    });
    assert.ok(openwrtProtocol.precheck);
    const pre = await openwrtProtocol.precheck(http);
    assert.deepEqual(pre, { occupied: false, locked: null });

    const identity = await client.withSession(async (s) => s.identify());
    assert.ok(identity);
    assert.equal(identity.model, "RM520N-GL");
    assert.equal(identity.hardwareVersion, "quectel");
    assert.equal(identity.softwareVersion, "RM520NGLAAR01A07M4G");

    // Login call used OPENWRT_ANONYMOUS_SESSION
    const loginCall = calls.find((c) => c.object === "session" && c.method === "login");
    assert.ok(loginCall);
    assert.equal(loginCall.session, OPENWRT_ANONYMOUS_SESSION);

    // Logout destroyed the session
    const destroyCall = calls.find((c) => c.object === "session" && c.method === "destroy");
    assert.ok(destroyCall);
    assert.equal(destroyCall.session, SESSION_TOKEN);
  });

  it("handles wrong password and rejects invalid session", async () => {
    const wrong = openwrtRouter({ loginStatus: 6 });
    await assert.rejects(wrong.client.withSession((s) => s.identify()), (err: unknown) => err instanceof CpeApiError && err.code === "108006");

    const invalid = openwrtRouter({ loginPayload: { not_a_session: true } });
    await assert.rejects(invalid.client.withSession((s) => s.identify()), (err: unknown) => err instanceof CpeApiError && err.code === "108006");
  });

  it("polls Quectel telemetry, neighbours and lock state", async () => {
    const { client } = openwrtRouter({ brand: "quectel" });
    await client.withSession(async (s) => {
      const telem = await s.telemetry();
      assert.equal(telem.mode, "SA");
      assert.equal(telem.plmn, "46000");
      assert.equal(telem.temperatureC, 46);
      assert.equal(telem.operatorName, "Three");
      assert.equal(telem.signalBars, null, "the module reports no bars: none are made up");
      assert.equal(telem.carriers.length, 1);
      assert.deepEqual(telem.nr?.rxRsrpDbm, [-82, -84, -85, -86]);

      const neigh = await s.neighbours();
      assert.equal(neigh.length, 2);

      const locks = await s.lockState();
      assert.deepEqual(locks.lteBands, [1, 3, 7]);
      assert.deepEqual(locks.nrBands, [41, 78]);
      assert.equal(locks.networkMode, "auto");
      assert.deepEqual(locks.lteCell, { locked: false });
      assert.deepEqual(locks.nrCell, { locked: false });
    });
  });

  it("executes Quectel band lock, cell lock, unlock, and reboot", async () => {
    const { state, client } = openwrtRouter({ brand: "quectel" });
    await client.withSession(async (s) => {
      // 1. Band lock
      const bandCheck = newCheck();
      await s.setBandLock({ lte: [1, 3], nr: [78], networkMode: "nr_sa" }, bandCheck);
      assert.equal(bandCheck.readback, "match");
      assert.equal(state.lteBand, "1:3");
      assert.equal(state.nrBand, "78");
      assert.equal(state.modePref, "NR5G");

      // 2. Cell lock (5G)
      const cellCheck = newCheck();
      await s.setCellLock({ rat: "NR", band: 78, arfcn: 627264, pci: 142, scsKhz: 30 }, cellCheck);
      assert.equal(cellCheck.readback, "match");
      assert.equal(state.lock5g, "142,627264,30,78");

      // 3. Unlock all
      const unlockCheck = newCheck();
      await s.unlockAll(unlockCheck);
      assert.equal(unlockCheck.readback, "match");
      assert.equal(state.lock4g, "0");
      assert.equal(state.lock5g, "0");
      assert.equal(state.modePref, "AUTO");

      // 4. Reboot
      const rebootCheck = newCheck();
      await s.reboot(rebootCheck);
      assert.equal(rebootCheck.readback, "pending");
      assert.ok(state.executedCommands.includes("AT+CFUN=1,1"));
    });
  });
});

describe("openwrt: Fibocom's carrier aggregation", () => {
  it("lists the activated secondary carriers of AT+GTCAINFO? and leaves the primary to AT+GTCCINFO?", () => {
    const answer = [
      "+GTCAINFO:",
      "PCC:101,211,300,100,100,2,1,3,1,-81",
      "SCC 1:2,1,103,142,1850,75,75,2,1,3,1,-88",
      "SCC2:2,0,578,142,650000,12,255,2,255,3,255,-90",
      "SCC 3:1,0,107,211,3100,50,255,2,255,3,255,-95",
      "SCC 4:2,0,999,1,1,1,1",
      "",
      "OK",
    ].join("\r\n");
    assert.deepEqual(parseFibocomCaInfo(answer), [
      { rat: "LTE", band: 3, arfcn: 1850, pci: 142, bandwidthMhz: 15, rsrpDbm: -88, rsrqDb: null, rssiDbm: null, sinrDb: null },
      // An NR carrier's bandwidth is coded per firmware: not guessed
      { rat: "NR", band: 78, arfcn: 650000, pci: 142, bandwidthMhz: null, rsrpDbm: -90, rsrqDb: null, rssiDbm: null, sinrDb: null },
    ]);
    // NR band codes come as 500 + band on some firmware and 5000 + band on others
    assert.equal(parseFibocomCaInfo("SCC 1:2,0,5078,142,650000,12,255,2,255,3,255,-90")[0]?.band, 78);
    assert.deepEqual(parseFibocomCaInfo("+GTCAINFO:\r\nOK"), []);
    assert.deepEqual(parseFibocomCaInfo("ERROR"), []);
    assert.deepEqual(parseFibocomCaInfo("SCC 1:2,0,103"), [], "too few fields");
    assert.equal(parseFibocomCaInfo("SCC 1:2,0,103,142,1850,75,75")[0]?.rsrpDbm, null, "no RSRP field");
  });
});

describe("openwrt: session and Fibocom integration", () => {
  it("polls Fibocom telemetry, neighbours and lock state", async () => {
    const { client } = openwrtRouter({ brand: "fibocom" });
    await client.withSession(async (s) => {
      const identity = await s.identify();
      assert.equal(identity.model, "FM650-CN");
      assert.equal(identity.hardwareVersion, "fibocom");
      assert.equal(identity.softwareVersion, "19001.1000.00.01.01.01");

      const telem = await s.telemetry();
      assert.equal(telem.mode, "SA");
      assert.equal(telem.plmn, "46000");
      assert.equal(telem.temperatureC, 45.5);
      assert.equal(telem.operatorName, "Three");
      assert.equal(telem.signalBars, null);
      assert.ok(telem.nr !== null);
      assert.equal(telem.nr.rsrpDbm, -82);
      assert.deepEqual(telem.carriers.map((c) => [c.rat, c.band, c.arfcn, c.pci]), [["NR", 78, 649980, 211]], "the activated secondary only");

      const neigh = await s.neighbours();
      assert.equal(neigh.length, 1);
      assert.equal(neigh[0]?.pci, 323); // 0x143 = 323

      const locks = await s.lockState();
      assert.deepEqual(locks.lteBands, [1, 3]);
      assert.deepEqual(locks.nrBands, [41, 78]);
      assert.deepEqual(locks.lteCell, { locked: false });
      assert.deepEqual(locks.nrCell, { locked: false });
    });
  });

  it("writes the module's own capability list for every band, and stops at a command the module refuses", async () => {
    const { state, client } = openwrtRouter({ brand: "quectel" });
    await client.withSession(async (s) => {
      // Locked first, so "all" has something to undo
      await s.setBandLock({ lte: [3], nr: [78], networkMode: null }, newCheck());
      const check = newCheck();
      await s.setBandLock({ lte: "all", nr: "all", networkMode: "nr_nsa" }, check);
      assert.equal(state.lteBand, "1:3:5:7:8:20:28:38:40:41");
      assert.equal(state.nrBand, "1:3:28:41:77:78:79");
      assert.deepEqual([state.modePref, state.nrDisableMode], ["LTE:NR5G", "1"]);
      assert.deepEqual([check.readback, check.reason], ["match", null]);
      assert.deepEqual(check.endpoints, [
        "openwrt:AT+QNWPREFCFG/lte_band",
        "openwrt:AT+QNWPREFCFG/nr5g_band",
        "openwrt:AT+QNWPREFCFG/nsa_nr5g_band",
        "openwrt:AT+QNWPREFCFG/nr5g_disable_mode",
        "openwrt:AT+QNWPREFCFG/mode_pref",
      ]);
    });

    const refusing = openwrtRouter({ brand: "quectel", atErrors: ['AT+QNWPREFCFG="nr5g_band",'] });
    const refused = newCheck();
    await assert.rejects(
      refusing.client.withSession((s) => s.setBandLock({ lte: [3], nr: [78], networkMode: "lte" }, refused)),
      (err: unknown) => err instanceof CpeApiError && err.code === "at-error"
    );
    assert.equal(refusing.state.lteBand, "3", "what went before the refusal was written");
    assert.equal(refusing.state.modePref, "AUTO", "nothing after it was sent");
    assert.deepEqual(refused.endpoints, ["openwrt:AT+QNWPREFCFG/lte_band", "openwrt:AT+QNWPREFCFG/nr5g_band"]);

    // No capability list to go by: "all" is not guessed
    const mute = openwrtRouter({ brand: "quectel", atErrors: ['AT+QNWPREFCFG="ue_capability_band"'] });
    await assert.rejects(mute.client.withSession((s) => s.setBandLock({ lte: "all", nr: null, networkMode: null }, newCheck())), /no capability band list/);
    assert.equal(mute.state.lteBand, "1:3:7");
  });

  it("reads a lock setting the module does not answer for as unknown, never as unlocked", async () => {
    const quectel = openwrtRouter({ brand: "quectel", atErrors: ['AT+QNWPREFCFG="lte_band"', 'AT+QNWLOCK="common/5g"'] });
    const q = await quectel.client.withSession((s) => s.lockState());
    assert.deepEqual([q?.lteBands, q?.nrCell, q?.lteCell], [null, null, { locked: false }]);
    assert.deepEqual(q?.nrBands, [41, 78]);
    const fibocom = openwrtRouter({ brand: "fibocom", atErrors: ["AT+GTACT?", "AT+GTCELLLOCK?"] });
    const f = await fibocom.client.withSession((s) => s.lockState());
    assert.deepEqual([f?.lteBands, f?.nrBands, f?.lteCell, f?.nrCell, f?.networkMode], [null, null, null, null, null]);
  });

  it("reads and writes the Fibocom RAT selection with the bands, and refuses a mode the command is not documented for", async () => {
    assert.deepEqual(parseFibocomAct("+GTACT: 17,6,2,101,103,541,578\n\nOK\n"), { rat: 17, preferRat: 6, preferBand: 2, lte: [1, 3], nr: [41, 78] });
    assert.deepEqual(parseFibocomAct("+GTACT: 14,6,2\nOK\n"), { rat: 14, preferRat: 6, preferBand: 2, lte: "all", nr: "all" });
    assert.equal(parseFibocomAct("ERROR\n"), null);
    assert.equal(parseFibocomAct("+GTACT: 17\nOK\n"), null);

    const { state, client } = openwrtRouter({ brand: "fibocom" });
    await client.withSession(async (s) => {
      assert.equal((await s.lockState()).networkMode, "auto");
      const check = newCheck();
      await s.setBandLock({ lte: "all", nr: [41, 78], networkMode: "nr_sa" }, check);
      // 14 is 5G standalone only; the preferences stay as the module reports them
      assert.equal(state.fibocomAct, "14,6,2,541,578");
      assert.deepEqual([check.readback, check.reason], ["match", null]);
      assert.equal((await s.lockState()).networkMode, "nr_sa");
      const before = state.executedCommands.length;
      await assert.rejects(s.setBandLock({ lte: [1], nr: null, networkMode: "lte" }, newCheck()), /documented for automatic/);
      assert.ok(!state.executedCommands.slice(before).some((cmd) => cmd.startsWith("AT+GTACT=")), "nothing was written");
    });
    const refusing = openwrtRouter({ brand: "fibocom", atErrors: ["AT+GTACT="] });
    await assert.rejects(refusing.client.withSession((s) => s.setBandLock({ lte: [1], nr: null, networkMode: null }, newCheck())), (err: unknown) => err instanceof CpeApiError && err.code === "at-error");
  });

  it("executes Fibocom band lock with +100/+500 offsets and cell lock", async () => {
    const { state, client } = openwrtRouter({ brand: "fibocom" });
    await client.withSession(async (s) => {
      // 1. Band lock: LTE 1, 3 (+100) -> 101, 103; NR 78 (+500) -> 578
      const bandCheck = newCheck();
      await s.setBandLock({ lte: [1, 3], nr: [78], networkMode: null }, bandCheck);
      assert.equal(bandCheck.readback, "match");
      assert.equal(state.fibocomAct, "17,6,2,101,103,578");

      // 2. Cell lock (LTE Band 3)
      const cellCheck = newCheck();
      await s.setCellLock({ rat: "LTE", band: 3, arfcn: 1650, pci: 211, scsKhz: null }, cellCheck);
      assert.equal(cellCheck.readback, "match");
      assert.equal(state.fibocomCellLock, "0,0,1650,211");

      // 3. Unlock all
      const unlockCheck = newCheck();
      await s.unlockAll(unlockCheck);
      assert.equal(unlockCheck.readback, "match");
      assert.equal(state.fibocomCellLock, "0");
      assert.equal(state.fibocomAct, "17,6,2");

      // 4. Reboot
      const rebootCheck = newCheck();
      await s.reboot(rebootCheck);
      assert.equal(rebootCheck.readback, "pending");
      assert.ok(state.executedCommands.includes("AT+CFUN=1,1"));
    });
  });
});

describe("openwrt: telling the module's make apart", () => {
  it("names the make from ATI / CGMM text, or none", () => {
    assert.equal(modemBrandOf("Fibocom Wireless Inc.\nFM650-CN\nOK"), "fibocom");
    assert.equal(modemBrandOf("FM150-AE"), "fibocom");
    assert.equal(modemBrandOf("fm160-na"), "fibocom");
    assert.equal(modemBrandOf("Model: FM350-GL"), "fibocom");
    assert.equal(modemBrandOf("FG370-EA"), "fibocom");
    assert.equal(modemBrandOf("Quectel\nRM520N-GL\nOK"), "quectel");
    assert.equal(modemBrandOf("RG500Q-EA"), "quectel");
    assert.equal(modemBrandOf("EM120R-GL"), "quectel");
    assert.equal(modemBrandOf("Manufacturer: Generic Inc.\nRevision: 1.0"), null);
    assert.equal(modemBrandOf(""), null);
    assert.equal(detectModemBrand("Generic Module"), "quectel");
    assert.equal(isAtError("ERROR"), true);
    assert.equal(isAtError("\r\nerror\r\n"), true);
    assert.equal(isAtError("+CME ERROR: 100"), true);
    assert.equal(isAtError("+CMS ERROR: 500\n"), true);
    assert.equal(isAtError('+QENG: "servingcell","SEARCH"\n\nOK'), false);
    assert.equal(isAtError(""), false);
  });

  it("identifies a Fibocom FM160 from AT+CGMM when ATI names no make, and runs the Fibocom commands", async () => {
    const { state, client } = openwrtRouter({
      brand: "fibocom",
      ati: "Manufacturer: Generic Inc.\nRevision: 81600.0000.00.29.19.21\n\nOK\n",
      cgmm: "FM160-NA\n\nOK\n",
    });
    await client.withSession(async (s) => {
      const identity = await s.identify();
      assert.equal(identity.hardwareVersion, "fibocom");
      assert.equal(identity.model, "FM160-NA");
      assert.equal(identity.softwareVersion, "19001.1000.00.01.01.01");

      const telem = await s.telemetry();
      assert.equal(telem.mode, "SA");
      assert.equal(telem.nr?.rsrpDbm, -82);
      assert.equal(telem.temperatureC, 45.5);

      const check = newCheck();
      await s.setBandLock({ lte: [1, 3], nr: [78], networkMode: null }, check);
      assert.equal(check.readback, "match");
      assert.equal(state.fibocomAct, "17,6,2,101,103,578");
    });
    assert.ok(state.executedCommands.includes("AT+CGMM"), "asked the model when ATI named no make");
    assert.ok(!state.executedCommands.some((c) => c.startsWith("AT+QNWPREFCFG") || c.startsWith("AT+QENG")), "no Quectel command went out");
  });

  it("falls back to Fibocom when neither ATI nor CGMM names the make and the Quectel serving-cell query answers ERROR", async () => {
    const { state, client } = openwrtRouter({
      brand: "fibocom",
      ati: "Manufacturer: Generic Inc.\nModel: 5G Module\n\nOK\n",
      cgmm: "5G Module\n\nOK\n",
      qengError: true,
    });
    await client.withSession(async (s) => {
      const identity = await s.identify();
      assert.equal(identity.hardwareVersion, "fibocom");
      assert.equal(identity.model, "5G Module");

      const telem = await s.telemetry();
      assert.equal(telem.mode, "SA");
      assert.equal(telem.plmn, "46000");
      const neigh = await s.neighbours();
      assert.equal(neigh.length, 1);
    });
    assert.equal(state.executedCommands.filter((c) => c === 'AT+QENG="servingcell"').length, 1, "probed once");
    assert.ok(state.executedCommands.includes("AT+GTCCINFO?"));
  });

  it("switches to the Fibocom commands when a module taken for Quectel answers the serving-cell query with ERROR", async () => {
    const { state, client } = openwrtRouter({ brand: "fibocom", ati: "Quectel\nRM500Q-GL\n\nOK\n", qengError: true });
    await client.withSession(async (s) => {
      assert.equal((await s.identify()).hardwareVersion, "quectel");
      const telem = await s.telemetry();
      assert.equal(telem.mode, "SA");
      assert.equal(telem.hardwareVersion, "fibocom");
      assert.equal((await s.identify()).hardwareVersion, "fibocom");

      // From here on the session speaks Fibocom
      const check = newCheck();
      await s.setBandLock({ lte: [1], nr: null, networkMode: null }, check);
      assert.equal(check.readback, "match");
      // One command carries every band: the NR bands the lock did not name go back as the module reports them
      assert.equal(state.fibocomAct, "17,6,2,101,541,578");
    });
  });
});

describe("openwrt: the router's and the module's status", () => {
  it("reads the channel state, the radio switch, the SIM card, the identifiers and the router's own load", async () => {
    forgetOpenwrtSimReads();
    const { client, calls } = openwrtRouter({ brand: "quectel", cfun: 4, systemInfo: { uptime: 7200, memory: { total: 1000, free: 300, buffered: 100, available: 600 } } });
    const t = await client.withSession((s) => s.telemetry());
    assert.ok(t);
    // NR SA: the CSI fills in the MCS and the layers the serving-cell line leaves empty (its CQI stays)
    assert.deepEqual([t.nr?.dlMcs, t.nr?.mimoLayers, t.nr?.cqi], [27, 4, 15]);
    assert.equal(t.status?.airplaneMode, true, "AT+CFUN 4: the radio is off");
    assert.deepEqual(t.status?.system, { uptimeSec: 7200, cpuPercent: null, memoryPercent: 40 });
    assert.deepEqual(t.status?.sim, { state: "ready", pinAttemptsLeft: 3, pukAttemptsLeft: 10, pinLockEnabled: null, slot: null });
    assert.deepEqual(t.ids, { imei: "860000000000000", imsi: "272010000000000", iccid: "8935301000000000000" });
    assert.ok(t.temperatures?.some((s) => s.kind === "pa" && s.celsius === 46));
    // The card and the identifiers are kept a minute: the next poll does not ask again
    const before = calls.filter((c) => JSON.stringify(c.args).includes("AT+CIMI")).length;
    await client.withSession((s) => s.telemetry());
    assert.equal(calls.filter((c) => JSON.stringify(c.args).includes("AT+CIMI")).length, before);
    forgetOpenwrtSimReads();
  });

  it("a Fibocom module: the radio switch and the card, no PIN counts", async () => {
    forgetOpenwrtSimReads();
    const { client } = openwrtRouter({ brand: "fibocom", cpin: "SIM PIN" });
    const t = await client.withSession((s) => s.telemetry());
    assert.equal(t?.status?.airplaneMode, false);
    assert.deepEqual(t?.status?.sim, { state: "pin_required", pinAttemptsLeft: null, pukAttemptsLeft: null, pinLockEnabled: null, slot: null });
    assert.equal(t?.ids?.iccid, null, "QCCID is Quectel's");
    assert.equal(t?.status?.system, null, "no system info");
    forgetOpenwrtSimReads();
  });

  it("parses the answers as the standard and the module's manual write them", () => {
    assert.deepEqual(parseQuectelCsi('+QNWCFG: "lte_csi",20,2,11,1\r\nOK', "lte_csi"), { mcs: 20, layers: 2, cqi: 11 });
    assert.equal(parseQuectelCsi('+QNWCFG: "nr5g_csi",27,4,15,2', "lte_csi"), null, "another carrier's line");
    assert.equal(parseQuectelCsi("ERROR", "nr5g_csi"), null);
    assert.deepEqual([parseCfun("+CFUN: 1"), parseCfun("+CFUN: 4"), parseCfun("+CFUN: 0"), parseCfun("+CFUN: 7"), parseCfun("ERROR")], [false, true, true, null, null]);
    assert.deepEqual(parseSimPin("+CPIN: SIM PUK", ""), { state: "puk_required", pinAttemptsLeft: null, pukAttemptsLeft: null });
    assert.deepEqual(parseSimPin("+CME ERROR: 10", "").state, "absent");
    assert.deepEqual(parseSimPin("+CME ERROR: 13", "").state, "error");
    assert.deepEqual(parseSimPin("", "").state, null);
    assert.deepEqual([atValueLine("860000000000000\nOK", "+CGSN:"), atValueLine('+CGSN: "860000000000000"', "+CGSN:"), atValueLine("ERROR", null)], ["860000000000000", "860000000000000", null]);
    assert.deepEqual(parseSystemInfo({ uptime: 10, memory: { total: 1000, free: 200, buffered: 100, cached: 100 } }), { uptimeSec: 10, cpuPercent: null, memoryPercent: 60 });
    assert.deepEqual([parseSystemInfo(null), parseSystemInfo({ load: [1, 2, 3] })], [null, null]);
    assert.deepEqual(parseQuectelTempSensors('+QTEMP: "modem-lte-sub6-pa1","32"\n+QTEMP: "aoss-0-usr","38"\n+QTEMP: "cpu0-thermal",41\n+QTEMP: 32,33,34'), [
      { kind: "pa", name: null, celsius: 32 },
      { kind: "other", name: "aoss-0-usr", celsius: 38 },
      { kind: "cpu", name: null, celsius: 41 },
    ]);
    // The LTE line's uplink: its bandwidth code and its power, tenths of a dBm above ±40
    const lte = parseQuectelServingCell('+QENG: "LTE","FDD",272,01,0800001E,211,300,1,3,5,2711,-82,-8,-56,19,14,85,-');
    assert.deepEqual([lte.lte?.ulBandwidthMhz, lte.lte?.bandwidthMhz, lte.lte?.puschTxDbm], [10, 20, 8.5]);
    assert.equal(parseQuectelServingCell('+QENG: "LTE","FDD",272,01,0800001E,211,300,1,3,5,2711,-82,-8,-56,19,14,8,-').lte?.puschTxDbm, 8);
  });
});
