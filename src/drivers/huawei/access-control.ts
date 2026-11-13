import { type AccessControlSnapshot, type AccessRequestContext, type TimeRulesState, accessGuardFromHosts } from "../../access-control.ts";
import {
  type AccessGuard,
  AccessPlanError,
  type TimeRule,
  type TimeRuleChange,
  type TimeRuleWrite,
  type WifiAccessChange,
  type WifiFilterPlan,
  type WifiMacFilterState,
  normalizeMac,
  planTimeRuleChange,
  planWifiAccessChange,
} from "../../access-plan.ts";
import { CpeControlValidationError } from "../../cpe-domain.ts";
import { TIME_RULES, WIFI_FEATURES, WIFI_FILTER_READ, WIFI_FILTER_WRITE, buildTimeRuleRequest, buildWifiMacFilterRequest, parseTimeRules, parseWifiMacFilter } from "../../protocols/hilink/access-control.ts";
import type { EphemeralCpeSession } from "../../protocols/hilink/client.ts";
import { parseHostInfoJson } from "../../protocols/hilink/parsers.ts";
import { CpeApiError } from "../../session-errors.ts";

/**
 * Device access control on the H168-383, built on the router's own features (firmware 4.4.0.1,
 * verified against a WebInspector capture and a read-only session; see docs/dev/protocol.md):
 *
 * - Wi-Fi MAC filter: `GET /api/wlan/multi-macfilter-settings-ex` / `POST .../multi-macfilter-settings`.
 *   Writes name SSID `Index` 0 like the router's "Device management" page does.
 * - Internet time rules (parental control): `GET` / `POST /api/timerule/timerule`.
 *
 * Every write is read-modify-write inside one session: read the hosts (to know which device runs
 * FengSui and which device sent the request), read the current state, plan the change with
 * src/access-plan.ts, write, and read back to verify the router applied it.
 */

async function optionalGet(session: EphemeralCpeSession, apiPath: string): Promise<string> {
  try {
    return await session.get(apiPath);
  } catch (err) {
    if (err instanceof CpeApiError) return "";
    throw err;
  }
}

/**
 * The guard for one write. A change that can cut a device off fails closed when the host list does
 * not mark the machine running FengSui (`IsLocalDevice`) with a MAC it can protect: a HostInfo that
 * did not parse, came back empty, lacks the mark or marks a host without a valid MAC would otherwise
 * leave nothing protected. Restoring access needs no guard.
 */
async function readGuard(session: EphemeralCpeSession, ctx: AccessRequestContext, canCutOff: boolean): Promise<AccessGuard> {
  const hosts = parseHostInfoJson(await session.get("/api/system/HostInfo"), { sanitize: false });
  if (canCutOff && !hosts.some((host) => host.isLocalDevice && normalizeMac(host.macAddress) !== null)) {
    throw new CpeControlValidationError(
      "The router's host list does not identify the machine running FengSui (IsLocalDevice), so this change cannot be checked against cutting it off; nothing was written"
    );
  }
  return accessGuardFromHosts(hosts, ctx.requesterIp);
}

/** Changes that only let devices back on: unblock, filter off. */
function restoresAccessOnly(change: WifiAccessChange): boolean {
  return change.kind === "unblock" || (change.kind === "mode" && change.mode === "off");
}

function asValidationError(err: unknown): unknown {
  return err instanceof AccessPlanError ? new CpeControlValidationError(err.message) : err;
}

/** Read the Wi-Fi MAC filter and the internet time rules in one session (3 GETs). */
export async function fetchAccessControl(session: EphemeralCpeSession): Promise<AccessControlSnapshot> {
  const [exXml, featureXml, timeXml] = await Promise.all([
    session.get(WIFI_FILTER_READ),
    optionalGet(session, WIFI_FEATURES),
    optionalGet(session, TIME_RULES),
  ]);
  const nowMs = Date.now();
  return {
    capturedAtIso: new Date(nowMs).toISOString(),
    capturedAtMs: nowMs,
    wifiMacFilter: parseWifiMacFilter(exXml, featureXml).state,
    timeRules: parseTimeRules(timeXml),
  };
}

/**
 * Apply one Wi-Fi access change: plan it against the live state and hosts, write SSID 0, and verify
 * the router now reports the planned switch, policy and list. `plan.write === null` means nothing
 * needed to change and nothing was written.
 */
export async function applyWifiAccessChange(
  session: EphemeralCpeSession,
  change: WifiAccessChange,
  ctx: AccessRequestContext
): Promise<{ wifiMacFilter: WifiMacFilterState; plan: WifiFilterPlan }> {
  const guard = await readGuard(session, ctx, !restoresAccessOnly(change));
  const [exXml, featureXml] = await Promise.all([session.get(WIFI_FILTER_READ), optionalGet(session, WIFI_FEATURES)]);
  const current = parseWifiMacFilter(exXml, featureXml);
  let plan: WifiFilterPlan;
  try {
    plan = planWifiAccessChange(current.state, change, guard);
  } catch (err) {
    throw asValidationError(err);
  }
  if (!plan.write) return { wifiMacFilter: current.state, plan };

  const listPolicy = plan.write.status === "1" || (plan.write.status === "0" && current.state.policy === "allow") ? "allow" : "deny";
  await session.postXml(WIFI_FILTER_WRITE, buildWifiMacFilterRequest(plan.write, current.slots[listPolicy]));

  const after = parseWifiMacFilter(await session.get(WIFI_FILTER_READ), featureXml).state;
  const list = listPolicy === "allow" ? after.allowList : after.denyList;
  const applied =
    after.enabled === plan.expected.enabled &&
    (!after.enabled || after.policy === plan.expected.policy) &&
    list.map((e) => e.macAddress).join(",") === plan.write.entries.map((e) => e.macAddress).join(",");
  if (!applied) {
    throw new Error("The router acknowledged the Wi-Fi MAC filter change but did not apply it (read-back differs)");
  }
  return { wifiMacFilter: after, plan };
}

function sameRule(rule: TimeRule, write: TimeRuleWrite): boolean {
  return (
    rule.enabled === write.enabled &&
    rule.weekMask === write.weekMask &&
    rule.startTime === write.startTime &&
    rule.endTime === write.endTime &&
    rule.devices.map((d) => d.macAddress).join(",") === write.devices.map((d) => d.macAddress).join(",")
  );
}

/** Create, update or delete one internet time rule and verify the router's table afterwards. */
export async function applyTimeRuleChange(
  session: EphemeralCpeSession,
  change: TimeRuleChange,
  ctx: AccessRequestContext
): Promise<TimeRulesState> {
  const guard = await readGuard(session, ctx, change.kind !== "delete");
  const current = parseTimeRules(await session.get(TIME_RULES));
  if (!current.supported) throw new CpeControlValidationError("This firmware does not offer internet time rules");
  let write: TimeRuleWrite;
  try {
    write = planTimeRuleChange(current.rules, current.maxRules, change, guard);
  } catch (err) {
    throw asValidationError(err);
  }
  await session.postXml(TIME_RULES, buildTimeRuleRequest(write));

  const after = parseTimeRules(await session.get(TIME_RULES));
  const known = new Set(current.rules.map((r) => r.id));
  const applied =
    write.action === "delete"
      ? !after.rules.some((r) => r.id === write.id)
      : write.action === "update"
        ? after.rules.some((r) => r.id === write.id && sameRule(r, write))
        : after.rules.some((r) => !known.has(r.id) && sameRule(r, write));
  if (!applied) {
    throw new Error(`The router acknowledged the internet time rule ${write.action} but did not apply it (read-back differs)`);
  }
  return after;
}
