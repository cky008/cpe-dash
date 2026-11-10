import { CpeAnswerFormatError, CpeApiError, type EphemeralCpeSession } from "./cpe-client.ts";
import { CpeControlValidationError } from "./control-error.ts";
import type { WanRepairSkipReason } from "./cpe-domain.ts";
import type { ReadbackReason, WriteCheck } from "./device-access.ts";
import { LTE_ALL_BANDS_MASK, isAllBandsMask, maskToBands } from "./device-profile.ts";
import { bandsToHexMask } from "./rf-bounds.ts";
import { getXmlTag } from "./xml.ts";

/**
 * The writes FengSui does on a HiLink router of a model nobody verified (on by default, each can be
 * turned off): the HiLink request formats of docs/PHASE1_PROTOCOL_SPEC.md appendix A.11, nothing
 * guessed. Each one runs inside the write's own `executeControl` session, is never
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
