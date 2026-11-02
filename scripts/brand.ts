/**
 * The FengSui logo has one source: `web/brand/logo.svg` (see docs/BRAND.md). The web build derives
 * the console's sprite symbol from it (coloured by the theme) and ships it unchanged as the favicon
 * (its own <style> follows the system's light / dark). Replacing the logo means replacing that file.
 */

export type MarkRole = "main" | "echo";

export interface BrandMark {
  paths: ReadonlyArray<{ role: MarkRole; d: string }>;
  /** The master file itself: served as favicon.svg. */
  svg: string;
}

export const BRAND_PLACEHOLDER = "{{BRAND_MARK}}";
const VIEW_BOX = "0 0 100 100";
const ALLOWED_TAGS = new Set(["svg", "title", "style", "path"]);
/** Path data only: commands, numbers, separators. Nothing that could close the tag or add markup. */
const PATH_DATA = /^[MmLlHhVvCcSsQqTtAaZz0-9.,\s-]+$/;
const MAX_PATH_LENGTH = 8192;

/** Read and check the master logo; the error names what to fix in the file. */
export function readBrandMark(svg: string): BrandMark {
  const root = /^\s*(?:<\?xml[^>]*\?>\s*)?<svg\b([^>]*)>/.exec(svg);
  if (!root) throw new Error("web/brand/logo.svg must start with an <svg> element");
  if (!new RegExp(`\\sviewBox="${VIEW_BOX}"`).test(root[1] ?? "")) throw new Error(`the logo's <svg> needs viewBox="${VIEW_BOX}"`);
  for (const [, tag] of svg.matchAll(/<([a-zA-Z][\w:-]*)/g)) {
    if (!ALLOWED_TAGS.has(tag ?? "")) throw new Error(`the logo may only contain <svg>, <title>, <style> and <path>; found <${tag}>`);
  }
  if (/\son\w+\s*=|javascript:|href\s*=/i.test(svg)) throw new Error("the logo must not carry event handlers or links");
  const paths: Array<{ role: MarkRole; d: string }> = [];
  for (const [element] of svg.matchAll(/<path\b[^>]*>/g)) {
    const role = /\sclass="(main|echo)"/.exec(element)?.[1];
    const d = /\sd="([^"]*)"/.exec(element)?.[1];
    if (role !== "main" && role !== "echo") throw new Error(`every <path> needs class="main" or class="echo": ${element.slice(0, 60)}`);
    if (!d || d.length > MAX_PATH_LENGTH || !PATH_DATA.test(d)) throw new Error(`a ${role} path has missing or unexpected path data`);
    paths.push({ role, d });
  }
  if (!paths.some((p) => p.role === "main")) throw new Error('the logo needs at least one class="main" path');
  if (!/@media\s*\(prefers-color-scheme:\s*dark\)/.test(svg)) throw new Error("the logo's <style> needs a (prefers-color-scheme: dark) block for the favicon");
  return { paths, svg: svg.endsWith("\n") ? svg : `${svg}\n` };
}

/** `<symbol id="i-mark">`: each arc takes the colour the theme computes for its role (web/styles.css `.fs-mark`). */
export function brandSymbol(mark: BrandMark): string {
  const paths = mark.paths.map((p) => `<path style="fill: var(--mark-${p.role}); stroke: none" d="${p.d}"/>`).join("");
  return `<symbol id="i-mark" viewBox="${VIEW_BOX}">${paths}</symbol>`;
}

/** Put the symbol where web/index.html keeps the placeholder (exactly once, inside the sprite). */
export function injectBrand(html: string, mark: BrandMark): string {
  const at = html.indexOf(BRAND_PLACEHOLDER);
  if (at < 0 || html.indexOf(BRAND_PLACEHOLDER, at + 1) >= 0) throw new Error(`web/index.html must contain ${BRAND_PLACEHOLDER} exactly once`);
  return html.slice(0, at) + brandSymbol(mark) + html.slice(at + BRAND_PLACEHOLDER.length);
}
