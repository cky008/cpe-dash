import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { type BuildOptions, build } from "esbuild";

/**
 * Build the offline web dashboard into `dist/web/public/` (the daemon's default STATIC_DIR):
 * esbuild bundles and minifies the strict-TypeScript sources, the Tailwind v4 CLI compiles
 * daisyUI themes, and every asset gets a content hash so `index.html` (served `no-cache`) always
 * points at matching files. No CDN, no runtime dependency. `--watch` rebuilds on change.
 *
 * `--demo` builds the static GitHub Pages demo into `dist/demo/` instead: the same console from
 * web/src/demo/main.ts (an in-page backend, no daemon), relative asset URLs so it works under any
 * path, and a CSP meta tag since Pages sends no headers. `npm run build:demo` then records its seed.
 */

const ROOT = process.cwd();
const WEB = path.join(ROOT, "web");
const DEMO = process.argv.includes("--demo");
const OUT = DEMO ? path.join(ROOT, "dist", "demo") : path.join(ROOT, "dist", "web", "public");
const ASSETS = path.join(OUT, "assets");
const ENTRY = DEMO ? path.join(WEB, "src", "demo", "main.ts") : path.join(WEB, "src", "main.ts");
/** The daemon serves the console at `/`; the demo may live under a sub-path (`/fengsui-demo/`). */
const ASSET_PREFIX = DEMO ? "assets/" : "/assets/";
const DEMO_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'";
/** Gzipped JS + CSS above this fails the build; the contract asks for < 60 KB on first paint. */
const GZIP_BUDGET_BYTES = (DEMO ? 200 : 120) * 1024;
const GZIP_TARGET_BYTES = 60 * 1024;

function contentHash(bytes: Buffer | string): string {
  return crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 10);
}

function emit(name: string, ext: string, bytes: Buffer | string): string {
  const file = `${name}.${contentHash(bytes)}.${ext}`;
  fs.writeFileSync(path.join(ASSETS, file), bytes);
  return `${ASSET_PREFIX}${file}`;
}

const ESBUILD_COMMON: BuildOptions = {
  bundle: true,
  platform: "browser",
  target: ["es2022", "safari16"],
  minify: true,
  legalComments: "none",
  charset: "utf8",
  logLevel: "warning",
};

/** The pre-paint boot script: one classic (non-module) file. */
async function bundleBoot(): Promise<string> {
  const result = await build({ ...ESBUILD_COMMON, entryPoints: [path.join(WEB, "src", "boot.ts")], format: "iife", write: false });
  const js = result.outputFiles?.[0]?.text;
  if (js === undefined) throw new Error("esbuild produced no output for boot.ts");
  return js;
}

/**
 * The app as ES modules with code splitting: the SMS centre, controls drawer and cell-lock form are
 * separate chunks loaded on first use. Returns the entry URL and every emitted file.
 */
type ChunkRole = "eager" | "locale" | "lazy";

async function bundleApp(): Promise<{ entryUrl: string; files: Array<{ name: string; text: string; role: ChunkRole }> }> {
  const result = await build({
    ...ESBUILD_COMMON,
    entryPoints: { app: ENTRY },
    format: "esm",
    splitting: true,
    outdir: ASSETS,
    entryNames: "[name].[hash]",
    chunkNames: "chunk.[hash]",
    write: false,
    metafile: true,
  });
  // Dynamic-import targets are entry points in the metafile too: match the entry itself
  const outputs = result.metafile?.outputs ?? {};
  const mainEntry = path.relative(ROOT, ENTRY);
  const entryKey = Object.keys(outputs).find((key) => outputs[key]?.entryPoint === mainEntry);
  if (!entryKey) throw new Error(`esbuild produced no entry chunk for ${mainEntry}`);
  // First paint = the entry plus everything it imports statically (chunks behind import() load later)
  const eager = new Set<string>();
  const visit = (key: string): void => {
    if (eager.has(key)) return;
    eager.add(key);
    for (const imp of outputs[key]?.imports ?? []) {
      if (imp.kind === "import-statement") visit(imp.path);
    }
  };
  visit(entryKey);
  const files: Array<{ name: string; text: string; role: ChunkRole }> = [];
  for (const file of result.outputFiles ?? []) {
    const name = path.basename(file.path);
    const key = path.relative(ROOT, file.path);
    // Exactly one language chunk loads with the page (the active locale)
    const role: ChunkRole = eager.has(key) ? "eager" : outputs[key]?.entryPoint?.includes("/i18n/") ? "locale" : "lazy";
    files.push({ name, text: file.text, role });
    fs.writeFileSync(path.join(ASSETS, name), file.text);
  }
  return { entryUrl: `${ASSET_PREFIX}${path.basename(entryKey)}`, files };
}

function compileCss(): string {
  const tmp = path.join(OUT, ".tailwind.css");
  const bin = path.join(ROOT, "node_modules", ".bin", process.platform === "win32" ? "tailwindcss.cmd" : "tailwindcss");
  const run = spawnSync(bin, ["-i", path.join(WEB, "styles.css"), "-o", tmp, "--minify"], { cwd: ROOT, encoding: "utf8" });
  if (run.status !== 0) {
    throw new Error(`tailwindcss failed (${run.status}):\n${run.stderr}`);
  }
  const css = fs.readFileSync(tmp, "utf8");
  fs.rmSync(tmp);
  return css;
}

async function buildOnce(): Promise<void> {
  const started = Date.now();
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(ASSETS, { recursive: true });

  const [app, bootJs] = await Promise.all([bundleApp(), bundleBoot()]);
  const appCss = compileCss();

  const urls = {
    "{{APP_JS}}": app.entryUrl,
    "{{BOOT_JS}}": emit("boot", "js", bootJs),
    "{{APP_CSS}}": emit("app", "css", appCss),
  };
  let html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
  for (const [placeholder, url] of Object.entries(urls)) {
    if (!html.includes(placeholder)) throw new Error(`web/index.html lacks ${placeholder}`);
    html = html.replaceAll(placeholder, url);
  }
  if (DEMO) html = demoHtml(html);
  fs.writeFileSync(path.join(OUT, "index.html"), html);
  // Pages would otherwise run the site through Jekyll
  if (DEMO) fs.writeFileSync(path.join(OUT, ".nojekyll"), "");
  fs.copyFileSync(path.join(WEB, "favicon.svg"), path.join(OUT, "favicon.svg"));

  const gzipKiB = (text: string): number => zlib.gzipSync(text, { level: 9 }).length / 1024;
  const report = (name: string, text: string, role: ChunkRole): number => {
    const gz = gzipKiB(text);
    const tag = role === "eager" ? "" : `  (${role})`;
    console.log(`  ${name.padEnd(24)} ${(Buffer.byteLength(text) / 1024).toFixed(1).padStart(7)} KiB  gzip ${gz.toFixed(1).padStart(6)} KiB${tag}`);
    return gz;
  };
  let firstPaint = report("index.html", html, "eager") + report(path.basename(urls["{{BOOT_JS}}"]), bootJs, "eager") + report(path.basename(urls["{{APP_CSS}}"]), appCss, "eager");
  let largestLocale = 0;
  let lazy = 0;
  for (const file of app.files) {
    const gz = report(file.name, file.text, file.role);
    if (file.role === "eager") firstPaint += gz;
    else if (file.role === "locale") largestLocale = Math.max(largestLocale, gz);
    else lazy += gz;
  }
  // Worst case: the larger of the two dictionaries loads with the page
  firstPaint += largestLocale;
  const note = firstPaint * 1024 <= GZIP_TARGET_BYTES ? "within" : "above";
  console.log(
    `  first paint ${firstPaint.toFixed(1)} KiB gzip incl. one language (${note} the 60 KiB target) + ${lazy.toFixed(1)} KiB on demand; built in ${Date.now() - started} ms -> ${path.relative(ROOT, OUT)}`
  );
  if ((firstPaint + lazy) * 1024 > GZIP_BUDGET_BYTES) {
    throw new Error(`Web bundle is ${(firstPaint + lazy).toFixed(1)} KiB gzipped, over the ${GZIP_BUDGET_BYTES / 1024} KiB budget`);
  }
}

/** Page tweaks for the static demo: relative favicon, CSP, demo title, footer link to the demo repo. */
function demoHtml(html: string): string {
  const swaps: ReadonlyArray<readonly [string, string]> = [
    ['href="/favicon.svg"', 'href="favicon.svg"'],
    ["<title>烽燧 FengSui</title>", `<title>烽燧 FengSui · Demo</title>\n    <meta http-equiv="Content-Security-Policy" content="${DEMO_CSP}" />`],
    ['href="https://github.com/cky008/cpe-dash"', 'href="https://github.com/cky008/fengsui-demo"'],
  ];
  let out = html;
  for (const [from, to] of swaps) {
    if (!out.includes(from)) throw new Error(`web/index.html lacks ${from} (demo build)`);
    out = out.replace(from, to);
  }
  return out;
}

async function watch(): Promise<void> {
  await buildOnce().catch((err: unknown) => console.error(err instanceof Error ? err.message : err));
  let timer: ReturnType<typeof setTimeout> | null = null;
  const rebuild = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      buildOnce().catch((err: unknown) => console.error(err instanceof Error ? err.message : err));
    }, 120);
  };
  for (const dir of [WEB, path.join(ROOT, "src")]) {
    fs.watch(dir, { recursive: true }, rebuild);
  }
  console.log("Watching web/ and src/ for changes…");
}

if (process.argv.includes("--watch")) {
  await watch();
} else {
  await buildOnce();
}
