import { type ApnAuthMode, type ApnIpType, type ApnView, type CellularSettingsSnapshot, type NetworkMode, type OperatorChoice, type OperatorRat, type OperatorSelection, type UssdAnswer, type UssdRequest, isApnName, isPlmn } from "./cellular.ts";
import type { EphemeralCpeSession } from "./cpe-client.ts";
import { CpeAnswerFormatError, CpeApiError } from "./session-errors.ts";
import { CpeControlValidationError } from "./control-error.ts";
import type { WanRepairSkipReason } from "./cpe-domain.ts";
import type { ReadbackReason, WriteCheck } from "./device-access.ts";
import { LTE_ALL_BANDS_MASK, isAllBandsMask, maskToBands } from "./device-profile.ts";
import { MAX_SCAN_ROWS, USSD_POLLS, USSD_POLL_MS, emptyUssd, operatorChoice, ussdText } from "./drivers/cellular.ts";
import { bandsToHexMask } from "./rf-bounds.ts";
import { getXmlBlocks, getXmlTag, getXmlTextPreserve } from "./xml.ts";

/**
 * The writes FengSui does on a HiLink router of a model nobody verified (on by default, each can be
 * turned off): the HiLink request formats of docs/dev/protocol.md appendix A.11, nothing
 * guessed. Each one runs inside the write's own session (the scheduler's `control`), is never
 * retried, and fills a `WriteCheck`: the endpoints it posted to and what reading them back in the
 * same session showed (a redial and a reboot are left `pending` for the polls that follow). A
 * read-back that fails after the router took the write never fails the write. The H168-383 never
 * comes here: its verified writes live in `cpe-domain.ts`.
 */

const NET_MODE = "/api/net/net-mode";
const DATA_SWITCH = "/api/dialup/mobile-dataswitch";
const RECONNECT = "/api/net/reconnect";
const DEVICE_CONTROL = "/api/device/control";

export function newWriteCheck(): WriteCheck {
  return { endpoints: [], readback: "none", reason: null };
}

/** Record a read-back: `true` a match, `false` a mismatch (`reason`), `null` unknown (`unreadable`). */
export function settleCheck(check: WriteCheck, verdict: boolean | null, reason: ReadbackReason = "differs", unknownReason: ReadbackReason = "unreadable"): void {
  check.readback = verdict === null ? "unknown" : verdict ? "match" : "mismatch";
  check.reason = verdict === true ? null : verdict === false ? reason : unknownReason;
}

/** A tag read back after the write; `null` when the read-back failed or named nothing (never an error: the write is done). */
async function readBack(session: EphemeralCpeSession, apiPath: string, tag: string): Promise<string | null> {
  try {
    return getXmlTag(await session.get(apiPath), tag)?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * What a band lock writes: these LTE bands, every band (`"all"`), or a mask saved before an AI
 * agent's test, written back as it was.
 */
export type GenericBandTarget = ReadonlyArray<number> | "all" | { savedMask: string };

export interface GenericBandLockResult {
  /** The bands locked now (`"all"`: unlocked). */
  bands: number[] | "all";
  /** The LTE mask the router reported before the write, as A.11 writes it (`null`: none to read). */
  before: string | null;
}

/** An LTE mask as A.11 writes it (lowercase hex, no leading zeros), or `null` for anything else. */
function lteMask(raw: string | null): string | null {
  const text = (raw ?? "").trim();
  return /^[0-9A-Fa-f]{1,32}$/.test(text) ? BigInt(`0x${text}`).toString(16) : null;
}

/** The bands a mask locks: `"all"` for the all-bands mask or one with every advertised band on. */
function bandsOfMask(mask: string, advertised: ReadonlyArray<number>): number[] | "all" {
  const bands = maskToBands(mask) ?? [];
  return isAllBandsMask(mask) || (advertised.length > 0 && advertised.every((band) => bands.includes(band))) ? "all" : bands;
}

/**
 * Lock the LTE bands (or unlock all with the all-bands mask, or write a saved mask back) with
 * `POST /api/net/net-mode`: `NetworkMode`, `NetworkBand` and `LTEBand` in that order, the first two
 * sent back exactly as the router reported them in this session, so only the LTE mask changes. Reads
 * the mask back: an unlock matches when the router reports the all-bands mask or every band it
 * advertises (with no advertised band to compare, any other mask says nothing).
 */
export async function genericBandLock(
  session: EphemeralCpeSession,
  check: WriteCheck,
  target: GenericBandTarget,
  advertised: ReadonlyArray<number>
): Promise<GenericBandLockResult> {
  let mask: string;
  if (target === "all") {
    mask = LTE_ALL_BANDS_MASK;
  } else if ("savedMask" in target) {
    const saved = lteMask(target.savedMask);
    if (saved === null) throw new CpeControlValidationError("A saved LTE band mask must be hexadecimal");
    mask = saved;
  } else {
    mask = bandsToHexMask([...target]);
  }
  const current = await session.get(NET_MODE);
  const networkMode = (getXmlTag(current, "NetworkMode") ?? "").trim();
  const networkBand = (getXmlTag(current, "NetworkBand") ?? "").trim();
  if (!/^\d{2,8}$/.test(networkMode) || !/^[0-9A-Fa-f]{1,16}$/.test(networkBand)) {
    throw new CpeAnswerFormatError(`Unexpected ${NET_MODE} answer without a NetworkMode and NetworkBand to send back; refusing to write guessed values`);
  }
  const before = lteMask(getXmlTag(current, "LTEBand"));
  check.endpoints.push(NET_MODE);
  await session.postXml(NET_MODE, { NetworkMode: networkMode, NetworkBand: networkBand, LTEBand: mask });

  const read = await readBack(session, NET_MODE, "LTEBand");
  if (read === null || !/^[0-9A-Fa-f]{1,32}$/.test(read)) {
    settleCheck(check, null);
  } else if (target === "all") {
    const enabled = new Set(maskToBands(read) ?? []);
    settleCheck(check, isAllBandsMask(read) ? true : advertised.length === 0 ? null : advertised.every((band) => enabled.has(band)));
  } else {
    settleCheck(check, BigInt(`0x${read}`) === BigInt(`0x${mask}`));
  }
  return { bands: target === "all" ? "all" : "savedMask" in target ? bandsOfMask(mask, advertised) : [...target], before };
}

/** Switch mobile data (`POST /api/dialup/mobile-dataswitch`, `<dataswitch>`) and read the switch back. */
export async function genericMobileData(session: EphemeralCpeSession, check: WriteCheck, enabled: boolean): Promise<boolean> {
  check.endpoints.push(DATA_SWITCH);
  await session.postXml(DATA_SWITCH, { dataswitch: enabled ? 1 : 0 });
  const read = await readBack(session, DATA_SWITCH, "dataswitch");
  settleCheck(check, read === null ? null : read === (enabled ? "1" : "0"));
  return enabled;
}

/** Redial (`POST /api/net/reconnect`, `<ReconnectAction>1</ReconnectAction>`); the next polls check it. */
export async function genericReconnect(session: EphemeralCpeSession, check: WriteCheck): Promise<void> {
  check.endpoints.push(RECONNECT);
  await session.postXml(RECONNECT, { ReconnectAction: 1 });
  check.readback = "pending";
}

/**
 * Reboot (`POST /api/device/control`, `<Control>1</Control>`); the next polls check it. The same
 * endpoint resets the router to factory settings with `2`, backs it up with `3` and powers it off with
 * `4`: nothing but `1` is ever sent.
 */
export async function genericReboot(session: EphemeralCpeSession, check: WriteCheck): Promise<void> {
  check.endpoints.push(DEVICE_CONTROL);
  await session.postXml(DEVICE_CONTROL, { Control: 1 });
  check.readback = "pending";
}

/**
 * `readWanRepairBlocker` for a model nobody verified: the WAN state decides as before, but a model
 * without the mobile data switch (an error code) does not block the repair. A broken session still
 * fails it, so nothing is written blind.
 */
export async function readWanRepairBlockerTolerant(session: EphemeralCpeSession): Promise<WanRepairSkipReason | null> {
  if (getXmlTag(await session.get("/api/monitoring/status"), "ConnectionStatus") === "901") return "wan_up";
  let dataswitch: string | null = null;
  try {
    dataswitch = getXmlTag(await session.get(DATA_SWITCH), "dataswitch");
  } catch (err) {
    if (!(err instanceof CpeApiError)) throw err;
  }
  return dataswitch === "0" ? "mobile_data_off" : null;
}

// ── Cellular settings (appendix A.12): the network mode, the operator, data roaming, the traffic counters, USSD ──

const NET_MODE_LIST = "/api/net/net-mode-list";
const REGISTER = "/api/net/register";
const PROFILES = "/api/dialup/profiles";
const PLMN_LIST = "/api/net/plmn-list";
const CONNECTION = "/api/dialup/connection";
const CLEAR_TRAFFIC = "/api/monitoring/clear-traffic";
const MODULE_SWITCH = "/api/global/module-switch";
const USSD_SEND = "/api/ussd/send";
const USSD_STATUS = "/api/ussd/status";
const USSD_GET = "/api/ussd/get";

/** How long the operator scan may take (the router answers once it has searched: up to a minute and more). */
export const OPERATOR_SCAN_TIMEOUT_MS = 120_000;

/** `NetworkMode` codes of the HiLink notes (library A §4.4): one or two two-digit access codes, most preferred first. */
const HILINK_MODE_CODES: Readonly<Partial<Record<NetworkMode, string>>> = { auto: "00", nr_sa: "08", nr_lte: "0803", lte: "03", lte_wcdma: "0302", wcdma: "02", gsm: "01" };

/** The mode a `NetworkMode` code stands for (`null`: a code FengSui has no mode for). */
export function hilinkModeOf(code: string | null | undefined): NetworkMode | null {
  const text = code?.trim();
  return (Object.entries(HILINK_MODE_CODES) as Array<[NetworkMode, string]>).find(([, value]) => value === text)?.[0] ?? null;
}

/**
 * The modes a router offers, from the access codes its `net-mode-list` names (`<AccessList><Access>`):
 * a single code when it is listed, a pair when the pair or both of its halves are. No list, no mode.
 */
export function hilinkModesOffered(netModeList: string | null): NetworkMode[] {
  if (netModeList === null) return [];
  const access = new Set(getXmlBlocks(getXmlBlocks(netModeList, "AccessList")[0] ?? "", "Access").map((code) => code.trim()));
  const listed = (code: string): boolean => access.has(code) || (code.length === 4 && access.has(code.slice(0, 2)) && access.has(code.slice(2)));
  return (Object.entries(HILINK_MODE_CODES) as Array<[NetworkMode, string]>).filter(([, code]) => listed(code)).map(([mode]) => mode);
}

/** A GET of the tolerant kind: the answer, or `null` when the router answers with an error code (a broken session still throws). */
async function getOrNull(session: EphemeralCpeSession, apiPath: string): Promise<string | null> {
  try {
    return await session.get(apiPath);
  } catch (err) {
    if (err instanceof CpeApiError) return null;
    throw err;
  }
}

/** What `net/register` reports: how the operator is chosen (`Mode` 0 automatic, 1 manual) and the operator it is kept on. */
function registrationOf(xml: string | null): { selection: "auto" | "manual" | null; plmn: string | null } | null {
  if (xml === null) return null;
  const mode = getXmlTag(xml, "Mode")?.trim();
  const plmn = getXmlTag(xml, "Plmn")?.trim() ?? "";
  return { selection: mode === "0" ? "auto" : mode === "1" ? "manual" : null, plmn: isPlmn(plmn) ? plmn : null };
}

/** `iptype` of a HiLink dial-up profile (0 IPv4, 1 IPv6, 2 both). */
const HILINK_IP_TYPES: Readonly<Record<string, ApnIpType>> = { "0": "ipv4", "1": "ipv6", "2": "ipv4v6" };
/** `AuthMode` (0 the router chooses, 1 PAP, 2 CHAP): only the two it names are a mode. */
const HILINK_AUTH: Readonly<Record<string, ApnAuthMode>> = { "1": "pap", "2": "chap" };

/**
 * The access point in use, from `GET /api/dialup/profiles`: the profile `CurrentProfile` names (else
 * the first valid one). `ApnIsStatic` 1 is an access point set by hand. Only whether a user name is
 * set is kept; the name and the password never leave this function. `null`: no answer, or no profile.
 */
export function hilinkApnOf(xml: string | null): ApnView | null {
  if (xml === null) return null;
  const current = getXmlTag(xml, "CurrentProfile")?.trim() ?? null;
  const profiles = getXmlBlocks(xml, "Profile").slice(0, 32);
  const profile = profiles.find((p) => getXmlTag(p, "Index")?.trim() === current) ?? profiles.find((p) => getXmlTag(p, "IsValid")?.trim() === "1");
  if (!profile) return null;
  const apn = getXmlTag(profile, "ApnName")?.trim() ?? "";
  const statik = getXmlTag(profile, "ApnIsStatic")?.trim();
  const username = getXmlTag(profile, "Username");
  return {
    mode: statik === "1" ? "manual" : statik === "0" ? "auto" : null,
    apn: isApnName(apn) ? apn : null,
    ipType: HILINK_IP_TYPES[getXmlTag(profile, "iptype")?.trim() ?? ""] ?? null,
    auth: HILINK_AUTH[getXmlTag(profile, "AuthMode")?.trim() ?? ""] ?? null,
    hasUsername: username === null ? null : username.trim() !== "",
  };
}

/** The cellular settings a HiLink model nobody verified reports; a part it answers with an error code is `null`. */
export async function genericCellularRead(session: EphemeralCpeSession): Promise<Omit<CellularSettingsSnapshot, "capturedAtIso" | "capturedAtMs">> {
  const netMode = await getOrNull(session, NET_MODE);
  const options = hilinkModesOffered(await getOrNull(session, NET_MODE_LIST));
  const connection = await getOrNull(session, CONNECTION);
  const roaming = connection === null ? null : getXmlTag(connection, "RoamAutoConnectEnable")?.trim();
  return {
    networkMode: netMode === null && options.length === 0 ? null : { current: netMode === null ? null : hilinkModeOf(getXmlTag(netMode, "NetworkMode")), options },
    simSlots: null,
    operator: registrationOf(await getOrNull(session, REGISTER)),
    apn: hilinkApnOf(await getOrNull(session, PROFILES)),
    dataLimit: null,
    dataRoaming: roaming === "1" ? true : roaming === "0" ? false : null,
  };
}

/**
 * Switch the network mode with `POST /api/net/net-mode`: the mode's code, with `NetworkBand` and
 * `LTEBand` sent back exactly as the router reported them in this session, so only the mode changes.
 * Only a mode the router's own list names is sent. Resolves the mode it had (`null`: none read).
 */
export async function genericNetworkMode(session: EphemeralCpeSession, check: WriteCheck, mode: NetworkMode): Promise<NetworkMode | null> {
  const offered = hilinkModesOffered(await getOrNull(session, NET_MODE_LIST));
  const code = HILINK_MODE_CODES[mode];
  if (code === undefined || !offered.includes(mode)) {
    throw new CpeControlValidationError(`This router offers no "${mode}" network mode (it offers ${offered.join(", ") || "none FengSui can read"})`);
  }
  const current = await session.get(NET_MODE);
  const networkBand = (getXmlTag(current, "NetworkBand") ?? "").trim();
  const lteBand = (getXmlTag(current, "LTEBand") ?? "").trim();
  if (!/^[0-9A-Fa-f]{1,16}$/.test(networkBand) || !/^[0-9A-Fa-f]{1,32}$/.test(lteBand)) {
    throw new CpeAnswerFormatError(`Unexpected ${NET_MODE} answer without a NetworkBand and LTEBand to send back; refusing to write guessed values`);
  }
  check.endpoints.push(NET_MODE);
  await session.postXml(NET_MODE, { NetworkMode: code, NetworkBand: networkBand, LTEBand: lteBand });
  const read = await readBack(session, NET_MODE, "NetworkMode");
  settleCheck(check, read === null ? null : read === code);
  return hilinkModeOf(getXmlTag(current, "NetworkMode"));
}

/**
 * Search for networks (`GET /api/net/plmn-list`): the router answers once it has searched, and may
 * drop the data connection meanwhile. Each `<Network>` names `State`, `FullName` / `ShortName`,
 * `Numeric` and `Rat`, as `net/current-plmn` does for the one in use.
 */
export async function genericScanOperators(session: EphemeralCpeSession, check: WriteCheck): Promise<OperatorChoice[]> {
  check.endpoints.push(PLMN_LIST);
  const xml = await session.get(PLMN_LIST, {}, OPERATOR_SCAN_TIMEOUT_MS);
  const found: OperatorChoice[] = [];
  for (const network of getXmlBlocks(xml, "Network").slice(0, MAX_SCAN_ROWS)) {
    const choice = operatorChoice(getXmlTag(network, "State"), getXmlTag(network, "FullName") ?? getXmlTag(network, "ShortName"), getXmlTag(network, "Numeric"), getXmlTag(network, "Rat"));
    if (choice) found.push(choice);
  }
  check.readback = "none";
  return found;
}

/** `Rat` of `net/register` as the reference project gives it: 2G, 3G and 4G; anything else is left to the router (`""`). */
const REGISTER_RATS: Readonly<Partial<Record<OperatorRat, string>>> = { "2G": "0", "3G": "2", "4G": "7" };

/**
 * Keep the router on one operator's network, or hand the choice back (`POST /api/net/register`:
 * `Mode` 1 with `Plmn` and `Rat`, or `Mode` 0 with both empty). Resolves how it chose before.
 */
export async function genericSelectOperator(session: EphemeralCpeSession, check: WriteCheck, selection: OperatorSelection): Promise<OperatorSelection | null> {
  const before = registrationOf(await getOrNull(session, REGISTER));
  check.endpoints.push(REGISTER);
  const request = selection.mode === "auto" ? { Mode: 0, Plmn: "", Rat: "" } : { Mode: 1, Plmn: selection.plmn, Rat: selection.rat === null ? "" : (REGISTER_RATS[selection.rat] ?? "") };
  await session.postXml(REGISTER, request);
  const after = registrationOf(await getOrNull(session, REGISTER).catch(() => null));
  settleCheck(check, after === null || after.selection === null ? null : after.selection === selection.mode && (selection.mode === "auto" || after.plmn === null || after.plmn === selection.plmn));
  if (before?.selection === "auto") return { mode: "auto" };
  return before?.selection === "manual" && before.plmn !== null ? { mode: "manual", plmn: before.plmn, rat: null } : null;
}

/** The tags of `dialup/connection`, in the order the reference project writes them; the router is sent back the ones it reported. */
const CONNECTION_TAGS = ["RoamAutoConnectEnable", "MaxIdelTime", "ConnectMode", "MTU", "auto_dial_switch", "pdp_always_on"] as const;

/**
 * Allow or stop data roaming (`POST /api/dialup/connection`, `RoamAutoConnectEnable`). The endpoint
 * takes the connection's other settings in the same request, so they are read first and sent back as
 * they are; a router that does not report the four the reference project names gets no write.
 */
export async function genericRoaming(session: EphemeralCpeSession, check: WriteCheck, enabled: boolean): Promise<void> {
  const current = await session.get(CONNECTION);
  const request: Record<string, string | number> = {};
  for (const tag of CONNECTION_TAGS) {
    const value = getXmlTag(current, tag)?.trim();
    if (value !== undefined && /^\d{1,6}$/.test(value)) request[tag] = value;
  }
  if (CONNECTION_TAGS.slice(0, 4).some((tag) => request[tag] === undefined)) {
    throw new CpeAnswerFormatError(`Unexpected ${CONNECTION} answer without the connection settings to send back; refusing to write guessed values`);
  }
  request["RoamAutoConnectEnable"] = enabled ? 1 : 0;
  check.endpoints.push(CONNECTION);
  await session.postXml(CONNECTION, request);
  const read = await readBack(session, CONNECTION, "RoamAutoConnectEnable");
  settleCheck(check, read === null ? null : read === (enabled ? "1" : "0"));
}

/** Clear the router's traffic counters (`POST /api/monitoring/clear-traffic`, `<ClearTraffic>1</ClearTraffic>`); nothing to read back. */
export async function genericTrafficReset(session: EphemeralCpeSession, check: WriteCheck): Promise<void> {
  check.endpoints.push(CLEAR_TRAFFIC);
  await session.postXml(CLEAR_TRAFFIC, { ClearTraffic: 1 });
  check.readback = "none";
}

/**
 * Send a USSD code (`POST /api/ussd/send`), wait while `ussd/status` reports the router busy
 * (`result` 1 or more), then read the operator's answer (`ussd/get`, `content`). A reply inside a
 * session is another send. The reference project has no call that ends a session, so a cancel is
 * refused. A router whose `module-switch` says USSD is off gets nothing.
 */
export async function genericUssd(session: EphemeralCpeSession, check: WriteCheck, request: UssdRequest, sleep: (ms: number) => Promise<void>): Promise<UssdAnswer> {
  if (request.kind === "cancel") throw new CpeControlValidationError("This router's interface gives FengSui no way to end a USSD session; nothing was sent to it");
  const switches = await getOrNull(session, MODULE_SWITCH);
  if (switches === null || getXmlTag(switches, "ussd_enabled")?.trim() !== "1") throw new CpeControlValidationError("This router reports USSD as switched off (ussd_enabled); nothing was sent to it");
  check.endpoints.push(USSD_SEND);
  await session.postXml(USSD_SEND, { content: request.code, codeType: "codeType", timeout: "" });
  check.readback = "none";
  for (let ask = 0; ask < USSD_POLLS; ask += 1) {
    if (ask > 0) await sleep(USSD_POLL_MS);
    const status = await getOrNull(session, USSD_STATUS);
    const result = status === null ? null : getXmlTag(status, "result")?.trim();
    if (result === undefined || result === null || !/^\d{1,3}$/.test(result) || Number(result) >= 1) continue;
    const answer = await session.get(USSD_GET);
    return { state: "answered", text: ussdText(getXmlTextPreserve(answer, "content")), awaitsReply: false };
  }
  return emptyUssd("no_answer");
}
