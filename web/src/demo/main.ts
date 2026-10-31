import { startApp } from "../ui/app.ts";
import { DemoBackend } from "./backend.ts";
import { readDemoSeed, rebaseSeed } from "./seed.ts";

/**
 * Entry of the static GitHub Pages demo (`npm run build:demo`): the unchanged web console, wired to
 * an in-page backend instead of a daemon. Only the seed file is fetched; nothing else leaves the page.
 */

const NOTICE = {
  "zh-CN": { text: "演示模式：数据都是虚构的，所有操作只在这个页面里生效，刷新即复原。", link: "关于演示", close: "关闭提示" },
  en: { text: "Demo mode: every value is fictional, and changes stay in this page until you reload.", link: "About the demo", close: "Dismiss" },
} as const;
const ABOUT_URL = "https://github.com/cky008/fengsui-demo#readme";
const DISMISS_KEY = "fengsui.demo.notice-dismissed";

function mountNotice(): void {
  try {
    if (window.sessionStorage.getItem(DISMISS_KEY) === "1") return;
  } catch {
    // Storage blocked: show the notice every time
  }
  const bar = document.createElement("div");
  bar.setAttribute("role", "note");
  bar.className = "relative z-40 flex items-center justify-center gap-2 px-10 py-1.5 text-xs text-center bg-primary/10 text-base-content/80";
  const text = document.createElement("span");
  const link = document.createElement("a");
  link.href = ABOUT_URL;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.className = "link link-primary whitespace-nowrap";
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
    text.textContent = copy.text;
    link.textContent = copy.link;
    close.setAttribute("aria-label", copy.close);
  };
  render();
  // The console sets <html lang> when the language is switched
  new MutationObserver(render).observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
  bar.append(text, link, close);
  document.body.prepend(bar);
}

async function boot(): Promise<void> {
  const res = await window.fetch(new URL("demo-seed.json", document.baseURI), { cache: "no-cache" });
  if (!res.ok) throw new Error(`demo seed: HTTP ${res.status}`);
  const seed = rebaseSeed(readDemoSeed(await res.json()), Date.now());
  const backend = new DemoBackend({ seed });
  backend.start();
  mountNotice();
  await startApp({ fetchImpl: backend.fetch, createEventSource: backend.createEventSource });
}

boot().catch((err: unknown) => {
  const message = document.createElement("p");
  message.className = "p-6 text-center text-sm";
  message.textContent = `The demo could not start: ${err instanceof Error ? err.message : String(err)}`;
  document.body.prepend(message);
});
