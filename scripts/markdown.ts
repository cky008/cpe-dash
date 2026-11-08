/**
 * Zero-dependency Markdown for FengSui's own documentation (docs/guide), rendered by scripts/build-docs.ts.
 * It covers what the guide uses and what GitHub renders the same way: ATX headings, paragraphs, `code`,
 * **bold**, *emphasis*, links, images, nested lists, fenced code, pipe tables, horizontal rules, quotes and
 * GitHub alerts (`> [!NOTE]`). Raw HTML is never passed through (it is escaped), only single-line comments are
 * dropped, and links accept http(s), mailto and relative targets only.
 */

export interface MarkdownHeading {
  level: number;
  text: string;
  id: string;
}

export interface RenderedMarkdown {
  html: string;
  /** Level 2–4 headings in order, for the page's table of contents. */
  headings: MarkdownHeading[];
  /** The first `# ` heading, if any (it is not rendered: the page shows its title itself). */
  title: string | null;
  /** Plain text of the page for the search index (no code blocks). */
  text: string;
}

export interface RenderOptions {
  locale?: "zh-CN" | "en";
  /** Rewrite a link target (e.g. `install.md#docker` -> `../install/#docker`). */
  link?: (href: string) => string;
  /** Rewrite an image source to the published asset path. */
  image?: (src: string) => string;
}

const ALERT_TITLES: Readonly<Record<"zh-CN" | "en", Readonly<Record<string, string>>>> = {
  en: { note: "Note", tip: "Tip", important: "Important", warning: "Warning", caution: "Caution" },
  "zh-CN": { note: "注意", tip: "提示", important: "重要", warning: "警告", caution: "小心" },
};

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

/** `---` key: value lines `---` at the top of a page. */
export function parseFrontMatter(source: string): { meta: Record<string, string>; body: string } {
  const meta: Record<string, string> = Object.create(null) as Record<string, string>;
  if (!source.startsWith("---\n")) return { meta: { ...meta }, body: source };
  const end = source.indexOf("\n---\n", 4);
  if (end < 0) return { meta: { ...meta }, body: source };
  for (const line of source.slice(4, end).split("\n")) {
    const sep = line.indexOf(":");
    if (sep > 0) meta[line.slice(0, sep).trim()] = line.slice(sep + 1).trim();
  }
  return { meta: { ...meta }, body: source.slice(end + 5) };
}

function safeHref(href: string): string | null {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(href)?.[1]?.toLowerCase();
  return scheme === undefined || scheme === "http" || scheme === "https" || scheme === "mailto" ? href : null;
}

interface InlineResult {
  html: string;
  text: string;
}

function renderInline(src: string, opts: RenderOptions): InlineResult {
  let html = "";
  let text = "";
  let i = 0;
  const plain = (s: string): void => {
    html += escapeHtml(s);
    text += s;
  };
  while (i < src.length) {
    const ch = src[i] ?? "";
    if (ch === "`") {
      const close = src.indexOf("`", i + 1);
      if (close > i) {
        const code = src.slice(i + 1, close);
        html += `<code>${escapeHtml(code)}</code>`;
        text += code;
        i = close + 1;
        continue;
      }
    }
    if (ch === "!" && src[i + 1] === "[") {
      const m = /^!\[([^\]]*)\]\(([^)\s]+)\)/.exec(src.slice(i));
      if (m) {
        const alt = m[1] ?? "";
        const target = safeHref(m[2] ?? "");
        if (target !== null) html += `<img src="${escapeHtml(opts.image ? opts.image(target) : target)}" alt="${escapeHtml(alt)}" loading="lazy">`;
        text += alt;
        i += m[0].length;
        continue;
      }
    }
    if (ch === "[" && src[i + 1] === "[") {
      // A citation: [[Source title](https://…)]
      const m = /^\[\[([^\]]+)\]\(([^)\s]+)\)\]/.exec(src.slice(i));
      const target = m ? safeHref(m[2] ?? "") : null;
      if (m && target !== null) {
        const inner = renderInline(m[1] ?? "", opts);
        const href = opts.link ? opts.link(target) : target;
        const external = /^https?:/i.test(href) ? ' rel="noopener" target="_blank"' : "";
        html += `<span class="cite">[<a href="${escapeHtml(href)}"${external}>${inner.html}</a>]</span>`;
        text += inner.text;
        i += m[0].length;
        continue;
      }
    }
    if (ch === "[") {
      const m = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(src.slice(i));
      if (m) {
        const inner = renderInline(m[1] ?? "", opts);
        const target = safeHref(m[2] ?? "");
        if (target === null) {
          html += inner.html;
        } else {
          const href = opts.link ? opts.link(target) : target;
          const external = /^https?:/i.test(href) ? ' rel="noopener" target="_blank"' : "";
          html += `<a href="${escapeHtml(href)}"${external}>${inner.html}</a>`;
        }
        text += inner.text;
        i += m[0].length;
        continue;
      }
    }
    if (ch === "<" && /^<https?:\/\/[^>\s]+>/.test(src.slice(i))) {
      const url = src.slice(i + 1, src.indexOf(">", i));
      html += `<a href="${escapeHtml(url)}" rel="noopener" target="_blank">${escapeHtml(url)}</a>`;
      text += url;
      i += url.length + 2;
      continue;
    }
    if (src.startsWith("**", i)) {
      const close = src.indexOf("**", i + 2);
      if (close > i + 2) {
        const inner = renderInline(src.slice(i + 2, close), opts);
        html += `<strong>${inner.html}</strong>`;
        text += inner.text;
        i = close + 2;
        continue;
      }
    }
    if (ch === "*" && src[i + 1] !== " ") {
      const close = src.indexOf("*", i + 1);
      if (close > i + 1 && src[close - 1] !== " ") {
        const inner = renderInline(src.slice(i + 1, close), opts);
        html += `<em>${inner.html}</em>`;
        text += inner.text;
        i = close + 1;
        continue;
      }
    }
    plain(ch);
    i += 1;
  }
  return { html, text };
}

const LIST_ITEM = /^(\s*)([-*]|\d+\.)\s+(.*)$/;
const TABLE_RULE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;
const FENCE = /^```\s*([\w-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s*(?:-{3,}|\*{3,})\s*$/;
const COMMENT = /^\s*<!--.*-->\s*$/;
/** A stable anchor for a term (`<a id="rsrp"></a>` on its own line): the console's help links point at it. */
const TERM_ANCHOR = /^<a id="([a-z0-9-]+)"><\/a>$/;

function cells(row: string): string[] {
  return row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

function startsBlock(line: string, next: string | undefined): boolean {
  return HEADING.test(line) || FENCE.test(line) || line.startsWith(">") || LIST_ITEM.test(line) || RULE.test(line) || COMMENT.test(line) || TERM_ANCHOR.test(line.trim()) || (line.includes("|") && next !== undefined && TABLE_RULE.test(next));
}

export function renderMarkdown(source: string, opts: RenderOptions = {}): RenderedMarkdown {
  const locale = opts.locale ?? "en";
  const headings: MarkdownHeading[] = [];
  const texts: string[] = [];
  const usedIds = new Map<string, number>();
  let title: string | null = null;

  function blocks(lines: ReadonlyArray<string>): string {
    let out = "";
    let i = 0;
    while (i < lines.length) {
      const line = lines[i] ?? "";
      if (!line.trim() || COMMENT.test(line)) {
        i += 1;
        continue;
      }
      const term = TERM_ANCHOR.exec(line.trim());
      if (term) {
        out += `<a id="${term[1]}" class="term-anchor"></a>`;
        i += 1;
        continue;
      }
      const fence = FENCE.exec(line);
      if (fence) {
        const body: string[] = [];
        i += 1;
        while (i < lines.length && !/^```\s*$/.test(lines[i] ?? "")) body.push(lines[i++] ?? "");
        i += 1;
        const lang = fence[1] ? ` class="language-${escapeHtml(fence[1])}"` : "";
        out += `<pre><code${lang}>${escapeHtml(body.join("\n"))}</code></pre>`;
        continue;
      }
      const heading = HEADING.exec(line);
      if (heading) {
        const level = heading[1]?.length ?? 2;
        const raw = heading[2] ?? "";
        const inline = renderInline(raw, opts);
        i += 1;
        if (level === 1) {
          title ??= inline.text;
          continue;
        }
        const base = slugify(inline.text) || "section";
        const seen = usedIds.get(base) ?? 0;
        usedIds.set(base, seen + 1);
        const id = seen === 0 ? base : `${base}-${seen + 1}`;
        if (level <= 4) headings.push({ level, text: inline.text, id });
        texts.push(inline.text);
        out += `<h${level} id="${escapeHtml(id)}"><a class="anchor" href="#${escapeHtml(id)}" aria-hidden="true">#</a>${inline.html}</h${level}>`;
        continue;
      }
      if (RULE.test(line)) {
        out += "<hr>";
        i += 1;
        continue;
      }
      if (line.startsWith(">")) {
        const inner: string[] = [];
        while (i < lines.length && (lines[i] ?? "").startsWith(">")) inner.push((lines[i++] ?? "").replace(/^>\s?/, ""));
        const alert = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/i.exec(inner[0] ?? "");
        if (alert) {
          const kind = (alert[1] ?? "note").toLowerCase();
          out += `<div class="callout callout-${kind}" role="note"><p class="callout-title">${ALERT_TITLES[locale][kind] ?? kind}</p>${blocks(inner.slice(1))}</div>`;
        } else {
          out += `<blockquote>${blocks(inner)}</blockquote>`;
        }
        continue;
      }
      if (line.includes("|") && TABLE_RULE.test(lines[i + 1] ?? "")) {
        const head = cells(line);
        const aligns = cells(lines[i + 1] ?? "").map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : ""));
        const style = (n: number): string => (aligns[n] ? ` class="align-${aligns[n]}"` : "");
        i += 2;
        const rows: string[][] = [];
        while (i < lines.length && (lines[i] ?? "").includes("|") && (lines[i] ?? "").trim()) rows.push(cells(lines[i++] ?? ""));
        const cell = (tag: "th" | "td", c: string, n: number): string => {
          const r = renderInline(c, opts);
          texts.push(r.text);
          return `<${tag}${style(n)}>${r.html}</${tag}>`;
        };
        out += `<div class="table-wrap"><table><thead><tr>${head.map((c, n) => cell("th", c, n)).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c, n) => cell("td", c, n)).join("")}</tr>`).join("")}</tbody></table></div>`;
        continue;
      }
      if (LIST_ITEM.test(line)) {
        const [html, next] = list(lines, i, (LIST_ITEM.exec(line)?.[1] ?? "").length);
        out += html;
        i = next;
        continue;
      }
      const para: string[] = [];
      while (i < lines.length && (lines[i] ?? "").trim() && (para.length === 0 || !startsBlock(lines[i] ?? "", lines[i + 1]))) para.push((lines[i++] ?? "").trim());
      const joined = para.join("\n");
      const onlyImage = /^!\[([^\]]*)\]\(([^)\s]+)\)$/.exec(joined);
      const inline = renderInline(joined, opts);
      texts.push(inline.text);
      out += onlyImage ? `<figure>${inline.html}<figcaption>${escapeHtml(onlyImage[1] ?? "")}</figcaption></figure>` : `<p>${inline.html}</p>`;
    }
    return out;
  }

  function list(lines: ReadonlyArray<string>, start: number, indent: number): [string, number] {
    const first = LIST_ITEM.exec(lines[start] ?? "");
    const ordered = /\d/.test(first?.[2] ?? "");
    const items: Array<{ text: string; nested: string }> = [];
    const indentOf = (l: string): number => l.length - l.trimStart().length;
    /** Content past the marker belongs to the item: a code block, another paragraph, a list after a blank line. */
    const base = indent + 2;
    const takeBody = (from: number, at: number): number => {
      const body: string[] = [];
      let k = from;
      let inFence = false;
      while (k < lines.length) {
        const l = lines[k] ?? "";
        if (!inFence && l.trim() && indentOf(l) < at) break;
        if (FENCE.test(l.trim())) inFence = !inFence;
        body.push(l.slice(Math.min(at, indentOf(l))));
        k += 1;
      }
      while (body.length > 0 && !(body[body.length - 1] ?? "").trim()) body.pop();
      const last = items[items.length - 1];
      if (last) last.nested += blocks(body);
      return k;
    };
    let i = start;
    while (i < lines.length) {
      const line = lines[i] ?? "";
      const m = LIST_ITEM.exec(line);
      if (!m) {
        const last = items[items.length - 1];
        if (!last) break;
        if (!line.trim()) {
          // After a blank line the item goes on if what follows is indented under it, the list if its next item follows
          let j = i + 1;
          while (j < lines.length && !(lines[j] ?? "").trim()) j += 1;
          const next = lines[j] ?? "";
          if (next.trim() && indentOf(next) >= base) {
            i = takeBody(j, indentOf(next));
            continue;
          }
          const nm = LIST_ITEM.exec(next);
          if (nm && (nm[1] ?? "").length === indent && /\d/.test(nm[2] ?? "") === ordered) {
            i = j;
            continue;
          }
          break;
        }
        if (indentOf(line) >= base && FENCE.test(line.trim())) {
          i = takeBody(i, indentOf(line));
          continue;
        }
        // A continuation line of the item's text
        if (/^\s+/.test(line)) {
          last.text += `\n${line.trim()}`;
          i += 1;
          continue;
        }
        break;
      }
      const depth = (m[1] ?? "").length;
      if (depth < indent) break;
      if (depth > indent) {
        const [nested, next] = list(lines, i, depth);
        const last = items[items.length - 1];
        if (last) last.nested += nested;
        i = next;
        continue;
      }
      if (/\d/.test(m[2] ?? "") !== ordered) break;
      items.push({ text: m[3] ?? "", nested: "" });
      i += 1;
    }
    const tag = ordered ? "ol" : "ul";
    const html = items
      .map((item) => {
        const r = renderInline(item.text, opts);
        texts.push(r.text);
        return `<li>${r.html}${item.nested}</li>`;
      })
      .join("");
    return [`<${tag}>${html}</${tag}>`, i];
  }

  const html = blocks(source.replace(/\r\n/g, "\n").split("\n"));
  return { html, headings, title, text: texts.join(" ").replace(/\s+/g, " ").trim() };
}
