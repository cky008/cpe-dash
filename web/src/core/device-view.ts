import type { DeviceFeature, DeviceIdentity, DeviceProfile, DeviceReport, EndpointProbe, EndpointState, ProbeOrigin, ReadSection, ReadState, WriteAccess } from "../../../src/api-contract.ts";
import type { SettingsTextKey } from "../i18n/settings.ts";
import { type NoticeTone, schemeText } from "./console-view.ts";
import { formatAgo } from "./format.ts";
import type { Locale } from "./i18n.ts";

/**
 * What the settings dialog's Device tab decides without the DOM: the verification notice, how the
 * login, the time of identification and each state read, and the device report's file.
 */

type Text = (key: SettingsTextKey, params?: Record<string, string | number>) => string;

export const FEATURE_KEYS: Readonly<Record<DeviceFeature, SettingsTextKey>> = {
  telemetry: "feature_telemetry",
  neighbors: "feature_neighbors",
  topology: "feature_topology",
  smsRead: "feature_sms_read",
  smsWrite: "feature_sms_write",
  bandLock: "feature_band_lock",
  cellLock: "feature_cell_lock",
  reboot: "feature_reboot",
  reconnect: "feature_reconnect",
  mobileData: "feature_mobile_data",
  securitySwitches: "feature_security",
  wifi: "feature_wifi",
  antenna: "feature_antenna",
  accessControl: "feature_access",
};

export const STATE_KEYS: Readonly<Record<EndpointState, SettingsTextKey>> = {
  supported: "state_supported",
  unsupported: "state_unsupported",
  restricted: "state_restricted",
  unknown: "state_unknown",
};

/** The read sections, in the order the Device tab lists them. */
export const SECTION_KEYS: Readonly<Record<ReadSection, SettingsTextKey>> = {
  telemetry: "section_telemetry",
  neighbors: "section_neighbors",
  topology: "section_topology",
  settings: "section_settings",
  accessControl: "section_access",
  sms: "section_sms",
};

export const READ_STATE_KEYS: Readonly<Record<ReadState, SettingsTextKey>> = {
  verified: "read_verified",
  available: "read_available",
  unavailable: "read_unavailable",
  unknown: "read_unknown",
};

export const WRITES_KEYS: Readonly<Record<WriteAccess, SettingsTextKey>> = {
  allowed: "access_writes_allowed",
  read_only: "access_writes_locked",
  unknown: "access_writes_unknown",
};

/** A read section's state, with the router's code when it answered without it. */
export function readText(read: { state: ReadState; code: string | null }, t: Text): string {
  const state = t(READ_STATE_KEYS[read.state]);
  return read.code ? `${state} · ${read.code}` : state;
}

const ORIGIN_KEYS: Readonly<Record<ProbeOrigin, SettingsTextKey>> = {
  startup: "origin_startup",
  "connection-test": "origin_connection_test",
};

/** The notice the tab opens with, from the profile's verification (`null`: not identified yet). */
export function verificationNotice(
  profile: DeviceProfile | null,
  verified: ReadonlyArray<{ model: string; softwareVersion: string }>
): { key: SettingsTextKey; params: Record<string, string>; tone: NoticeTone } {
  if (!profile) return { key: "device_none", params: {}, tone: "info" };
  const model = profile.identity.model ?? "?";
  const firmware = profile.identity.softwareVersion ?? "?";
  const verifiedLabel = verified.map((entry) => `${entry.model} ${entry.softwareVersion}`).join(", ");
  switch (profile.verification) {
    case "verified":
      return { key: "verification_verified", params: { model, firmware }, tone: "success" };
    case "new-firmware":
      return { key: "verification_new_firmware", params: { model, firmware, verified: verifiedLabel }, tone: "pending" };
    case "unverified-model":
      return { key: "verification_unverified_model", params: { model, verified: verifiedLabel }, tone: "pending" };
    default:
      return { key: "verification_unknown", params: {}, tone: "info" };
  }
}

/** The login scheme, with the `password_type` the router reported. */
export function loginText(identity: DeviceIdentity, t: Text): string {
  const scheme = schemeText(identity.loginScheme, t);
  return identity.passwordType === null ? scheme : t("login_with_type", { scheme, type: identity.passwordType });
}

/** When the router was identified, and whether at the daemon's start or in a connection test. */
export function detectedText(profile: DeviceProfile, nowMs: number, locale: Locale, t: Text): string {
  return t("detected_at", { when: formatAgo(Date.parse(profile.identity.detectedAtIso), nowMs, locale), origin: t(ORIGIN_KEYS[profile.origin]) });
}

/** An endpoint's state, with the router's error code when it gave one. */
export function endpointText(endpoint: EndpointProbe, t: Text): string {
  const state = t(STATE_KEYS[endpoint.state]);
  return endpoint.code ? `${state} · ${endpoint.code}` : state;
}

/** `B1 B3 B20`, or `null` when the router listed none. */
export function bandText(bands: ReadonlyArray<number> | null): string | null {
  return bands && bands.length > 0 ? bands.map((band) => `B${band}`).join(" ") : null;
}

/** `fengsui-device-report-<model>-<UTC time>.json`; the model keeps only file-safe characters. */
export function reportFileName(report: DeviceReport): string {
  const model = (report.identity?.model ?? "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
  const stamp = report.generatedAtIso.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `fengsui-device-report-${model}-${stamp}.json`;
}

/** The report as the file holds it (and the clipboard gets it): indented JSON. */
export function reportJson(report: DeviceReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
