/**
 * sRGB helpers for the user-picked colours of the custom theme and accent (`<input type="color">`
 * values): validation, WCAG contrast, and which text colour reads on a given fill.
 */

/** Text colours put on a user-picked fill. */
export const LIGHT_TEXT = "#ffffff";
export const DARK_TEXT = "#15171a";

/** `#rrggbb` in lower case, or `null` for anything else (named colours, `#rgb`, alpha). */
export function normalizeHex(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const match = /^#?([0-9a-f]{6})$/i.exec(raw.trim());
  return match?.[1] ? `#${match[1].toLowerCase()}` : null;
}

function linear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2 relative luminance of a `#rrggbb` colour (0 black … 1 white). */
export function relativeLuminance(hex: string): number {
  const value = normalizeHex(hex);
  if (!value) return 0;
  const n = Number.parseInt(value.slice(1), 16);
  return 0.2126 * linear((n >> 16) & 255) + 0.7152 * linear((n >> 8) & 255) + 0.0722 * linear(n & 255);
}

/** WCAG 2 contrast ratio (1 … 21). */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** White or near-black text, whichever contrasts more with `fill`. */
export function readableOn(fill: string): string {
  return contrastRatio(fill, LIGHT_TEXT) >= contrastRatio(fill, DARK_TEXT) ? LIGHT_TEXT : DARK_TEXT;
}
