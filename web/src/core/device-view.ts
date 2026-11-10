import type {
  DeviceFeature,
  DeviceIdentity,
  DeviceProfile,
  DeviceReport,
  EndpointProbe,
  EndpointState,
  ProbeOrigin,
  ReadSection,
  ReadState,
  ReadbackOutcome,
  ReadbackReason,
  WriteAccess,
  WriteFeatureState,
  WriteResultRecord,
} from "../../../src/api-contract.ts";
import { deviceIssueUrl } from "../../../src/feedback.ts";
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

/** Whether FengSui writes to this router; on a model nobody verified, by how many writes are open there. */
export function writesText(writes: WriteAccess, open: number, t: Text): string {
  if (writes === "allowed") return t("access_writes_allowed");
  if (writes === "unknown") return t("access_writes_unknown");
  return open > 0 ? t("access_writes_experimental", { count: open }) : t("access_writes_none");
}

/** What each write is on a model nobody verified, as the experimental writes list names it. */
export const WRITE_STATE_KEYS: Readonly<Record<WriteFeatureState, SettingsTextKey>> = {
  verified: "exp_state_verified",
  enabled: "exp_state_enabled",
  disabled: "exp_state_disabled",
  unsupported: "exp_state_unsupported",
  not_implemented: "exp_state_not_implemented",
  unknown: "exp_state_unknown",
};

export const READBACK_KEYS: Readonly<Record<ReadbackOutcome, SettingsTextKey>> = {
  match: "exp_readback_match",
  mismatch: "exp_readback_mismatch",
  unknown: "exp_readback_unknown",
  pending: "exp_readback_pending",
  none: "exp_readback_none",
};

export const REASON_KEYS: Readonly<Record<ReadbackReason, SettingsTextKey>> = {
  differs: "exp_reason_differs",
  unreadable: "exp_reason_unreadable",
  send_failed: "exp_reason_send_failed",
  send_unconfirmed: "exp_reason_send_unconfirmed",
  no_change: "exp_reason_no_change",
  unclear_change: "exp_reason_unclear_change",
  no_restart: "exp_reason_no_restart",
  no_evidence: "exp_reason_no_evidence",
};

/**
 * What a write's switch covers beyond its own name, as the gate files the actions under it: every
 * SMS write (send, mark read, delete), and the unlock or redial FengSui does on its own (R3-11).
 * Shown under the switch, so turning one off is an informed choice too. `null`: nothing more to say.
 */
const SWITCH_SCOPE_KEYS: Readonly<Partial<Record<DeviceFeature, SettingsTextKey>>> = {
  bandLock: "exp_scope_bandLock",
  cellLock: "exp_scope_cellLock",
  reboot: "exp_scope_reboot",
  reconnect: "exp_scope_reconnect",
  smsWrite: "exp_scope_smsWrite",
};

export function switchScope(feature: DeviceFeature, t: Text): string | null {
  const key = SWITCH_SCOPE_KEYS[feature];
  return key ? t(key) : null;
}

/** One write result's detail line: when, the endpoints it posted to, the router's code and why the read-back was not a match. */
export function writeResultDetail(result: WriteResultRecord, nowMs: number, locale: Locale, t: Text): string {
  return [
    formatAgo(Date.parse(result.atIso), nowMs, locale),
    result.endpoints.map((endpoint) => `POST ${endpoint}`).join(", "),
    result.code ? t("exp_code", { code: result.code }) : "",
    result.reason ? t(REASON_KEYS[result.reason]) : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

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

/** The new issue to file the report on, or `null` in the static demo: its report is the demo router's. */
export function reportIssueLink(report: DeviceReport, demo: boolean): string | null {
  return demo ? null : deviceIssueUrl(report.identity);
}
