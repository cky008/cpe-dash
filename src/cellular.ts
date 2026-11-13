import { CpeControlValidationError } from "./control-error.ts";

/**
 * The cellular settings FengSui reads and writes besides the locks: the network mode, which operator
 * the router registers with, the SIM slot in use, the card's PIN, airplane mode, data roaming, the
 * APN, the data limit and USSD. One shape for every brand: a backend fills what its router's
 * interface has and leaves the rest `null`; nothing here names a brand.
 *
 * Zero dependencies: the daemon, the web console and the live demo share these types and checks.
 * A PIN, an APN's credentials and USSD text are values a user typed or an operator sent: they are
 * checked here and never kept in a log, a summary or a record.
 */

type Args = Readonly<Record<string, unknown>>;

// ── Network mode ─────────────────────────────────────────────────────────────

/**
 * What the router may attach to: `auto` (whatever it finds), 5G standalone only (`nr_sa`), 5G next to
 * a 4G anchor (`nr_nsa`), 5G or 4G but no 3G (`nr_lte`), 4G only (`lte`), 4G TDD only (`lte_tdd`), 4G
 * FDD only (`lte_fdd`), 4G or 3G (`lte_wcdma`), 3G only (`wcdma`), 2G only (`gsm`). A router offers
 * some of them.
 */
export const NETWORK_MODES = ["auto", "nr_sa", "nr_nsa", "nr_lte", "lte", "lte_tdd", "lte_fdd", "lte_wcdma", "wcdma", "gsm"] as const;

export type NetworkMode = (typeof NETWORK_MODES)[number];

export function isNetworkMode(value: unknown): value is NetworkMode {
  return typeof value === "string" && (NETWORK_MODES as ReadonlyArray<string>).includes(value);
}

export function readNetworkMode(value: unknown, key = "mode"): NetworkMode {
  if (!isNetworkMode(value)) throw new CpeControlValidationError(`"${key}" must be one of ${NETWORK_MODES.join(", ")}`);
  return value;
}

// ── SIM slot ─────────────────────────────────────────────────────────────────

/** A SIM slot as the router counts it: a card in a tray (`physical`) or one built in (`embedded`, eSIM). */
export interface SimSlotRef {
  kind: "physical" | "embedded";
  index: number;
}

export function sameSimSlot(a: SimSlotRef | null | undefined, b: SimSlotRef | null | undefined): boolean {
  return a !== null && a !== undefined && b !== null && b !== undefined && a.kind === b.kind && a.index === b.index;
}

/** `{ kind: "physical" | "embedded", index? }` (`index` defaults to 1, the first of its kind). */
export function readSimSlot(args: Args): SimSlotRef {
  const kind = args["kind"];
  if (kind !== "physical" && kind !== "embedded") throw new CpeControlValidationError('"kind" must be "physical" or "embedded"');
  const index = args["index"] ?? 1;
  if (typeof index !== "number" || !Number.isInteger(index) || index < 1 || index > 4) throw new CpeControlValidationError('"index" must be a whole number from 1 to 4');
  return { kind, index };
}

// ── Operator selection ───────────────────────────────────────────────────────

export const OPERATOR_RATS = ["2G", "3G", "4G", "5G"] as const;

export type OperatorRat = (typeof OPERATOR_RATS)[number];

/** A network a scan found. Its name is the operator's own text: shown, never trusted. */
export interface OperatorChoice {
  /** MCC + MNC digits. */
  plmn: string;
  name: string | null;
  rat: OperatorRat | null;
  /** `current`: the one the router is on; `forbidden`: the SIM may not use it. */
  state: "current" | "available" | "forbidden" | "unknown";
}

/** Let the router choose (`auto`), or keep it on one operator's network. */
export type OperatorSelection = { mode: "auto" } | { mode: "manual"; plmn: string; rat: OperatorRat | null };

const PLMN = /^\d{5,6}$/;

export function isPlmn(value: unknown): value is string {
  return typeof value === "string" && PLMN.test(value);
}

/** `{ mode: "auto" }` or `{ mode: "manual", plmn, rat? }`. */
export function readOperatorSelection(args: Args): OperatorSelection {
  const mode = args["mode"];
  if (mode === "auto") return { mode: "auto" };
  if (mode !== "manual") throw new CpeControlValidationError('"mode" must be "auto" or "manual"');
  const plmn = args["plmn"];
  if (!isPlmn(plmn)) throw new CpeControlValidationError('"plmn" must be the operator\'s code: 5 or 6 digits (MCC + MNC)');
  const rat = args["rat"] ?? null;
  if (rat !== null && !(OPERATOR_RATS as ReadonlyArray<unknown>).includes(rat)) throw new CpeControlValidationError(`"rat" must be one of ${OPERATOR_RATS.join(", ")}, or left out`);
  return { mode: "manual", plmn, rat: rat as OperatorRat | null };
}

export function sameOperatorSelection(a: OperatorSelection, b: OperatorSelection): boolean {
  if (a.mode === "auto" || b.mode === "auto") return a.mode === b.mode;
  return a.plmn === b.plmn && (a.rat === null || b.rat === null || a.rat === b.rat);
}

// ── APN ──────────────────────────────────────────────────────────────────────

export const APN_IP_TYPES = ["ipv4", "ipv6", "ipv4v6"] as const;
export type ApnIpType = (typeof APN_IP_TYPES)[number];

export const APN_AUTH_MODES = ["none", "pap", "chap"] as const;
export type ApnAuthMode = (typeof APN_AUTH_MODES)[number];

/** An access point as FengSui writes it. The credentials are sent and never read back or kept. */
export interface ApnSetting {
  apn: string;
  ipType: ApnIpType;
  auth: ApnAuthMode;
  username: string;
  password: string;
}

/** `auto`: the access point the router picks for the SIM card; else the one to use. */
export type ApnChoice = { mode: "auto" } | ({ mode: "manual" } & ApnSetting);

/** The access point in use as the router reports it: never its password. */
export interface ApnView {
  /** `auto`: chosen by the router for the SIM card; `manual`: set by hand. */
  mode: "auto" | "manual" | null;
  apn: string | null;
  ipType: ApnIpType | null;
  auth: ApnAuthMode | null;
  /** Whether a user name is set (the name itself stays on the router). */
  hasUsername: boolean | null;
}

/**
 * An APN (3GPP TS 23.003 §9.1): labels of letters, digits and hyphens joined by dots, 100 characters
 * at most. Nothing else is ever put into a router's form or an AT command.
 */
const APN_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,98}[A-Za-z0-9])?$/;
/** Credentials as an operator hands them out: printable ASCII without quotes, commas or shell-active characters. */
const APN_CREDENTIAL = /^[A-Za-z0-9@._+:#*!/-]{0,64}$/;

export function isApnName(value: unknown): value is string {
  return typeof value === "string" && APN_NAME.test(value) && !value.includes("..");
}

/** `{ mode: "auto" }` or `{ mode: "manual", apn, ipType?, auth?, username?, password? }`. */
export function readApnChoice(args: Args): ApnChoice {
  const mode = args["mode"];
  if (mode === "auto") return { mode: "auto" };
  if (mode !== "manual") throw new CpeControlValidationError('"mode" must be "auto" or "manual"');
  const apn = args["apn"];
  if (!isApnName(apn)) throw new CpeControlValidationError('"apn" must be an access point name: letters, digits, dots and hyphens, 100 characters at most');
  const ipType = args["ipType"] ?? "ipv4v6";
  if (!(APN_IP_TYPES as ReadonlyArray<unknown>).includes(ipType)) throw new CpeControlValidationError(`"ipType" must be one of ${APN_IP_TYPES.join(", ")}`);
  const auth = args["auth"] ?? "none";
  if (!(APN_AUTH_MODES as ReadonlyArray<unknown>).includes(auth)) throw new CpeControlValidationError(`"auth" must be one of ${APN_AUTH_MODES.join(", ")}`);
  const credential = (key: string): string => {
    const value = args[key] ?? "";
    if (typeof value !== "string" || !APN_CREDENTIAL.test(value)) throw new CpeControlValidationError(`"${key}" may hold up to 64 letters, digits and @ . _ + : # * ! / -`);
    return value;
  };
  const username = credential("username");
  const password = credential("password");
  if (auth === "none" && (username !== "" || password !== "")) throw new CpeControlValidationError('A user name or password needs "auth" set to "pap" or "chap"');
  return { mode: "manual", apn, ipType: ipType as ApnIpType, auth: auth as ApnAuthMode, username, password };
}

/**
 * How the access point is put back when the WAN stays down after a change: the router's automatic
 * choice, the profile it used before (by the router's own id for it), or the context a module had.
 * Never a credential: a profile the router keeps is switched back to, not rewritten.
 */
export type ApnRestore = { mode: "auto" } | { mode: "profile"; id: string } | { mode: "context"; apn: string; ipType: ApnIpType };

/** A slot as a control summary names it (the daemon and the live demo say the same). */
export function simSlotLabel(locale: "zh-CN" | "en", slot: SimSlotRef): string {
  if (slot.kind === "physical") return locale === "en" ? (slot.index > 1 ? `card ${slot.index}` : "the card in the tray") : slot.index > 1 ? `实体卡 ${slot.index}` : "实体卡";
  return locale === "en" ? `built-in card ${slot.index}` : `内置卡 ${slot.index}`;
}

// ── Data limit ───────────────────────────────────────────────────────────────

/** The monthly data limit the router itself keeps: at `alertPercent` of `bytes` it warns. */
export interface DataLimitSetting {
  enabled: boolean;
  /** `null` with `enabled: false`: the size on the router is left as it is. */
  bytes: number | null;
  alertPercent: number | null;
}

/** 1 MB to 100 TB. */
const MIN_LIMIT_BYTES = 1024 * 1024;
const MAX_LIMIT_BYTES = 100 * 1024 ** 4;

/** `{ enabled, bytes?, alertPercent? }` (turning the limit on needs `bytes`). */
export function readDataLimit(args: Args): DataLimitSetting {
  const enabled = args["enabled"];
  if (typeof enabled !== "boolean") throw new CpeControlValidationError('"enabled" must be a boolean');
  const bytes = args["bytes"] ?? null;
  if (bytes !== null && (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < MIN_LIMIT_BYTES || bytes > MAX_LIMIT_BYTES)) {
    throw new CpeControlValidationError('"bytes" must be a whole number of bytes from 1 MB to 100 TB');
  }
  const alertPercent = args["alertPercent"] ?? null;
  if (alertPercent !== null && (typeof alertPercent !== "number" || !Number.isInteger(alertPercent) || alertPercent < 1 || alertPercent > 100)) {
    throw new CpeControlValidationError('"alertPercent" must be a whole number from 1 to 100');
  }
  if (enabled && bytes === null) throw new CpeControlValidationError('Turning the data limit on needs "bytes"');
  return { enabled, bytes, alertPercent };
}

// ── SIM PIN ──────────────────────────────────────────────────────────────────

/** A SIM PIN: 4 to 8 digits (3GPP TS 31.101). */
const SIM_PIN = /^\d{4,8}$/;

export function readSimPin(value: unknown, key = "pin"): string {
  if (typeof value !== "string" || !SIM_PIN.test(value)) throw new CpeControlValidationError(`"${key}" must be 4 to 8 digits`);
  return value;
}

/**
 * Whether FengSui may send a PIN: only while the router says how many attempts the card has left, and
 * more than one is (the last attempt is the owner's to spend on the router's own page). The reason it
 * may not is said in plain words, with no number a caller could act on by guessing.
 */
export function pinAttemptAllowed(attemptsLeft: number | null | undefined): { allowed: true; attemptsLeft: number } | { allowed: false; reason: "unknown" | "last_attempt" | "none_left" } {
  if (attemptsLeft === null || attemptsLeft === undefined) return { allowed: false, reason: "unknown" };
  if (attemptsLeft <= 0) return { allowed: false, reason: "none_left" };
  if (attemptsLeft === 1) return { allowed: false, reason: "last_attempt" };
  return { allowed: true, attemptsLeft };
}

/** Why a PIN is not sent, in words that tell its owner what to do instead (the daemon and the live demo say the same). */
export const PIN_REFUSALS: Readonly<Record<"unknown" | "last_attempt" | "none_left", string>> = {
  unknown: "The router does not report how many PIN attempts the SIM card has left, so FengSui sends no PIN: enter it on the router's own page",
  last_attempt: "The SIM card has one PIN attempt left, and a wrong PIN would lock it until its PUK is entered: FengSui sends no PIN now, enter it on the router's own page",
  none_left: "The SIM card takes no more PINs and wants its PUK, which FengSui does not enter: use the router's own page",
};

/** How one PIN write ended: the router took it, or said it was wrong (nothing is sent again). */
export interface SimPinOutcome {
  accepted: boolean;
  /** Attempts the card has left after the write, where the router says (`null`: it did not). */
  attemptsLeft: number | null;
}

// ── USSD ─────────────────────────────────────────────────────────────────────

/**
 * A USSD string as a keypad types it (3GPP TS 22.090): digits, `*` and `#`, 1 to 40 of them; a reply
 * inside a session may be a short number alone.
 */
const USSD_CODE = /^[0-9*#]{1,40}$/;

/** `send`: start a session with a code; `reply`: answer the network's question; `cancel`: end the session. */
export type UssdRequest = { kind: "send"; code: string } | { kind: "reply"; code: string } | { kind: "cancel" };

/** `{ action?: "send" | "reply" | "cancel", code? }` (`action` defaults to `send`). */
export function readUssdRequest(args: Args): UssdRequest {
  const action = args["action"] ?? "send";
  if (action === "cancel") return { kind: "cancel" };
  if (action !== "send" && action !== "reply") throw new CpeControlValidationError('"action" must be "send", "reply" or "cancel"');
  const code = args["code"];
  if (typeof code !== "string" || !USSD_CODE.test(code)) throw new CpeControlValidationError('"code" must be 1 to 40 of the characters 0-9, * and #');
  return { kind: action, code };
}

/** The longest answer kept (a USSD message is 182 characters; menus chain a few). */
export const USSD_MAX_TEXT = 1000;

/**
 * What came back. `text` is the operator's own words: third-party content, shown to the person who
 * asked and never logged. `awaitsReply`: the network keeps the session open for an answer.
 */
export interface UssdAnswer {
  state: "answered" | "no_answer" | "cancelled";
  text: string | null;
  awaitsReply: boolean;
}

// ── What the router reports ──────────────────────────────────────────────────

/**
 * The cellular settings as one read reports them (the SIM slot in use, the PIN's state, airplane mode
 * and the roaming switch ride on the 5 s poll: `GlobalTelemetrySnapshot.status`). A part the router's
 * interface has no read for is `null`.
 */
export interface CellularSettingsSnapshot {
  capturedAtIso: string;
  capturedAtMs: number;
  /** The mode in use (`current: null`: not read) and the ones this router can be set to. */
  networkMode: { current: NetworkMode | null; options: NetworkMode[] } | null;
  /** The slots the router can switch between (fewer than two: nothing to switch). */
  simSlots: SimSlotRef[] | null;
  operator: { selection: "auto" | "manual" | null; plmn: string | null } | null;
  apn: ApnView | null;
  dataLimit: { enabled: boolean | null; bytes: number | null; alertPercent: number | null } | null;
  /** The data roaming switch as this read saw it, where the 5 s poll does not carry it (`null`: not read here). */
  dataRoaming: boolean | null;
}

// ── A change that can cut the WAN ────────────────────────────────────────────

/**
 * A setting whose change can take the router off the network by accident, with the value it had
 * right before (read in the write's own session): what it is put back to if the WAN stays down.
 */
export type LinkChange =
  | { kind: "sim_slot"; previous: SimSlotRef }
  | { kind: "network_mode"; previous: NetworkMode }
  | { kind: "operator"; previous: OperatorSelection }
  | { kind: "apn"; previous: ApnRestore };

export type LinkChangeKind = LinkChange["kind"];

export const LINK_CHANGE_KINDS: ReadonlyArray<LinkChangeKind> = ["sim_slot", "network_mode", "operator", "apn"];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A stored change this version can read (state.json is input: anything else is dropped). */
export function isLinkChange(value: unknown): value is LinkChange {
  if (!isRecord(value)) return false;
  const previous = value["previous"];
  switch (value["kind"]) {
    case "sim_slot":
      return isRecord(previous) && (previous["kind"] === "physical" || previous["kind"] === "embedded") && Number.isInteger(previous["index"]);
    case "network_mode":
      return isNetworkMode(previous);
    case "operator":
      return isRecord(previous) && (previous["mode"] === "auto" || (previous["mode"] === "manual" && isPlmn(previous["plmn"]) && (previous["rat"] === null || (OPERATOR_RATS as ReadonlyArray<unknown>).includes(previous["rat"]))));
    case "apn":
      if (!isRecord(previous)) return false;
      if (previous["mode"] === "auto") return true;
      if (previous["mode"] === "profile") return typeof previous["id"] === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(previous["id"]);
      return previous["mode"] === "context" && (previous["apn"] === "" || isApnName(previous["apn"])) && (APN_IP_TYPES as ReadonlyArray<unknown>).includes(previous["ipType"]);
    default:
      return false;
  }
}
