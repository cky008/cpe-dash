import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { THEME_META } from "../web/src/core/prefs.ts";
import { type ChromeHandle, type Page, type Viewport, closeChrome, launchChrome, openPage } from "./cdp.ts";
import { type DemoDaemon, startDemoDaemon } from "./demo-router.ts";
import { SHOWCASE_THEMES, showcaseImage } from "./site-home.ts";

/**
 * Regenerate the screenshots of the READMEs and the documentation site (docs/screenshots/*.webp) from the offline demo: the real daemon
 * against the in-process mock router (placeholder data only, no network, no .env), the built console,
 * and a headless Chrome driven over the DevTools protocol through Node's own WebSocket.
 *
 *   npm run build:web && npm run screenshots                 # every shot
 *   npm run screenshots -- dashboard-sujian mobile           # only these
 *   npm run screenshots -- themes                            # the home page's theme wipe
 *   CHROME_PATH=/path/to/chrome npm run screenshots          # another Chrome / Chromium
 *
 * Run it before tagging a release, so the pictures land in the signed release commit.
 */

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT_DIR = path.join(ROOT, "docs", "screenshots");
const TOKEN = "fengsui-screenshots";

type Scenario = "normal" | "yield" | "breaker" | "unverified";

interface Shot {
  name: string;
  scenario: Scenario;
  theme: string;
  locale?: "zh-CN" | "en";
  viewport?: Viewport;
  fullPage?: boolean;
  /** Brings the page into the state to capture, after the dashboard is ready. */
  prepare?: (page: Page, demo: DemoDaemon) => Promise<void>;
}

const DESKTOP: Viewport = { width: 1440, height: 900, scale: 1, mobile: false };
const PHONE: Viewport = { width: 390, height: 844, scale: 2, mobile: true };

const openSms = async (page: Page): Promise<void> => {
  await page.click('[data-view="sms"]');
  await page.waitUntil("document.querySelector('#smsListPane [data-thread-key]') !== null", "SMS threads");
  await page.click("#smsListPane [data-thread-key]");
  await page.waitUntil("document.querySelectorAll('#smsChatPane .fs-bubble, #smsChatPane [data-uid]').length > 0 || document.querySelector('#smsChatPane')?.textContent?.length > 40", "a conversation");
};

const openSettings = async (page: Page, tab: string): Promise<void> => {
  await page.click('[data-action="open-settings"]');
  await page.waitUntil("document.querySelector('#settingsDialog')?.open === true", "the settings dialog");
  await page.clickText("#settingsDialog nav button", tab);
};

const SHOTS: ReadonlyArray<Shot> = [
  { name: "dashboard-sujian", scenario: "normal", theme: "fengsui-sujian" },
  { name: "dashboard-jiye", scenario: "normal", theme: "fengsui-jiye" },
  { name: "dashboard-dailan", scenario: "normal", theme: "fengsui-dailan" },
  { name: "dashboard-full-jiye", scenario: "normal", theme: "fengsui-jiye", fullPage: true },
  { name: "sms-suzhi", scenario: "normal", theme: "fengsui-suzhi", prepare: openSms },
  { name: "sms-ziming-en", scenario: "normal", theme: "fengsui-ziming", locale: "en", prepare: openSms },
  {
    name: "controls-chenxi",
    scenario: "normal",
    theme: "fengsui-chenxi",
    prepare: async (page) => {
      await page.click('[data-action="open-controls"]');
      await page.waitUntil("document.querySelector('#controlsDialog')?.open === true && document.querySelector('#controlsDialog')?.textContent?.length > 80", "the controls drawer");
    },
  },
  {
    name: "cell-lock",
    scenario: "normal",
    theme: "fengsui-sujian",
    prepare: async (page) => {
      await page.waitUntil("document.querySelector('#neighborsCard button[title]:not([disabled])') !== null", "a lockable neighbor cell");
      await page.click("#neighborsCard button[title]:not([disabled])");
      await page.waitUntil("document.querySelector('#cellLockDialog')?.open === true", "the cell lock dialog");
    },
  },
  {
    name: "appearance",
    scenario: "normal",
    theme: "fengsui-sujian",
    prepare: async (page) => {
      await page.click('[data-action="open-appearance"]');
      await page.waitUntil("document.querySelector('#appearanceDialog')?.open === true", "the appearance dialog");
    },
  },
  {
    name: "access-panel",
    scenario: "normal",
    theme: "fengsui-sujian",
    prepare: async (page) => {
      await page.clickText("#topologyCard button", "访问控制");
      await page.waitUntil("document.querySelector('#accessDialog')?.open === true && document.querySelector('#accessDialog')?.textContent?.length > 80", "the access drawer");
    },
  },
  { name: "mobile", scenario: "normal", theme: "fengsui-sujian", viewport: PHONE },
  {
    name: "yield",
    scenario: "yield",
    theme: "fengsui-sujian",
    prepare: async (page, demo) => {
      // A person opens the router's own admin page: the next poll yields and the banner appears
      demo.router.human.loginSameIp();
      await page.waitUntil("document.querySelector('#bannerArea')?.textContent?.includes('有人正在使用路由器管理页') === true", "the avoidance banner", 30_000);
    },
  },
  {
    name: "breaker",
    scenario: "breaker",
    theme: "fengsui-sujian",
    prepare: async (page) => {
      await page.waitUntil("document.querySelector('#bannerArea')?.textContent?.includes('路由器拒绝了密码') === true", "the breaker banner", 30_000);
    },
  },
  {
    name: "settings-router",
    scenario: "normal",
    theme: "fengsui-sujian",
    prepare: async (page) => {
      await openSettings(page, "路由器");
      await page.clickText("#settingsDialog button", "测试连接");
      await page.waitUntil(`document.querySelector('#settingsDialog .fs-notice[data-tone="success"]') !== null`, "a passed connection test");
    },
  },
  {
    name: "settings-tokens",
    scenario: "normal",
    theme: "fengsui-jiye",
    prepare: async (page) => {
      await openSettings(page, "令牌");
      await page.waitUntil("document.querySelectorAll('#settingsDialog li').length >= 3", "the token list");
    },
  },
  {
    name: "topology-access",
    scenario: "normal",
    theme: "fengsui-sujian",
    prepare: async (page) => {
      // The demo household already has blocked Wi-Fi devices (one online, one gone offline) to restore
      await page.waitUntil("document.querySelector('#topologyCard')?.textContent?.includes('已断网') === true", "the blocked badges");
      await page.evaluate("document.querySelector('#topologyCard').scrollIntoView({ block: 'center' })");
    },
  },
  {
    name: "settings-device",
    scenario: "normal",
    theme: "fengsui-sujian",
    prepare: async (page) => {
      await openSettings(page, "设备");
      await page.waitUntil(`document.querySelector('#settingsDialog .fs-notice[data-tone="success"]') !== null`, "the verified model");
    },
  },
  {
    name: "experimental-writes",
    scenario: "unverified",
    theme: "fengsui-jiye",
    prepare: async (page) => {
      // Another model (the demo's B535-232): turning on an experimental write asks for its model first
      await openSettings(page, "设备");
      await page.waitUntil("document.querySelector('#settingsDialog li[data-feature=bandLock] input') !== null", "the experimental writes");
      await page.click("#settingsDialog li[data-feature=bandLock] input");
      await page.waitUntil("document.querySelector('#confirmDialog')?.open === true", "the risk dialog");
      await page.evaluate("(() => { const input = document.getElementById('confirmTypeInput'); input.value = 'B535-232'; input.dispatchEvent(new Event('input', { bubbles: true })); return true; })()");
      await page.waitUntil("document.getElementById('confirmOk').disabled === false", "the model typed");
    },
  },
];

// ---------------------------------------------------------------- demo world

/** Two hours of 5 s samples behind "now", so the charts and their summaries have a history to show. */
function backfillHistory(demo: DemoDaemon): void {
  const now = Date.now();
  for (let t = now - 2 * 60 * 60_000, i = 0; t < now - 5000; t += 5000, i++) {
    const wave = Math.max(0, Math.sin(i / 120)) * 9_000_000 + Math.max(0, Math.sin(i / 33)) * 2_500_000 + 180_000;
    demo.stack.timeseries.push({
      tsMs: t,
      downloadBps: Math.round(wave * 8),
      uploadBps: Math.round(wave * 0.9),
      lteRsrpDbm: -87 + Math.sin(i / 90) * 3,
      lteSinrDb: 13 + Math.sin(i / 50) * 3,
      nrRsrpDbm: -95 + Math.sin(i / 70) * 5,
      nrSinrDb: 9 + Math.sin(i / 40) * 4,
      temperatureCelsius: null,
    });
  }
}

const DEMO_CONTACTS = [
  { phone: "+353830000001", name: "Sam Demo", note: "Dinner club" },
  { phone: "+447700900123", name: "Parcel Depot" },
  { phone: "+353830000002", name: "Robin Demo" },
];

async function startWorld(scenario: Scenario): Promise<DemoDaemon> {
  const demo = await startDemoDaemon({ port: 0, token: TOKEN, scenario });
  backfillHistory(demo);
  for (const contact of DEMO_CONTACTS) demo.stack.sms?.upsertContact(contact);
  // A dashboard and an agent use their own read-only tokens next to the one imported from .env
  const grafana = demo.stack.settings.createToken({ name: "Grafana", scope: "read", lifetimeDays: null });
  demo.stack.settings.createToken({ name: "Claude Code", scope: "read", lifetimeDays: 90 });
  demo.stack.settings.resolveBearer(grafana.token);
  // Another model's Settings → Device lists its experimental writes once it is identified
  if (scenario === "unverified") await demo.stack.monitor.identifyDevice();
  if (scenario !== "breaker") {
    // The first neighbor scan and settings read would otherwise wait for their own schedules
    const reads = [
      demo.stack.monitor.refreshNeighbors({ ignoreCooldown: true }),
      demo.stack.monitor.refreshSettings({ ignoreCooldown: true }),
      demo.stack.monitor.refreshAccessControl({ ignoreCooldown: true }),
    ];
    // Another model may lack some of them; the H168-383 must have them all
    if (scenario === "unverified") await Promise.allSettled(reads);
    else await Promise.all(reads);
  }
  const ticker = setInterval(() => demo.router.advance(), 5000);
  ticker.unref();
  return demo;
}

async function signIn(page: Page, demo: DemoDaemon, shot: Shot): Promise<void> {
  await page.goto(`${demo.baseUrl}/`);
  // Preferences live in this origin's localStorage: fix the theme and language, then reload
  await page.evaluate(
    `localStorage.setItem("fengsui.followSystem", "0"); localStorage.setItem("fengsui.theme", ${JSON.stringify(shot.theme)}); localStorage.setItem("fengsui.locale", ${JSON.stringify(shot.locale ?? "zh-CN")}); true`
  );
  await page.goto(`${demo.baseUrl}/`);
  // Both views start hidden until the auth check answers; decide only once one of them shows
  const visible = (id: string): string => `!document.getElementById('${id}').classList.contains('hidden')`;
  await page.waitUntil(`${visible("loginView")} || ${visible("appView")}`, "the sign-in page or the console");
  const needsLogin = await page.evaluate<boolean>(visible("loginView"));
  if (needsLogin) {
    await page.evaluate(`document.getElementById('loginToken').value = ${JSON.stringify(TOKEN)}; document.getElementById('loginForm').requestSubmit(); true`);
  }
  await page.waitUntil("document.getElementById('appView') && !document.getElementById('appView').classList.contains('hidden')", "the console");
  if (shot.scenario !== "breaker") {
    await page.waitUntil("document.querySelector('#operatorCard')?.textContent?.length > 40", "telemetry");
    await page.waitUntil("document.querySelectorAll('#chartsCard svg path').length > 2", "the charts");
  }
  await sleep(800);
}

/**
 * The home page's theme wipe: the dashboard is captured once per palette with its live stream closed, so
 * every picture shows the same numbers and only the colours change between them.
 */
async function captureThemes(chrome: ChromeHandle, demo: DemoDaemon): Promise<void> {
  const page = await openPage(chrome);
  // Keep the console's event streams within reach; close() fires no error event, so it does not reconnect
  await page.send("Page.addScriptToEvaluateOnNewDocument", {
    source: "window.__fsStreams = []; window.EventSource = class extends window.EventSource { constructor(...args) { super(...args); window.__fsStreams.push(this); } };",
  });
  await page.viewport(DESKTOP);
  await signIn(page, demo, { name: "themes", scenario: "normal", theme: SHOWCASE_THEMES[0] });
  await page.waitUntil("document.getElementById('toasts')?.childElementCount === 0", "toasts to clear", 12_000).catch(() => undefined);
  // No more updates, and a clock that stands still so "updated just now" stays as it is
  await page.evaluate("for (const stream of window.__fsStreams) stream.close(); const now = Date.now(); Date.now = () => now; true");
  // Let the last update's transitions (gauges, counters) settle
  await sleep(2000);
  for (const id of SHOWCASE_THEMES) {
    await page.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(id)}; document.documentElement.dataset.scheme = ${JSON.stringify(THEME_META[id].scheme)}; true`);
    await sleep(300);
    const file = path.join(OUT_DIR, showcaseImage(id));
    await page.capture(file, false, DESKTOP);
    console.log(`  ${path.basename(file)}  ${(fs.statSync(file).size / 1024).toFixed(0)} KiB`);
  }
}

async function main(): Promise<void> {
  if (!fs.existsSync(path.join(ROOT, "dist", "web", "public", "index.html"))) throw new Error("build the console first: npm run build:web");
  const only = new Set(process.argv.slice(2));
  const shots = SHOTS.filter((s) => only.size === 0 || only.has(s.name));
  const themes = only.size === 0 || only.has("themes");
  if (shots.length === 0 && !themes) throw new Error(`unknown shot(s); known: ${[...SHOTS.map((s) => s.name), "themes"].join(", ")}`);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const chrome = await launchChrome();
  const worlds = new Map<Scenario, DemoDaemon>();
  try {
    const page = await openPage(chrome);
    for (const shot of shots) {
      let demo = worlds.get(shot.scenario);
      if (!demo) {
        demo = await startWorld(shot.scenario);
        worlds.set(shot.scenario, demo);
      }
      const view = shot.viewport ?? DESKTOP;
      await page.viewport(view);
      await signIn(page, demo, shot);
      await shot.prepare?.(page, demo);
      // Toasts (an alert, a saved setting) fade on their own; never let one cover the picture
      await page.waitUntil("document.getElementById('toasts')?.childElementCount === 0", "toasts to clear", 12_000).catch(() => undefined);
      await sleep(500);
      const file = path.join(OUT_DIR, `${shot.name}.webp`);
      await page.capture(file, shot.fullPage === true, view);
      console.log(`  ${shot.name}.webp  ${(fs.statSync(file).size / 1024).toFixed(0)} KiB`);
    }
    if (themes) {
      const demo = worlds.get("normal") ?? (await startWorld("normal"));
      worlds.set("normal", demo);
      await captureThemes(chrome, demo);
    }
  } finally {
    await closeChrome(chrome);
    for (const demo of worlds.values()) await demo.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main().catch((err: unknown) => {
    process.stderr.write(`screenshots: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
