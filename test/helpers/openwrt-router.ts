import assert from "node:assert/strict";
import { DriverCpeClient } from "../../src/drivers/client.ts";
import { openwrtProtocol } from "../../src/drivers/openwrt.ts";
import { LanRouterMock } from "./lan-router.ts";

/**
 * A stand-in OpenWrt router with a Quectel or Fibocom module behind ubus (`POST /ubus` only; every
 * other request fails the test, so a HiLink request leaking onto it is caught at once). Placeholder
 * cells only (the shared demo cell: N78 / 627264 / PCI 142, B3 / 1650 / PCI 211).
 */

export const OPENWRT_PASSWORD = "test-root-password";
export const OPENWRT_SESSION_TOKEN = "a1b2c3d4e5f60718293a4b5c6d7e8f90";

export interface UbusCall {
  session: string;
  object: string;
  method: string;
  args: Record<string, unknown>;
}

export interface OpenwrtRouterOptions {
  brand?: "quectel" | "fibocom";
  modemRpcObject?: string;
  loginStatus?: number;
  loginPayload?: Record<string, unknown>;
  /** What `ATI` answers (default: the make's usual banner). */
  ati?: string;
  /** What `AT+CGMM` answers (default: `OK` alone). */
  cgmm?: string;
  /** `AT+QENG="servingcell"` answers `ERROR` (a module without Quectel's query). */
  qengError?: boolean;
  /** Commands (by prefix) the module answers `ERROR` to. */
  atErrors?: ReadonlyArray<string>;
}

export interface OpenwrtRouterState {
  loggedIn: boolean;
  destroyed: boolean;
  executedCommands: string[];
  lteBand: string;
  nrBand: string;
  modePref: string;
  nrDisableMode: string;
  lock4g: string;
  lock5g: string;
  fibocomAct: string;
  fibocomCellLock: string;
  /** `none`: the module is searching (no serving cell, so the WAN is down). */
  serving: "sa" | "none";
}

export function openwrtRouter(opts: OpenwrtRouterOptions = {}) {
  const brand = opts.brand ?? "quectel";
  const rpcObj = opts.modemRpcObject ?? "gl-modem";
  const calls: UbusCall[] = [];
  const state: OpenwrtRouterState = {
    loggedIn: false,
    destroyed: false,
    executedCommands: [],
    lteBand: "1:3:7",
    nrBand: "41:78",
    modePref: "AUTO",
    nrDisableMode: "0",
    lock4g: "0",
    lock5g: "0",
    fibocomAct: "17,6,2,101,103,541,578",
    fibocomCellLock: "0",
    serving: "sa",
  };

  const mock = new LanRouterMock((req) => {
    assert.equal(req.method, "POST");
    assert.equal(req.path, "/ubus");
    const body = JSON.parse(req.body) as { id: number; method: string; params: [string, string, string, Record<string, unknown>] };
    const [session, object, method, args] = body.params;
    calls.push({ session, object, method, args });

    const reply = (payload: unknown, status = 0) => ({
      json: { jsonrpc: "2.0", id: body.id, result: payload === null ? [status] : [status, payload] },
    });

    if (object === "system" && method === "board") {
      return reply({ release: { distribution: "OpenWrt", version: "23.05.3" } });
    }

    if (object === "session" && method === "login") {
      if (opts.loginStatus !== undefined && opts.loginStatus !== 0) {
        return reply(null, opts.loginStatus);
      }
      if (opts.loginPayload) return reply(opts.loginPayload);
      if (args["password"] === OPENWRT_PASSWORD) {
        state.loggedIn = true;
        return reply({ ubus_rpc_session: OPENWRT_SESSION_TOKEN });
      }
      return reply(null, 6); // permission denied
    }

    if (object === "session" && method === "destroy") {
      state.destroyed = true;
      return reply({});
    }

    // AT dispatch object
    if (object === rpcObj && (method === "send_at" || method === "at_cmd" || method === "at" || method === "send")) {
      const cmd = String(args["cmd"] ?? "");
      state.executedCommands.push(cmd);
      if (opts.atErrors?.some((prefix) => cmd.startsWith(prefix))) return reply("ERROR\n");

      // Identify
      if (cmd === "ATI") {
        if (opts.ati !== undefined) return reply(opts.ati);
        if (brand === "quectel") {
          return reply("Quectel\nRM520N-GL\nRevision: RM520NGLAAR01A07M4G\n\nOK\n");
        } else {
          return reply("Fibocom Wireless Inc.\nFM650-CN\nRevision: 19001.1000.00.01.01.01\n\nOK\n");
        }
      }
      if (cmd === "AT+CGMM") {
        return reply(opts.cgmm ?? "OK\n");
      }
      if (cmd === "AT+QGMR") {
        return reply("RM520NGLAAR01A07M4G\n\nOK\n");
      }
      if (cmd === "AT+CGMR" || cmd === "AT+GMR") {
        return reply("19001.1000.00.01.01.01\n\nOK\n");
      }

      // Quectel Telemetry
      if (cmd === 'AT+QENG="servingcell"') {
        if (opts.qengError) return reply("ERROR\n");
        if (state.serving === "none") return reply('+QENG: "servingcell","SEARCH"\n\nOK\n');
        return reply(
          '+QENG: "servingcell","NOCONN","NR5G-SA","TDD",460,00,01A2B3C,142,000A,627264,78,11,-82,-10,18,1,0\n\nOK\n'
        );
      }
      if (cmd === "AT+QCAINFO") {
        return reply(
          '+QCAINFO: "PCC",627264,11,"NR5G BAND 78",1,142,-82,-10,-55,18\n+QCAINFO: "SCC",634000,11,"NR5G BAND 78",1,143,-85,-11,-58,16\n\nOK\n'
        );
      }
      if (cmd === 'AT+QENG="neighbourcell"') {
        return reply(
          '+QENG: "neighbourcell","NR5G",627264,145,-88,-12,12\n+QENG: "neighbourcell intra","LTE",1650,211,-90,-11,-60,10\n\nOK\n'
        );
      }
      if (cmd === "AT+QRSRP") {
        return reply("+QRSRP: -82,-84,-85,-86,NR5G\n\nOK\n");
      }
      if (cmd === "AT+QTEMP") {
        return reply('+QTEMP: "soc-thermal",42\n+QTEMP: "pa-thermal",46\n+QTEMP: "modem-thermal",44\n\nOK\n');
      }

      // Quectel Locks
      if (cmd === 'AT+QNWPREFCFG="lte_band"') {
        return reply(`+QNWPREFCFG: "lte_band",${state.lteBand}\n\nOK\n`);
      }
      if (cmd.startsWith('AT+QNWPREFCFG="lte_band",')) {
        state.lteBand = cmd.slice('AT+QNWPREFCFG="lte_band",'.length);
        return reply("OK\n");
      }
      if (cmd === 'AT+QNWPREFCFG="nr5g_band"') {
        return reply(`+QNWPREFCFG: "nr5g_band",${state.nrBand}\n\nOK\n`);
      }
      if (cmd.startsWith('AT+QNWPREFCFG="nr5g_band",')) {
        state.nrBand = cmd.slice('AT+QNWPREFCFG="nr5g_band",'.length);
        return reply("OK\n");
      }
      if (cmd.startsWith('AT+QNWPREFCFG="nsa_nr5g_band",')) {
        return reply("OK\n");
      }
      if (cmd === 'AT+QNWPREFCFG="mode_pref"') {
        return reply(`+QNWPREFCFG: "mode_pref",${state.modePref}\n\nOK\n`);
      }
      if (cmd.startsWith('AT+QNWPREFCFG="mode_pref",')) {
        state.modePref = cmd.slice('AT+QNWPREFCFG="mode_pref",'.length);
        return reply("OK\n");
      }
      if (cmd === 'AT+QNWPREFCFG="nr5g_disable_mode"') {
        return reply(`+QNWPREFCFG: "nr5g_disable_mode",${state.nrDisableMode}\n\nOK\n`);
      }
      if (cmd.startsWith('AT+QNWPREFCFG="nr5g_disable_mode",')) {
        state.nrDisableMode = cmd.slice('AT+QNWPREFCFG="nr5g_disable_mode",'.length);
        return reply("OK\n");
      }
      if (cmd === 'AT+QNWLOCK="common/4g"') {
        return reply(state.lock4g === "0" ? '+QNWLOCK: "common/4g",0\n\nOK\n' : `+QNWLOCK: "common/4g",1,${state.lock4g}\n\nOK\n`);
      }
      if (cmd.startsWith('AT+QNWLOCK="common/4g",1,')) {
        state.lock4g = cmd.slice('AT+QNWLOCK="common/4g",1,'.length);
        return reply("OK\n");
      }
      if (cmd === 'AT+QNWLOCK="common/4g",0') {
        state.lock4g = "0";
        return reply("OK\n");
      }
      if (cmd === 'AT+QNWLOCK="common/5g"') {
        return reply(state.lock5g === "0" ? '+QNWLOCK: "common/5g",0\n\nOK\n' : `+QNWLOCK: "common/5g",${state.lock5g}\n\nOK\n`);
      }
      if (cmd.startsWith('AT+QNWLOCK="common/5g",') && cmd !== 'AT+QNWLOCK="common/5g",0') {
        state.lock5g = cmd.slice('AT+QNWLOCK="common/5g",'.length);
        return reply("OK\n");
      }
      if (cmd === 'AT+QNWLOCK="common/5g",0') {
        state.lock5g = "0";
        return reply("OK\n");
      }
      if (cmd === 'AT+QNWPREFCFG="ue_capability_band"') {
        return reply('+QNWPREFCFG: "ue_capability_band","lte_band",1:3:5:7:8:20:28:38:40:41,"nr5g_band",1:3:28:41:77:78:79\n\nOK\n');
      }

      // 3GPP TS 27.007: mode, format (0: long name), operator, access technology
      if (cmd === "AT+COPS?") {
        return reply(state.serving === "none" ? "+COPS: 0\n\nOK\n" : '+COPS: 0,0,"Three",11\n\nOK\n');
      }

      // Fibocom Telemetry & Locks
      if (cmd === "AT+GTCCINFO?") {
        if (state.serving === "none") return reply("OK\n");
        return reply(
          '+GTCCINFO: 1,9,460,00,000A,01A2B3C,627264,142,-70,-10,74,18\n' +
          '+GTCCINFO: 2,9,460,00,000A,01A2B3D,627264,143,-75,-12,68,14\n\nOK\n'
        );
      }
      if (cmd === "AT+MTSM=1") {
        return reply("+MTSM: 45.5\n\nOK\n");
      }
      if (cmd === "AT+GTACT?") {
        return reply(`+GTACT: ${state.fibocomAct}\n\nOK\n`);
      }
      if (cmd.startsWith("AT+GTACT=")) {
        const parts = cmd.slice("AT+GTACT=".length);
        state.fibocomAct = parts;
        return reply("OK\n");
      }
      if (cmd === "AT+GTCELLLOCK?") {
        return reply(state.fibocomCellLock === "0" ? "+GTCELLLOCK: 0\n\nOK\n" : `+GTCELLLOCK: 1,${state.fibocomCellLock}\n\nOK\n`);
      }
      if (cmd.startsWith("AT+GTCELLLOCK=1,")) {
        state.fibocomCellLock = cmd.slice("AT+GTCELLLOCK=1,".length);
        return reply("OK\n");
      }
      if (cmd === "AT+GTCELLLOCK=0") {
        state.fibocomCellLock = "0";
        return reply("OK\n");
      }

      if (cmd === "AT+CFUN=1,1") {
        return reply("OK\n");
      }

      return reply("OK\n");
    }

    return reply(null, 6);
  });

  const client = new DriverCpeClient({
    protocol: openwrtProtocol,
    cpeUrl: "http://192.168.1.1",
    cpePassword: OPENWRT_PASSWORD,
    fetchImpl: mock.fetchImpl,
    requestTimeoutMs: 2000,
  });

  return { mock, calls, state, client };
}
