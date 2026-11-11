import { DOCS_SITE } from "../core/help.ts";
import { startApp } from "../ui/app.ts";
import { DemoBackend } from "./backend.ts";
import { readDemoSeed, rebaseSeed } from "./seed.ts";

/**
 * Entry of the static GitHub Pages demo (`npm run build:demo`): the unchanged web console, wired to
 * an in-page backend instead of a daemon. Only the seed file is fetched; nothing else leaves the page.
 * `?router=other` opens it on an LTE-only Huawei model FengSui was not verified on instead of the
 * H168-383, so visitors can see what FengSui does there: the experimental writes with their switches, and the device report.
 */

const NOTICE = {
  "zh-CN": {
    text: "演示模式：数据都是虚构的，所有操作只在这个页面里生效，刷新即复原。",
    other: "演示模式：现在模拟的是一台烽燧没验证过的华为路由器，数据都是虚构的，刷新即复原。",
    toOther: "看看烽燧在其他华为型号上怎么工作 →",
    toVerified: "换回 H168-383",
    devices: "每个型号能做什么",
    link: "关于演示",
    close: "关闭提示",
  },
  en: {
    text: "Demo mode: every value is fictional, and changes stay in this page until you reload.",
    other: "Demo mode: this is a Huawei router FengSui was not verified on. Every value is fictional, and changes stay in this page until you reload.",
    toOther: "See how FengSui works on other Huawei models →",
    toVerified: "Back to the H168-383",
    devices: "What works on each model",
    link: "About the demo",
    close: "Dismiss",
  },
} as const;
const ABOUT_URL = "https://github.com/cky008/fengsui-demo#readme";
/** The demo opened on the other router (`?router=other`). */
const OTHER_ROUTER = new URLSearchParams(window.location.search).get("router") === "other";
/** Dismissed per router: the other router's notice is also the way back. */
const DISMISS_KEY = OTHER_ROUTER ? "fengsui.demo.notice-dismissed.other" : "fengsui.demo.notice-dismissed";

/** This page on the other router, or back on the H168-383 (the open view kept). */
function switchUrl(): string {
  const url = new URL(window.location.href);
  if (OTHER_ROUTER) url.searchParams.delete("router");
  else url.searchParams.set("router", "other");
  return url.toString();
}

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
  // Tailwind utilities: the console's daisyUI build leaves its link component out
  const linkClass = "font-medium text-primary underline underline-offset-2 whitespace-nowrap";
  const switcher = document.createElement("a");
  switcher.href = switchUrl();
  switcher.className = linkClass;
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
    text.textContent = OTHER_ROUTER ? copy.other : copy.text;
    switcher.textContent = OTHER_ROUTER ? copy.toVerified : copy.toOther;
    link.textContent = copy.link;
    devices.textContent = copy.devices;
    devices.href = `${DOCS_SITE}${document.documentElement.lang === "en" ? "en/" : ""}docs/supported-devices/`;
    close.setAttribute("aria-label", copy.close);
  };
  render();
  // The console sets <html lang> when the language is switched
  new MutationObserver(render).observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
  bar.append(text, switcher, ...(OTHER_ROUTER ? [devices] : []), link, close);
  document.body.prepend(bar);
}

async function boot(): Promise<void> {
  const res = await window.fetch(new URL(OTHER_ROUTER ? "demo-seed-other.json" : "demo-seed.json", document.baseURI), { cache: "no-cache" });
  if (!res.ok) throw new Error(`demo seed: HTTP ${res.status}`);
  const seed = rebaseSeed(readDemoSeed(await res.json()), Date.now());
  const backend = new DemoBackend({ seed });
  backend.start();
  mountNotice();
  await startApp({ fetchImpl: backend.fetch, createEventSource: backend.createEventSource, demo: true });
}

boot().catch((err: unknown) => {
  const message = document.createElement("p");
  message.className = "p-6 text-center text-sm";
  message.textContent = `The demo could not start: ${err instanceof Error ? err.message : String(err)}`;
  document.body.prepend(message);
});
