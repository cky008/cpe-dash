import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { buildDocsSite, webpSize } from "../scripts/build-docs.ts";
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
      "www.rohde-schwarz.com", "www.ericsson.com", "www.fortinet.com", "www.cellmapper.net",
      // The author's site and the sponsor pages of .github/FUNDING.yml
      "iocky.com", "buymeacoffee.com",
      "docs.docker.com", "docs.kernel.org",
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
    assert.match(fs.readFileSync(path.join(site, "404.html"), "utf8"), /<meta name="robots" content="noindex">/);

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

  it("reads image sizes from WebP headers so pictures reserve their space", () => {
    assert.deepEqual(webpSize(fs.readFileSync("docs/screenshots/dashboard-sujian.webp")), { width: 1440, height: 900 });
    const home = fs.readFileSync(path.join(site, "index.html"), "utf8");
    for (const m of home.matchAll(/<img [^>]*>/g)) assert.match(m[0], /width="\d+" height="\d+"/);
    assert.throws(() => webpSize(Buffer.from("RIFF\0\0\0\0WEBPABCD")), /not a WebP/);
  });
});
