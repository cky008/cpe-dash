import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { type MarkRole, readBrandMark } from "./brand.ts";

/**
 * `npm run brand:trace -- <concept.png> [--out web/brand/logo.svg] [--tolerance 0.6]`
 *
 * Turns a flat logo concept (PNG, solid shapes on a plain background) into the master logo
 * (docs/dev/brand.md). A concept that shows the logo twice side by side, light on the left and dark on
 * the right, gives the geometry from the left half and the dark colours from the right half. The
 * outline of each shape is traced at sub-pixel precision (marching squares on the anti-aliased
 * edge), lightly smoothed, then fitted with cubic Béziers (Schneider, Graphics Gems 1990) to within
 * the tolerance, in source pixels. The highest-contrast shapes become `main`, the softer ones
 * `echo`. No dependencies: the PNG is decoded here.
 */

type Rgb = readonly [number, number, number];
type Pt = readonly [number, number];
type Cubic = readonly [Pt, Pt, Pt, Pt];

export interface DecodedPng {
  width: number;
  height: number;
  channels: 3 | 4;
  data: Uint8Array;
}

export interface TracedShape {
  color: Rgb;
  area: number;
  bbox: readonly [number, number, number, number];
  curves: Cubic[];
  /** Largest distance from a traced outline point to its fitted curve (source pixels). */
  maxError: number;
}

export interface TraceResult {
  background: Rgb;
  shapes: TracedShape[];
}

/** 8-bit RGB / RGBA, non-interlaced: what image generators and editors export. */
export function decodePng(bytes: Uint8Array): DecodedPng {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG file");
  let pos = 8;
  let width = 0;
  let height = 0;
  let colorType = -1;
  let bitDepth = 0;
  let interlace = 0;
  const idat: Buffer[] = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const chunk = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      bitDepth = chunk.readUInt8(8);
      colorType = chunk.readUInt8(9);
      interlace = chunk.readUInt8(12);
    } else if (type === "IDAT") idat.push(chunk);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  if (bitDepth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`unsupported PNG (bit depth ${bitDepth}, colour type ${colorType}, interlace ${interlace}): export 8-bit RGB or RGBA`);
  }
  const channels = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)] ?? 0;
    const line = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? (out[y * stride + x - channels] ?? 0) : 0;
      const b = y > 0 ? (out[(y - 1) * stride + x] ?? 0) : 0;
      const c = x >= channels && y > 0 ? (out[(y - 1) * stride + x - channels] ?? 0) : 0;
      let v = raw[line + x] ?? 0;
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[y * stride + x] = v & 255;
    }
  }
  return { width, height, channels, data: out };
}

// ---------------------------------------------------------------- geometry helpers

const sub = (a: Pt, b: Pt): Pt => [a[0] - b[0], a[1] - b[1]];
const add = (a: Pt, b: Pt): Pt => [a[0] + b[0], a[1] + b[1]];
const mul = (a: Pt, s: number): Pt => [a[0] * s, a[1] * s];
const dot = (a: Pt, b: Pt): number => a[0] * b[0] + a[1] * b[1];
const len = (a: Pt): number => Math.hypot(a[0], a[1]);
const unit = (a: Pt): Pt => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l];
};
const at = <T>(list: ReadonlyArray<T>, i: number): T => {
  const v = list[((i % list.length) + list.length) % list.length];
  if (v === undefined) throw new Error("empty list");
  return v;
};

function bezier(c: Cubic, t: number): Pt {
  const mt = 1 - t;
  return add(add(mul(c[0], mt * mt * mt), mul(c[1], 3 * mt * mt * t)), add(mul(c[2], 3 * mt * t * t), mul(c[3], t * t * t)));
}
function bezier1(c: Cubic, t: number): Pt {
  const mt = 1 - t;
  return add(add(mul(sub(c[1], c[0]), 3 * mt * mt), mul(sub(c[2], c[1]), 6 * mt * t)), mul(sub(c[3], c[2]), 3 * t * t));
}
function bezier2(c: Cubic, t: number): Pt {
  return add(mul(add(sub(c[2], mul(c[1], 2)), c[0]), 6 * (1 - t)), mul(add(sub(c[3], mul(c[2], 2)), c[1]), 6 * t));
}

// ---------------------------------------------------------------- tracing

/** Pixels of one rectangle of the image (a half of a light / dark concept, or all of it). */
interface Region {
  x0: number;
  width: number;
  height: number;
  rgb(x: number, y: number): Rgb;
}

function region(img: DecodedPng, x0: number, x1: number): Region {
  return {
    x0,
    width: x1 - x0,
    height: img.height,
    rgb: (x, y) => {
      const i = (y * img.width + x + x0) * img.channels;
      return [img.data[i] ?? 0, img.data[i + 1] ?? 0, img.data[i + 2] ?? 0];
    },
  };
}

const distance = (a: Rgb, b: Rgb): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

function backgroundOf(r: Region): Rgb {
  const frame: Rgb[] = [];
  for (let x = 0; x < r.width; x += 2) frame.push(r.rgb(x, 1), r.rgb(x, r.height - 2));
  for (let y = 0; y < r.height; y += 2) frame.push(r.rgb(1, y), r.rgb(r.width - 2, y));
  const median = (k: 0 | 1 | 2): number => at(frame.map((c) => c[k]).sort((a, b) => a - b), frame.length >> 1);
  return [median(0), median(1), median(2)];
}

interface Component {
  id: number;
  area: number;
  cx: number;
  bbox: [number, number, number, number];
}

/** Ink pixels grouped into 8-connected shapes, largest first. */
function components(r: Region, bg: Rgb): { label: Int32Array; list: Component[] } {
  const { width: w, height: h } = r;
  const ink = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (distance(r.rgb(x, y), bg) > 30) ink[y * w + x] = 1;
  const label = new Int32Array(w * h).fill(-1);
  const list: Component[] = [];
  for (let s = 0; s < w * h; s++) {
    if (!ink[s] || (label[s] ?? 0) >= 0) continue;
    const id = list.length;
    const stack = [s];
    label[s] = id;
    const comp: Component = { id, area: 0, cx: 0, bbox: [w, h, 0, 0] };
    while (stack.length) {
      const p = stack.pop() ?? 0;
      const px = p % w;
      const py = Math.floor(p / w);
      comp.area++;
      comp.cx += px;
      comp.bbox = [Math.min(comp.bbox[0], px), Math.min(comp.bbox[1], py), Math.max(comp.bbox[2], px), Math.max(comp.bbox[3], py)];
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const qx = px + dx;
          const qy = py + dy;
          if (qx < 0 || qy < 0 || qx >= w || qy >= h) continue;
          const q = qy * w + qx;
          if (ink[q] && (label[q] ?? 0) < 0) {
            label[q] = id;
            stack.push(q);
          }
        }
      }
    }
    comp.cx /= comp.area;
    list.push(comp);
  }
  return { label, list: list.sort((a, b) => b.area - a.area) };
}

/** Mean colour of the pixels well inside a shape (4 px from its edge). */
function inkColor(r: Region, label: Int32Array, c: Component): Rgb {
  const sum = [0, 0, 0];
  let n = 0;
  for (let y = c.bbox[1] + 4; y <= c.bbox[3] - 4; y++) {
    for (let x = c.bbox[0] + 4; x <= c.bbox[2] - 4; x++) {
      let inside = true;
      for (let d = -4; d <= 4 && inside; d += 2) for (let e = -4; e <= 4 && inside; e += 2) if (label[(y + d) * r.width + x + e] !== c.id) inside = false;
      if (!inside) continue;
      const px = r.rgb(x, y);
      sum[0] = (sum[0] ?? 0) + px[0];
      sum[1] = (sum[1] ?? 0) + px[1];
      sum[2] = (sum[2] ?? 0) + px[2];
      n++;
    }
  }
  if (n === 0) return r.rgb(Math.round((c.bbox[0] + c.bbox[2]) / 2), Math.round((c.bbox[1] + c.bbox[3]) / 2));
  return [Math.round((sum[0] ?? 0) / n), Math.round((sum[1] ?? 0) / n), Math.round((sum[2] ?? 0) / n)];
}

/** Ink coverage 0..1 of one shape (projection on its background→ink axis), zero away from it. */
function coverage(r: Region, label: Int32Array, c: Component, bg: Rgb, ink: Rgb): Float32Array {
  const { width: w, height: h } = r;
  const near = new Uint8Array(w * h);
  for (let y = c.bbox[1]; y <= c.bbox[3]; y++) {
    for (let x = c.bbox[0]; x <= c.bbox[2]; x++) {
      if (label[y * w + x] !== c.id) continue;
      for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
        const qx = x + dx;
        const qy = y + dy;
        if (qx >= 0 && qy >= 0 && qx < w && qy < h) near[qy * w + qx] = 1;
      }
    }
  }
  const axis: Rgb = [ink[0] - bg[0], ink[1] - bg[1], ink[2] - bg[2]];
  const len2 = axis[0] * axis[0] + axis[1] * axis[1] + axis[2] * axis[2] || 1;
  const f = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (!near[i]) continue;
    const p = r.rgb(i % w, Math.floor(i / w));
    const t = ((p[0] - bg[0]) * axis[0] + (p[1] - bg[1]) * axis[1] + (p[2] - bg[2]) * axis[2]) / len2;
    f[i] = Math.max(0, Math.min(1, t));
  }
  return f;
}

/** Marching squares at coverage 0.5 (samples at pixel centres): the longest closed outline. */
function outline(f: Float32Array, w: number, h: number): Pt[] {
  const value = (x: number, y: number): number => (x < 0 || y < 0 || x >= w || y >= h ? 0 : (f[y * w + x] ?? 0));
  const points = new Map<string, Pt>();
  const next = new Map<string, string>();
  const cross = (ax: number, ay: number, bx: number, by: number): string => {
    const key = ax === bx ? `v${ax},${Math.min(ay, by)}` : `h${Math.min(ax, bx)},${ay}`;
    if (!points.has(key)) {
      const va = value(ax, ay);
      const t = (0.5 - va) / (value(bx, by) - va);
      points.set(key, [ax + (bx - ax) * t + 0.5, ay + (by - ay) * t + 0.5]);
    }
    return key;
  };
  for (let y = -1; y < h; y++) {
    for (let x = -1; x < w; x++) {
      const tl = value(x, y) >= 0.5;
      const tr = value(x + 1, y) >= 0.5;
      const br = value(x + 1, y + 1) >= 0.5;
      const bl = value(x, y + 1) >= 0.5;
      const kind = (tl ? 8 : 0) | (tr ? 4 : 0) | (br ? 2 : 0) | (bl ? 1 : 0);
      if (kind === 0 || kind === 15) continue;
      const T = (): string => cross(x, y, x + 1, y);
      const R = (): string => cross(x + 1, y, x + 1, y + 1);
      const B = (): string => cross(x, y + 1, x + 1, y + 1);
      const L = (): string => cross(x, y, x, y + 1);
      const link = (a: string, b: string): void => void next.set(a, b);
      const centre = (value(x, y) + value(x + 1, y) + value(x + 1, y + 1) + value(x, y + 1)) / 4 >= 0.5;
      switch (kind) {
        case 1: link(L(), B()); break;
        case 2: link(B(), R()); break;
        case 3: link(L(), R()); break;
        case 4: link(R(), T()); break;
        case 5: if (centre) { link(L(), T()); link(R(), B()); } else { link(L(), B()); link(R(), T()); } break;
        case 6: link(B(), T()); break;
        case 7: link(L(), T()); break;
        case 8: link(T(), L()); break;
        case 9: link(T(), B()); break;
        case 10: if (centre) { link(T(), R()); link(B(), L()); } else { link(T(), L()); link(B(), R()); } break;
        case 11: link(T(), R()); break;
        case 12: link(R(), L()); break;
        case 13: link(R(), B()); break;
        case 14: link(B(), L()); break;
      }
    }
  }
  let best: Pt[] = [];
  const seen = new Set<string>();
  for (const start of next.keys()) {
    if (seen.has(start)) continue;
    const loop: Pt[] = [];
    let key: string | undefined = start;
    while (key !== undefined && !seen.has(key)) {
      seen.add(key);
      const p = points.get(key);
      if (p) loop.push(p);
      key = next.get(key);
    }
    if (loop.length > best.length) best = loop;
  }
  return best;
}

/** Gaussian smoothing along the loop: removes texture noise, keeps the shape. */
function smooth(loop: ReadonlyArray<Pt>, sigma = 1.2): Pt[] {
  const r = Math.ceil(sigma * 3);
  const weights: number[] = [];
  for (let i = -r; i <= r; i++) weights.push(Math.exp(-(i * i) / (2 * sigma * sigma)));
  const total = weights.reduce((a, b) => a + b, 0);
  return loop.map((_, i) => {
    let x = 0;
    let y = 0;
    for (let j = -r; j <= r; j++) {
      const p = at(loop, i + j);
      const wgt = at(weights, j + r);
      x += p[0] * wgt;
      y += p[1] * wgt;
    }
    return [x / total, y / total];
  });
}

// ---------------------------------------------------------------- curve fitting (Schneider 1990)

function chordParameters(p: ReadonlyArray<Pt>): number[] {
  const u = [0];
  for (let i = 1; i < p.length; i++) u.push(at(u, i - 1) + len(sub(at(p, i), at(p, i - 1))));
  const total = at(u, u.length - 1) || 1;
  return u.map((v) => v / total);
}

function generate(p: ReadonlyArray<Pt>, u: ReadonlyArray<number>, t1: Pt, t2: Pt): Cubic {
  const first = at(p, 0);
  const last = at(p, p.length - 1);
  let c00 = 0;
  let c01 = 0;
  let c11 = 0;
  let x0 = 0;
  let x1 = 0;
  for (let i = 0; i < p.length; i++) {
    const t = at(u, i);
    const mt = 1 - t;
    const a1 = mul(t1, 3 * mt * mt * t);
    const a2 = mul(t2, 3 * mt * t * t);
    c00 += dot(a1, a1);
    c01 += dot(a1, a2);
    c11 += dot(a2, a2);
    const rest = sub(at(p, i), add(mul(first, mt * mt * mt + 3 * mt * mt * t), mul(last, 3 * mt * t * t + t * t * t)));
    x0 += dot(a1, rest);
    x1 += dot(a2, rest);
  }
  const det = c00 * c11 - c01 * c01;
  let alphaL = det === 0 ? 0 : (x0 * c11 - x1 * c01) / det;
  let alphaR = det === 0 ? 0 : (c00 * x1 - c01 * x0) / det;
  const chord = len(sub(last, first));
  if (alphaL < 1e-6 * chord || alphaR < 1e-6 * chord) alphaL = alphaR = chord / 3;
  return [first, add(first, mul(t1, alphaL)), add(last, mul(t2, alphaR)), last];
}

function worst(p: ReadonlyArray<Pt>, c: Cubic, u: ReadonlyArray<number>): { error: number; split: number } {
  let error = 0;
  let split = p.length >> 1;
  for (let i = 1; i < p.length - 1; i++) {
    const d = len(sub(bezier(c, at(u, i)), at(p, i)));
    if (d > error) {
      error = d;
      split = i;
    }
  }
  return { error, split };
}

function reparameterize(p: ReadonlyArray<Pt>, c: Cubic, u: ReadonlyArray<number>): number[] {
  return u.map((t, i) => {
    const d = sub(bezier(c, t), at(p, i));
    const d1 = bezier1(c, t);
    const den = dot(d1, d1) + dot(d, bezier2(c, t));
    return den === 0 ? t : Math.min(1, Math.max(0, t - dot(d, d1) / den));
  });
}

function fitSpan(p: ReadonlyArray<Pt>, t1: Pt, t2: Pt, tolerance: number, out: Cubic[]): number {
  if (p.length === 2) {
    const third = len(sub(at(p, 1), at(p, 0))) / 3;
    out.push([at(p, 0), add(at(p, 0), mul(t1, third)), add(at(p, 1), mul(t2, third)), at(p, 1)]);
    return 0;
  }
  let u = chordParameters(p);
  let c = generate(p, u, t1, t2);
  let { error, split } = worst(p, c, u);
  if (error < tolerance) {
    out.push(c);
    return error;
  }
  if (error < tolerance * 4) {
    for (let k = 0; k < 20; k++) {
      u = reparameterize(p, c, u);
      c = generate(p, u, t1, t2);
      ({ error, split } = worst(p, c, u));
      if (error < tolerance) {
        out.push(c);
        return error;
      }
    }
  }
  const centre = unit(sub(at(p, split - 1), at(p, split + 1)));
  const left = fitSpan(p.slice(0, split + 1), t1, centre, tolerance, out);
  const right = fitSpan(p.slice(split), mul(centre, -1), t2, tolerance, out);
  return Math.max(left, right);
}

/** Closed outline → smooth cubics, anchored at evenly spaced points with shared tangents. */
export function fitLoop(loop: ReadonlyArray<Pt>, tolerance: number, anchors = 10): { curves: Cubic[]; maxError: number } {
  const n = loop.length;
  if (n < anchors * 3) throw new Error("outline too small to fit");
  let start = 0;
  for (let i = 1; i < n; i++) if (at(loop, i)[1] > at(loop, start)[1]) start = i;
  const ring = loop.slice(start).concat(loop.slice(0, start));
  const tangent = (i: number): Pt => unit(sub(at(ring, i + 3), at(ring, i - 3)));
  const cumulative = [0];
  for (let i = 1; i < n; i++) cumulative.push(at(cumulative, i - 1) + len(sub(at(ring, i), at(ring, i - 1))));
  const perimeter = at(cumulative, n - 1) + len(sub(at(ring, 0), at(ring, n - 1)));
  const index: number[] = [];
  for (let a = 0; a < anchors; a++) {
    let i = index.length ? at(index, index.length - 1) : 0;
    while (i < n - 1 && at(cumulative, i) < (perimeter * a) / anchors) i++;
    index.push(i);
  }
  const curves: Cubic[] = [];
  let maxError = 0;
  for (let a = 0; a < anchors; a++) {
    const i0 = at(index, a);
    const i1 = a + 1 < anchors ? at(index, a + 1) : n;
    const span = ring.slice(i0, i1).concat([at(ring, i1)]);
    maxError = Math.max(maxError, fitSpan(span, tangent(i0), mul(tangent(i1), -1), tolerance, curves));
  }
  return { curves, maxError };
}

/** Trace the solid shapes of one image region (largest first, at most `maxShapes`). */
export function traceRegion(img: DecodedPng, x0: number, x1: number, opts: { tolerance?: number; maxShapes?: number } = {}): TraceResult {
  const r = region(img, x0, x1);
  const background = backgroundOf(r);
  const { label, list } = components(r, background);
  const kept = list.filter((c) => c.area >= 200).slice(0, opts.maxShapes ?? 4).sort((a, b) => a.cx - b.cx);
  if (kept.length === 0) throw new Error("no shapes found: the concept needs solid shapes on a plain background");
  const shapes = kept.map((c): TracedShape => {
    const color = inkColor(r, label, c);
    const fitted = fitLoop(smooth(outline(coverage(r, label, c, background, color), r.width, r.height)), opts.tolerance ?? 0.6);
    return { color, area: c.area, bbox: c.bbox, curves: fitted.curves, maxError: fitted.maxError };
  });
  return { background, shapes };
}

const hex = (c: Rgb): string => `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;

/** The master logo (docs/dev/brand.md): shapes centred in a 0 0 100 100 box, roles by contrast. */
export function masterSvg(light: TraceResult, dark: TraceResult | null, title = "烽燧 FengSui"): string {
  const xs = light.shapes.flatMap((s) => [s.bbox[0], s.bbox[2] + 1]);
  const ys = light.shapes.flatMap((s) => [s.bbox[1], s.bbox[3] + 1]);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const pad = 2;
  const scale = (100 - 2 * pad) / Math.max(Math.max(...xs) - minX, Math.max(...ys) - minY);
  const offsetX = (100 - (Math.max(...xs) - minX) * scale) / 2;
  const offsetY = (100 - (Math.max(...ys) - minY) * scale) / 2;
  const fmt = (v: number): string => String(Math.round(v * 10) / 10 || 0);
  const map = (p: Pt): string => `${fmt((p[0] - minX) * scale + offsetX)} ${fmt((p[1] - minY) * scale + offsetY)}`;
  const contrast = light.shapes.map((s) => distance(s.color, light.background));
  const strongest = Math.max(...contrast);
  const roles = contrast.map((c): MarkRole => (c >= strongest * 0.8 ? "main" : "echo"));
  const colorOf = (result: TraceResult | null, role: MarkRole): string | null => {
    const i = roles.indexOf(role);
    const shape = i >= 0 ? result?.shapes[i] : undefined;
    return shape ? hex(shape.color) : null;
  };
  const style = (result: TraceResult | null): string =>
    (["main", "echo"] as const).flatMap((role) => { const c = colorOf(result, role); return c ? [`.${role}{fill:${c}}`] : []; }).join("");
  const darkStyle = dark && dark.shapes.length === light.shapes.length ? style(dark) : style(light);
  const paths = light.shapes.map((s, i) => {
    const first = s.curves[0];
    if (!first) throw new Error("a shape has no curves");
    const d = `M${map(first[0])}` + s.curves.map((c) => `C${map(c[1])} ${map(c[2])} ${map(c[3])}`).join("") + "Z";
    return `  <path class="${roles[i] ?? "main"}" d="${d}"/>`;
  });
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">',
    `  <title>${title.replace(/[<>&"]/g, "")}</title>`,
    `  <style>${style(light)}@media (prefers-color-scheme: dark){${darkStyle}}</style>`,
    ...paths,
    "</svg>",
    "",
  ].join("\n");
  readBrandMark(svg);
  return svg;
}

/** A light / dark comparison: two halves whose backgrounds are far apart in brightness. */
export function isSideBySide(img: DecodedPng): boolean {
  if (img.width < img.height * 1.2) return false;
  const half = Math.floor(img.width / 2);
  const brightness = (c: Rgb): number => c[0] + c[1] + c[2];
  return Math.abs(brightness(backgroundOf(region(img, 0, half))) - brightness(backgroundOf(region(img, half, half * 2)))) > 200;
}

function main(argv: ReadonlyArray<string>): void {
  const file = argv.find((a) => !a.startsWith("--"));
  const option = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  if (!file) throw new Error("usage: npm run brand:trace -- <concept.png> [--out web/brand/logo.svg] [--tolerance 0.6]");
  const out = option("out") ?? path.join("web", "brand", "logo.svg");
  const tolerance = Number(option("tolerance") ?? "0.6");
  const img = decodePng(fs.readFileSync(file));
  const split = isSideBySide(img);
  const half = Math.floor(img.width / 2);
  const light = traceRegion(img, 0, split ? half : img.width, { tolerance });
  const dark = split ? traceRegion(img, half, half * 2, { tolerance }) : null;
  const svg = masterSvg(light, dark);
  fs.writeFileSync(out, svg);
  console.log(`${split ? "light / dark concept" : "single concept"}: ${light.shapes.length} shape(s) → ${out}`);
  for (const [i, s] of light.shapes.entries()) {
    console.log(`  shape ${i}: ${hex(s.color)}, ${s.curves.length} cubics, max deviation ${s.maxError.toFixed(2)} px`);
  }
  console.log("Next: npm run build:web, look at it (npm run demo), npm run screenshots; see docs/dev/brand.md");
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  try {
    main(process.argv.slice(2));
  } catch (err: unknown) {
    process.stderr.write(`brand:trace: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}
