import type { Locale } from "./i18n.ts";

/**
 * Number, unit and time formatting. Rates and sizes use the same binary (1024) steps as the
 * daemon's `downloadRateFormatted` / `todayUsedFormatted`, so chart axes agree with the cards.
 */

export const DASH = "—";

export interface ScaledValue {
  value: string;
  unit: string;
}

const RATE_UNITS = ["bps", "Kbps", "Mbps", "Gbps"] as const;
const BYTE_UNITS = ["B", "KiB", "MiB", "GiB", "TiB"] as const;

function scaleBinary(amount: number, units: ReadonlyArray<string>, fractionDigits: (scaled: number) => number): ScaledValue {
  let scaled = Number.isFinite(amount) ? Math.max(0, amount) : 0;
  let index = 0;
  while (scaled >= 1024 && index < units.length - 1) {
    scaled /= 1024;
    index += 1;
  }
  const digits = index === 0 ? 0 : fractionDigits(scaled);
  return { value: scaled.toFixed(digits), unit: units[index] ?? units[0] ?? "" };
}

/** Throughput in bits per second (`12.4 Mbps`), three significant digits. */
export function formatBitRate(bps: number): ScaledValue {
  return scaleBinary(bps, RATE_UNITS, (v) => (v >= 100 ? 0 : v >= 10 ? 1 : 2));
}

export function formatBytes(bytes: number): ScaledValue {
  return scaleBinary(bytes, BYTE_UNITS, (v) => (v >= 100 ? 1 : 2));
}

export function joinScaled(value: ScaledValue): string {
  return `${value.value} ${value.unit}`;
}

/** Megabits per second (binary, like the daemon) for chart axes. */
export function toMbps(bps: number): number {
  return bps / (1024 * 1024);
}

/** `-87 dBm`, `13.5 dB`; `—` for null. */
export function formatSigned(value: number | null | undefined, unit: string, digits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
  return `${value.toFixed(digits)} ${unit}`;
}

/** Whole duration as the two largest units (`3d 4h`, `5h 12m`, `42s`; `3天 4小时` in Chinese). */
export function formatDuration(totalSec: number, locale: Locale): string {
  const sec = Math.max(0, Math.floor(Number.isFinite(totalSec) ? totalSec : 0));
  const parts: Array<[number, string, string]> = [
    [Math.floor(sec / 86_400), "天", "d"],
    [Math.floor((sec % 86_400) / 3600), "小时", "h"],
    [Math.floor((sec % 3600) / 60), "分", "m"],
    [sec % 60, "秒", "s"],
  ];
  const first = parts.findIndex(([n]) => n > 0);
  if (first < 0) return locale === "zh-CN" ? "0秒" : "0s";
  return parts
    .slice(first, first + 2)
    .filter(([n]) => n > 0)
    .map(([n, zh, en]) => (locale === "zh-CN" ? `${n}${zh}` : `${n}${en}`))
    .join(" ");
}

/** `HH:MM:SS` countdown, with a day prefix past 24 h (`2d 03:14:07`). */
export function formatCountdown(totalSec: number): string {
  const sec = Math.max(0, Math.floor(Number.isFinite(totalSec) ? totalSec : 0));
  const days = Math.floor(sec / 86_400);
  const pad = (n: number): string => String(n).padStart(2, "0");
  const clock = `${pad(Math.floor((sec % 86_400) / 3600))}:${pad(Math.floor((sec % 3600) / 60))}:${pad(sec % 60)}`;
  return days > 0 ? `${days}d ${clock}` : clock;
}

/** Coarse "x ago" for freshness labels. */
export function formatAgo(fromMs: number, nowMs: number, locale: Locale): string {
  const sec = Math.max(0, Math.round((nowMs - fromMs) / 1000));
  const zh = locale === "zh-CN";
  if (sec < 5) return zh ? "刚刚" : "just now";
  if (sec < 60) return zh ? `${sec} 秒前` : `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return zh ? `${min} 分钟前` : `${min}m ago`;
  const hours = Math.floor(min / 60);
  if (hours < 48) return zh ? `${hours} 小时前` : `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return zh ? `${days} 天前` : `${days}d ago`;
}

/** Local `HH:MM` or `MM-DD HH:MM` (spans beyond a day) for chart axes and tooltips. */
export function formatClock(ms: number, withDate: boolean): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, "0");
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return withDate ? `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}` : time;
}

/** Value for an `<input type="datetime-local">` in local time. */
export function toDateTimeLocalValue(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Parse an `<input type="datetime-local">` value as local time; `null` when empty or invalid. */
export function parseDateTimeLocalValue(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const [, y, mo, d, h, mi] = match.map(Number);
  const ms = new Date(y ?? 0, (mo ?? 1) - 1, d ?? 1, h ?? 0, mi ?? 0).getTime();
  return Number.isFinite(ms) ? ms : null;
}
