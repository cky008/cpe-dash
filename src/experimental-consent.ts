import type { ConsoleSettings } from "./console-settings.ts";
import { type DeviceAccess, WRITE_FEATURES, type WriteFeature, type WriteFeatureState } from "./device-access.ts";
import type { ExperimentalFeature } from "./device-profile.ts";

export type ExperimentalConsentResult =
  | { ok: true; detail: string }
  | { ok: false; errorCode: "VALIDATION_ERROR"; message: string; detail: string | null }
  | { ok: false; errorCode: "EXPERIMENTAL_UNAVAILABLE"; message: string; detail: string; state: WriteFeatureState };

/**
 * Turn one experimental write on or off (multi-model phase 3), for the console and for AI agents
 * alike. On needs the feature to be offered on this router (a generic implementation and the
 * probe's evidence) and the router's model typed back, so a consent always names the model seen;
 * off always works. The write gate sees the change at once; the caller audits `detail`. No
 * dependencies beyond the parts it uses: the online demo turns its writes on and off with it too.
 */
export function changeExperimentalConsent(
  settings: Pick<ConsoleSettings, "experimentalConsents" | "grantExperimental" | "revokeExperimental">,
  device: Pick<DeviceAccess, "current" | "setConsents" | "snapshot" | "writeState">,
  request: { feature: unknown; enabled: unknown; model?: unknown }
): ExperimentalConsentResult {
  const { feature, enabled } = request;
  if (typeof feature !== "string" || !(WRITE_FEATURES as ReadonlyArray<string>).includes(feature)) {
    return { ok: false, errorCode: "VALIDATION_ERROR", message: `"feature" must be one of ${WRITE_FEATURES.join(", ")}`, detail: null };
  }
  if (typeof enabled !== "boolean") return { ok: false, errorCode: "VALIDATION_ERROR", message: '"enabled" must be true or false', detail: null };
  if (!enabled) {
    const was = settings.revokeExperimental(feature);
    device.setConsents(settings.experimentalConsents);
    return { ok: true, detail: `${feature} off${was ? "" : " (was off)"}` };
  }
  const state = device.writeState(feature as WriteFeature);
  const model = device.snapshot().model;
  if (state !== "available" && state !== "consented") {
    return { ok: false, errorCode: "EXPERIMENTAL_UNAVAILABLE", message: `${feature} cannot be turned on as an experimental write on this router (${state})`, detail: `${feature} on: ${state}`, state };
  }
  const typed = typeof request.model === "string" && request.model.length <= 256 ? request.model.trim().toLowerCase() : "";
  const current = device.current?.model;
  if (!current || !model || model === "?" || typed !== model.toLowerCase()) {
    return { ok: false, errorCode: "VALIDATION_ERROR", message: `Type the router's model (${model ?? "?"}) to confirm the experimental ${feature} write`, detail: `${feature} on: model not confirmed` };
  }
  settings.grantExperimental(current, feature as ExperimentalFeature);
  device.setConsents(settings.experimentalConsents);
  return { ok: true, detail: `${feature} on for ${model}` };
}
