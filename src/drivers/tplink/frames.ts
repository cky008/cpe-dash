import { parseJsonText } from "../../protocols/transport.ts";
import { fieldOf, isPlainObject } from "../../protocols/values.ts";

/**
 * The two ways a TP-Link cellular router's page writes a request, once it is decrypted. Both name an
 * object of the router's data model (`LTE_NET_STATUS`, `DEV2_LTE_SERVING_CELL_INFO`), an instance of
 * it (the `stack`, six numbers) and the attributes wanted or set:
 *
 * - the MR series (text): one frame may carry several actions, each a numbered block of
 *   `name=value` lines, answered block by block;
 * - the EX and NX series (JSON): one action per request, answered as `{ success, data }`.
 *
 * Nothing here knows which objects exist: the driver names them.
 */

export type TplinkOperation = "get" | "set" | "add" | "del" | "list" | "getSub" | "run" | "cgi";

export interface TplinkAction {
  operation: TplinkOperation;
  /** The object, or for `cgi` the path of the router's script. */
  oid: string;
  /** The instance (`1,0,0,0,0,0`); left out: the first one. */
  stack?: string;
  /** Attributes to read (names), or to set (name and value). */
  attrs?: ReadonlyArray<string> | Readonly<Record<string, string>>;
}

export const FIRST_STACK = "0,0,0,0,0,0";
const STACK = /^\d{1,4}(?:,\d{1,4}){5}$/;
const OID = /^[A-Za-z0-9_/.]{1,64}$/;
const ATTR_NAME = /^[A-Za-z0-9_]{1,64}$/;

/**
 * What one action answered: an instance's attributes, a list of them, or nothing. An instance of a
 * list carries its own `stack` next to its attributes (the JSON form sends it so; the text form's
 * block header has it), which is what a later write names it by.
 */
export type TplinkResult = Record<string, string> | Array<Record<string, string>> | null;

/** A result as a list: one instance is a list of one, nothing an empty one. */
export function instances(result: TplinkResult | undefined): Array<Record<string, string>> {
  return result === null || result === undefined ? [] : Array.isArray(result) ? result : [result];
}

/** A result as the one instance it should be (the first of a list). */
export function instance(result: TplinkResult | undefined): Record<string, string> | null {
  return instances(result)[0] ?? null;
}

function checked(action: TplinkAction): { oid: string; stack: string; names: string[]; values: Record<string, string> | null } {
  const stack = action.stack ?? FIRST_STACK;
  if (!OID.test(action.oid) || !STACK.test(stack)) throw new TypeError(`Refusing the action "${action.oid.slice(0, 32)}"`);
  const attrs = action.attrs ?? [];
  const names = Array.isArray(attrs) ? [...(attrs as ReadonlyArray<string>)] : Object.keys(attrs);
  if (!names.every((name) => ATTR_NAME.test(name))) throw new TypeError(`Refusing an attribute of "${action.oid.slice(0, 32)}"`);
  return { oid: action.oid, stack, names, values: Array.isArray(attrs) ? null : { ...(attrs as Record<string, string>) } };
}

// ── The MR series: text frames ───────────────────────────────────────────────

const MR_CODES: Readonly<Record<TplinkOperation, number>> = { get: 1, set: 2, add: 3, del: 4, list: 5, getSub: 6, run: 7, cgi: 8 };

/** A value as a frame carries it: a frame is line based, so a line break inside a value travels as a control character. */
export function mrValue(text: string): string {
  return text.replace(/\r/g, "\u0011").replace(/\n/g, "\u0012");
}

/** The reverse, for a value read out of a frame. */
export function mrText(value: string): string {
  return value.replace(/\u0011/g, "\r").replace(/\u0012/g, "\n");
}

/**
 * Several actions as one frame: a first line with each action's number joined by `&`, then one block
 * per action, `[object#stack#0,0,0,0,0,0]index,attributes` followed by its attribute lines.
 */
export function mrFrame(actions: ReadonlyArray<TplinkAction>): string {
  const blocks = actions.map((action, index) => {
    const { oid, stack, names, values } = checked(action);
    const lines = names.map((name) => (values === null ? name : `${name}=${mrValue(values[name] ?? "")}`));
    return [`[${oid}#${stack}#${FIRST_STACK}]${index},${lines.length}`, ...lines].join("\r\n");
  });
  return `${actions.map((action) => MR_CODES[action.operation]).join("&")}\r\n${blocks.join("\r\n")}\r\n`;
}

/**
 * A frame's answer: `[stack]index` opens the attributes of one instance of action `index` (several
 * instances make a list), `[error]code` ends it (`0`: no error), `[cgi]n` opens a script's own text.
 * `results` has one entry per action asked; an action that answered nothing is `null`.
 */
export function parseMrAnswer(text: string, actions: number): { error: number | null; results: TplinkResult[] } {
  const results: TplinkResult[] = Array.from({ length: actions }, () => null);
  let error: number | null = null;
  let current: Record<string, string> | null = null;
  for (const raw of text.slice(0, 512 * 1024).split("\n")) {
    const line = raw.replace(/\r$/, "");
    const header = /^\[([^\]]{1,64})\](\d{1,9})$/.exec(line);
    if (header) {
      current = null;
      const [, stack = "", number = ""] = header;
      if (stack === "error") error = Number(number);
      else if (STACK.test(stack) && Number(number) < actions) {
        current = Object.create(null) as Record<string, string>;
        current["stack"] = stack;
        const index = Number(number);
        const before = results[index] ?? null;
        results[index] = before === null ? current : Array.isArray(before) ? [...before, current] : [before, current];
      }
      continue;
    }
    const eq = line.indexOf("=");
    if (current !== null && eq > 0 && ATTR_NAME.test(line.slice(0, eq))) current[line.slice(0, eq)] = mrText(line.slice(eq + 1));
  }
  return { error, results };
}

// ── The EX and NX series: JSON ───────────────────────────────────────────────

const EX_OPERATIONS: Readonly<Record<TplinkOperation, string>> = { get: "go", set: "so", add: "ao", del: "do", list: "gl", getSub: "gs", run: "op", cgi: "cgi" };

/** One action as the JSON the page posts: the attributes next to the instance, the operation by its short name. */
export function exRequest(action: TplinkAction): string {
  const { oid, stack, names, values } = checked(action);
  const data: Record<string, string> = {};
  for (const name of names) data[name] = values === null ? "" : (values[name] ?? "");
  // The page marks what a person asked for (a write) apart from what it polls
  const active = action.operation === "set" || action.operation === "add" || action.operation === "del" || action.operation === "run";
  return JSON.stringify({ data: { ...data, stack, pstack: FIRST_STACK }, operation: EX_OPERATIONS[action.operation], oid, ...(active ? { isuseractive: true } : {}) });
}

function record(value: unknown): Record<string, string> | null {
  if (!isPlainObject(value)) return null;
  const out = Object.create(null) as Record<string, string>;
  for (const [key, entry] of Object.entries(value)) if (typeof entry === "string" || typeof entry === "number") out[key] = String(entry);
  return out;
}

/**
 * An answer of the JSON form: `success` and what the action read (`data`, an object or a list of
 * them; an answer without it is `null`). `code`: the router's error number, where it gives one.
 */
export function parseExAnswer(text: string): { ok: boolean; code: number | null; result: TplinkResult } {
  const trimmed = text.replace(/[\r\n\t]/g, "").trim();
  if (trimmed === "") return { ok: true, code: null, result: null };
  const parsed = parseJsonText(trimmed, "cgi_gdpr");
  const data = fieldOf(parsed, "data");
  const code = fieldOf(parsed, "errorcode");
  const number = typeof code === "number" ? code : typeof code === "string" && /^-?\d{1,9}$/.test(code) ? Number(code) : null;
  return {
    ok: fieldOf(parsed, "success") !== false && (number === null || number === 0),
    code: number,
    result: Array.isArray(data) ? data.slice(0, 256).flatMap((entry): Array<Record<string, string>> => { const one = record(entry); return one === null ? [] : [one]; }) : record(data),
  };
}

/** `$.ret=<code>;` as the router's scripts answer a login (or `{"ret": <code>}` on newer firmware); `null`: neither. */
export function returnCode(text: string): number | null {
  const script = /\$\.ret=(-?\d{1,9});/.exec(text);
  if (script) return Number(script[1]);
  if (text.trimStart().startsWith("{")) {
    try {
      const ret = fieldOf(parseJsonText(text, "ret"), "ret");
      return typeof ret === "number" && Number.isInteger(ret) ? ret : typeof ret === "string" && /^-?\d{1,9}$/.test(ret) ? Number(ret) : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** A `var name=value;` of one of the router's scripts (`var seq="123";`, `var isLogined=0;`), quotes dropped. */
export function scriptVar(text: string, name: string): string | null {
  const match = new RegExp(`\\bvar ${name}\\s*=\\s*"?([^";\\r\\n]{0,2048})"?;`).exec(text.slice(0, 256 * 1024));
  return match ? (match[1] ?? "").trim() : null;
}
