/**
 * Data-usage thresholds for the daily / monthly rings. The router's own monthly limit
 * (`DataLimit`, e.g. `100GB`; `0MB` = none) is the default; the user can set browser-local caps.
 */

export type UsageLevel = "none" | "ok" | "warn" | "over";

/** Share of the cap at which a ring turns amber. */
export const USAGE_WARN_RATIO = 0.8;

const UNIT_BYTES: Readonly<Record<string, number>> = {
  B: 1,
  KB: 1024,
  K: 1024,
  KIB: 1024,
  MB: 1024 ** 2,
  M: 1024 ** 2,
  MIB: 1024 ** 2,
  GB: 1024 ** 3,
  G: 1024 ** 3,
  GIB: 1024 ** 3,
  TB: 1024 ** 4,
  T: 1024 ** 4,
  TIB: 1024 ** 4,
};

/** Parse `100GB`, `1.5 TB`, `500 MiB` (binary units, like the router); `null` for empty, zero or invalid. */
export function parseByteSize(raw: string): number | null {
  const match = /^\s*(\d+(?:\.\d+)?)\s*([a-zA-Z]{0,3})\s*$/.exec(raw);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = (match[2] || "GB").toUpperCase();
  const factor = UNIT_BYTES[unit];
  if (factor === undefined || !Number.isFinite(amount) || amount <= 0) return null;
  return Math.round(amount * factor);
}

/** The router's monthly plan limit, or `null` when it is unset (`0MB`). */
export function routerMonthlyCapBytes(dataLimitRaw: string): number | null {
  return parseByteSize(dataLimitRaw);
}

export function usageRatio(usedBytes: number, capBytes: number | null): number | null {
  if (capBytes === null || capBytes <= 0 || !Number.isFinite(usedBytes)) return null;
  return Math.max(0, usedBytes / capBytes);
}

export function usageLevel(ratio: number | null, warnRatio = USAGE_WARN_RATIO): UsageLevel {
  if (ratio === null) return "none";
  if (ratio >= 1) return "over";
  if (ratio >= warnRatio) return "warn";
  return "ok";
}
