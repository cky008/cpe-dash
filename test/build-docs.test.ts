import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { buildDocsSite, inlineDiagram, webpSize } from "../scripts/build-docs.ts";
import { SHOWCASE_THEMES, showcaseImage } from "../scripts/site-home.ts";
import { THEME_META } from "../web/src/core/prefs.ts";
import { THEME_NAMES } from "../web/src/i18n/appearance.ts";
import { removeTempDir, tempDir } from "./helpers/temp-dir.ts";

const GUIDE = (dir: string): string[] =>
  fs
    .readdirSync(path.join("docs", "guide", dir))
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/, ""))
    .sort();

function htmlFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true, recursive: true }).filter((e) => e.isFile() && e.name.endsWith(".html")).map((e) => path.join(e.parentPath, e.name));
}

/** Where a relative URL in `from` points inside the site, and its anchor. */
function resolve(siteDir: string, from: string, url: string): { file: string; anchor: string } {
  const [pathPart = "", anchor = ""] = url.split("#");
  const target = path.resolve(path.dirname(from), decodeURIComponent(pathPart));
  const file = pathPart === "" ? from : pathPart.endsWith("/") ? path.join(target, "index.html") : target;
  assert.ok(file.startsWith(siteDir), `${url} leaves the site`);
  return { file, anchor: decodeURIComponent(anchor) };
}

describe("documentation site (scripts/build-docs.ts)", () => {
  let dir = "";
  let site = "";
  let plain = "";
  before(async () => {
    dir = tempDir("fengsui-site-");
    site = (await buildDocsSite({ out: path.join(dir, "site"), siteUrl: "https://docs.example.com/" })).out;
    plain = (await buildDocsSite({ out: path.join(dir, "plain") })).out;
  });
  after(() => removeTempDir(dir));

  it("inlines the diagrams, so they follow the site's theme toggle, and lets nothing but drawing through", () => {
    for (const lang of ["zh", "en"] as const) {
      const page = fs.readFileSync(path.join(site, ...(lang === "en" ? ["en"] : []), "docs", "architecture", "index.html"), "utf8");
      assert.equal((page.match(/<figure class="diagram"><svg /g) ?? []).length, 2, `${lang}: both diagrams inline`);
      assert.doesNotMatch(page, /<img[^>]+\.svg/, `${lang}: no diagram as an image`);
    }
    // Same drawings in both languages: the two folders hold the same files
    assert.deepEqual(fs.readdirSync("docs/diagrams/zh").sort(), fs.readdirSync("docs/diagrams/en").sort());
    const ok = '<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="t"><title id="t">x</title><path marker-end="url(#a)"/></svg>';
    assert.equal(inlineDiagram(`<?xml version="1.0"?>\n${ok}`, "ok.svg"), ok);
    for (const bad of [
      ok.replace("<path", "<script>alert(1)</script><path"),
      ok.replace("<path", '<path onload="x()"'),
      ok.replace("<path", '<a href="https://example.com/"><path') + "</a>",
      ok.replace("<path", '<path style="fill:red"'),
      ok.replace("<path", "<foreignObject></foreignObject><path"),
      ok.replace('url(#a)', "url(https://example.com/x)"),
      ok.replace(' role="img"', ""),
      ok.replace('<title id="t">x</title>', ""),
      `${ok}${ok}`,
    ]) {
      assert.throws(() => inlineDiagram(bad, "bad.svg"), /bad\.svg/, bad);
    }
  });

  it("has the same guide pages in both languages, each built with the home pages", () => {
    assert.deepEqual(GUIDE("zh"), GUIDE("en"));
    assert.ok(GUIDE("zh").length >= 10);
    for (const slug of GUIDE("zh")) {
      assert.ok(fs.existsSync(path.join(site, "docs", slug, "index.html")), slug);
      assert.ok(fs.existsSync(path.join(site, "en", "docs", slug, "index.html")), `en ${slug}`);
    }
    assert.ok(fs.existsSync(path.join(site, "index.html")) && fs.existsSync(path.join(site, "en", "index.html")));
  });

  it("links only to pages, anchors and assets that exist, or to known outside sites", () => {
    // The project's own sites, and the standards and vendor pages the guide cites as sources
    const allowedHosts = new Set([
      "github.com", "cky008.github.io", "docs.example.com", "polyformproject.org", "schema.org", "www.sitemaps.org", "www.w3.org",
      "modelcontextprotocol.io", "www.3gpp.org", "standards.ieee.org", "www.wi-fi.org", "www.rfc-editor.org", "consumer.huawei.com",
      "www.rohde-schwarz.com", "www.ericsson.com", "www.fortinet.com", "www.cellmapper.net", "www.etsi.org",
      // The author's site and the sponsor pages of .github/FUNDING.yml
      "iocky.com", "buymeacoffee.com",
      "docs.docker.com", "docs.kernel.org",
      // The API reference: the SSE standard and the Prometheus text format
      "html.spec.whatwg.org", "prometheus.io",
      // Where one of the projects credited on "Other models and brands" is hosted
      "gitee.com",
    ]);
    let internal = 0;
    for (const file of htmlFiles(site)) {
      const html = fs.readFileSync(file, "utf8");
      for (const m of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
        const url = (m[1] ?? "").replace(/&amp;/g, "&");
        if (/^https?:/.test(url)) {
          assert.ok(allowedHosts.has(new URL(url).hostname), `${path.relative(site, file)}: ${url}`);
          continue;
        }
        if (url.startsWith("mailto:") || path.basename(file) === "404.html") continue;
        internal += 1;
        const { file: target, anchor } = resolve(site, file, url);
        assert.ok(fs.existsSync(target), `${path.relative(site, file)}: ${url} -> missing ${path.relative(site, target)}`);
        if (anchor && target.endsWith(".html")) assert.ok(fs.readFileSync(target, "utf8").includes(`id="${anchor}"`), `${path.relative(site, file)}: #${anchor} not in ${path.relative(site, target)}`);
      }
    }
    assert.ok(internal > 300, `checked ${internal} internal links`);
  });

  it("leaves the developer notes off the site: links to docs/dev go to GitHub, in both languages", () => {
    // The owner's call (2026-11-11): the notes stay on GitHub only, the site is for people using FengSui
    assert.equal(fs.existsSync(path.join(site, "docs", "dev")), false);
    for (const prefix of ["", "en/"]) {
      const page = fs.readFileSync(path.join(site, prefix, "docs", "api", "index.html"), "utf8");
      assert.ok(page.includes("https://github.com/cky008/cpe-dash/blob/main/docs/dev/api.md"), `${prefix}docs/api`);
    }
    for (const file of htmlFiles(site)) {
      for (const m of fs.readFileSync(file, "utf8").matchAll(/href="([^"]*docs\/dev\/[^"]*)"/g)) {
        assert.ok((m[1] ?? "").startsWith("https://github.com/cky008/cpe-dash/blob/main/docs/dev/"), `${path.relative(site, file)}: ${m[1]}`);
      }
    }
  });

  it("keeps to its CSP: no inline script or style, and no outside script, style or font", () => {
    for (const file of htmlFiles(site)) {
      const html = fs.readFileSync(file, "utf8");
      assert.match(html, /<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self';/, file);
      assert.doesNotMatch(html, /\sstyle="/, `${file}: inline style attribute`);
      for (const m of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) {
        const attrs = m[1] ?? "";
        if (attrs.includes('type="application/ld+json"')) continue;
        assert.match(attrs, /src="[^"]*assets\/site\.[0-9a-f]{10}\.js"/, `${file}: only the site's own script`);
        assert.equal(m[2]?.trim(), "", `${file}: inline script`);
      }
      assert.doesNotMatch(html, /<link rel="stylesheet" href="https?:/, file);
    }
  });

  it("gives search engines what they need when the site URL is known, and nothing absolute otherwise", () => {
    const home = fs.readFileSync(path.join(site, "index.html"), "utf8");
    assert.match(home, /<link rel="canonical" href="https:\/\/docs\.example\.com\/">/);
    assert.match(home, /hreflang="en" href="https:\/\/docs\.example\.com\/en\/"/);
    assert.match(home, /<meta property="og:image" content="https:\/\/docs\.example\.com\/assets\/screenshots\/dashboard-sujian\.webp">/);
    assert.match(home, /"@type":"SoftwareApplication"/);
    const page = fs.readFileSync(path.join(site, "en", "docs", "install", "index.html"), "utf8");
    assert.match(page, /<title>[^<]+ · 烽燧 FengSui<\/title>/);
    assert.match(page, /<meta name="description" content="[^"]{30,}">/);
    assert.match(page, /<link rel="canonical" href="https:\/\/docs\.example\.com\/en\/docs\/install\/">/);
    assert.match(page, /hreflang="zh-CN" href="https:\/\/docs\.example\.com\/docs\/install\/"/);
    const sitemap = fs.readFileSync(path.join(site, "sitemap.xml"), "utf8");
    for (const slug of GUIDE("zh")) assert.ok(sitemap.includes(`<loc>https://docs.example.com/docs/${slug}/</loc>`) && sitemap.includes(`https://docs.example.com/en/docs/${slug}/`), slug);
    assert.match(fs.readFileSync(path.join(site, "robots.txt"), "utf8"), /Sitemap: https:\/\/docs\.example\.com\/sitemap\.xml/);
    const notFound = fs.readFileSync(path.join(site, "404.html"), "utf8");
    assert.match(notFound, /<meta name="robots" content="noindex">/);
    // Served for any missing path: its stylesheet, script and links are absolute to the site, and both languages are there
    const assets = [...notFound.matchAll(/(?:href|src)="(\/assets\/[^"]+)"/g)].map((m) => m[1] ?? "");
    assert.deepEqual(assets.map((a) => a.replace(/\.[0-9a-f]+\./, ".#.")).sort(), ["/assets/site.#.css", "/assets/site.#.js"]);
    for (const asset of assets) assert.ok(fs.existsSync(path.join(site, asset)), asset);
    for (const href of ['href="/"', 'href="/docs/quick-start/"', 'href="/en/"', 'href="/en/docs/quick-start/"']) assert.ok(notFound.includes(href), href);
    assert.deepEqual([...notFound.matchAll(/data-nf="([^"]+)"/g)].map((m) => m[1]), ["zh-CN", "en"]);

    // Without DOCS_SITE_URL (a local build): no canonical, no sitemap, nothing pointing at a domain
    const local = fs.readFileSync(path.join(plain, "index.html"), "utf8");
    assert.doesNotMatch(local, /rel="canonical"|og:url|og:image|hreflang="zh-CN"/);
    assert.equal(fs.existsSync(path.join(plain, "sitemap.xml")), false);
    assert.doesNotMatch(fs.readFileSync(path.join(plain, "robots.txt"), "utf8"), /Sitemap/);
  });

  it("indexes every page for search, ships the licence notices and names the author's site only by its home page", () => {
    for (const [locale, prefix] of [["zh-CN", ""], ["en", "en/"]] as const) {
      const file = fs.readdirSync(path.join(site, "assets")).find((f) => f.startsWith(`search.${locale}.`));
      assert.ok(file, locale);
      const index = JSON.parse(fs.readFileSync(path.join(site, "assets", file), "utf8")) as Array<{ url: string; title: string; text: string }>;
      assert.deepEqual(index.map((e) => e.url).sort(), GUIDE("zh").map((slug) => `${prefix}docs/${slug}/`).sort());
      assert.ok(index.every((e) => e.title && e.text.length > 100));
      // A model deep in Supported devices is found in its brand's section, not cut off with the page's text
      const devices = (index as unknown as Array<{ url: string; headings: Array<{ text: string; id: string; body: string }> }>).find((e) => e.url === `${prefix}docs/supported-devices/`);
      const zte = devices?.headings.find((h) => h.body.includes("MC888 Ultra"));
      assert.equal(zte?.text, locale === "en" ? "ZTE" : "中兴");
      assert.ok(devices?.headings.some((h) => h.body.includes("D-Link DWR-921")), "the last section too");
    }
    assert.ok(fs.readFileSync(path.join(site, "THIRD_PARTY_NOTICES.txt"), "utf8").includes("daisyUI"));
    for (const file of fs.readdirSync(site, { recursive: true, withFileTypes: true }).filter((e) => e.isFile() && /\.(html|json|xml|txt|js|css)$/.test(e.name))) {
      // The site's own domain (docker-compose.yml names it), else no subdomain (a NAS host name, say) and
      // no deeper path: just https://iocky.com/ (AGENTS.md)
      const text = fs.readFileSync(path.join(file.parentPath, file.name), "utf8").replaceAll("https://fengsui.iocky.com/", "");
      assert.doesNotMatch(text, /[\w-]\.iocky\.com|iocky\.com\/[\w#?%-]/, path.relative(site, path.join(file.parentPath, file.name)));
    }
  });

  it("shows docker-compose.yml on its guide page exactly as the repository has it, in both languages", () => {
    const compose = fs.readFileSync("docker-compose.yml", "utf8").trimEnd();
    for (const lang of ["zh", "en"]) {
      const page = fs.readFileSync(path.join("docs", "guide", lang, "docker-compose.md"), "utf8");
      assert.ok(page.includes("```yaml\n" + compose + "\n```"), `docs/guide/${lang}/docker-compose.md: copy docker-compose.yml into its yaml block again`);
      // Every entry of the service, and every variable it sets, is explained on the page
      for (const key of compose.matchAll(/^ {4}#? ?([a-z_]+):/gm)) assert.ok(page.includes(`\`${key[1]}`), `${lang}: ${key[1]}`);
      for (const env of compose.matchAll(/^ {6}- ([A-Z_]+=)/gm)) assert.ok(page.includes(`| \`${env[1]}`), `${lang}: ${env[1]}`);
    }
  });

  it("lets readers support the project and find its author, on every page", () => {
    for (const rel of ["index.html", path.join("docs", "faq", "index.html"), path.join("en", "docs", "install", "index.html")]) {
      const html = fs.readFileSync(path.join(site, rel), "utf8");
      assert.ok(html.includes('href="https://github.com/sponsors/cky008"') && html.includes('href="https://buymeacoffee.com/iocky"'), `${rel}: sponsor links`);
      assert.match(html, /© 2026 <a [^>]*href="https:\/\/iocky\.com\/"[^>]*>iocky<\/a>/, `${rel}: the author's site`);
    }
    assert.match(fs.readFileSync(path.join(site, "index.html"), "utf8"), /<h2[^>]*>支持烽燧<\/h2>/);
    assert.match(fs.readFileSync(path.join(site, "en", "index.html"), "utf8"), /<h2[^>]*>Support FengSui<\/h2>/);
    const funding = fs.readFileSync(".github/FUNDING.yml", "utf8");
    assert.match(funding, /^github: cky008$/m);
    assert.match(funding, /^buy_me_a_coffee: iocky$/m, "the site links the same sponsor pages as GitHub's Sponsor button");
  });

  it("wipes through the dashboard in light and dark themes in turn on the home page, named as in the console", () => {
    SHOWCASE_THEMES.forEach((id, i) => {
      assert.equal(THEME_META[id].scheme, i % 2 === 0 ? "light" : "dark", id);
      // npm run screenshots -- themes: one size, so the shots stack exactly
      assert.deepEqual(webpSize(fs.readFileSync(path.join("docs", "screenshots", showcaseImage(id)))), { width: 1440, height: 900 }, id);
    });
    for (const [rel, locale] of [["index.html", "zh-CN"], [path.join("en", "index.html"), "en"]] as const) {
      const home = fs.readFileSync(path.join(site, rel), "utf8");
      const layers = [...home.matchAll(/<img [^>]*data-theme-layer[^>]*>/g)].map((m) => m[0]);
      assert.deepEqual(layers.map((tag) => /screenshots\/([\w.-]+)"/.exec(tag)?.[1]), SHOWCASE_THEMES.map(showcaseImage), rel);
      // Only the first picture is described; the others are the same dashboard in other colours
      assert.match(layers[0] ?? "", /alt="[^"]+"/);
      assert.ok(layers.slice(1).every((tag) => tag.includes('alt=""')));
      const chips = [...home.matchAll(/<button type="button" class="theme-chip"[^>]*>(.*?)<\/button>/g)].map((m) => m[1]?.replace(/<[^>]+>[^<]*<\/span>/, ""));
      assert.deepEqual(chips, SHOWCASE_THEMES.map((id) => THEME_NAMES[locale][id]), rel);
    }
  });

  it("refuses to empty an output folder that holds the sources", async () => {
    // A test-owned tree: `--out .` (or a parent folder) must not delete the repository, .git included
    const base = tempDir("fengsui-out-guard-");
    try {
      const root = path.join(base, "repo");
      fs.mkdirSync(root);
      fs.writeFileSync(path.join(root, "package.json"), '{"version":"0.0.0"}');
      fs.writeFileSync(path.join(root, "keep.txt"), "kept");
      await assert.rejects(buildDocsSite({ root, out: root }), /holds the sources/);
      await assert.rejects(buildDocsSite({ root, out: base }), /holds the sources/);
      assert.equal(fs.readFileSync(path.join(root, "keep.txt"), "utf8"), "kept");
    } finally {
      removeTempDir(base);
    }
  });

  it("reads image sizes from WebP headers so pictures reserve their space", () => {
    assert.deepEqual(webpSize(fs.readFileSync("docs/screenshots/dashboard-sujian.webp")), { width: 1440, height: 900 });
    const home = fs.readFileSync(path.join(site, "index.html"), "utf8");
    for (const m of home.matchAll(/<img [^>]*>/g)) assert.match(m[0], /width="\d+" height="\d+"/);
    assert.throws(() => webpSize(Buffer.from("RIFF\0\0\0\0WEBPABCD")), /not a WebP/);
  });
});
