/**
 * Byte and bit-rate formatting of the traffic DTO, shared by the daemon and the browser demo. Zero
 * runtime dependencies (no Node built-in).
 */

/**
 * Format byte count into human-readable IEC binary units (`B`, `KiB`, `MiB`, `GiB`, `TiB`).
 */
export function formatBytesBinary(bytes: bigint | number): string {
  const b = typeof bytes === "bigint" ? Number(bytes) : bytes;
  if (!Number.isFinite(b) || b < 1024) return `${Math.max(0, Math.trunc(b))} B`;
  const kib = b / 1024;
  if (kib < 1024) return `${kib.toFixed(2)} KiB`;
  const mib = kib / 1024;
  if (mib < 1024) return `${mib.toFixed(2)} MiB`;
  const gib = mib / 1024;
  if (gib < 1024) return `${gib.toFixed(2)} GiB`;
  const tib = gib / 1024;
  return `${tib.toFixed(2)} TiB`;
}

/**
 * Format bit-per-second throughput matching Huawei WebUI binary scaling (`bps`, `Kbps`, `Mbps`, `Gbps`).
 */
export function formatRateBitsPerSec(bps: number): string {
  if (!Number.isFinite(bps) || bps < 1024) return `${Math.max(0, bps).toFixed(2)} bps`;
  const kbps = bps / 1024;
  if (kbps < 1024) return `${kbps.toFixed(2)} Kbps`;
  const mbps = kbps / 1024;
  if (mbps < 1024) return `${mbps.toFixed(2)} Mbps`;
  const gbps = mbps / 1024;
  return `${gbps.toFixed(2)} Gbps`;
}
