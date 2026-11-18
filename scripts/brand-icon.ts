import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { type MarkRole, readBrandMark } from "./brand.ts";

/**
 * `npm run brand:icon`: the Claude Desktop extension's icons, drawn from the master logo (web/brand/logo.svg, see
 * docs/dev/brand.md) with no dependency. The MCP Bundle format wants a PNG; Claude's guidance asks for 512×512 with
 * transparency. Two files: the master's light colours (`theme: "light"` in the manifest, and its `icon`) and the
 * colours of its `(prefers-color-scheme: dark)` block, the same pair the favicon switches between.
 *
 * The drawing is plain arithmetic (no browser, no font, no platform library), so it gives the same pixels on every
 * machine: test/brand.test.ts redraws both icons from the master and compares them with the committed files pixel
 * for pixel, so a changed logo fails the gate until this is run again.
 */

export const ICON_SIZE = 512;
export const ICON_FILES = { light: "mcpb/icon.png", dark: "mcpb/icon-dark.png" } as const;
export type IconTheme = keyof typeof ICON_FILES;
export type Rgb = readonly [number, number, number];
type Pt = [number, number];

/** The master's view box is 0 0 100 100 (readBrandMark checks it). */
const VIEW_BOX = 100;
/** Sub-rows per pixel row; horizontal coverage is exact. */
const SUBSAMPLES = 16;

/** The fill of `.main` / `.echo` in the master's `<style>`: the rules before its dark block, and those inside it. */
export function markColours(svg: string): Record<IconTheme, Partial<Record<MarkRole, Rgb>>> {
  const style = /<style>([\s\S]*?)<\/style>/.exec(svg)?.[1] ?? "";
  const media = /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{/.exec(style);
  if (!media) throw new Error("the logo's <style> needs a (prefers-color-scheme: dark) block for the dark icon");
  const read = (css: string): Partial<Record<MarkRole, Rgb>> => {
    const colours: Partial<Record<MarkRole, Rgb>> = {};
    for (const [, role, hex] of css.matchAll(/\.(main|echo)\s*\{\s*fill:\s*#([0-9a-fA-F]{6})\s*;?\s*\}/g)) {
      const n = Number.parseInt(hex ?? "", 16);
      colours[role as MarkRole] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }
    return colours;
  };
  return { light: read(style.slice(0, media.index)), dark: read(style.slice(media.index + media[0].length)) };
}

/** Points along a quadratic or cubic Bézier (the end point included, the start not), enough to look smooth at 512 px. */
function curvePoints(p: ReadonlyArray<Pt>): Pt[] {
  let span = 0;
  for (let i = 1; i < p.length; i++) {
    const a = p[i - 1] as Pt;
    const b = p[i] as Pt;
    span += Math.sqrt((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2);
  }
  const steps = Math.min(256, Math.max(8, Math.ceil(span * 2)));
  const out: Pt[] = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    if (p.length === 3) {
      const [a, b, c] = p as [Pt, Pt, Pt];
      out.push([u * u * a[0] + 2 * u * t * b[0] + t * t * c[0], u * u * a[1] + 2 * u * t * b[1] + t * t * c[1]]);
    } else {
      const [a, b, c, d] = p as [Pt, Pt, Pt, Pt];
      out.push([
        u * u * u * a[0] + 3 * u * u * t * b[0] + 3 * u * t * t * c[0] + t * t * t * d[0],
        u * u * u * a[1] + 3 * u * u * t * b[1] + 3 * u * t * t * c[1] + t * t * t * d[1],
      ]);
    }
  }
  return out;
}

/** SVG path data (every command but arcs, which the tracer never writes) as closed polygons in view-box units. */
export function parsePathData(d: string): Pt[][] {
  const tokens = d.match(/[A-Za-z]|[-+]?(?:\d+\.\d*|\.\d+|\d+)/g) ?? [];
  const loops: Pt[][] = [];
  let loop: Pt[] = [];
  let at: Pt = [0, 0];
  let start: Pt = [0, 0];
  let lastControl: Pt | null = null;
  let lastKind = "";
  let command = "";
  let i = 0;
  const num = (): number => {
    const token = tokens[i++];
    const value = Number(token);
    if (token === undefined || !Number.isFinite(value)) throw new Error(`path data ends early or has "${token}" where a number belongs`);
    return value;
  };
  const close = (): void => {
    if (loop.length > 2) loops.push(loop);
    loop = [];
  };
  while (i < tokens.length) {
    const token = tokens[i] ?? "";
    if (/[A-Za-z]/.test(token)) {
      command = token;
      i++;
    } else if (command === "") {
      throw new Error("path data must start with a command");
    }
    const rel = command === command.toLowerCase();
    const ox = rel ? at[0] : 0;
    const oy = rel ? at[1] : 0;
    const kind = command.toUpperCase();
    if (kind === "Z") {
      close();
      at = [start[0], start[1]];
      lastControl = null;
      lastKind = "Z";
      continue;
    }
    if (kind === "A") throw new Error("the icon drawing does not handle arc commands (A): write them as curves");
    if (kind === "M") {
      close();
      at = [ox + num(), oy + num()];
      start = [at[0], at[1]];
      loop.push([at[0], at[1]]);
      // Further pairs after a move are line-tos
      command = rel ? "l" : "L";
      lastControl = null;
      lastKind = "M";
      continue;
    }
    let next: Pt[];
    let control: Pt | null = null;
    if (kind === "L") next = [[ox + num(), oy + num()]];
    else if (kind === "H") next = [[ox + num(), at[1]]];
    else if (kind === "V") next = [[at[0], oy + num()]];
    else if (kind === "C" || kind === "S") {
      const reflected: Pt = lastControl && (lastKind === "C" || lastKind === "S") ? [2 * at[0] - lastControl[0], 2 * at[1] - lastControl[1]] : [at[0], at[1]];
      const c1: Pt = kind === "C" ? [ox + num(), oy + num()] : reflected;
      const c2: Pt = [ox + num(), oy + num()];
      const end: Pt = [ox + num(), oy + num()];
      next = curvePoints([at, c1, c2, end]);
      control = c2;
    } else if (kind === "Q" || kind === "T") {
      const reflected: Pt = lastControl && (lastKind === "Q" || lastKind === "T") ? [2 * at[0] - lastControl[0], 2 * at[1] - lastControl[1]] : [at[0], at[1]];
      const c: Pt = kind === "Q" ? [ox + num(), oy + num()] : reflected;
      const end: Pt = [ox + num(), oy + num()];
      next = curvePoints([at, c, end]);
      control = c;
    } else {
      throw new Error(`unknown path command "${command}"`);
    }
    if (loop.length === 0) loop.push([at[0], at[1]]);
    loop.push(...next);
    at = next[next.length - 1] as Pt;
    lastControl = control;
    lastKind = kind;
  }
  close();
  return loops;
}

/**
 * Fill each path by the non-zero rule, one after another (source-over), on a transparent square of `pixels` a side
 * that shows `viewBox` units. Straight (not premultiplied) RGBA, as PNG stores it.
 */
export function renderPaths(paths: ReadonlyArray<{ d: string; colour: Rgb }>, viewBox: number, pixels: number): Uint8Array {
  const scale = pixels / viewBox;
  const rgb = new Float64Array(pixels * pixels * 3);
  const alpha = new Float64Array(pixels * pixels);
  const coverage = new Float64Array(pixels);
  for (const { d, colour } of paths) {
    const edges: Array<[number, number, number, number]> = [];
    for (const loop of parsePathData(d)) {
      for (let k = 0; k < loop.length; k++) {
        const a = loop[k] as Pt;
        const b = loop[(k + 1) % loop.length] as Pt;
        if (a[1] !== b[1]) edges.push([a[0] * scale, a[1] * scale, b[0] * scale, b[1] * scale]);
      }
    }
    for (let y = 0; y < pixels; y++) {
      coverage.fill(0);
      for (let s = 0; s < SUBSAMPLES; s++) {
        const sy = y + (s + 0.5) / SUBSAMPLES;
        const crossings: Array<[number, number]> = [];
        for (const [x0, y0, x1, y1] of edges) {
          // Half-open in y, so a vertex shared by two edges counts once
          if ((y0 <= sy && sy < y1) || (y1 <= sy && sy < y0)) crossings.push([x0 + ((sy - y0) / (y1 - y0)) * (x1 - x0), y1 > y0 ? 1 : -1]);
        }
        crossings.sort((p, q) => p[0] - q[0]);
        let winding = 0;
        for (let c = 0; c < crossings.length - 1; c++) {
          winding += (crossings[c] as [number, number])[1];
          if (winding === 0) continue;
          const from = Math.max(0, (crossings[c] as [number, number])[0]);
          const to = Math.min(pixels, (crossings[c + 1] as [number, number])[0]);
          for (let x = Math.floor(from); x < to && x < pixels; x++) {
            const overlap = Math.min(to, x + 1) - Math.max(from, x);
            if (overlap > 0) coverage[x] = (coverage[x] ?? 0) + overlap / SUBSAMPLES;
          }
        }
      }
      for (let x = 0; x < pixels; x++) {
        const src = Math.min(1, coverage[x] ?? 0);
        if (src <= 0) continue;
        const at = y * pixels + x;
        const dst = alpha[at] ?? 0;
        const out = src + dst * (1 - src);
        for (let ch = 0; ch < 3; ch++) {
          rgb[at * 3 + ch] = ((colour[ch] ?? 0) * src + (rgb[at * 3 + ch] ?? 0) * dst * (1 - src)) / out;
        }
        alpha[at] = out;
      }
    }
  }
  const pixelsOut = new Uint8Array(pixels * pixels * 4);
  for (let at = 0; at < pixels * pixels; at++) {
    const a = Math.round((alpha[at] ?? 0) * 255);
    if (a === 0) continue;
    for (let ch = 0; ch < 3; ch++) pixelsOut[at * 4 + ch] = Math.round(rgb[at * 3 + ch] ?? 0);
    pixelsOut[at * 4 + 3] = a;
  }
  return pixelsOut;
}

/** The icon for `theme`: every arc of the master in that theme's colour for its role. */
export function renderIcon(svg: string, theme: IconTheme): Uint8Array {
  const mark = readBrandMark(svg);
  const colours = markColours(svg)[theme];
  return renderPaths(
    mark.paths.map((p) => {
      const colour = colours[p.role];
      if (!colour) throw new Error(`the logo's <style> gives the ${p.role} arc no ${theme} colour`);
      return { d: p.d, colour };
    }),
    VIEW_BOX,
    ICON_SIZE
  );
}

/** A plain 8-bit RGBA PNG: filter 0 on every row, maximum compression, no metadata (the same bytes every time). */
export function encodeRgbaPng(width: number, height: number, rgba: Uint8Array): Buffer {
  const rows = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) rows.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  const chunk = (type: string, data: Buffer): Buffer => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "ascii");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(type, "ascii"), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(rows, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function main(): void {
  const root = path.resolve(import.meta.dirname, "..");
  const svg = fs.readFileSync(path.join(root, "web", "brand", "logo.svg"), "utf8");
  for (const theme of ["light", "dark"] as const) {
    const file = path.join(root, ICON_FILES[theme]);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, encodeRgbaPng(ICON_SIZE, ICON_SIZE, renderIcon(svg, theme)));
    process.stdout.write(`[brand:icon] ${ICON_FILES[theme]} (${ICON_SIZE}×${ICON_SIZE}, ${theme})\n`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) main();
