/**
 * Zero-dependency: what WAN self-healing (`src/self-heal.ts`) will do next, as the daemon reports it
 * (REST `GET /api/session/status`, MCP `get_cpe_session_status`) and the console and the static demo
 * show it, with the limits both sides need. Nothing about the router or any device.
 */

/** The WAN must stay up this long after a lock for the lock to be kept. */
export const LOCK_CONFIRM_MS = 2 * 60_000;
/** Redials that reached the router within 24 h. */
export const RECONNECT_MAX_PER_DAY = 4;

export interface SelfHealStatus {
  lockRollback: {
    /** `LOCK_ROLLBACK_AFTER_MIN` (`null`: off). */
    afterMin: number | null;
    /** The lock whose window is open: by `deadlineIso` the WAN must be back and have stayed up 2 min, or every lock is cleared. */
    watch: { lockUpdatedAtIso: string; deadlineIso: string; wanUpSinceIso: string | null } | null;
  };
  reconnect: {
    /** `WAN_AUTO_RECONNECT_AFTER_MIN` (`null`: off). */
    afterMin: number | null;
    /** Redials that reached the router in the last 24 h, of at most `maxPer24h`. */
    redialsLast24h: number;
    maxPer24h: number;
    /** No redial before this (the backoff step or the 24 h cap); `null` when nothing holds one back. */
    nextAllowedAtIso: string | null;
    /** The outage being timed (`null`: the WAN is up, or not seen down yet). */
    wanDownSinceIso: string | null;
  };
}

/** The status of a daemon with both parts off (no `WanSelfHeal` is built). */
export const SELF_HEAL_OFF: SelfHealStatus = {
  lockRollback: { afterMin: null, watch: null },
  reconnect: { afterMin: null, redialsLast24h: 0, maxPer24h: RECONNECT_MAX_PER_DAY, nextAllowedAtIso: null, wanDownSinceIso: null },
};
