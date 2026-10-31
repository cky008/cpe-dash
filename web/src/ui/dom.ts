/**
 * Minimal DOM builder. Strings always become text nodes — never HTML — so untrusted data (SMS bodies,
 * sender names, DHCP host names) cannot inject markup; the dashboard never assigns `innerHTML`.
 */

export type Child = Node | string | number | null | undefined | false;

export interface Props {
  class?: string;
  title?: string;
  /** Attributes set verbatim (`aria-*`, `type`, `role`, …). */
  attrs?: Readonly<Record<string, string>>;
  data?: Readonly<Record<string, string>>;
  style?: string;
  on?: { [K in keyof HTMLElementEventMap]?: (event: HTMLElementEventMap[K]) => void };
}

const SVG_NS = "http://www.w3.org/2000/svg";

function append(parent: Node, children: ReadonlyArray<Child>): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(typeof child === "string" || typeof child === "number" ? document.createTextNode(String(child)) : child);
  }
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    if (props.class) el.className = props.class;
    if (props.title) el.title = props.title;
    if (props.style) el.setAttribute("style", props.style);
    for (const [k, v] of Object.entries(props.attrs ?? {})) el.setAttribute(k, v);
    for (const [k, v] of Object.entries(props.data ?? {})) el.dataset[k] = v;
    const handlers = props.on ?? {};
    for (const key of Object.keys(handlers) as Array<keyof HTMLElementEventMap>) {
      const handler = handlers[key];
      if (handler) el.addEventListener(key, handler as EventListener);
    }
  }
  append(el, children);
  return el;
}

/** An SVG element with attributes (charts, gauges). */
export function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Readonly<Record<string, string | number>> = {}, ...children: SVGElement[]): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  for (const child of children) el.appendChild(child);
  return el;
}

/** `<svg class="ico …"><use href="#i-name"/></svg>` from the sprite in index.html. */
export function icon(name: string, cls = ""): SVGSVGElement {
  const el = svg("svg", { class: `ico ${cls}`.trim(), "aria-hidden": "true" });
  el.appendChild(svg("use", { href: `#i-${name}` }));
  return el;
}

export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id} in index.html`);
  return el as T;
}

/** Replace all children (old nodes become unreachable and are collected with their listeners). */
export function mount(parent: Element, ...children: Child[]): void {
  parent.replaceChildren();
  append(parent, children);
}

export function setText(el: Element, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

export function show(el: Element, visible: boolean): void {
  el.classList.toggle("hidden", !visible);
}

/** Restart a CSS animation class on an element. */
export function replay(el: HTMLElement, cls: string): void {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}

/** Debounce for input handlers. */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): (...args: A) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (...args: A) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, ms);
  };
}
