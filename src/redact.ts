import type { AccessControlSnapshot } from "./access-control.ts";
import type { MacFilterEntry } from "./access-plan.ts";
import type { GlobalTelemetrySnapshot, TerminalTopologySnapshot } from "./cpe-domain.ts";
import {
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

/** See {@link telemetryForOutput}. */
export function accessControlForOutput(snap: AccessControlSnapshot | null, redact: boolean): AccessControlSnapshot | null {
  return snap && redact ? redactAccessControl(snap) : snap;
}
