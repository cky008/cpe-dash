import { isIP } from "node:net";
import type { AccessControlSnapshot } from "./access-control.ts";
import type { MacFilterEntry } from "./access-plan.ts";
import type { AuditEntry } from "./audit-log.ts";
import type { GlobalTelemetrySnapshot, TerminalTopologySnapshot } from "./cpe-domain.ts";
import {
  ICCID_VISIBLE_DIGITS,
  IMEI_VISIBLE_DIGITS,
  IMSI_VISIBLE_DIGITS,
  maskIdentityDigits,
  maskIpAddress,
  maskMacTail,
  maskPhoneNumber,
} from "./privacy-mask.ts";

/**
 * REDACT_SENSITIVE_IN_API at the output boundary. The daemon keeps plain snapshots (encrypted at
 * rest) and the logged-in web console receives them, masked on screen until revealed; Bearer REST /
 * SSE clients and MCP agents receive these redacted copies instead. Every mask reads as a mask
 * (`*` or `<REDACTED>`), never as a plausible value a reader could take for the real one.
 */

/** Stands in for values with no anonymous part: TAC, Cell ID, eNodeB ID and LAN client names. */
export const REDACTED = "<REDACTED>";

function redactWhole(value: string): string {
  return value ? REDACTED : "";
}

/** Redacted copy of a telemetry snapshot; the input is never modified. */
export function redactTelemetry(snap: GlobalTelemetrySnapshot): GlobalTelemetrySnapshot {
  const { device, rf } = snap;
  // Masking twice would also star the prefixes a mask keeps (IMEI TAC, IMSI operator, MAC OUI)
  if (device.sensitiveRedacted) return snap;
  return {
    ...snap,
    device: {
      ...device,
      wanIpv4: maskIpAddress(device.wanIpv4),
      wanDnsV4: device.wanDnsV4.map(maskIpAddress),
      wanIpv6: maskIpAddress(device.wanIpv6),
      wanDnsV6: device.wanDnsV6.map(maskIpAddress),
      imei: maskIdentityDigits(device.imei, IMEI_VISIBLE_DIGITS),
      imsi: maskIdentityDigits(device.imsi, IMSI_VISIBLE_DIGITS),
      msisdn: maskPhoneNumber(device.msisdn),
      macAddress: maskMacTail(device.macAddress),
      iccid: maskIdentityDigits(device.iccid, ICCID_VISIBLE_DIGITS),
      sensitiveRedacted: true,
    },
    rf: {
      ...rf,
      cellIdDisplay: redactWhole(rf.cellIdDisplay),
      eNodeBDisplay: redactWhole(rf.eNodeBDisplay),
      tacDisplay: redactWhole(rf.tacDisplay),
    },
  };
}

/**
 * Redacted copy of the LAN topology: client names, MAC tails and IPv6 addresses (global ones carry
 * the subscriber prefix) are hidden; LAN IPv4 addresses stay, so clients remain distinguishable.
 */
export function redactTopology(snap: TerminalTopologySnapshot): TerminalTopologySnapshot {
  return {
    ...snap,
    hosts: snap.hosts.map((host) => ({
      ...host,
      displayName: REDACTED,
      macAddress: maskMacTail(host.macAddress),
      ipv6Addresses: host.ipv6Addresses.map(maskIpAddress),
    })),
  };
}

/** Redacted copy of the Wi-Fi MAC filter lists and time rules: MACs keep their OUI, labels are hidden. */
export function redactAccessControl(snap: AccessControlSnapshot): AccessControlSnapshot {
  const entry = (e: MacFilterEntry): MacFilterEntry => ({ macAddress: maskMacTail(e.macAddress), name: redactWhole(e.name) });
  return {
    ...snap,
    wifiMacFilter: {
      ...snap.wifiMacFilter,
      allowList: snap.wifiMacFilter.allowList.map(entry),
      denyList: snap.wifiMacFilter.denyList.map(entry),
    },
    timeRules: { ...snap.timeRules, rules: snap.timeRules.rules.map((rule) => ({ ...rule, devices: rule.devices.map(entry) })) },
  };
}

/** The snapshot for one response: as stored for the web console, redacted for API / MCP clients. */
export function telemetryForOutput(snap: GlobalTelemetrySnapshot | null, redact: boolean): GlobalTelemetrySnapshot | null {
  return snap && redact ? redactTelemetry(snap) : snap;
}

/** See {@link telemetryForOutput}. */
export function topologyForOutput(snap: TerminalTopologySnapshot | null, redact: boolean): TerminalTopologySnapshot | null {
  return snap && redact ? redactTopology(snap) : snap;
}

/** An address in an audit detail, alone or as `host:port` / `[v6]:port`, masked like the snapshots. */
function maskAddressWord(word: string): string {
  if (isIP(word)) return maskIpAddress(word);
  const v4 = /^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/.exec(word);
  if (v4?.[1] && isIP(v4[1])) return `${maskIpAddress(v4[1])}:${v4[2] ?? ""}`;
  const v6 = /^\[([0-9a-fA-F:.]{2,45})\](:\d{1,5})?$/.exec(word);
  if (v6?.[1] && isIP(v6[1])) return `[${maskIpAddress(v6[1])}]${v6[2] ?? ""}`;
  return word;
}

/** Audit entries for one response: Bearer readers get the addresses in each detail (where a sign-in came from) masked. */
export function auditForOutput(entries: AuditEntry[], redact: boolean): AuditEntry[] {
  if (!redact) return entries;
  return entries.map((entry) => (entry.detail ? { ...entry, detail: entry.detail.split(" ").map(maskAddressWord).join(" ") } : entry));
}

/** See {@link telemetryForOutput}. */
export function accessControlForOutput(snap: AccessControlSnapshot | null, redact: boolean): AccessControlSnapshot | null {
  return snap && redact ? redactAccessControl(snap) : snap;
}
