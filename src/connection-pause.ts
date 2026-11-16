import { CpeControlValidationError } from "./control-error.ts";

/**
 * Zero-dependency: pausing the connection to the router (Settings → Router). For a time its owner
 * chooses FengSui opens no session on the router and sends it nothing, so they can use the router's
 * own page on a router that keeps one admin session; the pause ends by itself. The daemon, the
 * console and the live demo share the limits and the shape of its status.
 */

/** The longest a pause may last: FengSui always takes the router up again by itself. */
export const PAUSE_MAX_MINUTES = 120;
/** What the console offers. */
export const PAUSE_CHOICES_MINUTES: ReadonlyArray<number> = [15, 30, 60, 120];

/** Why a pause cannot begin now: a change FengSui made is still watched (it is put back if the internet stays down). */
export interface PauseBlock {
  reason: "watch";
  /** About when the watch is over (`null`: not known). */
  untilIso: string | null;
}

export interface ConnectionPauseStatus {
  /** While `true`, FengSui sends the router nothing: reads are skipped, writes are refused. */
  active: boolean;
  sinceIso: string | null;
  /** When FengSui takes the router up again by itself. */
  untilIso: string | null;
  /** While not paused: why a pause cannot begin now (`null`: it can). */
  blocked: PauseBlock | null;
}

/** A pause's record in state.json: a restart carries on with it to the same end. */
export interface ConnectionPauseRecord {
  sinceMs: number;
  untilMs: number;
}

/** A record as stored: both times are numbers, in order, and no further apart than the longest pause. */
export function isPauseRecord(value: unknown): value is ConnectionPauseRecord {
  if (typeof value !== "object" || value === null) return false;
  const { sinceMs, untilMs } = value as Record<string, unknown>;
  return typeof sinceMs === "number" && typeof untilMs === "number" && Number.isFinite(sinceMs) && Number.isFinite(untilMs) && untilMs > sinceMs && untilMs - sinceMs <= PAUSE_MAX_MINUTES * 60_000;
}

/** The minutes of a pause: whole, from 1 to `PAUSE_MAX_MINUTES`. */
export function checkPauseMinutes(minutes: unknown): number {
  if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < 1 || minutes > PAUSE_MAX_MINUTES) {
    throw new CpeControlValidationError(`"minutes" must be a whole number from 1 to ${PAUSE_MAX_MINUTES}`);
  }
  return minutes;
}

/** The body of `POST /api/session/pause`. */
export function readPauseMinutes(fields: Readonly<Record<string, unknown>>): { minutes: number } {
  return { minutes: checkPauseMinutes(fields["minutes"]) };
}
