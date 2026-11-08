import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

/**
 * A zero-dependency Chrome DevTools driver over Node's own WebSocket: launch a headless Chrome or
 * Chromium, open a page, evaluate, wait, click and capture. `npm run screenshots` and the console's
 * browser tests (`npm run test:ui`) share it; the pages it opens are the console on 127.0.0.1.
 */

export interface CdpMessage {
  id?: number;
  method?: string;
  sessionId?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { message: string };
}

export interface Viewport {
  width: number;
  height: number;
  scale: number;
  mobile: boolean;
}

export class Cdp {
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

  /** Every event from now on; returns the unsubscribe. */
  onEvent(listener: (msg: CdpMessage) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** The next event `method` for `sessionId`. */
  once(method: string, sessionId: string, timeoutMs = 30_000): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error(`timed out waiting for ${method}`));
      }, timeoutMs);
      const unsubscribe = this.onEvent((msg) => {
        if (msg.method !== method || msg.sessionId !== sessionId) return;
        clearTimeout(timer);
        unsubscribe();
        resolve(msg.params ?? {});
      });
    });
  }

  close(): void {
    this.#ws.close();
  }
}

export class Page {
  readonly #cdp: Cdp;
  readonly #sessionId: string;
  /** Uncaught exceptions the page threw (a browser test fails on any). */
  readonly exceptions: string[] = [];

  constructor(cdp: Cdp, sessionId: string) {
    this.#cdp = cdp;
    this.#sessionId = sessionId;
    cdp.onEvent((msg) => {
      if (msg.sessionId !== sessionId || msg.method !== "Runtime.exceptionThrown") return;
      const details = msg.params?.["exceptionDetails"] as { text?: string; exception?: { description?: string } } | undefined;
      this.exceptions.push(details?.exception?.description ?? details?.text ?? "exception");
    });
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

  async viewport(v: Viewport): Promise<void> {
    await this.send("Emulation.setDeviceMetricsOverride", { width: v.width, height: v.height, deviceScaleFactor: v.scale, mobile: v.mobile });
  }

  async capture(file: string, fullPage: boolean, v: Viewport): Promise<void> {
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

export function findChrome(): string {
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

export interface ChromeHandle {
  cdp: Cdp;
  process: ChildProcess;
  profile: string;
}

export async function launchChrome(): Promise<ChromeHandle> {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "fengsui-chrome-"));
  const child = spawn(
    findChrome(),
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--hide-scrollbars",
      "--mute-audio",
      "--disable-extensions",
      // CI runners restrict the user namespaces Chrome's sandbox needs; there it only ever loads the console on 127.0.0.1
      ...(process.env["CI"] === "true" ? ["--no-sandbox"] : []),
      "about:blank",
    ],
    { stdio: "ignore" }
  );
  const portFile = path.join(profile, "DevToolsActivePort");
  for (let i = 0; i < 300 && !fs.existsSync(portFile); i++) await sleep(100);
  if (!fs.existsSync(portFile)) {
    child.kill();
    throw new Error("Chrome did not open its DevTools port within 30 s");
  }
  const [port, wsPath] = fs.readFileSync(portFile, "utf8").trim().split("\n");
  return { cdp: await Cdp.connect(`ws://127.0.0.1:${port}${wsPath}`), process: child, profile };
}

/** A new tab, attached, with page and runtime events on. */
export async function openPage(chrome: ChromeHandle): Promise<Page> {
  const { targetId } = await chrome.cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await chrome.cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
  const page = new Page(chrome.cdp, sessionId);
  await page.send("Page.enable");
  await page.send("Runtime.enable");
  return page;
}

/** Quit Chrome and remove its profile once it has exited (it writes there until the end). */
export async function closeChrome(chrome: ChromeHandle): Promise<void> {
  chrome.cdp.close();
  if (chrome.process.exitCode === null && chrome.process.signalCode === null) {
    const exited = new Promise((resolve) => chrome.process.once("exit", resolve));
    chrome.process.kill();
    await exited;
  }
  fs.rmSync(chrome.profile, { recursive: true, force: true, maxRetries: 3 });
}
