import type { WriteCheck } from "../device-access.ts";
import type { DriverFamily } from "../router-family.ts";
import type { CellLockState, DriverBandLockTarget, DriverCellLockTarget, DriverLockState } from "./types.ts";

/**
 * What a driver write records (the command names it sent, never a value) and how it reads the write
 * back in the same session: the lock state the router reports after it, compared with what was asked.
 * A family that names nothing to compare leaves the read-back `unknown` rather than guess `match`.
 */

const COMMAND = /^[A-Za-z0-9_.+=/-]{1,64}$/;

/** Note a command before it is sent: `<family>:<command>` (the write's endpoints in the device report). */
export function noteSent(check: WriteCheck, family: DriverFamily, command: string): void {
  if (!COMMAND.test(command)) throw new Error(`Refusing to record the command "${command.slice(0, 32)}"`);
  const label = `${family}:${command}`;
  if (!check.endpoints.includes(label)) check.endpoints.push(label);
}

function sameBands(wanted: ReadonlyArray<number> | "all", got: ReadonlyArray<number> | "all" | null): boolean | null {
  if (got === null) return null;
  if (wanted === "all" || got === "all") return wanted === got;
  const a = [...new Set(wanted)].sort((x, y) => x - y);
  const b = [...new Set(got)].sort((x, y) => x - y);
  return a.length === b.length && a.every((band, i) => band === b[i]);
}

/** Fold one comparison into the read-back: a difference wins, then anything unread, then a match. */
function fold(results: ReadonlyArray<boolean | null>): Pick<WriteCheck, "readback" | "reason"> {
  if (results.length === 0) return { readback: "unknown", reason: "unreadable" };
  if (results.includes(false)) return { readback: "mismatch", reason: "differs" };
  if (results.includes(null)) return { readback: "unknown", reason: "unreadable" };
  return { readback: "match", reason: null };
}

function settle(check: WriteCheck, results: ReadonlyArray<boolean | null>): void {
  const outcome = fold(results);
  check.readback = outcome.readback;
  check.reason = outcome.reason;
}

/** A band lock read back: the LTE bands, the NR bands and the network mode it set (each when it set one). */
export function settleBandLock(check: WriteCheck, target: DriverBandLockTarget, after: DriverLockState | null): void {
  if (!after) return settle(check, []);
  const results: Array<boolean | null> = [sameBands(target.lte, after.lteBands)];
  if (target.nr !== null) results.push(sameBands(target.nr, after.nrBands));
  if (target.networkMode !== null) results.push(after.networkMode === null ? null : after.networkMode === target.networkMode);
  settle(check, results);
}

/** A cell lock read back: the channel and PCI the router reports locked, for the RAT that was locked. */
export function settleCellLock(check: WriteCheck, target: DriverCellLockTarget, after: DriverLockState | null): void {
  const cell: CellLockState | null = after ? (target.rat === "LTE" ? after.lteCell : after.nrCell) : null;
  if (!cell) return settle(check, []);
  if (!cell.locked) return settle(check, [false]);
  const results: Array<boolean | null> = [cell.pci === null ? null : cell.pci === target.pci, cell.arfcn === null ? null : cell.arfcn === target.arfcn];
  settle(check, results);
}

/** Every lock cleared: all bands on both RATs (where the router names them) and no cell lock. */
export function settleUnlock(check: WriteCheck, after: DriverLockState | null, opts: { nr: boolean; mode: boolean }): void {
  if (!after) return settle(check, []);
  const results: Array<boolean | null> = [sameBands("all", after.lteBands)];
  if (opts.nr) results.push(sameBands("all", after.nrBands));
  for (const cell of [after.lteCell, after.nrCell]) if (cell) results.push(!cell.locked);
  if (opts.mode) results.push(after.networkMode === null ? null : after.networkMode === "auto");
  settle(check, results);
}

/** A reboot is checked by the polls that follow it (`MutexSessionScheduler.notePollForWrites`). */
export function settleRestart(check: WriteCheck): void {
  check.readback = "pending";
  check.reason = null;
}
