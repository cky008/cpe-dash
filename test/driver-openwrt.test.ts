import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CpeApiError } from "../src/cpe-client.ts";
import type { WriteCheck } from "../src/device-access.ts";
import {
  OPENWRT_ANONYMOUS_SESSION,
  detectModemBrand,
  extractAtResponse,
  isAtError,
  modemBrandOf,
  openwrtProtocol,
  parseFibocomCcInfo,
  parseQuectelCaInfo,
  parseQuectelNeighbours,
  parseQuectelRsrp,
  parseQuectelServingCell,
  parseQuectelTemp,
  quectelLteSinr,
  splitAtCsv,
} from "../src/drivers/openwrt.ts";
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
      assert.ok(telem.nr !== null);
      assert.equal(telem.nr.rsrpDbm, -82);

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
      assert.equal(state.fibocomAct, "17,6,2,101");
    });
  });
});
