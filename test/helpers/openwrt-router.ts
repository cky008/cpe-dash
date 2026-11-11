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
  /** The parts the modem's message storage starts with (`false`: a module without SMS commands). */
  sms?: StoredPdu[] | false;
  /** QModem is installed: its UCI section, and `qmodem.send_at` / `qmodem.send_raw_pdu`. */
  qmodem?: boolean;
  /** What the modem answers a sent PDU with (default: `+CMGS` and `OK`). */
  sendAnswer?: string;
  /** What LuCI's `luci-rpc getDHCPLeases` answers (left out: a router without LuCI). */
  leases?: Record<string, unknown>;
}

/** One stored part: its storage index, `<stat>` (0 unread, 1 read, 2 unsent, 3 sent) and its PDU. */
export interface StoredPdu {
  index: number;
  stat: number;
  pdu: string;
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
  sms: StoredPdu[];
  /** The PDUs handed to QModem to send. */
  sentPdus: string[];
  /** The packet data counters, bytes sent then received (4G `QGDCNT`, 5G `QGDNRCNT`). */
  counters: { lte: [bigint, bigint]; nr: [bigint, bigint] };
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
    sms: opts.sms ? opts.sms.map((part) => ({ ...part })) : [],
    sentPdus: [],
    counters: { lte: [1_000n, 4_000n], nr: [2_194_810_368n, 15_849_203_712n] },
  };

  /** The modem's answer to one AT command, whichever service carried it. */
  const smsAnswer = (cmd: string): string | null => {
    if (!/^AT\+(CPMS|CMGF|CMGL|CMGD)/.test(cmd)) return null;
    if (opts.sms === false) return "ERROR\n";
    if (cmd === "AT+CPMS?") return `+CPMS: "ME",${state.sms.length},50,"ME",${state.sms.length},50,"ME",${state.sms.length},50\n\nOK\n`;
    if (cmd === "AT+CMGF=0") return "OK\n";
    if (cmd === "AT+CMGL=4") {
      const listed = state.sms.map((part) => `+CMGL: ${part.index},${part.stat},,${part.pdu.length / 2 - 1}\n${part.pdu}`).join("\n");
      // Listing a message marks it read, as the standard has it
      for (const part of state.sms) if (part.stat === 0) part.stat = 1;
      return `${listed}\n\nOK\n`;
    }
    const gone = /^AT\+CMGD=(\d+)$/.exec(cmd);
    if (gone) {
      const before = state.sms.length;
      state.sms = state.sms.filter((part) => part.index !== Number(gone[1]));
      return state.sms.length < before ? "OK\n" : "+CMS ERROR: 321\n";
    }
    return "ERROR\n";
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

    if (object === "luci-rpc" && method === "getDHCPLeases") return opts.leases ? reply(opts.leases) : reply(null, 4);

    // QModem: its UCI section, its own AT method and its PDU sender
    if (opts.qmodem && object === "uci" && method === "get" && args["config"] === "qmodem") {
      return reply({ values: { main: { ".type": "main", enable: "1" }, modem1: { ".type": "modem-device", at_port: "/dev/ttyUSB2", manufacturer: "quectel" } } });
    }
    if (opts.qmodem && object === "qmodem" && method === "send_raw_pdu") {
      state.sentPdus.push(String(args["cmd"] ?? ""));
      return reply({ result: { status: "1", cmd: "tom_modem -d /dev/ttyUSB2 -o s -p", res: opts.sendAnswer ?? `+CMGS: ${state.sentPdus.length}\n\nOK` } });
    }
    if (opts.qmodem && rpcObj === "qmodem" && object === "qmodem" && method === "send_at") {
      const params = args["params"] as { at?: string; port?: string } | undefined;
      const cmd = String(params?.at ?? "");
      state.executedCommands.push(cmd);
      const sms = smsAnswer(cmd);
      if (sms !== null) return reply({ at_cfg: { status: "1", cmd: `at ${String(params?.port)} ${cmd}`, res: sms } });
      if (cmd === "ATI") return reply({ at_cfg: { status: "1", res: "Quectel\nRM520N-GL\nRevision: RM520NGLAAR01A07M4G\n\nOK\n" } });
      return reply({ at_cfg: { status: "1", res: "OK\n" } });
    }

    // AT dispatch object
    if (object === rpcObj && (method === "send_at" || method === "at_cmd" || method === "at" || method === "send")) {
      const cmd = String(args["cmd"] ?? "");
      state.executedCommands.push(cmd);
      if (opts.atErrors?.some((prefix) => cmd.startsWith(prefix))) return reply("ERROR\n");
      const sms = smsAnswer(cmd);
      if (sms !== null) return reply(sms);

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
      if (cmd === "AT+QGDCNT?") return reply(`+QGDCNT: ${state.counters.lte[0]},${state.counters.lte[1]}\n\nOK\n`);
      if (cmd === "AT+QGDNRCNT?") return reply(`+QGDNRCNT: ${state.counters.nr[0]},${state.counters.nr[1]}\n\nOK\n`);
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
      if (cmd === "AT+GTCAINFO?") {
        if (state.serving === "none") return reply("+GTCAINFO:\n\nOK\n");
        // The serving NR carrier, one activated and one configured-but-idle secondary
        return reply("+GTCAINFO:\nPCC:578,142,650000,100,4,1,3,1,-70\nSCC 1:2,0,578,211,649980,12,255,2,255,3,255,-77\nSCC 2:1,0,101,211,300,100,100,2,1,2,0,-90\n\nOK\n");
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
