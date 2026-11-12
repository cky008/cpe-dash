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
  /** What `AT+CFUN?` answers (`<fun>`; default 1, full functionality). */
  cfun?: number;
  /** What `AT+CPIN?` names (default `READY`). */
  cpin?: string;
  /** What `ubus call system info` answers (left out: an older procd without it). */
  systemInfo?: Record<string, unknown>;
  /** The SIM card's PIN (default `1234`); a wrong one costs an attempt. */
  simPin?: string;
  /** The first PDP context as `AT+CGDCONT?` lists it at the start (default `"IPV4V6","internet"`). */
  cgdcont?: string;
  /**
   * What `AT+COPS=?` answers (left out: an error, as a module that cannot search right now), and
   * whether the module registers on an operator it is told to (`false`: it gives up with an error and
   * stays in manual mode).
   */
  cops?: { scan?: string; registers?: boolean };
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
  /** QModem's dial worker and the data connection it holds; the dial calls it was asked for. */
  dial: { running: boolean; up: boolean; calls: string[]; refuse: string[] };
  /** `<fun>` of `AT+CFUN?`, what `AT+CPIN?` names, the PIN lock (`AT+CLCK="SC",2`) and the PIN attempts left. */
  cfun: number;
  cpin: string;
  pinLock: boolean;
  pinAttempts: number;
  /** The first PDP context: `"<type>","<apn>"`. */
  cgdcont: string;
  /** `<mode>` of `AT+COPS?` (0 automatic, 1 manual) and the operator the module was told to stay on. */
  copsMode: number;
  copsPlmn: string | null;
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
    dial: { running: true, up: true, calls: [], refuse: [] },
    cfun: opts.cfun ?? 1,
    cpin: opts.cpin ?? "READY",
    pinLock: false,
    pinAttempts: 3,
    cgdcont: opts.cgdcont ?? '"IPV4V6","internet"',
    copsMode: 0,
    copsPlmn: null,
  };
  const simPin = opts.simPin ?? "1234";
  /** A PIN command: the right PIN applies `then`, a wrong one costs an attempt and answers the card's error. */
  const pinCommand = (pin: string | undefined, then: () => void): string => {
    if (pin === simPin && state.pinAttempts > 0) {
      state.pinAttempts = 3;
      then();
      return "OK\n";
    }
    state.pinAttempts = Math.max(0, state.pinAttempts - 1);
    if (state.pinAttempts === 0) state.cpin = "SIM PUK";
    return "+CME ERROR: 16\n";
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
    if (object === "system" && method === "info") return opts.systemInfo ? reply(opts.systemInfo) : reply(null, 3);

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
    if (opts.qmodem && object === "qmodem" && ["modem_dial", "modem_hang", "modem_redial"].includes(method)) {
      state.dial.calls.push(method);
      if (args["config_section"] !== "modem1" || state.dial.refuse.includes(method)) return reply({ result: { status: "0", message: "Dial command failed" } });
      state.dial.running = method !== "modem_hang";
      state.dial.up = state.dial.running;
      return reply({ result: { status: "1", message: "Dial command executed successfully" } });
    }
    if (opts.qmodem && object === "qmodem" && method === "dial_status") return reply({ running: String(state.dial.running) });
    if (opts.qmodem && object === "qmodem" && method === "get_connect_status") return reply({ connection_status: state.dial.up ? "Yes" : "No" });
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
      // The radio switch, the SIM card and the identifiers (placeholders only)
      if (cmd === "AT+CFUN?") return reply(`+CFUN: ${state.cfun}\n\nOK\n`);
      if (cmd === "AT+CFUN=4" || cmd === "AT+CFUN=1") {
        state.cfun = Number(cmd.slice("AT+CFUN=".length));
        return reply("OK\n");
      }
      if (cmd === "AT+CPIN?") return reply(`+CPIN: ${state.cpin}\n\nOK\n`);
      if (cmd.startsWith("AT+CPIN=")) return reply(pinCommand(/^AT\+CPIN="(\d+)"$/.exec(cmd)?.[1], () => (state.cpin = "READY")));
      if (cmd === 'AT+CLCK="SC",2') return reply(`+CLCK: ${state.pinLock ? 1 : 0}\n\nOK\n`);
      if (cmd.startsWith('AT+CLCK="SC",')) {
        const match = /^AT\+CLCK="SC",([01]),"(\d+)"$/.exec(cmd);
        return reply(pinCommand(match?.[2], () => (state.pinLock = match?.[1] === "1")));
      }
      if (cmd === 'AT+QPINC="SC"') return brand === "quectel" ? reply(`+QPINC: "SC",${state.pinAttempts},10\n\nOK\n`) : reply("ERROR\n");
      if (cmd === "AT+CGDCONT?") return reply(`+CGDCONT: 1,${state.cgdcont},"0.0.0.0",0,0\n+CGDCONT: 2,"IPV4V6","ims","0.0.0.0",0,0\n\nOK\n`);
      if (cmd.startsWith("AT+CGDCONT=1,")) {
        state.cgdcont = cmd.slice("AT+CGDCONT=1,".length);
        return reply("OK\n");
      }
      if (cmd === "AT+CGSN") return reply("860000000000000\n\nOK\n");
      if (cmd === "AT+CIMI") return reply("272010000000000\n\nOK\n");
      if (cmd === "AT+QCCID") return reply("+QCCID: 8935301000000000000F\n\nOK\n");
      if (cmd === 'AT+QNWCFG="nr5g_csi"') return reply('+QNWCFG: "nr5g_csi",27,4,15,2\n\nOK\n');
      if (cmd === 'AT+QNWCFG="lte_csi"') return reply('+QNWCFG: "lte_csi",20,2,11,1\n\nOK\n');
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
        return reply(state.serving === "none" ? `+COPS: ${state.copsMode}\n\nOK\n` : `+COPS: ${state.copsMode},0,"Three",11\n\nOK\n`);
      }
      if (cmd === "AT+COPS=?") return reply(opts.cops?.scan === undefined ? "+CME ERROR: 3\n" : `${opts.cops.scan}\n\nOK\n`);
      if (cmd === "AT+COPS=0") {
        state.copsMode = 0;
        state.copsPlmn = null;
        return reply("OK\n");
      }
      const register = /^AT\+COPS=1,2,"(\d{5,6})"(?:,\d{1,2})?$/.exec(cmd);
      if (register) {
        state.copsMode = 1;
        state.copsPlmn = register[1] ?? null;
        if (opts.cops?.registers === false) {
          state.serving = "none";
          return reply("+CME ERROR: 30\n");
        }
        return reply("OK\n");
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
