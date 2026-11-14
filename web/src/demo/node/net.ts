/**
 * `isIP` from `node:net` for the live demo's bundle (scripts/build-web.ts puts this in place of it):
 * the address checks of redaction, access control and the HiLink reads. `BlockList` (trusted proxies,
 * read only by the HTTP server, which the demo does not run) is not here.
 */

const DECIMAL_OCTET = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const HEX_GROUP = /^[0-9a-fA-F]{1,4}$/;

export function isIPv4(input: string): boolean {
  const parts = input.split(".");
  return parts.length === 4 && parts.every((part) => DECIMAL_OCTET.test(part));
}

export function isIPv6(input: string): boolean {
  // A zone ("fe80::1%eth0") names an interface, as Node takes it
  const zoneAt = input.indexOf("%");
  const address = zoneAt >= 0 ? input.slice(0, zoneAt) : input;
  if (zoneAt >= 0 && zoneAt === input.length - 1) return false;
  if (address.length === 0 || address.length > 45) return false;
  const halves = address.split("::");
  if (halves.length > 2) return false;
  const groups = (half: string): string[] | null => (half === "" ? [] : half.split(":"));
  const head = groups(halves[0] ?? "");
  const tail = halves.length === 2 ? groups(halves[1] ?? "") : [];
  if (head === null || tail === null) return false;
  const all = [...head, ...tail];
  // A dotted IPv4 address may stand for the last two groups
  const last = all[all.length - 1];
  let count = all.length;
  if (last !== undefined && last.includes(".")) {
    if (!isIPv4(last)) return false;
    all.pop();
    count += 1;
  }
  if (!all.every((group) => HEX_GROUP.test(group))) return false;
  return halves.length === 2 ? count <= 7 : count === 8;
}

export function isIP(input: string): 0 | 4 | 6 {
  if (isIPv4(input)) return 4;
  if (isIPv6(input)) return 6;
  return 0;
}

export class BlockList {
  constructor() {
    throw new Error("net.BlockList is not available in the demo");
  }
}

export default { BlockList, isIP, isIPv4, isIPv6 };
