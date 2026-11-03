import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { type DemoDaemon, startDemoDaemon } from "./demo-router.ts";

/**
 * Regenerate the README screenshots (docs/screenshots/*.webp) from the offline demo: the real daemon
 * against the in-process mock router (placeholder data only, no network, no .env), the built console,
 * and a headless Chrome driven over the DevTools protocol through Node's own WebSocket.
 *
 *   npm run build:web && npm run screenshots                 # every shot
 *   npm run screenshots -- dashboard-sujian mobile           # only these
 *   CHROME_PATH=/path/to/chrome npm run screenshots          # another Chrome / Chromium
 *
 * Run it before tagging a release, so the pictures land in the signed release commit.
 */

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT_DIR = path.join(ROOT, "docs", "screenshots");
const TOKEN = "fengsui-screenshots";

type Scenario = "normal" | "yield" | "breaker";

interface Shot {
  name: string;
  scenario: Scenario;
  theme: string;
  locale?: "zh-CN" | "en";
  viewport?: { width: number; height: number; scale: number; mobile: boolean };
  fullPage?: boolean;
  /** Brings the page into the state to capture, after the dashboard is ready. */
  prepare?: (page: Page, demo: DemoDaemon) => Promise<void>;
}

const DESKTOP = { width: 1440, height: 900, scale: 1, mobile: false };
const PHONE = { width: 390, height: 844, scale: 2, mobile: true };

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
      await page.waitUntil("document.querySelector('#bannerArea')?.textContent?.includes('真人用户正在访问官方后台') === true", "the avoidance banner", 30_000);
    },
  },
  {
    name: "breaker",
    scenario: "breaker",
    theme: "fengsui-sujian",
    prepare: async (page) => {
      await page.waitUntil("document.querySelector('#bannerArea')?.textContent?.includes('防爆破熔断已触发') === true", "the breaker banner", 30_000);
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
];

// ---------------------------------------------------------------- DevTools protocol client

interface CdpMessage {
  id?: number;
  method?: string;
  sessionId?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { message: string };
}

class Cdp {
  readonly #ws: WebSocket;
  #nextId = 0;
  readonly #pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();
  readonly #listeners = new Set<(msg: CdpMessage) => void>();

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(String(event.data)) as CdpMessage;
      if (msg.id !== undefined) {
        const waiter = this.#pending.get(msg.id);
        this.#pending.delete(msg.id);
        if (msg.error) waiter?.reject(new Error(msg.error.message));
        else waiter?.resolve(msg.result);
        return;
      }
      for (const listener of this.#listeners) listener(msg);
    });
  }

  static async connect(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error(`cannot reach Chrome at ${url}`)), { once: true });
    });
    return new Cdp(ws);
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    const id = ++this.#nextId;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: (value) => resolve(value as T), reject });
      this.#ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  /** The next event `method` for `sessionId`. */
  once(method: string, sessionId: string, timeoutMs = 30_000): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#listeners.delete(listener);
        reject(new Error(`timed out waiting for ${method}`));
      }, timeoutMs);
      const listener = (msg: CdpMessage): void => {
        if (msg.method !== method || msg.sessionId !== sessionId) return;
        clearTimeout(timer);
        this.#listeners.delete(listener);
        resolve(msg.params ?? {});
      };
      this.#listeners.add(listener);
    });
  }

  close(): void {
    this.#ws.close();
  }
}

class Page {
  readonly #cdp: Cdp;
  readonly #sessionId: string;

  constructor(cdp: Cdp, sessionId: string) {
    this.#cdp = cdp;
    this.#sessionId = sessionId;
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.#cdp.send<T>(method, params, this.#sessionId);
  }

  async evaluate<T = unknown>(expression: string): Promise<T> {
    const reply = await this.send<{ result?: { value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } }>("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text ?? "evaluation failed");
    return reply.result?.value as T;
  }

  async waitUntil(expression: string, what: string, timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.evaluate<boolean>(`Boolean(${expression})`).catch(() => false)) return;
      await sleep(150);
    }
    throw new Error(`timed out waiting for ${what}`);
  }

  async click(selector: string): Promise<void> {
    const found = await this.evaluate<boolean>(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`);
    if (!found) throw new Error(`nothing matches ${selector}`);
  }

  async clickText(selector: string, text: string): Promise<void> {
    const found = await this.evaluate<boolean>(
      `(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.textContent?.includes(${JSON.stringify(text)})); if (!el) return false; el.click(); return true; })()`
    );
    if (!found) throw new Error(`no ${selector} with "${text}"`);
  }

  async goto(url: string): Promise<void> {
    const loaded = this.#cdp.once("Page.loadEventFired", this.#sessionId);
    await this.send("Page.navigate", { url });
    await loaded;
  }

  async viewport(v: { width: number; height: number; scale: number; mobile: boolean }): Promise<void> {
    await this.send("Emulation.setDeviceMetricsOverride", { width: v.width, height: v.height, deviceScaleFactor: v.scale, mobile: v.mobile });
  }

  async capture(file: string, fullPage: boolean, v: { width: number; height: number; scale: number; mobile: boolean }): Promise<void> {
    if (fullPage) {
      const height = await this.evaluate<number>("Math.ceil(document.documentElement.scrollHeight)");
      await this.viewport({ ...v, height });
      await sleep(400);
    }
    const shot = await this.send<{ data: string }>("Page.captureScreenshot", { format: "webp", quality: 85 });
    fs.writeFileSync(file, Buffer.from(shot.data, "base64"));
    if (fullPage) await this.viewport(v);
  }
}

// ---------------------------------------------------------------- demo world and browser

function findChrome(): string {
  const candidates = [
    process.env["CHROME_PATH"],
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  const found = candidates.find((c): c is string => typeof c === "string" && c !== "" && fs.existsSync(c));
  if (!found) throw new Error("no Chrome or Chromium found: set CHROME_PATH");
  return found;
}

async function launchChrome(): Promise<{ cdp: Cdp; process: ChildProcess; profile: string }> {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "fengsui-shots-"));
  const child = spawn(
    findChrome(),
    ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--hide-scrollbars", "--mute-audio", "--disable-extensions", "about:blank"],
    { stdio: "ignore" }
  );
  const portFile = path.join(profile, "DevToolsActivePort");
  for (let i = 0; i < 150 && !fs.existsSync(portFile); i++) await sleep(100);
  const [port, wsPath] = fs.readFileSync(portFile, "utf8").trim().split("\n");
  return { cdp: await Cdp.connect(`ws://127.0.0.1:${port}${wsPath}`), process: child, profile };
}

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
  if (scenario !== "breaker") {
    // The first neighbor scan and settings read would otherwise wait for their own schedules
    await Promise.all([
      demo.stack.monitor.refreshNeighbors({ ignoreCooldown: true }),
      demo.stack.monitor.refreshSettings({ ignoreCooldown: true }),
      demo.stack.monitor.refreshAccessControl({ ignoreCooldown: true }),
    ]);
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

async function main(): Promise<void> {
  if (!fs.existsSync(path.join(ROOT, "dist", "web", "public", "index.html"))) throw new Error("build the console first: npm run build:web");
  const only = new Set(process.argv.slice(2));
  const shots = SHOTS.filter((s) => only.size === 0 || only.has(s.name));
  if (shots.length === 0) throw new Error(`unknown shot(s); known: ${SHOTS.map((s) => s.name).join(", ")}`);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const chrome = await launchChrome();
  const worlds = new Map<Scenario, DemoDaemon>();
  try {
    const { targetId } = await chrome.cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await chrome.cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
    const page = new Page(chrome.cdp, sessionId);
    await page.send("Page.enable");
    await page.send("Runtime.enable");
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
  } finally {
    chrome.cdp.close();
    chrome.process.kill();
    for (const demo of worlds.values()) await demo.close();
    fs.rmSync(chrome.profile, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main().catch((err: unknown) => {
    process.stderr.write(`screenshots: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
