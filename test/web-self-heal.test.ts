import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SELF_HEAL_OFF, type SelfHealStatus } from "../src/self-heal-status.ts";
import { interpolate } from "../web/src/core/i18n.ts";
import { lockRollbackNote, selfHealRows } from "../web/src/core/self-heal-view.ts";
import { en } from "../web/src/i18n/en.ts";
import { type MessageKey, zhCN } from "../web/src/i18n/zh-CN.ts";

const tEn = (key: MessageKey, params?: Record<string, string | number>): string => interpolate(en[key], params);
const tZh = (key: MessageKey, params?: Record<string, string | number>): string => interpolate(zhCN[key], params);
const clock = (ms: number): string => new Date(ms).toISOString().slice(11, 16);

const ON: SelfHealStatus = {
  lockRollback: { afterMin: 10, watch: null },
  reconnect: { afterMin: 3, redialsLast24h: 0, maxPer24h: 4, nextAllowedAtIso: null, wanDownSinceIso: null },
};

describe("web core: WAN self-healing in the controls drawer", () => {
  it("shows nothing before the daemon said, and says so when both parts are off", () => {
    assert.deepEqual(selfHealRows(null, tEn, clock), []);
    assert.equal(lockRollbackNote(null, tEn), null);
    const off = selfHealRows(SELF_HEAL_OFF, tEn, clock);
    assert.deepEqual(off.map((row) => [row.label, row.value, row.tone]), [
      ["Lock rollback", "Off", "muted"],
      ["Auto redial", "Off", "muted"],
    ]);
    assert.match(lockRollbackNote(SELF_HEAL_OFF, tEn) ?? "", /off[\s\S]*by hand[\s\S]*LOCK_ROLLBACK_AFTER_MIN/);
  });

  it("follows a lock window from the watch to the WAN coming back, and the redial budget", () => {
    assert.deepEqual(selfHealRows(ON, tEn, clock).map((row) => row.tone), ["ok", "ok"]);
    assert.match(selfHealRows(ON, tEn, clock)[0]?.value ?? "", /within 10 min/);
    assert.match(lockRollbackNote(ON, tEn) ?? "", /on[\s\S]*within 10 minutes[\s\S]*cleared automatically/);

    const watching: SelfHealStatus = {
      ...ON,
      lockRollback: { afterMin: 10, watch: { lockUpdatedAtIso: "2026-11-08T08:00:00.000Z", deadlineIso: "2026-11-08T08:10:00.000Z", wanUpSinceIso: null } },
    };
    const [lock] = selfHealRows(watching, tEn, clock);
    assert.deepEqual([lock?.tone, /by 08:10/.test(lock?.value ?? "")], ["pending", true]);
    const confirming: SelfHealStatus = {
      ...ON,
      lockRollback: { afterMin: 10, watch: { lockUpdatedAtIso: "2026-11-08T08:00:00.000Z", deadlineIso: "2026-11-08T08:10:00.000Z", wanUpSinceIso: "2026-11-08T08:01:00.000Z" } },
    };
    assert.match(selfHealRows(confirming, tEn, clock)[0]?.value ?? "", /since 08:01/);

    const outage: SelfHealStatus = {
      ...ON,
      reconnect: { afterMin: 3, redialsLast24h: 2, maxPer24h: 4, nextAllowedAtIso: "2026-11-08T09:30:00.000Z", wanDownSinceIso: "2026-11-08T09:00:00.000Z" },
    };
    const [, redial] = selfHealRows(outage, tEn, clock);
    assert.deepEqual([redial?.tone, /2\/4/.test(redial?.value ?? ""), /09:00/.test(redial?.value ?? ""), /09:30/.test(redial?.value ?? "")], ["ok", true, true, true]);
    const spent: SelfHealStatus = { ...ON, reconnect: { ...outage.reconnect, redialsLast24h: 4, nextAllowedAtIso: null } };
    assert.equal(selfHealRows(spent, tEn, clock)[1]?.tone, "pending", "the day's redials are spent");

    // The same rows in Chinese, every placeholder filled
    for (const row of [...selfHealRows(outage, tZh, clock), ...selfHealRows(watching, tZh, clock)]) assert.doesNotMatch(row.value, /\{\w+\}/);
    assert.match(lockRollbackNote(ON, tZh) ?? "", /10 分钟/);
  });
});
