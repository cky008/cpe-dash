import type { SelfHealStatus } from "../../../src/self-heal-status.ts";
import type { MessageKey } from "../i18n/zh-CN.ts";

type Text = (key: MessageKey, params?: Record<string, string | number>) => string;

export type SelfHealTone = "ok" | "pending" | "muted";

export interface SelfHealRow {
  label: string;
  value: string;
  tone: SelfHealTone;
}

/**
 * What WAN self-healing will do next, as rows for the controls drawer: the lock rollback (its window,
 * or the lock it is watching) and the automatic redial (the day's budget, the next allowed redial).
 * `clock` formats a time of day; nothing is shown before the daemon has said.
 */
export function selfHealRows(status: SelfHealStatus | null, t: Text, clock: (ms: number) => string): SelfHealRow[] {
  if (!status) return [];
  const { lockRollback: lock, reconnect } = status;
  const at = (iso: string): string => clock(Date.parse(iso));

  let lockRow: SelfHealRow;
  if (lock.afterMin === null) lockRow = { label: t("heal.lock"), value: t("heal.off"), tone: "muted" };
  else if (lock.watch === null) lockRow = { label: t("heal.lock"), value: t("heal.lock_armed", { min: lock.afterMin }), tone: "ok" };
  else if (lock.watch.wanUpSinceIso === null) lockRow = { label: t("heal.lock"), value: t("heal.lock_watching", { deadline: at(lock.watch.deadlineIso) }), tone: "pending" };
  else lockRow = { label: t("heal.lock"), value: t("heal.lock_confirming", { since: at(lock.watch.wanUpSinceIso) }), tone: "pending" };

  let redialRow: SelfHealRow;
  if (reconnect.afterMin === null) redialRow = { label: t("heal.redial"), value: t("heal.off"), tone: "muted" };
  else {
    const parts = [t("heal.redial_armed", { min: reconnect.afterMin, count: reconnect.redialsLast24h, max: reconnect.maxPer24h })];
    if (reconnect.wanDownSinceIso) parts.push(t("heal.redial_down", { since: at(reconnect.wanDownSinceIso) }));
    if (reconnect.nextAllowedAtIso) parts.push(t("heal.redial_next", { at: at(reconnect.nextAllowedAtIso) }));
    redialRow = { label: t("heal.redial"), value: parts.join(" · "), tone: reconnect.redialsLast24h >= reconnect.maxPer24h ? "pending" : "ok" };
  }
  return [lockRow, redialRow];
}

/** The line a lock confirmation adds: what happens if the lock cuts the WAN (`null` before the daemon said). */
export function lockRollbackNote(status: SelfHealStatus | null, t: Text): string | null {
  if (!status) return null;
  return status.lockRollback.afterMin === null ? t("heal.note_off") : t("heal.note_on", { min: status.lockRollback.afterMin });
}
