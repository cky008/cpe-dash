import { h } from "./dom.ts";

/**
 * Copy text. The async clipboard needs a secure context (HTTPS or localhost); a console opened over
 * plain HTTP on the LAN falls back to a selected textarea inside `host` (a modal dialog makes the
 * rest of the page inert, so the textarea must live in it).
 */
export async function copyText(host: HTMLElement, text: string): Promise<boolean> {
  if (window.isSecureContext && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Permission denied: try the fallback
    }
  }
  const area = h("textarea", { class: "fixed opacity-0 pointer-events-none", attrs: { readonly: "", "aria-hidden": "true" } });
  area.value = text;
  host.appendChild(area);
  area.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
  }
}
