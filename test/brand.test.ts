import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import zlib from "node:zlib";
import { BRAND_PLACEHOLDER, brandSymbol, injectBrand, readBrandMark } from "../scripts/brand.ts";
import { decodePng, fitLoop, isSideBySide, masterSvg, traceRegion } from "../scripts/trace-logo.ts";

const master = fs.readFileSync("web/brand/logo.svg", "utf8");
const html = fs.readFileSync("web/index.html", "utf8");
const css = fs.readFileSync("web/styles.css", "utf8");

/** A minimal 8-bit RGB PNG (filter 0 on every row), written the way image tools do. */
function encodePng(width: number, height: number, pixel: (x: number, y: number) => readonly [number, number, number]): Buffer {
  const rows = Buffer.alloc(height * (width * 3 + 1));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      rows.set([r, g, b], y * (width * 3 + 1) + 1 + x * 3);
    }
  }
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
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

/**
 * A light / dark concept like the designer's: each half shows a disk (strong) and a rounded bar
 * (softer), anti-aliased by 4×4 supersampling.
 */
function concept(): Buffer {
  const half = 160;
  const inDisk = (x: number, y: number): boolean => (x - 55) ** 2 + (y - 80) ** 2 <= 38 ** 2;
  const inBar = (x: number, y: number): boolean => {
    const cx = Math.max(112, Math.min(140, x));
    const cy = Math.max(52, Math.min(118, y));
    return (x - cx) ** 2 + (y - cy) ** 2 <= 8 ** 2;
  };
  const palettes = [
    { bg: [243, 249, 251], disk: [52, 88, 111], bar: [113, 146, 164] },
    { bg: [20, 32, 44], disk: [184, 217, 228], bar: [119, 165, 181] },
  ] as const;
  return encodePng(half * 2, 160, (px, py) => {
    const p = palettes[px < half ? 0 : 1];
    const lx = px % half;
    let disk = 0;
    let bar = 0;
    for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
      const x = lx + (sx + 0.5) / 4;
      const y = py + (sy + 0.5) / 4;
      if (inDisk(x, y)) disk++;
      else if (inBar(x, y)) bar++;
    }
    const mix = (k: 0 | 1 | 2): number => Math.round((p.bg[k] * (16 - disk - bar) + p.disk[k] * disk + p.bar[k] * bar) / 16);
    return [mix(0), mix(1), mix(2)];
  });
}

describe("brand: the master logo and how the console uses it", () => {
  it("keeps one valid master with a main and an echo arc", () => {
    const mark = readBrandMark(master);
    assert.deepEqual(mark.paths.map((p) => p.role), ["main", "echo"]);
    assert.equal(mark.svg, master, "the favicon is the master itself");
  });

  it("refuses a master that breaks the contract", () => {
    const path = '<path class="main" d="M1 1L9 9Z"/>';
    const dark = "<style>@media (prefers-color-scheme: dark){.main{fill:#fff}}</style>";
    const svg = (body: string, viewBox = "0 0 100 100"): string => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${body}</svg>`;
    assert.doesNotThrow(() => readBrandMark(svg(dark + path)));
    for (const [bad, why] of [
      ["<g/>", /must start with an <svg>/],
      [svg(dark + path, "0 0 24 24"), /viewBox="0 0 100 100"/],
      [svg(dark + path + "<script>alert(1)</script>"), /found <script>/],
      [svg(dark + '<path class="main" onclick="x()" d="M1 1Z"/>'), /event handlers or links/],
      [svg(dark + '<path d="M1 1Z"/>'), /class="main" or class="echo"/],
      [svg(dark + '<path class="main" d="M1 1 url(#x)"/>'), /unexpected path data/],
      [svg(dark + '<path class="echo" d="M1 1Z"/>'), /at least one class="main"/],
      [svg(path), /prefers-color-scheme: dark/],
    ] as const) {
      assert.throws(() => readBrandMark(bad), why, bad);
    }
  });

  it("puts the theme-coloured symbol into the page's sprite at build time", () => {
    const mark = readBrandMark(master);
    const sprite = html.slice(html.indexOf("<svg"), html.indexOf("</svg>"));
    assert.equal(sprite.split(BRAND_PLACEHOLDER).length, 2, "the placeholder sits once, inside the sprite");
    const page = injectBrand(html, mark);
    assert.ok(page.includes(brandSymbol(mark)));
    for (const p of mark.paths) assert.ok(page.includes(`fill: var(--mark-${p.role}); stroke: none" d="${p.d}"`));
    const symbols = new Set([...page.matchAll(/<symbol id="([^"]+)"/g)].map((m) => m[1]));
    for (const [, id] of page.matchAll(/<use href="#([^"]+)"/g)) assert.ok(symbols.has(id), `#${id} has a symbol`);
    assert.equal([...page.matchAll(/<svg class="fs-mark[^"]*" aria-hidden="true"><use href="#i-mark" \/><\/svg>/g)].length, 2, "header and sign-in page");
    assert.throws(() => injectBrand("<svg></svg>", mark), /exactly once/);
    assert.throws(() => injectBrand(BRAND_PLACEHOLDER + BRAND_PLACEHOLDER, mark), /exactly once/);
    const build = fs.readFileSync("scripts/build-web.ts", "utf8");
    assert.match(build, /injectBrand\(fs\.readFileSync\(path\.join\(WEB, "index\.html"\), "utf8"\), brand\)/);
    assert.match(build, /writeFileSync\(path\.join\(OUT, "favicon\.svg"\), brand\.svg\)/);
    assert.match(fs.readFileSync("Dockerfile", "utf8"), /COPY scripts\/build-web\.ts scripts\/brand\.ts \.\/scripts\//);
  });

  it("colours the arcs from the theme, with shares for light and dark schemes", () => {
    assert.match(css, /--mark-main: color-mix\(in oklab, var\(--color-primary\) var\(--mark-strength\), var\(--color-base-content\)\)/);
    assert.match(css, /--mark-echo: color-mix\(in oklab, var\(--mark-main\) var\(--mark-echo-share\), var\(--color-base-100\)\)/);
    for (const scheme of [':root,\n[data-scheme="light"] {', '[data-scheme="dark"] {']) {
      const block = css.slice(css.indexOf(scheme), css.indexOf("}", css.indexOf(scheme)));
      assert.match(block, /--mark-strength: \d+%;/, scheme);
      assert.match(block, /--mark-echo-share: \d+%;/, scheme);
    }
  });
});

describe("brand: tracing a concept into the master", () => {
  it("decodes what it encodes and recognises a light / dark comparison", () => {
    const png = concept();
    const img = decodePng(png);
    assert.deepEqual([img.width, img.height, img.channels], [320, 160, 3]);
    assert.deepEqual([...img.data.subarray(0, 3)], [243, 249, 251]);
    assert.equal(isSideBySide(img), true);
    assert.equal(isSideBySide(decodePng(encodePng(40, 40, () => [255, 255, 255]))), false);
    assert.throws(() => decodePng(Buffer.from("GIF89a....")), /not a PNG/);
    const sixteenBit = Buffer.from(png);
    sixteenBit[24] = 16;
    assert.throws(() => decodePng(sixteenBit), /unsupported PNG/);
  });

  it("follows the outlines within the tolerance and gives the stronger shape the main role", () => {
    const img = decodePng(concept());
    const light = traceRegion(img, 0, 160);
    const dark = traceRegion(img, 160, 320);
    assert.equal(light.shapes.length, 2);
    const [disk, bar] = light.shapes;
    assert.ok(disk && bar);
    assert.ok(disk.maxError <= 0.6 && bar.maxError <= 0.6, "fitted within 0.6 px of the traced outline");
    // Every fitted point lies on the true circle (radius 38 around 55,80), sub-pixel close
    for (const c of disk.curves) {
      for (const t of [0, 0.25, 0.5, 0.75, 1]) {
        const mt = 1 - t;
        const x = c[0][0] * mt ** 3 + 3 * c[1][0] * mt * mt * t + 3 * c[2][0] * mt * t * t + c[3][0] * t ** 3;
        const y = c[0][1] * mt ** 3 + 3 * c[1][1] * mt * mt * t + 3 * c[2][1] * mt * t * t + c[3][1] * t ** 3;
        assert.ok(Math.abs(Math.hypot(x - 55, y - 80) - 38) < 1, `${x.toFixed(2)},${y.toFixed(2)}`);
      }
    }
    const svg = masterSvg(light, dark, "Test <mark>");
    const mark = readBrandMark(svg);
    assert.deepEqual(mark.paths.map((p) => p.role), ["main", "echo"]);
    assert.match(svg, /<title>Test mark<\/title>/);
    assert.match(svg, /<style>\.main\{fill:#34586f\}\.echo\{fill:#7192a4\}@media \(prefers-color-scheme: dark\)\{\.main\{fill:#b8d9e4\}\.echo\{fill:#77a5b5\}\}<\/style>/);
    assert.match(masterSvg(light, null), /@media \(prefers-color-scheme: dark\)\{\.main\{fill:#34586f\}/, "no dark half: the light colours serve both");
  });

  it("refuses an outline too small to fit and an image without shapes", () => {
    assert.throws(() => fitLoop([[0, 0], [1, 0], [1, 1]], 0.6), /too small/);
    assert.throws(() => traceRegion(decodePng(encodePng(40, 40, () => [255, 255, 255])), 0, 40), /no shapes found/);
  });
});
