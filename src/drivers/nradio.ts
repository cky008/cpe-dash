import { CpeControlValidationError } from "../control-error.ts";
import { CpeAnswerFormatError, CpeApiError } from "../cpe-client.ts";
import { type AntennaModeName, SectionUnavailableError } from "../cpe-domain.ts";
import type { WriteCheck } from "../device-access.ts";
import { buildXmlRequest, getXmlTag, parseXmlError } from "../xml.ts";
import { bandsToHex, checkCellLock, checkLockBands, hexToBands } from "./bands.ts";
import { bandOfChannel, neighbourOf, ratOfChannel, servingModeOf } from "./cells.ts";
import type { DriverCredentials, DriverProtocol } from "./client.ts";
import { DriverSessionClosedError, loginUnplaced, wrongPassword } from "./login.ts";
import { awaitConnection, noteSent, settleBandLock, settleDataSwitch, settleRestart, settleSetting, settleUnlock } from "./readback.ts";
import { cellHasData, emptyCell } from "./snapshot.ts";
import type { LanHttp } from "./transport.ts";
import type {
  DriverBandLockTarget,
  DriverCell,
  DriverCellLockTarget,
  DriverDataLink,
  DriverHost,
  DriverIdentity,
  DriverLockState,
  DriverNeighbour,
  DriverNetworkMode,
  DriverSessionHandle,
  DriverTelemetry,
} from "./types.ts";
import { arfcnOf, bandOf, counterOf, fieldOf, identityOf, intOf, ipv4Of, ipv6Of, isPlainObject, labelOf, nonNegativeOf, numberOf, operatorOfPlmn, pciOf, plmnCodeOf, rsrpOf, rsrqOf, sinrOf, textOf } from "./values.ts";

/**
 * NRadio routers (C2000 Max / Ultra / Pro, C8-668GL, C5800, C8-660, C3000…) on NROS, NRadio's
 * OpenWrt: the LuCI login (`root` and the password the router's page asks for) sets a `sysauth`
 * cookie, the overview page carries the model, the version and the request token later writes add
 * as `?token=`. Readings come from LuCI (`status/runtime/wan,cpe_4`, the nearby-cell scan); band and
 * cell locks go through the HiLink-style XML the cellular module's bridge offers (`/api/net/net-mode`,
 * `/api/net/lock-freq`): the LTE mask, the NR mask under the tag the module itself reports it with
 * (`NR5GBand` or `NRBand`; a module that reports neither locks LTE bands only), and the network mode;
 * whatever a write does not change is sent back as the router reports it.
 */

const FAMILY = "nradio" as const;
const LOGIN = "/cgi-bin/luci";
const OVERVIEW = "/cgi-bin/luci/nradio/system/overview";
const RUNTIME = "/cgi-bin/luci/nradio/status/runtime/wan,cpe_4";
const SCAN = "/cgi-bin/luci/nradioadv/cellular/cpestatus/scaninfo";
const LOGOUT = "/cgi-bin/luci/nradio/logout";
const REBOOT = "/cgi-bin/luci/admin/system/reboot/call";
const NET_MODE = "/api/net/net-mode";
const LOCK_FREQ = "/api/net/lock-freq";
const DATA_SWITCH = "/api/dialup/mobile-dataswitch";
const CLIENTS = "/cgi-bin/luci/nradio/client/all_list";
const DEVICE_INFO = "/api/device/information";
const ANTENNA_SET = "/api/device/antenna_set_type";

/**
 * The module bridge's antenna codes as the NRadio notes give them (table 3.2 row 16): `0` automatic,
 * `1` external, `2` internal (`3`, mixed, is not offered). The H168-383 numbers internal and external
 * the other way round; each router is written its own notes' codes.
 */
const ANTENNA_CODES: Readonly<Record<AntennaModeName, number>> = { auto: 0, external: 1, internal: 2 };
const REFERER = "/html/content.html";
const TOKEN = /^[0-9A-Za-z]{8,64}$/;

/** Every band of a RAT, as HiLink-style modules take "no lock". */
export const NRADIO_ALL_MASK = "7FFFFFFFFFFFFFFF";
export const NRADIO_LTE_ALL_MASK = NRADIO_ALL_MASK;

/** `NetworkMode` codes of the module's bridge: automatic, 4G only, 5G standalone only, 5G non-standalone. */
const NETWORK_MODES: Readonly<Record<DriverNetworkMode, string>> = { auto: "00", lte: "03", nr_sa: "0801", nr_nsa: "0802" };

/** The tags a module names its NR band mask with (both are in the field; FengSui answers with the one it read). */
const NR_BAND_TAGS = ["NR5GBand", "NRBand"] as const;

type NrBandTag = (typeof NR_BAND_TAGS)[number];

/** The NR band mask of a `net-mode` answer with the tag that carried it (`null`: the module reports none). */
export function nradioNrMask(netMode: string): { tag: NrBandTag; hex: string } | null {
  for (const tag of NR_BAND_TAGS) {
    const hex = getXmlTag(netMode, tag);
    if (hex !== null && hex !== "") return { tag, hex };
  }
  return null;
}

function bandsOfMask(hex: string | null): number[] | "all" | null {
  if (hex === null) return null;
  return hex.toUpperCase() === NRADIO_ALL_MASK ? "all" : hexToBands(hex);
}

function maskOfBands(bands: ReadonlyArray<number> | "all"): string {
  return bands === "all" ? NRADIO_ALL_MASK : bandsToHex(bands, { upper: true });
}

/** The text after `label` up to the next `<` (or `'` for the token), bounded: no regex on router HTML. */
export function textAfter(html: string, label: string, end: string, max = 64): string | null {
  const at = html.indexOf(label);
  if (at < 0) return null;
  const start = at + label.length;
  const stop = html.indexOf(end, start);
  if (stop < 0 || stop - start > max) return null;
  const text = html.slice(start, stop).replace(/&nbsp;|\s+/g, " ").trim();
  return text === "" ? null : text;
}

export interface NradioOverview {
  model: string | null;
  version: string | null;
  token: string | null;
}

export function parseNradioOverview(html: string): NradioOverview {
  // The page's script sets the token as ['token']='…'; newer builds carry it as "token":"…"
  const token = textAfter(html, "'token']='", "'") ?? textAfter(html, '"token":"', '"');
  return { model: labelOf(textAfter(html, "设备型号:", "<")), version: labelOf(textAfter(html, "系统版本:", "<")), token: token !== null && TOKEN.test(token) ? token : null };
}

/** `cpe_4` of the runtime status (the `wan` block next to it has counters of its own, never read). */
export function parseNradioTelemetry(answer: unknown, overview: NradioOverview): DriverTelemetry {
  const cpe = fieldOf(answer, "cpe_4");
  const c = (key: string): unknown => (isPlainObject(cpe) ? fieldOf(cpe, key) : undefined);
  const mode = servingModeOf(c("mode"));
  const rat = mode === "SA" ? "NR" : "LTE";
  const cell: DriverCell = {
    ...emptyCell(),
    band: bandOf(c("band")),
    arfcn: arfcnOf(c("earfcn"), rat),
    pci: pciOf(c("pci"), rat, "auto"),
    tac: identityOf(c("tac"), "auto"),
    cellId: identityOf(c("cell"), "auto"),
    rsrpDbm: rsrpOf(c("rsrp")),
    rsrqDb: rsrqOf(c("rsrq")),
    sinrDb: sinrOf(c("sinr")),
  };
  const up = fieldOf(cpe, "up");
  return {
    model: overview.model,
    softwareVersion: overview.version,
    hardwareVersion: null,
    // `isp` is the operator's name, or on some firmware its PLMN
    operatorName: operatorOfPlmn(plmnCodeOf(c("isp"))) ?? labelOf(c("isp")),
    plmn: plmnCodeOf(c("isp")),
    mode,
    lte: rat === "LTE" && cellHasData(cell) ? cell : null,
    nr: rat === "NR" && cellHasData(cell) ? cell : null,
    carriers: [],
    wan: { connected: typeof up === "boolean" ? up : null, ipv4: ipv4Of(c("ipaddr")), ipv6: ipv6Of(c("ipv6addr")), uptimeSec: nonNegativeOf(c("uptime")) },
    traffic: isPlainObject(cpe)
      ? {
          downloadBytesPerSec: null,
          uploadBytesPerSec: null,
          totalDownloadBytes: counterOf(c("download")),
          totalUploadBytes: counterOf(c("upload")),
          sessionDownloadBytes: null,
          sessionUploadBytes: null,
          sessionSeconds: nonNegativeOf(c("uptime")),
          monthDownloadBytes: null,
          monthUploadBytes: null,
          monthTotalBytes: null,
          monthSeconds: null,
        }
      : null,
    temperatureC: null,
    signalBars: null,
  };
}

/** `result.neighbour[0]` (or a flat `result.neighbour`): `BAND`, `EARFCN`, `PCI`, `RSRP`, `RSRQ`. */
export function parseNradioNeighbours(answer: unknown): DriverNeighbour[] | null {
  const list = fieldOf(fieldOf(answer, "result"), "neighbour");
  if (!Array.isArray(list)) return null;
  const items: unknown[] = Array.isArray(list[0]) ? (list[0] as unknown[]) : list;
  const out: DriverNeighbour[] = [];
  for (const item of items.slice(0, 64)) {
    if (!isPlainObject(item)) continue;
    const arfcn = arfcnOf(item["EARFCN"], "NR");
    const band = bandOf(item["BAND"]);
    // The band tells the RAT when the channel number alone could be either
    const rat = band !== null && arfcn !== null && bandOfChannel("LTE", arfcn) === band ? "LTE" : ratOfChannel(arfcn);
    const cell = rat ? neighbourOf(rat, { band: item["BAND"], arfcn: item["EARFCN"], pci: item["PCI"], rsrp: item["RSRP"], rsrq: item["RSRQ"] }) : null;
    if (cell) out.push(cell);
  }
  return out;
}

export function parseNradioLockState(netMode: string): DriverLockState {
  const code = getXmlTag(netMode, "NetworkMode");
  const networkMode = (Object.entries(NETWORK_MODES) as Array<[DriverNetworkMode, string]>).find(([, v]) => v === code)?.[0] ?? null;
  return {
    lteBands: bandsOfMask(getXmlTag(netMode, "LTEBand")),
    nrBands: bandsOfMask(nradioNrMask(netMode)?.hex ?? null),
    lteCell: null,
    nrCell: null,
    networkMode,
    supportedLte: null,
    supportedNr: null,
  };
}

/** How a client of `client/all_list` is connected: wired, or the Wi-Fi band its `frequency` names (as the page tells them apart). */
function nradioLinkOf(client: Record<string, unknown>): DriverHost["link"] {
  if (textOf(client["type"]) === "wired") return "lan";
  const frequency = textOf(client["frequency"]) ?? "";
  return frequency.includes("2.4") ? "wifi_2_4" : frequency.includes("5.") ? "wifi_5" : "wifi";
}

class NradioSession implements DriverSessionHandle {
  readonly family = FAMILY;
  readonly #http: LanHttp;
  readonly #overview: NradioOverview;
  #open = true;

  constructor(http: LanHttp, overview: NradioOverview) {
    this.#http = http;
    this.#overview = overview;
  }

  get open(): boolean {
    return this.#open;
  }

  #guard(): void {
    if (!this.#open) throw new DriverSessionClosedError();
  }

  async identify(): Promise<DriverIdentity> {
    this.#guard();
    return { model: this.#overview.model, softwareVersion: this.#overview.version, hardwareVersion: await this.#hardwareVersion() };
  }

  /**
   * The cellular module's hardware version through its bridge (`/api/device/information`,
   * `<HardwareVersion>`, notes library A table 3.2 row 8); `null` on a router without the bridge.
   */
  async #hardwareVersion(): Promise<string | null> {
    const res = await this.#http.request({ method: "GET", path: DEVICE_INFO, referer: REFERER }).catch(() => null);
    if (!res || res.status !== 200 || parseXmlError(res.text)) return null;
    return labelOf(getXmlTag(res.text, "HardwareVersion"));
  }

  async telemetry(): Promise<DriverTelemetry> {
    this.#guard();
    return parseNradioTelemetry(await this.#http.getJson(RUNTIME, { referer: REFERER }), this.#overview);
  }

  async neighbours(): Promise<DriverNeighbour[]> {
    this.#guard();
    const list = parseNradioNeighbours(await this.#http.getJson(SCAN, { referer: REFERER }));
    if (list === null) throw new CpeAnswerFormatError("GET scaninfo: no neighbour list");
    return list;
  }

  async #netMode(): Promise<string> {
    const res = await this.#http.request({ method: "GET", path: NET_MODE, referer: REFERER });
    if (res.status !== 200) throw new CpeAnswerFormatError(`GET ${NET_MODE}: HTTP ${res.status}`);
    const error = parseXmlError(res.text);
    if (error) throw new CpeApiError(error.code, `GET ${NET_MODE}`);
    return res.text;
  }

  async lockState(): Promise<DriverLockState> {
    this.#guard();
    return parseNradioLockState(await this.#netMode());
  }

  /**
   * Connected devices, as the router's own client page reads them (`client/all_list`, notes library A
   * table 3.1 row 5): `result.client`, each with `mac`, `hostname`, `type` (`wired`, or Wi-Fi with
   * `frequency`, `ssid`, `rssi`) and `exsit` (`1`: connected now; the page lists no other).
   */
  async hosts(): Promise<DriverHost[]> {
    this.#guard();
    const list = fieldOf(fieldOf(await this.#http.getJson(CLIENTS, { referer: REFERER }), "result"), "client");
    if (!Array.isArray(list)) throw new SectionUnavailableError("The device list", null);
    return list
      .filter(isPlainObject)
      .filter((client) => intOf(client["exsit"]) === 1)
      .map((client) => ({ mac: textOf(client["mac"]) ?? "", name: labelOf(client["hostname"]), ipv4: null, ipv6: [], link: nradioLinkOf(client), connectedSec: null, leaseSec: null, rssiDbm: numberOf(client["rssi"]) }));
  }

  /** The module's mobile data switch (`<dataswitch>` `1` on, `0` off; `null`: it named neither). */
  async #dataSwitch(): Promise<boolean | null> {
    this.#guard();
    const res = await this.#http.request({ method: "GET", path: DATA_SWITCH, referer: REFERER });
    if (res.status !== 200) throw new CpeAnswerFormatError(`GET ${DATA_SWITCH}: HTTP ${res.status}`);
    const error = parseXmlError(res.text);
    if (error) throw new CpeApiError(error.code, `GET ${DATA_SWITCH}`);
    const value = getXmlTag(res.text, "dataswitch")?.trim();
    return value === "1" ? true : value === "0" ? false : null;
  }

  /**
   * Mobile data through the module's bridge (notes library A, table 3.2 rows 13 and 14): the switch is
   * read and written at `/api/dialup/mobile-dataswitch`, and toggling it is how the notes redial.
   * Switching off waits for the cellular link (`cpe_4.up`) to go down before the read-back.
   */
  readonly data: DriverDataLink = {
    enabled: () => this.#dataSwitch(),
    set: async (enabled, check, wait) => {
      await this.#postXml(check, DATA_SWITCH, { dataswitch: enabled ? 1 : 0 });
      if (!enabled) await awaitConnection(async () => (await this.telemetry()).wan.connected, false, wait);
      settleDataSwitch(check, enabled, await this.#dataSwitch().catch(() => null));
    },
  };

  /**
   * Switch the antenna through the module's bridge, then read the setting back where the bridge
   * answers it the HiLink way (`GET antenna_set_type`, `<antennasettype>`); a bridge that does not
   * leaves the read-back unknown.
   */
  async setAntennaMode(mode: AntennaModeName, check: WriteCheck): Promise<number> {
    const code = ANTENNA_CODES[mode];
    await this.#postXml(check, ANTENNA_SET, { antennasettype: code });
    const res = await this.#http.request({ method: "GET", path: ANTENNA_SET, referer: REFERER }).catch(() => null);
    const read = res && res.status === 200 && !parseXmlError(res.text) ? (getXmlTag(res.text, "antennasettype")?.trim() ?? null) : null;
    settleSetting(check, read === null || !/^\d$/.test(read) ? null : read === String(code));
    return code;
  }

  /** A write through the module's bridge, with the session's request token; the router must answer `OK`. */
  async #postXml(check: WriteCheck, path: string, data: Record<string, unknown>): Promise<void> {
    this.#guard();
    const token = this.#overview.token;
    if (token === null) throw new CpeAnswerFormatError("The router's overview page named no request token: nothing was written");
    noteSent(check, FAMILY, path);
    const res = await this.#http.request({ method: "POST", path, query: [["token", token]], body: buildXmlRequest(data), contentType: "application/xml; charset=UTF-8", referer: REFERER });
    if (res.status !== 200) throw new CpeApiError(`http${res.status}`, `${path} refused`);
    const error = parseXmlError(res.text);
    if (error) throw new CpeApiError(error.code, `${path} refused`);
    if (getXmlTag(res.text, "response")?.toUpperCase() !== "OK") throw new CpeAnswerFormatError(`${path}: the router did not answer OK`);
  }

  /**
   * `net-mode` with the LTE mask changed, and the NR mask and the mode when asked; what the router
   * reports is sent back as it is, the NR mask under the tag it came with. A module that reports no
   * NR mask gets none: there is no telling which tag it would take.
   */
  async #writeNetMode(check: WriteCheck, write: { lte: ReadonlyArray<number> | "all"; nr: ReadonlyArray<number> | "all" | null; mode: DriverNetworkMode | null }): Promise<void> {
    const current = await this.#netMode();
    const networkMode = getXmlTag(current, "NetworkMode");
    const networkBand = getXmlTag(current, "NetworkBand");
    if (!networkMode || !networkBand) throw new CpeAnswerFormatError(`${NET_MODE} named no NetworkMode and NetworkBand to send back; refusing to write guessed values`);
    const nr = nradioNrMask(current);
    if (write.nr !== null && nr === null) throw new CpeControlValidationError("This router's cellular module reports no NR band setting: it locks LTE bands only");
    await this.#postXml(check, NET_MODE, {
      NetworkMode: write.mode === null ? networkMode : NETWORK_MODES[write.mode],
      NetworkBand: networkBand,
      LTEBand: maskOfBands(write.lte),
      ...(nr === null ? {} : { [nr.tag]: write.nr === null ? nr.hex : maskOfBands(write.nr) }),
    });
  }

  async setBandLock(target: DriverBandLockTarget, check: WriteCheck): Promise<void> {
    const lte = target.lte === "all" ? "all" : checkLockBands("LTE", target.lte, null);
    const nr = target.nr === null || target.nr === "all" ? target.nr : checkLockBands("NR", target.nr, null);
    await this.#writeNetMode(check, { lte, nr, mode: target.networkMode });
    settleBandLock(check, { lte, nr, networkMode: target.networkMode }, await this.lockState().catch(() => null));
  }

  async setCellLock(target: DriverCellLockTarget, check: WriteCheck): Promise<void> {
    const t = checkCellLock(target);
    const scs = t.scsKhz === null ? null : [15, 30, 60, 120, 240].indexOf(t.scsKhz);
    await this.#postXml(check, LOCK_FREQ, {
      mode: t.rat === "LTE" ? 0 : 1,
      enable: 2,
      ...(scs !== null && scs >= 0 ? { scstype: scs } : {}),
      freq: t.arfcn,
      band: t.band,
      cellid: t.pci,
    });
    // The bridge has no documented way to read a cell lock back
    check.readback = "unknown";
    check.reason = "unreadable";
  }

  async unlockAll(check: WriteCheck): Promise<void> {
    const before = await this.lockState();
    const resetMode = before.networkMode !== null && before.networkMode !== "auto";
    // The NR bands are unlocked where the module reports them
    const nrReported = before.nrBands !== null;
    if (before.lteBands !== "all" || (nrReported && before.nrBands !== "all") || resetMode) {
      await this.#writeNetMode(check, { lte: "all", nr: nrReported ? "all" : null, mode: resetMode ? "auto" : null });
    }
    for (const mode of [0, 1]) await this.#postXml(check, LOCK_FREQ, { mode, enable: 0, freq: 0, band: 0, cellid: 0 });
    settleUnlock(check, await this.lockState().catch(() => null), { nr: nrReported, mode: resetMode });
  }

  async reboot(check: WriteCheck): Promise<void> {
    this.#guard();
    const token = this.#overview.token;
    if (token === null) throw new CpeAnswerFormatError("The router's overview page named no request token: nothing was written");
    noteSent(check, FAMILY, REBOOT);
    const res = await this.#http.request({ method: "POST", path: REBOOT, query: [["token", token]], body: buildXmlRequest({ Control: 1 }), contentType: "application/xml; charset=UTF-8", referer: REFERER, redirect: "manual" });
    if (res.status >= 400) throw new CpeApiError(`http${res.status}`, "reboot refused");
    settleRestart(check);
    this.#open = false;
  }

  async logout(): Promise<void> {
    if (!this.#open) return;
    this.#open = false;
    await this.#http.request({ method: "GET", path: LOGOUT, referer: REFERER, redirect: "manual" });
  }
}

function hasSysauth(http: LanHttp): boolean {
  return http.cookie("sysauth") !== undefined || http.cookie("sysauth_http") !== undefined || http.cookie("sysauth_https") !== undefined;
}

export const nradioProtocol: DriverProtocol = {
  family: FAMILY,

  async detect(http: LanHttp): Promise<boolean> {
    const res = await http.request({ method: "GET", path: LOGIN, referer: LOGIN, redirect: "manual" });
    if (res.status !== 200 && res.status !== 302) return false;
    // NROS mounts its pages under /cgi-bin/luci/nradio: plain OpenWrt has no such path
    return `${res.location ?? ""} ${res.text.slice(0, 262_144)}`.toLowerCase().includes("nradio");
  },

  async login(http: LanHttp, credentials: DriverCredentials): Promise<DriverSessionHandle> {
    // The form POST, never the password in a query string; the cookie comes with the redirect
    const res = await http.request({
      method: "POST",
      path: LOGIN,
      body: new URLSearchParams([
        ["luci_username", credentials.username || "root"],
        ["luci_password", credentials.password],
      ]).toString(),
      contentType: "application/x-www-form-urlencoded",
      referer: LOGIN,
      redirect: "manual",
    });
    if (!hasSysauth(http)) {
      if (res.status === 403 || res.text.includes("密码错误") || res.text.includes("Invalid password") || res.text.includes("luci_password")) throw wrongPassword("the router refused the password");
      throw loginUnplaced(`login answered HTTP ${res.status} without a session`);
    }
    const page = await http.request({ method: "GET", path: OVERVIEW, referer: REFERER });
    if (page.status !== 200) throw new CpeAnswerFormatError(`GET overview: HTTP ${page.status}`);
    return new NradioSession(http, parseNradioOverview(page.text));
  },
};

