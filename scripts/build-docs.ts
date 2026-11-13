import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { build } from "esbuild";
import { readBrandMark } from "./brand.ts";
import { type MarkdownHeading, escapeHtml, parseFrontMatter, renderMarkdown } from "./markdown.ts";
import { type SiteLocale, homeMeta, renderHome } from "./site-home.ts";

/**
 * The documentation site (GitHub Pages, .github/workflows/docs-pages.yml): a home page and the user guide in
 * docs/guide/{zh,en}, rendered with the zero-dependency scripts/markdown.ts and the console's own Tailwind
 * toolchain. Every link is relative, so the same files work under a project path or a custom domain.
 * The pages never name the domain: `DOCS_SITE_URL` (an Actions variable) adds the canonical URLs, hreflang
 * pairs, Open Graph image and sitemap at deploy time; without it those are left out. (The READMEs, the release
 * notes and the console's "?" marks link to https://fengsui.iocky.com/ directly.)
 *
 *   node --experimental-strip-types scripts/build-docs.ts [--out dist/site]
 */

export const REPO_URL = "https://github.com/cky008/cpe-dash";
export const DEMO_URL = "https://cky008.github.io/fengsui-demo/";
/** The author's site (the console's footer links it too) and the sponsor pages of .github/FUNDING.yml. */
export const AUTHOR_URL = "https://iocky.com/";
export const SPONSOR_URLS = { github: "https://github.com/sponsors/cky008", coffee: "https://buymeacoffee.com/iocky" } as const;
const SITE_NAME = "烽燧 FengSui";
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'";
const ICONS_USED = ["i-signal", "i-lock", "i-inbox", "i-network", "i-bell", "i-cpu", "i-eye", "i-shield", "i-key", "i-layers", "i-search", "i-sun", "i-moon", "i-copy", "i-github", "i-languages", "i-x", "i-heart"];
const MENU_ICON = '<symbol id="i-menu" viewBox="0 0 24 24"><path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h16"/></symbol>';

interface LocaleInfo {
  locale: SiteLocale;
  /** Folder under docs/guide. */
  dir: "zh" | "en";
  /** Path of this language's pages from the site root. */
  prefix: "" | "en/";
  ogLocale: string;
}

const LOCALES: ReadonlyArray<LocaleInfo> = [
  { locale: "zh-CN", dir: "zh", prefix: "", ogLocale: "zh_CN" },
  { locale: "en", dir: "en", prefix: "en/", ogLocale: "en_US" },
];

const UI = {
  "zh-CN": {
    docs: "文档",
    demo: "在线演示",
    search: "搜索文档",
    searchPlaceholder: "搜索文档…",
    popular: "常用页面",
    theme: "切换浅色 / 深色",
    otherLanguage: "English",
    menu: "文档目录",
    onThisPage: "本页内容",
    previous: "上一页",
    next: "下一页",
    edit: "在 GitHub 上编辑此页",
    skip: "跳到正文",
    footerDocs: "文档",
    footerProject: "项目",
    footerSupport: "支持烽燧",
    footerLegal: "许可与声明",
    releases: "版本发布",
    changelog: "更新日志",
    security: "安全策略",
    contributing: "参与贡献",
    sponsor: "在 GitHub 上赞助",
    coffee: "请作者喝杯咖啡",
    author: "作者主页",
    license: "许可证（PolyForm Noncommercial 1.0.0）",
    notices: "第三方声明",
    disclaimer: "烽燧是独立的开源项目，与华为、群晖及任何运营商均无关联，也未获其认可。所有商标归各自所有者。",
    notFound: "页面不存在",
    notFoundTitle: "这里收不到信号",
    notFoundLead: "这个地址上没有页面。可能是链接写错了，或者页面搬了家。",
    notFoundHome: "回到首页",
    notFoundDocs: "打开文档",
    notFoundMeter: "已扫描全部频段 · RSRP −∞ dBm · 没找到这一页",
    notFoundFace: "换个表情",
  },
  en: {
    docs: "Docs",
    demo: "Live demo",
    search: "Search the docs",
    searchPlaceholder: "Search the docs…",
    popular: "Popular pages",
    theme: "Toggle light / dark",
    otherLanguage: "中文",
    menu: "Docs menu",
    onThisPage: "On this page",
    previous: "Previous",
    next: "Next",
    edit: "Edit this page on GitHub",
    skip: "Skip to content",
    footerDocs: "Docs",
    footerProject: "Project",
    footerSupport: "Support FengSui",
    footerLegal: "Licence",
    releases: "Releases",
    changelog: "Changelog",
    security: "Security policy",
    contributing: "Contributing",
    sponsor: "Sponsor on GitHub",
    coffee: "Buy me a coffee",
    author: "The author's site",
    license: "Licence (PolyForm Noncommercial 1.0.0)",
    notices: "Third-party notices",
    disclaimer: "FengSui is an independent project, not affiliated with or endorsed by Huawei, Synology or any carrier. All trademarks belong to their owners.",
    notFound: "Page not found",
    notFoundTitle: "No signal here",
    notFoundLead: "There is no page at this address. The link may be mistyped, or the page has moved.",
    notFoundHome: "Back to the home page",
    notFoundDocs: "Open the docs",
    notFoundMeter: "Scanned every band · RSRP −∞ dBm · no page in range",
    notFoundFace: "Change the face",
  },
} as const;

const POPULAR = ["quick-start", "install", "configuration", "locking", "sms", "troubleshooting"];

interface GuidePage {
  slug: string;
  title: string;
  description: string;
  section: string;
  order: number;
  source: string;
  file: string;
}

interface RenderedPage extends GuidePage {
  html: string;
  headings: MarkdownHeading[];
  text: string;
  /** The text under each heading, by its id. */
  sections: Record<string, string>;
}

export interface SiteReport {
  pages: string[];
  out: string;
}

function hash(bytes: Buffer | string): string {
  return crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 10);
}

/**
 * A diagram from `docs/diagrams/`, inlined so its classes take the page's colours in both themes (an
 * `<img>` would follow the system's scheme, not the site's toggle). Only drawing goes in: no script, no
 * event attribute, no style (the CSP allows none), no link or embedded document, one `<svg>` with a
 * title. Throws on anything else.
 */
export function inlineDiagram(source: string, name: string): string {
  const svg = source.replace(/^<\?xml[^>]*\?>\s*/, "").trim();
  const refuse = (why: string): never => {
    throw new Error(`${name}: ${why}`);
  };
  if (!/^<svg\s[^>]*>[\s\S]*<\/svg>$/.test(svg) || (svg.match(/<svg[\s>]/g) ?? []).length !== 1) refuse("one <svg> element, nothing around it");
  if (/<script|<style|<foreignObject|<iframe|<image|<use\b/i.test(svg)) refuse("only shapes and text");
  if (/\son\w+\s*=|\sstyle\s*=|href\s*=|url\(\s*(?!#)/i.test(svg)) refuse("no event attributes, styles or links");
  if (!/<svg[^>]*\srole="img"/.test(svg) || !/<title[^>]*>[^<]+<\/title>/.test(svg)) refuse('role="img" and a <title>');
  return svg;
}

/** Width and height of a WebP from its VP8X / VP8 / VP8L header, so images reserve their space. */
export function webpSize(bytes: Buffer): { width: number; height: number } {
  const chunk = bytes.subarray(12, 16).toString("latin1");
  if (chunk === "VP8X") return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 };
  if (chunk === "VP8 ") return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  if (chunk === "VP8L") {
    const bits = bytes.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  throw new Error("not a WebP image");
}

function loadPages(root: string, dir: string): GuidePage[] {
  const folder = path.join(root, "docs", "guide", dir);
  return fs
    .readdirSync(folder)
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      const file = path.join(folder, f);
      const { meta, body } = parseFrontMatter(fs.readFileSync(file, "utf8"));
      const slug = f.replace(/\.md$/, "");
      for (const key of ["title", "description", "section", "order"]) {
        if (!meta[key]) throw new Error(`docs/guide/${dir}/${f}: front matter needs "${key}"`);
      }
      return { slug, title: meta["title"] ?? slug, description: meta["description"] ?? "", section: meta["section"] ?? "", order: Number(meta["order"]), source: body, file: `docs/guide/${dir}/${f}` };
    })
    .sort((a, b) => a.order - b.order);
}

function sectionsOf(pages: ReadonlyArray<GuidePage>): Array<{ name: string; pages: GuidePage[] }> {
  const out: Array<{ name: string; pages: GuidePage[] }> = [];
  for (const page of pages) {
    const section = out.find((s) => s.name === page.section);
    if (section) section.pages.push(page);
    else out.push({ name: page.section, pages: [page] });
  }
  return out;
}

function compileCss(root: string, tmpDir: string): string {
  const tmp = path.join(tmpDir, ".site.css");
  const bin = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "tailwindcss.cmd" : "tailwindcss");
  const run = spawnSync(bin, ["-i", path.join(root, "docs", "site", "site.css"), "-o", tmp, "--minify"], { cwd: root, encoding: "utf8" });
  if (run.status !== 0) throw new Error(`tailwindcss failed (${run.status}):\n${run.stderr}`);
  const css = fs.readFileSync(tmp, "utf8");
  fs.rmSync(tmp);
  return css;
}

async function bundleClient(root: string): Promise<string> {
  const result = await build({
    entryPoints: [path.join(root, "web", "site", "main.ts")],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: ["es2022", "safari16"],
    minify: true,
    legalComments: "none",
    write: false,
    logLevel: "warning",
  });
  const js = result.outputFiles?.[0]?.text;
  if (js === undefined) throw new Error("esbuild produced no output for web/site/main.ts");
  return js;
}

function sprite(root: string): string {
  const html = fs.readFileSync(path.join(root, "web", "index.html"), "utf8");
  const symbols = ICONS_USED.map((id) => {
    const m = new RegExp(`<symbol id="${id}"[^>]*>[\\s\\S]*?</symbol>`).exec(html);
    if (!m) throw new Error(`web/index.html has no icon ${id}`);
    return m[0];
  });
  const mark = readBrandMark(fs.readFileSync(path.join(root, "web", "brand", "logo.svg"), "utf8"));
  const brand = `<symbol id="i-mark" viewBox="0 0 100 100">${mark.paths.map((p) => `<path class="mark-${p.role}" d="${p.d}"/>`).join("")}</symbol>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" class="hidden" aria-hidden="true"><defs>${brand}${MENU_ICON}${symbols.join("")}</defs></svg>`;
}

export async function buildDocsSite(opts: { root?: string; out?: string; siteUrl?: string | null } = {}): Promise<SiteReport> {
  const root = opts.root ?? process.cwd();
  const out = opts.out ?? path.join(root, "dist", "site");
  // The output folder is emptied first: never one that holds the sources (`--out .` would take .git with it)
  const fromOut = path.relative(path.resolve(out), path.resolve(root));
  if (fromOut !== ".." && !fromOut.startsWith(`..${path.sep}`) && !path.isAbsolute(fromOut)) throw new Error(`refusing to empty ${path.resolve(out)}: it holds the sources`);
  const siteUrl = opts.siteUrl ? opts.siteUrl.replace(/\/?$/, "/") : null;
  if (siteUrl !== null && !/^https:\/\/[^/\s]+\/(?:[^\s]*)$/.test(siteUrl)) throw new Error(`DOCS_SITE_URL must be an https URL, got ${siteUrl}`);
  const version = (JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { version: string }).version;
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(path.join(out, "assets", "screenshots"), { recursive: true });

  const css = compileCss(root, out);
  const cssFile = `assets/site.${hash(css)}.css`;
  fs.writeFileSync(path.join(out, cssFile), css);
  const js = await bundleClient(root);
  const jsFile = `assets/site.${hash(js)}.js`;
  fs.writeFileSync(path.join(out, jsFile), js);
  const logo = fs.readFileSync(path.join(root, "web", "brand", "logo.svg"), "utf8");
  fs.writeFileSync(path.join(out, "favicon.svg"), logo);
  fs.copyFileSync(path.join(root, "THIRD_PARTY_NOTICES.md"), path.join(out, "THIRD_PARTY_NOTICES.txt"));
  fs.writeFileSync(path.join(out, ".nojekyll"), "");
  const icons = sprite(root);

  const images = new Map<string, { width: number; height: number }>();
  const useImage = (name: string): { width: number; height: number } => {
    const known = images.get(name);
    if (known) return known;
    const source = path.join(root, "docs", "screenshots", name);
    if (!/^[\w.-]+\.webp$/.test(name) || !fs.existsSync(source)) throw new Error(`no screenshot docs/screenshots/${name}`);
    const bytes = fs.readFileSync(source);
    fs.writeFileSync(path.join(out, "assets", "screenshots", name), bytes);
    const size = webpSize(bytes);
    images.set(name, size);
    return size;
  };

  const all = LOCALES.map((info) => ({ info, pages: loadPages(root, info.dir) }));
  const slugs = (pages: ReadonlyArray<GuidePage>): string => pages.map((p) => p.slug).sort().join(",");
  const [zh, en] = all;
  if (!zh || !en || slugs(zh.pages) !== slugs(en.pages)) throw new Error("docs/guide/zh and docs/guide/en must hold the same pages");

  const written: string[] = [];
  const write = (rel: string, html: string): void => {
    const file = path.join(out, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, html);
    written.push(rel);
  };
  const toRoot = (rel: string): string => "../".repeat(rel.split("/").length - 1);
  const absolute = (rel: string): string | null => (siteUrl ? siteUrl + rel.replace(/index\.html$/, "") : null);

  for (const { info, pages } of all) {
    const ui = UI[info.locale];
    const other = LOCALES.find((l) => l.locale !== info.locale) ?? info;
    const sections = sectionsOf(pages);
    const bySlug = new Map(pages.map((p) => [p.slug, p]));

    // Render every page first: links are checked against the full page list
    const rendered: RenderedPage[] = pages.map((page) => {
      const pageRel = `${info.prefix}docs/${page.slug}/index.html`;
      const r = renderMarkdown(page.source, {
        locale: info.locale,
        link: (href) => {
          if (/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(href)) return href;
          const [target = "", anchor] = href.split("#");
          const repoPath = path.posix.normalize(path.posix.join(path.posix.dirname(page.file), target));
          const guide = /^docs\/guide\/(zh|en)\/([\w-]+)\.md$/.exec(repoPath);
          if (guide) {
            const locale = LOCALES.find((l) => l.dir === guide[1]) ?? info;
            const sameLocale = locale.locale === info.locale;
            if (sameLocale && !bySlug.has(guide[2] ?? "")) throw new Error(`${page.file}: link to a missing page ${href}`);
            return `${toRoot(pageRel)}${locale.prefix}docs/${guide[2]}/${anchor ? `#${anchor}` : ""}`;
          }
          if (repoPath.startsWith("..") || !fs.existsSync(path.join(root, repoPath))) throw new Error(`${page.file}: link to a missing file ${href}`);
          return `${REPO_URL}/blob/main/${repoPath}${anchor ? `#${anchor}` : ""}`;
        },
        figure: (src) => {
          const repoPath = path.posix.normalize(path.posix.join(path.posix.dirname(page.file), src));
          const m = /^docs\/diagrams\/(zh|en)\/([\w-]+\.svg)$/.exec(repoPath);
          if (!m) return null;
          const file = path.join(root, repoPath);
          if (!fs.existsSync(file)) throw new Error(`${page.file}: no diagram ${repoPath}`);
          return inlineDiagram(fs.readFileSync(file, "utf8"), repoPath);
        },
        image: (src) => {
          const repoPath = path.posix.normalize(path.posix.join(path.posix.dirname(page.file), src));
          const m = /^docs\/screenshots\/([\w.-]+\.webp)$/.exec(repoPath);
          if (!m) throw new Error(`${page.file}: images must come from docs/screenshots (${src})`);
          useImage(m[1] ?? "");
          return `${toRoot(pageRel)}assets/screenshots/${m[1]}`;
        },
      });
      return { ...page, html: r.html, headings: r.headings, text: r.text, sections: r.sections };
    });

    const searchIndex = JSON.stringify(
      rendered.map((p) => ({
        title: p.title,
        section: p.section,
        url: `${info.prefix}docs/${p.slug}/`,
        // Each heading carries the text under it, so a term deep in a long page (a model on Supported devices) finds its section
        headings: p.headings.map((h) => ({ text: h.text, id: h.id, body: (p.sections[h.id] ?? "").slice(0, 4000) })),
        text: `${p.description} ${p.text}`.slice(0, 6000),
      }))
    );
    const searchFile = `assets/search.${info.locale}.${hash(searchIndex)}.json`;
    fs.writeFileSync(path.join(out, searchFile), searchIndex);

    const shell = (rel: string, otherRel: string, meta: { title: string; description: string; type: "website" | "article"; noindex?: boolean; jsonLd?: string }, main: string, menu: boolean): string => {
      const r = toRoot(rel);
      const url = absolute(rel);
      const otherUrl = absolute(otherRel);
      const zhUrl = info.locale === "zh-CN" ? url : otherUrl;
      const enUrl = info.locale === "en" ? url : otherUrl;
      const ogImage = siteUrl ? `${siteUrl}assets/screenshots/dashboard-sujian.webp` : null;
      if (ogImage) useImage("dashboard-sujian.webp");
      const e = escapeHtml;
      const head = [
        '<meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        `<title>${e(meta.title)}</title>`,
        `<meta name="description" content="${e(meta.description)}">`,
        `<meta http-equiv="Content-Security-Policy" content="${CSP}">`,
        '<meta name="color-scheme" content="light dark">',
        '<meta name="theme-color" content="#fbfbfd" media="(prefers-color-scheme: light)">',
        '<meta name="theme-color" content="#0b0d10" media="(prefers-color-scheme: dark)">',
        meta.noindex ? '<meta name="robots" content="noindex">' : "",
        url ? `<link rel="canonical" href="${e(url)}">` : "",
        url && !meta.noindex && zhUrl && enUrl ? `<link rel="alternate" hreflang="zh-CN" href="${e(zhUrl)}"><link rel="alternate" hreflang="en" href="${e(enUrl)}"><link rel="alternate" hreflang="x-default" href="${e(zhUrl)}">` : "",
        `<meta property="og:type" content="${meta.type}">`,
        `<meta property="og:site_name" content="${SITE_NAME}">`,
        `<meta property="og:title" content="${e(meta.title)}">`,
        `<meta property="og:description" content="${e(meta.description)}">`,
        `<meta property="og:locale" content="${info.ogLocale}">`,
        url ? `<meta property="og:url" content="${e(url)}">` : "",
        ogImage ? `<meta property="og:image" content="${e(ogImage)}"><meta property="og:image:width" content="1440"><meta property="og:image:height" content="900">` : "",
        `<meta name="twitter:card" content="${ogImage ? "summary_large_image" : "summary"}">`,
        `<link rel="icon" href="${r}favicon.svg" type="image/svg+xml">`,
        `<link rel="stylesheet" href="${r}${cssFile}">`,
        `<script src="${r}${jsFile}" defer></script>`,
        meta.jsonLd ? `<script type="application/ld+json">${meta.jsonLd}</script>` : "",
      ]
        .filter(Boolean)
        .join("\n");
      const docsHome = `${r}${info.prefix}docs/quick-start/`;
      const header = `
<header class="site-header">
  <div class="mx-auto max-w-7xl px-4 sm:px-6 h-16 flex items-center gap-3">
    ${menu ? `<button type="button" class="icon-btn lg:hidden" data-menu-toggle aria-expanded="false" aria-label="${ui.menu}"><svg class="svg-icon" aria-hidden="true"><use href="#i-menu"/></svg></button>` : ""}
    <a href="${r}${info.prefix}" class="flex items-center gap-2.5 shrink-0" aria-label="${SITE_NAME}">
      <svg class="w-8 h-8" aria-hidden="true"><use href="#i-mark"/></svg>
      <span class="font-semibold text-lg tracking-tight">烽燧</span><span class="faint hidden sm:inline text-sm">FengSui</span>
    </a>
    <span class="faint hidden sm:inline text-xs font-mono border hairline rounded-full px-2 py-0.5">v${e(version)}</span>
    <nav class="hidden md:flex items-center gap-6 ml-6 text-sm muted" aria-label="${ui.docs}">
      <a class="hover:text-current" href="${docsHome}">${ui.docs}</a>
      <a class="hover:text-current" href="${DEMO_URL}" rel="noopener" target="_blank">${ui.demo}</a>
      <a class="hover:text-current" href="${REPO_URL}" rel="noopener" target="_blank">GitHub</a>
    </nav>
    <div class="ml-auto flex items-center gap-1.5">
      <button type="button" class="search-btn" data-search-open aria-label="${ui.search}"><svg class="svg-icon w-4 h-4" aria-hidden="true"><use href="#i-search"/></svg><span class="hidden sm:inline pr-6">${ui.searchPlaceholder}</span><kbd class="hidden sm:inline">⌘K</kbd></button>
      <a class="icon-btn" href="${r}${otherRel.replace(/index\.html$/, "")}" hreflang="${other.locale}" lang="${other.locale}" aria-label="${ui.otherLanguage}" title="${ui.otherLanguage}"><svg class="svg-icon" aria-hidden="true"><use href="#i-languages"/></svg></a>
      <button type="button" class="icon-btn" data-theme-toggle aria-label="${ui.theme}" title="${ui.theme}"><svg class="svg-icon" aria-hidden="true"><use href="#i-moon"/></svg></button>
      <a class="icon-btn icon-btn-sponsor hidden sm:inline-flex" href="${SPONSOR_URLS.github}" rel="noopener" target="_blank" aria-label="${ui.sponsor}" title="${ui.sponsor}"><svg class="svg-icon" aria-hidden="true"><use href="#i-heart"/></svg></a>
      <a class="icon-btn hidden sm:inline-flex" href="${REPO_URL}" rel="noopener" target="_blank" aria-label="GitHub"><svg class="svg-icon" aria-hidden="true"><use href="#i-github"/></svg></a>
    </div>
  </div>
</header>`;
      const link = (slug: string): string => `${r}${info.prefix}docs/${slug}/`;
      const title = (slug: string): string => bySlug.get(slug)?.title ?? slug;
      const footer = `
<footer class="band mt-8">
  <div class="mx-auto max-w-7xl px-4 sm:px-6 py-12 grid gap-8 sm:grid-cols-2 lg:grid-cols-4 text-sm">
    <div><p class="font-semibold mb-3">${ui.footerDocs}</p><ul class="space-y-2 muted">${["quick-start", "install", "configuration", "faq"].map((s) => `<li><a class="hover:underline" href="${link(s)}">${e(title(s))}</a></li>`).join("")}</ul></div>
    <div><p class="font-semibold mb-3">${ui.footerProject}</p><ul class="space-y-2 muted">
      <li><a class="hover:underline" href="${REPO_URL}" rel="noopener" target="_blank">GitHub</a></li>
      <li><a class="hover:underline" href="${REPO_URL}/releases" rel="noopener" target="_blank">${ui.releases}</a></li>
      <li><a class="hover:underline" href="${REPO_URL}/blob/main/CHANGELOG.md" rel="noopener" target="_blank">${ui.changelog}</a></li>
      <li><a class="hover:underline" href="${REPO_URL}/blob/main/SECURITY.md" rel="noopener" target="_blank">${ui.security}</a></li>
      <li><a class="hover:underline" href="${REPO_URL}/blob/main/CONTRIBUTING.md" rel="noopener" target="_blank">${ui.contributing}</a></li>
    </ul></div>
    <div><p class="font-semibold mb-3">${ui.footerSupport}</p><ul class="space-y-2 muted">
      <li><a class="hover:underline" href="${SPONSOR_URLS.github}" rel="noopener" target="_blank">${ui.sponsor}</a></li>
      <li><a class="hover:underline" href="${SPONSOR_URLS.coffee}" rel="noopener" target="_blank">${ui.coffee}</a></li>
      <li><a class="hover:underline" href="${AUTHOR_URL}" rel="noopener" target="_blank">${ui.author}</a></li>
    </ul></div>
    <div><p class="font-semibold mb-3">${ui.footerLegal}</p><ul class="space-y-2 muted">
      <li><a class="hover:underline" href="${REPO_URL}/blob/main/LICENSE" rel="noopener" target="_blank">${ui.license}</a></li>
      <li><a class="hover:underline" href="${r}THIRD_PARTY_NOTICES.txt">${ui.notices}</a></li>
    </ul><p class="faint mt-4 leading-relaxed">${ui.disclaimer}</p></div>
  </div>
  <div class="mx-auto max-w-7xl px-4 sm:px-6 pb-10 faint text-xs">© 2026 <a class="hover:underline" href="${AUTHOR_URL}" rel="noopener" target="_blank">iocky</a> · ${SITE_NAME} v${e(version)}</div>
</footer>`;
      const searchDialog = `
<dialog id="search" aria-label="${ui.search}">
  <div class="flex items-center gap-3 px-5 py-4 border-b hairline">
    <svg class="svg-icon faint" aria-hidden="true"><use href="#i-search"/></svg>
    <input class="search-input" type="search" placeholder="${ui.searchPlaceholder}" aria-label="${ui.search}" autocomplete="off" spellcheck="false">
    <span class="faint text-sm whitespace-nowrap" data-count></span><kbd>Esc</kbd>
  </div>
  <div class="search-list">
    <div data-popular><p class="search-label">${ui.popular}</p>${POPULAR.map((s) => `<a class="search-hit" href="${link(s)}"><span class="search-hit-title">${e(title(s))}</span><span class="search-hit-where">${e(bySlug.get(s)?.section ?? "")}</span></a>`).join("")}</div>
    <div data-results role="listbox"></div>
  </div>
</dialog>`;
      return `<!doctype html>
<html lang="${info.locale}" data-root="${r || "./"}" data-search="${searchFile}">
<head>
${head}
</head>
<body>
${icons}
<a class="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 btn-primary" href="#main">${ui.skip}</a>
${header}
<main id="main">${main}</main>
${footer}
${searchDialog}
</body>
</html>
`;
    };

    // Home
    const homeRel = `${info.prefix}index.html`;
    const homeOtherRel = `${other.prefix}index.html`;
    const meta = homeMeta(info.locale);
    const jsonLd = JSON.stringify({
      "@context": "https://schema.org",
      "@type": "SoftwareApplication",
      name: SITE_NAME,
      description: meta.description,
      applicationCategory: "UtilitiesApplication",
      operatingSystem: "Linux, macOS, Windows (Docker or Node.js 22.6+)",
      softwareVersion: version,
      license: "https://polyformproject.org/licenses/noncommercial/1.0.0/",
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      ...(siteUrl ? { url: absolute(homeRel), image: `${siteUrl}assets/screenshots/dashboard-sujian.webp` } : {}),
      sameAs: [REPO_URL],
    }).replace(/</g, "\\u003c");
    write(
      homeRel,
      shell(homeRel, homeOtherRel, { title: meta.title, description: meta.description, type: "website", jsonLd }, renderHome({
        locale: info.locale,
        root: toRoot(homeRel),
        docs: `${toRoot(homeRel)}${info.prefix}docs/`,
        version,
        demoUrl: DEMO_URL,
        repoUrl: REPO_URL,
        sponsorUrls: SPONSOR_URLS,
        image: (name) => ({ src: `${toRoot(homeRel)}assets/screenshots/${name}`, ...useImage(name) }),
        icon: (id) => `<svg class="svg-icon" aria-hidden="true"><use href="#${id}"/></svg>`,
      }), false)
    );

    // Guide pages
    rendered.forEach((page, i) => {
      const rel = `${info.prefix}docs/${page.slug}/index.html`;
      const otherRel = `${other.prefix}docs/${page.slug}/index.html`;
      const r = toRoot(rel);
      const e = escapeHtml;
      const nav = sections
        .map((s) => `<h2>${e(s.name)}</h2>${s.pages.map((p) => `<a href="${r}${info.prefix}docs/${p.slug}/"${p.slug === page.slug ? ' aria-current="page"' : ""}>${e(p.title)}</a>`).join("")}`)
        .join("");
      const toc = page.headings.filter((h) => h.level <= 3);
      const prev = rendered[i - 1];
      const next = rendered[i + 1];
      const pager = `<nav class="pager mt-16 grid gap-4 sm:grid-cols-2" aria-label="${UI[info.locale].previous} / ${UI[info.locale].next}">${prev ? `<a href="../${prev.slug}/"><span class="faint text-sm">← ${ui.previous}</span><span class="block font-semibold mt-1">${e(prev.title)}</span></a>` : "<span></span>"}${next ? `<a class="sm:text-right" href="../${next.slug}/"><span class="faint text-sm">${ui.next} →</span><span class="block font-semibold mt-1">${e(next.title)}</span></a>` : ""}</nav>`;
      const main = `
<div class="mx-auto max-w-7xl px-4 sm:px-6 py-8 lg:py-12 docs-grid">
  <nav class="sidebar" data-sidebar aria-label="${ui.menu}">${nav}</nav>
  <article class="article min-w-0">
    <p class="faint text-sm font-medium">${e(page.section)}</p>
    <h1 class="mt-2">${e(page.title)}</h1>
    <p class="description">${e(page.description)}</p>
    ${page.html}
    ${pager}
    <p class="faint text-sm mt-10"><a class="hover:underline" href="${REPO_URL}/edit/main/${page.file}" rel="noopener" target="_blank">${ui.edit}</a></p>
  </article>
  ${toc.length > 1 ? `<aside class="toc" data-toc aria-label="${ui.onThisPage}"><p>${ui.onThisPage}</p>${toc.map((h) => `<a class="depth-${h.level}" href="#${e(h.id)}">${e(h.text)}</a>`).join("")}</aside>` : ""}
</div>`;
      write(rel, shell(rel, otherRel, { title: `${page.title} · ${SITE_NAME}`, description: page.description, type: "article" }, main, true));
    });
  }

  // Not found: GitHub Pages serves /404.html for any missing path, so its links are absolute to the site. Both
  // languages are in the page; the site script shows the one of the address (`/en/…`) and lets the face be poked.
  const siteBase = siteUrl ? new URL(siteUrl).pathname : "/";
  const notFoundCard = (locale: "zh-CN" | "en", prefix: string): string => {
    const t = UI[locale];
    return `
<section class="nf-card" lang="${locale}" data-nf="${locale}" data-title="${t.notFound} · ${SITE_NAME}">
  <button type="button" class="nf-face" data-nf-face aria-label="${t.notFoundFace}" title="${t.notFoundFace}">(´・ω・\`)</button>
  <p class="nf-code" aria-hidden="true">404</p>
  <h1 class="nf-title">${t.notFoundTitle}</h1>
  <p class="nf-lead">${t.notFoundLead}</p>
  <div class="nf-actions"><a class="btn-primary" href="${siteBase}${prefix}">${t.notFoundHome}</a><a class="btn-secondary" href="${siteBase}${prefix}docs/quick-start/">${t.notFoundDocs}</a></div>
  <p class="nf-meter"><svg class="svg-icon" aria-hidden="true"><use href="#i-signal"/></svg>${t.notFoundMeter}</p>
</section>`;
  };
  fs.writeFileSync(
    path.join(out, "404.html"),
    `<!doctype html>
<html lang="zh-CN" data-root="${siteBase}" data-not-found>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${UI["zh-CN"].notFound} · ${SITE_NAME}</title>
<meta name="robots" content="noindex">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<meta name="color-scheme" content="light dark">
<link rel="icon" href="${siteBase}favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="${siteBase}${cssFile}">
<script src="${siteBase}${jsFile}" defer></script>
</head>
<body>
${icons}
<header class="site-header">
  <div class="mx-auto max-w-7xl px-4 sm:px-6 h-16 flex items-center gap-3">
    <a href="${siteBase}" class="flex items-center gap-2.5 shrink-0" aria-label="${SITE_NAME}"><svg class="w-8 h-8" aria-hidden="true"><use href="#i-mark"/></svg><span class="font-semibold text-lg tracking-tight">烽燧</span><span class="faint hidden sm:inline text-sm">FengSui</span></a>
    <div class="ml-auto"><button type="button" class="icon-btn" data-theme-toggle aria-label="${UI["zh-CN"].theme} / ${UI.en.theme}" title="${UI["zh-CN"].theme} / ${UI.en.theme}"><svg class="svg-icon" aria-hidden="true"><use href="#i-moon"/></svg></button></div>
  </div>
</header>
<main id="main" class="not-found">${notFoundCard("zh-CN", "")}${notFoundCard("en", "en/")}
</main>
</body>
</html>
`
  );

  if (siteUrl) {
    const urls = written
      .map((rel) => {
        const loc = absolute(rel) ?? "";
        const twin = rel.startsWith("en/") ? rel.slice(3) : `en/${rel}`;
        const zhUrl = rel.startsWith("en/") ? absolute(twin) : loc;
        const enUrl = rel.startsWith("en/") ? loc : absolute(twin);
        return `<url><loc>${escapeHtml(loc)}</loc><xhtml:link rel="alternate" hreflang="zh-CN" href="${escapeHtml(zhUrl ?? "")}"/><xhtml:link rel="alternate" hreflang="en" href="${escapeHtml(enUrl ?? "")}"/></url>`;
      })
      .join("\n");
    fs.writeFileSync(path.join(out, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls}\n</urlset>\n`);
    fs.writeFileSync(path.join(out, "robots.txt"), `User-agent: *\nAllow: /\nSitemap: ${siteUrl}sitemap.xml\n`);
  } else {
    fs.writeFileSync(path.join(out, "robots.txt"), "User-agent: *\nAllow: /\n");
  }
  return { pages: written, out };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const outArg = process.argv.indexOf("--out");
  const started = Date.now();
  try {
    const report = await buildDocsSite({
      out: outArg > 0 ? path.resolve(process.argv[outArg + 1] ?? "dist/site") : undefined,
      siteUrl: process.env["DOCS_SITE_URL"] || null,
    });
    process.stdout.write(`docs site: ${report.pages.length} pages in ${Date.now() - started} ms -> ${path.relative(process.cwd(), report.out)}\n`);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}
