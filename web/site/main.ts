/**
 * The documentation site's only script (built by scripts/build-docs.ts): light / dark theme, copy buttons,
 * ⌘K search over a prebuilt index, the mobile menu, the "on this page" highlight and the not-found page. No
 * imports, no network beyond the site's own search index, no storage beyond the chosen theme.
 */

interface SearchEntry {
  title: string;
  section: string;
  url: string;
  /** Each heading with the text under it (`body`), so a term deep in a long page finds its section. */
  headings: ReadonlyArray<{ text: string; id: string; body?: string }>;
  text: string;
}

interface SearchHit {
  title: string;
  where: string;
  url: string;
  snippet: string;
  score: number;
}

const root = document.documentElement;
const base = root.dataset["root"] ?? "./";

function storedTheme(): string | null {
  try {
    return localStorage.getItem("fengsui-site-theme");
  } catch {
    return null;
  }
}

function applyTheme(theme: string | null): void {
  const dark = theme === "dark" || (theme !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  root.dataset["theme"] = dark ? "dark" : "light";
}

applyTheme(storedTheme());
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => applyTheme(storedTheme()));

document.querySelector<HTMLButtonElement>("[data-theme-toggle]")?.addEventListener("click", () => {
  const next = root.dataset["theme"] === "dark" ? "light" : "dark";
  try {
    localStorage.setItem("fengsui-site-theme", next);
  } catch {
    // Private windows: the choice lasts for this page only
  }
  applyTheme(next);
});

// ---------- Copy ----------
const copiedLabel = root.lang.startsWith("zh") ? "已复制" : "Copied";
async function copy(text: string, button: HTMLElement): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    button.dataset["copied"] = "true";
    button.setAttribute("aria-label", copiedLabel);
    window.setTimeout(() => {
      delete button.dataset["copied"];
      button.setAttribute("aria-label", button.dataset["label"] ?? "");
    }, 1600);
  } catch {
    // No clipboard permission: the text stays selectable
  }
}

for (const chip of document.querySelectorAll<HTMLButtonElement>("[data-copy]")) {
  chip.addEventListener("click", () => void copy(chip.dataset["copy"] ?? "", chip));
}

const copyLabel = root.lang.startsWith("zh") ? "复制" : "Copy";
for (const pre of document.querySelectorAll<HTMLPreElement>(".article pre")) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "pre-copy";
  button.dataset["label"] = copyLabel;
  button.setAttribute("aria-label", copyLabel);
  button.textContent = copyLabel;
  button.addEventListener("click", () => void copy(pre.querySelector("code")?.textContent ?? pre.textContent ?? "", button));
  pre.appendChild(button);
}

// ---------- Mobile menu ----------
const menu = document.querySelector<HTMLElement>("[data-sidebar]");
document.querySelector<HTMLButtonElement>("[data-menu-toggle]")?.addEventListener("click", (event) => {
  const open = menu?.dataset["open"] !== "true";
  if (menu) menu.dataset["open"] = String(open);
  (event.currentTarget as HTMLButtonElement).setAttribute("aria-expanded", String(open));
});

// ---------- On this page ----------
const tocLinks = [...document.querySelectorAll<HTMLAnchorElement>("[data-toc] a")];
if (tocLinks.length > 0 && "IntersectionObserver" in window) {
  const byId = new Map(tocLinks.map((a) => [decodeURIComponent(a.hash.slice(1)), a]));
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        for (const a of tocLinks) a.removeAttribute("aria-current");
        byId.get(entry.target.id)?.setAttribute("aria-current", "true");
      }
    },
    { rootMargin: "0px 0px -70% 0px" }
  );
  for (const id of byId.keys()) {
    const target = document.getElementById(id);
    if (target) observer.observe(target);
  }
}

// ---------- Search ----------
const dialog = document.querySelector<HTMLDialogElement>("#search");
const input = dialog?.querySelector<HTMLInputElement>("input");
const results = dialog?.querySelector<HTMLElement>("[data-results]");
const popular = dialog?.querySelector<HTMLElement>("[data-popular]");
const count = dialog?.querySelector<HTMLElement>("[data-count]");
let index: SearchEntry[] | null = null;
let active = 0;

async function loadIndex(): Promise<SearchEntry[]> {
  if (index) return index;
  const url = root.dataset["search"];
  if (!url) return [];
  try {
    const res = await fetch(base + url);
    index = (await res.json()) as SearchEntry[];
  } catch {
    index = [];
  }
  return index;
}

function snippetOf(text: string, at: number, length: number): string {
  const start = Math.max(0, at - 40);
  return `${start > 0 ? "…" : ""}${text.slice(start, at + length + 80)}…`;
}

function search(entries: ReadonlyArray<SearchEntry>, query: string): SearchHit[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  const hits: SearchHit[] = [];
  for (const entry of entries) {
    const title = entry.title.toLowerCase();
    const text = entry.text.toLowerCase();
    let score = 0;
    let missing = false;
    const inBody = (term: string): { text: string; id: string; body?: string } | undefined => entry.headings.find((h) => (h.body ?? "").toLowerCase().includes(term));
    for (const term of terms) {
      const inTitle = title.includes(term);
      const heading = entry.headings.find((h) => h.text.toLowerCase().includes(term));
      const body = heading ? undefined : inBody(term);
      const inText = text.includes(term);
      if (!inTitle && !heading && !body && !inText) missing = true;
      score += (inTitle ? 10 : 0) + (heading ? 5 : 0) + (body ? 3 : 0) + (inText ? 1 : 0);
    }
    if (missing) continue;
    const first = terms[0] ?? "";
    const named = entry.headings.find((h) => h.text.toLowerCase().includes(first));
    const under = named ? undefined : inBody(first);
    const heading = named ?? under;
    if (heading && !title.includes(first)) {
      const body = heading.body ?? "";
      const at = under ? body.toLowerCase().indexOf(first) : -1;
      hits.push({ title: heading.text, where: `${entry.section} · ${entry.title}`, url: `${entry.url}#${heading.id}`, snippet: at >= 0 ? snippetOf(body, at, first.length) : "", score: score + 1 });
    }
    const at = text.indexOf(first);
    hits.push({ title: entry.title, where: entry.section, url: entry.url, snippet: at >= 0 ? snippetOf(entry.text, at, first.length) : "", score });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, 12);
}

function render(hits: ReadonlyArray<SearchHit>, query: string): void {
  if (!results || !popular || !count) return;
  popular.hidden = query.length > 0;
  results.replaceChildren();
  count.textContent = query ? `${hits.length}` : "";
  hits.forEach((hit, i) => {
    const a = document.createElement("a");
    a.href = base + hit.url;
    a.className = "search-hit";
    a.setAttribute("role", "option");
    if (i === active) a.setAttribute("aria-selected", "true");
    const t = document.createElement("span");
    t.className = "search-hit-title";
    t.textContent = hit.title;
    const w = document.createElement("span");
    w.className = "search-hit-where";
    w.textContent = hit.where;
    a.append(t, w);
    if (hit.snippet) {
      const s = document.createElement("span");
      s.className = "search-hit-snippet";
      s.textContent = hit.snippet;
      a.append(s);
    }
    results.append(a);
  });
  if (query && hits.length === 0) {
    const empty = document.createElement("p");
    empty.className = "search-empty";
    empty.textContent = root.lang.startsWith("zh") ? "没有找到相关页面" : "No matching pages";
    results.append(empty);
  }
}

async function update(): Promise<void> {
  const query = input?.value.trim() ?? "";
  active = 0;
  render(search(await loadIndex(), query), query);
}

function openSearch(): void {
  if (!dialog || dialog.open) return;
  dialog.showModal();
  input?.focus();
  input?.select();
  void loadIndex();
}

for (const button of document.querySelectorAll<HTMLButtonElement>("[data-search-open]")) button.addEventListener("click", openSearch);
input?.addEventListener("input", () => void update());
dialog?.addEventListener("click", (event) => {
  if (event.target === dialog) dialog.close();
});
dialog?.addEventListener("keydown", (event) => {
  const items = [...(results?.querySelectorAll<HTMLAnchorElement>(".search-hit") ?? [])];
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    if (items.length === 0) return;
    active = (active + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
    items.forEach((a, i) => (i === active ? a.setAttribute("aria-selected", "true") : a.removeAttribute("aria-selected")));
    items[active]?.scrollIntoView({ block: "nearest" });
  } else if (event.key === "Enter" && items[active]) {
    event.preventDefault();
    items[active]?.click();
  }
});
document.addEventListener("keydown", (event) => {
  const typing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;
  if ((event.key === "k" && (event.metaKey || event.ctrlKey)) || (event.key === "/" && !typing)) {
    event.preventDefault();
    openSearch();
  }
});

// The not-found page (served for any missing path): show the card in the address's language, and change the face when poked
if (root.dataset["notFound"] !== undefined) {
  const english = location.pathname.slice(new URL(base, location.href).pathname.length).startsWith("en/");
  for (const card of document.querySelectorAll<HTMLElement>("[data-nf]")) {
    const shown = (card.dataset["nf"] === "en") === english;
    card.hidden = !shown;
    if (shown) {
      root.lang = card.dataset["nf"] ?? root.lang;
      document.title = card.dataset["title"] ?? document.title;
    }
  }
  const faces = ["(´・ω・`)", "(・_・;)", "(°ロ°) !", "¯\\_(ツ)_/¯", "(｡•ㅅ•｡)?"];
  for (const face of document.querySelectorAll<HTMLButtonElement>("[data-nf-face]")) {
    let at = 0;
    face.addEventListener("click", () => {
      at = (at + 1) % faces.length;
      face.textContent = faces[at] ?? faces[0] ?? "";
    });
  }
}

// The home page's theme wipe: scrolling through the section uncovers each palette over the last, on a slant
const themes = document.querySelector<HTMLElement>("[data-themes]");
if (themes) setUpThemeWipe(themes);

function setUpThemeWipe(section: HTMLElement): void {
  const track = section.querySelector<HTMLElement>("[data-themes-track]");
  const sticky = section.querySelector<HTMLElement>("[data-themes-sticky]");
  const layers = [...section.querySelectorAll<HTMLElement>("[data-theme-layer]")];
  const chips = [...section.querySelectorAll<HTMLButtonElement>("[data-theme-chip]")];
  if (!track || !sticky || layers.length < 2) return;
  /** How far the cut leans, in percent of the width (matches site.css). */
  const slant = 40;
  const steps = layers.length - 1;
  section.classList.add("themes-live");
  track.style.setProperty("--steps", String(steps));
  const range = (): { start: number; length: number } => {
    const stickTop = Number.parseFloat(getComputedStyle(sticky).top) || 0;
    const start = track.getBoundingClientRect().top + window.scrollY - stickTop;
    return { start, length: Math.max(1, track.offsetHeight - sticky.offsetHeight) };
  };
  let frame = 0;
  const update = (): void => {
    frame = 0;
    const { start, length } = range();
    const position = Math.min(1, Math.max(0, (window.scrollY - start) / length)) * steps;
    layers.forEach((layer, i) => {
      if (i === 0) return;
      const shown = Math.min(1, Math.max(0, position - (i - 1)));
      layer.style.setProperty("--wipe", String(-slant + shown * (100 + slant)));
    });
    const current = Math.round(position);
    chips.forEach((chip, i) => chip.setAttribute("aria-pressed", String(i === current)));
  };
  const schedule = (): void => {
    if (frame === 0) frame = requestAnimationFrame(update);
  };
  window.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("resize", schedule);
  chips.forEach((chip, i) =>
    chip.addEventListener("click", () => {
      const { start, length } = range();
      const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      window.scrollTo({ top: Math.ceil(start + (i / steps) * length), behavior: smooth ? "smooth" : "auto" });
    })
  );
  update();
}
