import type { ConsoleSettings } from "./console-settings.ts";
import { type DeviceAccess, type WriteFeatureState } from "./device-access.ts";
import { WRITE_FEATURES, type WriteFeature } from "./features.ts";

export type ExperimentalSwitchResult =
  | { ok: true; detail: string }
  | { ok: false; errorCode: "VALIDATION_ERROR"; message: string; detail: null }
  | { ok: false; errorCode: "EXPERIMENTAL_UNAVAILABLE"; message: string; detail: string; state: WriteFeatureState };

/**
 * Turn one experimental write off, or back on, for the console and for AI agents alike. On a model
 * nobody verified, the writes FengSui implements for the router are on by default; this is the
 * switch per write, kept for the model it was turned off on. Only a write that is open there or was
 * turned off has one: a write FengSui does not implement for this router, or one the router lacks
 * what it needs for, stays refused whatever is asked, and a verified model has no switches. The
 * write gate sees the change at once; the caller audits `detail`. No dependencies beyond the parts
 * it uses: the online demo turns its writes off and on with it too.
 */
export function switchExperimentalWrite(
  settings: Pick<ConsoleSettings, "disabledWrites" | "disableWrite" | "enableWrite">,
  device: Pick<DeviceAccess, "current" | "setDisabledWrites" | "snapshot" | "writeState" | "writes">,
  request: { feature: unknown; enabled: unknown }
): ExperimentalSwitchResult {
  const { feature, enabled } = request;
  if (typeof feature !== "string" || !(WRITE_FEATURES as ReadonlyArray<string>).includes(feature)) {
    return { ok: false, errorCode: "VALIDATION_ERROR", message: `"feature" must be one of ${WRITE_FEATURES.join(", ")}`, detail: null };
  }
  if (typeof enabled !== "boolean") return { ok: false, errorCode: "VALIDATION_ERROR", message: '"enabled" must be true or false', detail: null };
  const state = device.writeState(feature as WriteFeature);
  const current = device.current?.model;
  const switchable = device.writes === "experimental" && (state === "enabled" || state === "disabled" || state === "verified");
  if (!current || !switchable) {
    return { ok: false, errorCode: "EXPERIMENTAL_UNAVAILABLE", message: `${feature} has no switch on this router (${state})`, detail: `${feature} ${enabled ? "on" : "off"}: ${state}`, state };
  }
  const model = device.snapshot().model ?? "?";
  const changed = enabled ? settings.enableWrite(current, feature) : settings.disableWrite(current, feature as WriteFeature);
  device.setDisabledWrites(settings.disabledWrites);
  return { ok: true, detail: `${feature} ${enabled ? "on" : "off"} for ${model}${changed ? "" : enabled ? " (was on)" : " (was off)"}` };
}
