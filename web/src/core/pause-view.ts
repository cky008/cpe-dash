/**
 * View helper for the connection pause control and banner: maps the daemon's
 * `ConnectionPauseStatus` to the console's display state (`paused`, `blocked`, or `ready`).
 * The daemon decides when a pause runs or is blocked; this only formats the status to show.
 */

import type { ConnectionPauseStatus } from "../../../src/connection-pause.ts";

/** What the console shows for the connection's pause. */
export type PauseView =
  | { state: "paused"; untilMs: number; minutesLeft: number }
  | { state: "blocked"; untilMs: number | null }
  | { state: "ready" };

function parseIsoMs(iso: string | null): number | null {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

export function pauseView(pause: ConnectionPauseStatus | null | undefined, nowMs: number): PauseView {
  if (!pause) return { state: "ready" };
  if (pause.active) {
    const untilMs = parseIsoMs(pause.untilIso);
    if (untilMs === null) return { state: "ready" };
    const minutesLeft = Math.max(1, Math.ceil((untilMs - nowMs) / 60_000));
    return { state: "paused", untilMs, minutesLeft };
  }
  if (pause.blocked !== null) {
    return { state: "blocked", untilMs: parseIsoMs(pause.blocked.untilIso) };
  }
  return { state: "ready" };
}
