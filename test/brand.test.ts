import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import zlib from "node:zlib";
import { BRAND_PLACEHOLDER, brandSymbol, injectBrand, readBrandMark } from "../scripts/brand.ts";
import { ICON_FILES, ICON_SIZE, encodeRgbaPng, markColours, parsePathData, renderIcon, renderPaths } from "../scripts/brand-icon.ts";
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
    assert.match(fs.readFileSync("Dockerfile", "utf8"), /^COPY scripts\/build-web\.ts (?:scripts\/[a-z-]+\.ts )*scripts\/brand\.ts (?:scripts\/[a-z-]+\.ts )*\.\/scripts\/$/m);
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

describe("brand: the Claude Desktop extension's icons", () => {
  /** The pixel at (x, y) of an RGBA image. */
  const px = (img: { width: number; data: Uint8Array }, x: number, y: number): number[] => [...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)];

  it("draws the committed icons from the master logo, pixel for pixel (npm run brand:icon redraws them)", () => {
    for (const theme of ["light", "dark"] as const) {
      const committed = decodePng(fs.readFileSync(ICON_FILES[theme]));
      assert.deepEqual([committed.width, committed.height, committed.channels], [ICON_SIZE, ICON_SIZE, 4], `${ICON_FILES[theme]} is ${ICON_SIZE}×${ICON_SIZE} RGBA`);
      const drawn = renderIcon(master, theme);
      assert.ok(Buffer.from(committed.data).equals(Buffer.from(drawn)), `${ICON_FILES[theme]} no longer matches web/brand/logo.svg: run npm run brand:icon`);
      // Transparent around the mark, the arcs' own colours inside them
      assert.deepEqual(px(committed, 0, 0), [0, 0, 0, 0]);
      assert.deepEqual(px(committed, ICON_SIZE - 1, ICON_SIZE - 1), [0, 0, 0, 0]);
    }
  });

  it("takes the light colours and the (prefers-color-scheme: dark) ones from the master's style", () => {
    assert.deepEqual(markColours(master), {
      light: { main: [0x2e, 0x56, 0x72], echo: [0x6e, 0x92, 0xa7] },
      dark: { main: [0xbb, 0xe0, 0xef], echo: [0x81, 0xb5, 0xc9] },
    });
    // Each arc is drawn in its role's colour: a point well inside the main arc (x 20, y 70 of the 100-unit view box)
    const light = decodePng(encodeRgbaPng(ICON_SIZE, ICON_SIZE, renderIcon(master, "light")));
    const dark = decodePng(encodeRgbaPng(ICON_SIZE, ICON_SIZE, renderIcon(master, "dark")));
    assert.deepEqual(px(light, 102, 358), [0x2e, 0x56, 0x72, 255]);
    assert.deepEqual(px(dark, 102, 358), [0xbb, 0xe0, 0xef, 255]);
    assert.throws(() => markColours('<style>.main{fill:#123456}</style>'), /dark/);
  });

  it("fills by the non-zero rule with exact coverage at the edges", () => {
    const red = [255, 0, 0] as const;
    // A 4×4 square from (1, 1) to (3, 3) on a 4-unit canvas drawn at 4 px: inside opaque, outside clear
    const square = renderPaths([{ d: "M1 1H3V3H1Z", colour: red }], 4, 4);
    assert.deepEqual([...square.subarray((1 * 4 + 1) * 4, (1 * 4 + 1) * 4 + 4)], [255, 0, 0, 255]);
    assert.deepEqual([...square.subarray(0, 4)], [0, 0, 0, 0]);
    // Half a pixel covered: half the alpha
    const half = renderPaths([{ d: "M0 0h0.5v1h-0.5z", colour: red }], 1, 1);
    assert.deepEqual([...half], [255, 0, 0, 128]);
    // Two squares the same way round both fill; the inner one drawn the other way cuts a hole
    const same = renderPaths([{ d: "M0 0H4V4H0Z M1 1H3V3H1Z", colour: red }], 4, 4);
    const hole = renderPaths([{ d: "M0 0H4V4H0Z M1 1V3H3V1Z", colour: red }], 4, 4);
    assert.equal(same[(1 * 4 + 1) * 4 + 3], 255);
    assert.equal(hole[(1 * 4 + 1) * 4 + 3], 0);
    assert.equal(hole[3], 255);
  });

  it("reads the path commands the tracer writes, and refuses arcs it cannot draw", () => {
    const cubic = parsePathData("M10 10C20 0 30 0 40 10S60 20 70 10Q80 0 90 10T95 10L95 20l-5 5h-5v5H10z");
    assert.equal(cubic.length, 1, "one closed outline");
    assert.ok((cubic[0]?.length ?? 0) > 20, "curves become many short segments");
    assert.deepEqual(cubic[0]?.[0], [10, 10]);
    assert.deepEqual(parsePathData("M1 1L2 2 3 1Z m1 0 l1 1 1 -1z"), [[[1, 1], [2, 2], [3, 1]], [[2, 1], [3, 2], [4, 1]]], "implicit line-tos; a relative move starts from where Z closed");
    assert.throws(() => parsePathData("M1 1A5 5 0 0 1 9 9Z"), /arc/);
  });
});
