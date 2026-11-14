import { DOCS_SITE } from "../core/help.ts";
import type { EventSourceLike } from "../core/sse.ts";
import { startApp } from "../ui/app.ts";
import type { DemoRuntime, DemoWorld } from "./runtime.ts";

/**
 * Entry of the static GitHub Pages demo (`npm run build:demo`): the unchanged web console, wired to
 * FengSui's own services running in the page (./runtime.ts) in front of a demo router. They load
 * while the console draws itself, and nothing leaves the page.
 * `?router=other` opens it on an LTE-only Huawei model FengSui was not verified on instead of the
 * H168-383, so visitors can see what FengSui does there: the experimental writes with their switches, and the device report.
 * `?router=zte` opens it on a ZTE mobile router, read and written through FengSui's ZTE driver: its
 * battery, SIM card and SMS.
 */

const NOTICE = {
  "zh-CN": {
    text: "演示模式：数据都是虚构的，所有操作只在这个页面里生效，刷新即复原。",
    other: "演示模式：现在模拟的是一台烽燧没验证过的华为路由器，数据都是虚构的，刷新即复原。",
    zte: "演示模式：现在模拟的是一台中兴随身路由器（烽燧没在真机上验证过），数据都是虚构的，刷新即复原。",
    toOther: "看看烽燧在其他华为型号上怎么工作 →",
    toZte: "看看一台中兴随身路由器 →",
    toVerified: "换回 H168-383",
    devices: "每个型号能做什么",
    link: "关于演示",
    close: "关闭提示",
  },
  en: {
    text: "Demo mode: every value is fictional, and changes stay in this page until you reload.",
    other: "Demo mode: this is a Huawei router FengSui was not verified on. Every value is fictional, and changes stay in this page until you reload.",
    zte: "Demo mode: this is a ZTE mobile router FengSui was not verified on. Every value is fictional, and changes stay in this page until you reload.",
    toOther: "See how FengSui works on other Huawei models →",
    toZte: "See a ZTE mobile router →",
    toVerified: "Back to the H168-383",
    devices: "What works on each model",
    link: "About the demo",
    close: "Dismiss",
  },
} as const;
const ABOUT_URL = "https://github.com/cky008/fengsui-demo#readme";
const WORLD: DemoWorld = ((): DemoWorld => {
  const router = new URLSearchParams(window.location.search).get("router");
  return router === "other" || router === "zte" ? router : "verified";
})();
/** Dismissed per router: each other router's notice is also the way back. */
const DISMISS_KEY = WORLD === "verified" ? "fengsui.demo.notice-dismissed" : `fengsui.demo.notice-dismissed.${WORLD}`;

/** This page on another of the demo's routers (the open view kept). */
function worldUrl(world: DemoWorld): string {
  const url = new URL(window.location.href);
  if (world === "verified") url.searchParams.delete("router");
  else url.searchParams.set("router", world);
  return url.toString();
}

/** The other two routers, in the order the notice offers them. */
const SWITCHES: Readonly<Record<DemoWorld, ReadonlyArray<DemoWorld>>> = { verified: ["other", "zte"], other: ["verified", "zte"], zte: ["verified", "other"] };

function mountNotice(): void {
  try {
    if (window.sessionStorage.getItem(DISMISS_KEY) === "1") return;
  } catch {
    // Storage blocked: show the notice every time
  }
  const bar = document.createElement("div");
  bar.setAttribute("role", "note");
  bar.className = "relative z-40 flex flex-wrap items-center justify-center gap-x-2 gap-y-0.5 px-10 py-1.5 text-xs text-center bg-primary/10 text-base-content/80";
  const text = document.createElement("span");
  const linkClass = "font-medium text-primary underline underline-offset-2 whitespace-nowrap";
  // Tailwind utilities: the console's daisyUI build leaves its link component out
  const switchers = SWITCHES[WORLD].map((world) => {
    const a = document.createElement("a");
    a.href = worldUrl(world);
    a.className = linkClass;
    a.dataset["world"] = world;
    return a;
  });
  // On the other router: the Supported devices page, every model and what FengSui does on it
  const devices = document.createElement("a");
  devices.target = "_blank";
  devices.rel = "noopener noreferrer";
  devices.className = linkClass;
  const link = document.createElement("a");
  link.href = ABOUT_URL;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.className = linkClass;
  const close = document.createElement("button");
  close.type = "button";
  close.className = "btn btn-ghost btn-xs btn-square absolute right-2 top-1/2 -translate-y-1/2";
  close.textContent = "✕";
  close.addEventListener("click", () => {
    bar.remove();
    try {
      window.sessionStorage.setItem(DISMISS_KEY, "1");
    } catch {
      // Storage blocked: dismissed for this view only
    }
  });
  const render = (): void => {
    const copy = document.documentElement.lang === "en" ? NOTICE.en : NOTICE["zh-CN"];
    text.textContent = WORLD === "other" ? copy.other : WORLD === "zte" ? copy.zte : copy.text;
    const label: Readonly<Record<DemoWorld, string>> = { verified: copy.toVerified, other: copy.toOther, zte: copy.toZte };
    for (const a of switchers) a.textContent = label[(a.dataset["world"] ?? "verified") as DemoWorld];
    link.textContent = copy.link;
    devices.textContent = copy.devices;
    devices.href = `${DOCS_SITE}${document.documentElement.lang === "en" ? "en/" : ""}docs/supported-devices/`;
    close.setAttribute("aria-label", copy.close);
  };
  render();
  // The console sets <html lang> when the language is switched
  new MutationObserver(render).observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
  bar.append(text, ...switchers, ...(WORLD !== "verified" ? [devices] : []), link, close);
  document.body.prepend(bar);
}

/**
 * An `EventSource` the console can hold before the services are up: listeners wait, then go to the
 * stream the page's event bus opens.
 */
class LateEventSource implements EventSourceLike {
  readonly #listeners: Array<[string, (event: { data?: unknown }) => void]> = [];
  #inner: EventSourceLike | null = null;
  #closed = false;

  constructor(opening: Promise<(url: string) => EventSourceLike>, url: string) {
    void opening.then((open) => {
      if (this.#closed) return;
      this.#inner = open(url);
      for (const [type, listener] of this.#listeners) this.#inner.addEventListener(type, listener);
    });
  }

  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    this.#listeners.push([type, listener]);
    this.#inner?.addEventListener(type, listener);
  }

  close(): void {
    this.#closed = true;
    this.#inner?.close();
  }
}

/** The daemon's services in the page: the backend dictionaries first, then the router of this world. */
async function startRuntime(): Promise<DemoRuntime> {
  const [{ seedFile }, { startDemoRuntime }, zh, en] = await Promise.all([
    import("./node/fs.ts"),
    import("./runtime.ts"),
    import("../../../locales/zh-CN.json", { with: { type: "json" } }),
    import("../../../locales/en.json", { with: { type: "json" } }),
  ]);
  // Where src/i18n.ts looks for them in a page (its working directory is the file system's root)
  seedFile("/locales/zh-CN.json", JSON.stringify(zh.default));
  seedFile("/locales/en.json", JSON.stringify(en.default));
  return startDemoRuntime({ world: WORLD, dataDir: "/data", autoReply: true });
}

function showFailure(err: unknown): void {
  const message = document.createElement("p");
  message.className = "p-6 text-center text-sm";
  message.textContent = `The demo could not start: ${err instanceof Error ? err.message : String(err)}`;
  document.body.prepend(message);
}

declare global {
  interface Window {
    /** The page's own back end, for the browser tests (test/ui/demo.test.ts): what the console's `fetch` reaches. */
    __fengsuiDemo?: { fetch: typeof fetch };
  }
}

async function boot(): Promise<void> {
  const runtime = startRuntime();
  runtime.catch(showFailure);
  window.__fengsuiDemo = { fetch: async (input, init) => (await runtime).transport.fetch(input, init) };
  mountNotice();
  await startApp({
    fetchImpl: async (input, init) => (await runtime).transport.fetch(input, init),
    createEventSource: (url) => new LateEventSource(runtime.then((r) => r.transport.createEventSource), url),
    demo: true,
  });
}

boot().catch(showFailure);
