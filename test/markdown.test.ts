import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseFrontMatter, renderMarkdown, slugify } from "../scripts/markdown.ts";

describe("docs Markdown renderer (scripts/markdown.ts)", () => {
  it("renders headings with stable ids, paragraphs and inline marks, escaping everything else", () => {
    const { html, headings, title } = renderMarkdown(
      [
        "# 快速开始",
        "",
        "Run **FengSui** with `docker compose up -d` and *wait*.",
        "",
        "## 1. 准备 .env",
        "",
        "### Step two: the <script>alert(1)</script> part",
        "",
        "A & B < C > D \"quoted\"",
      ].join("\n")
    );
    assert.equal(title, "快速开始");
    assert.deepEqual(headings, [
      { level: 2, text: "1. 准备 .env", id: "1-准备-env" },
      { level: 3, text: "Step two: the <script>alert(1)</script> part", id: "step-two-the-scriptalert1script-part" },
    ]);
    assert.ok(html.includes('<p>Run <strong>FengSui</strong> with <code>docker compose up -d</code> and <em>wait</em>.</p>'));
    assert.ok(html.includes('<h2 id="1-准备-env"><a class="anchor" href="#1-准备-env" aria-hidden="true">#</a>1. 准备 .env</h2>'));
    assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
    assert.ok(html.includes("<p>A &amp; B &lt; C &gt; D &quot;quoted&quot;</p>"));
    assert.doesNotMatch(html, /<script/);
    assert.doesNotMatch(html, /<h1/, "the title is the page's, not the article's");
  });

  it("keeps the text under each heading for search, a deeper heading's in its own section", () => {
    const { sections, text } = renderMarkdown(["Intro text.", "", "## ZTE", "", "| Model | Form |", "| :--- | :--- |", "| MC888 | Indoor CPE |", "", "##### Small print", "", "More.", "", "## Pinsu", "", "- R200C"].join("\n"));
    assert.deepEqual({ ...sections }, { zte: "Model Form MC888 Indoor CPE Small print More.", pinsu: "R200C" });
    assert.match(text, /^Intro text\. ZTE Model Form MC888/);
  });

  it("renders lists, nested lists, ordered lists, code fences, rules and tables", () => {
    const { html } = renderMarkdown(
      [
        "- one",
        "- two",
        "  - two a",
        "- three",
        "",
        "1. first",
        "2. second",
        "",
        "```bash",
        "echo '<b>' && npm ci",
        "```",
        "",
        "---",
        "",
        "| Key | Default | Meaning |",
        "| :--- | :---: | ---: |",
        "| `WEB_PORT` | 18384 | the console's port |",
      ].join("\n")
    );
    assert.ok(html.includes("<ul><li>one</li><li>two<ul><li>two a</li></ul></li><li>three</li></ul>"));
    assert.ok(html.includes("<ol><li>first</li><li>second</li></ol>"));
    assert.ok(html.includes('<pre><code class="language-bash">echo &#39;&lt;b&gt;&#39; &amp;&amp; npm ci</code></pre>'));
    assert.ok(html.includes("<hr>"));
    // Classes, not style attributes: the site's CSP allows no inline styles
    assert.ok(html.includes('<table><thead><tr><th class="align-left">Key</th><th class="align-center">Default</th><th class="align-right">Meaning</th></tr></thead>'));
    assert.ok(html.includes('<td class="align-left"><code>WEB_PORT</code></td>'));
  });

  it("keeps a code block, a paragraph or a nested list that belongs to a list item inside it, and one numbering", () => {
    const { html } = renderMarkdown(
      [
        "1. **Prepare the folder**:",
        "",
        "   ```bash",
        "   mkdir -p data && cd data",
        "   chmod 700 data   # keep it private",
        "   ```",
        "",
        "2. **Edit .env**: set the key.",
        "",
        "   A second paragraph of step 2.",
        "",
        "   - a nested point",
        "3. Start it.",
        "   ```text",
        "   right after the line",
        "   ```",
      ].join("\n")
    );
    assert.equal(
      html,
      "<ol><li><strong>Prepare the folder</strong>:<pre><code class=\"language-bash\">mkdir -p data &amp;&amp; cd data\nchmod 700 data   # keep it private</code></pre></li>" +
        "<li><strong>Edit .env</strong>: set the key.<p>A second paragraph of step 2.</p><ul><li>a nested point</li></ul></li>" +
        "<li>Start it.<pre><code class=\"language-text\">right after the line</code></pre></li></ol>"
    );
  });

  it("turns GitHub alerts into callouts and keeps plain quotes", () => {
    const { html } = renderMarkdown(["> [!WARNING]", "> Three wrong passwords lock the router.", "> - really", "", "> Just a quote."].join("\n"));
    assert.ok(html.includes('<div class="callout callout-warning" role="note"><p class="callout-title">Warning</p><p>Three wrong passwords lock the router.</p><ul><li>really</li></ul></div>'));
    assert.ok(html.includes("<blockquote><p>Just a quote.</p></blockquote>"));
    assert.ok(renderMarkdown("> [!TIP]\n> x", { locale: "zh-CN" }).html.includes('<p class="callout-title">提示</p>'));
  });

  it("rewrites links and images through the caller, refuses script URLs and marks external links", () => {
    const { html } = renderMarkdown("See [install](install.md#docker), [GitHub](https://github.com/cky008/cpe-dash), [bad](javascript:alert(1)).\n\n![The dashboard](../../screenshots/dashboard.webp)", {
      link: (href) => (href.endsWith(".md") || href.includes(".md#") ? href.replace(/\.md/, "/") : href),
      image: (src) => `assets/${src.split("/").pop() ?? ""}`,
    });
    assert.ok(html.includes('<a href="install/#docker">install</a>'));
    assert.ok(html.includes('<a href="https://github.com/cky008/cpe-dash" rel="noopener" target="_blank">GitHub</a>'));
    assert.ok(html.includes("bad"));
    assert.doesNotMatch(html, /javascript:/);
    assert.ok(html.includes('<figure><img src="assets/dashboard.webp" alt="The dashboard" loading="lazy"><figcaption>The dashboard</figcaption></figure>'));
  });

  it("keeps stable term anchors and renders [[source](url)] citations", () => {
    const { html, text } = renderMarkdown('<a id="rsrp"></a>\n\n### RSRP 是什么\n\nSignal power [[3GPP TS 36.214](https://www.3gpp.org/DynaReport/36214.htm)].\n\n<a id="Bad Id"></a>');
    assert.ok(html.includes('<a id="rsrp" class="term-anchor"></a>'));
    assert.ok(html.includes('<span class="cite">[<a href="https://www.3gpp.org/DynaReport/36214.htm" rel="noopener" target="_blank">3GPP TS 36.214</a>]</span>'));
    assert.ok(html.includes("&lt;a id=&quot;Bad Id&quot;&gt;"), "only [a-z0-9-] ids pass; anything else is escaped text");
    assert.match(text, /Signal power 3GPP TS 36\.214/);
  });

  it("starts a term anchor on its own line even right under a paragraph line", () => {
    const { html } = renderMarkdown('Signal power, averaged.\n<a id="rsrp"></a>\n### RSRP');
    assert.ok(html.includes('<p>Signal power, averaged.</p><a id="rsrp" class="term-anchor"></a>'), html);
    assert.ok(!html.includes("&lt;a id="), "the anchor is never printed as text");
  });

  it("collects the plain text for the search index and skips HTML comments", () => {
    const { text } = renderMarkdown("<!-- compat:begin -->\n## Hello\n\nSome **bold** `code` [link](x.md).\n<!-- compat:end -->");
    assert.equal(text, "Hello Some bold code link.");
  });

  it("reads front matter and makes slugs for CJK and ASCII alike", () => {
    assert.deepEqual(parseFrontMatter("---\ntitle: 安装\norder: 3\nsection: 开始使用\n---\n# body"), {
      meta: { title: "安装", order: "3", section: "开始使用" },
      body: "# body",
    });
    assert.deepEqual(parseFrontMatter("# no front matter"), { meta: {}, body: "# no front matter" });
    assert.equal(slugify("What's `DEFAULT_COUNTRY_CODE`?"), "whats-default_country_code");
    assert.equal(slugify("短信 / SMS 中心"), "短信-sms-中心");
  });

  it("reads GitHub's escaped pipes in tables, <br> and strikethrough the way GitHub does", () => {
    const table = renderMarkdown("| Body | Note |\n| :--- | :--- |\n| `{ mode?: \"full\" \\| \"incremental\" }` | one<br>two |").html;
    assert.match(table, /<td class="align-left"><code>\{ mode\?: &quot;full&quot; \| &quot;incremental&quot; \}<\/code><\/td>/);
    assert.match(table, /<td class="align-left">one<br>two<\/td>/);
    assert.equal((table.match(/<td/g) ?? []).length, 2, "an escaped pipe does not start a cell");
    assert.match(renderMarkdown("~~gone~~ and kept").html, /<p><del>gone<\/del> and kept<\/p>/);
    // Any other tag stays text, and so does a lone ~~ or a <br> inside code
    assert.match(renderMarkdown("<b>x</b> ~~ open `<br>`").html, /&lt;b&gt;x&lt;\/b&gt; ~~ open <code>&lt;br&gt;<\/code>/);
    assert.equal(renderMarkdown("a ~~struck~~ b").text, "a struck b");
  });
});
