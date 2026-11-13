import type { SmsCounters, SmsWireMessage } from "../../sms/types.ts";
import { dateOfParts, storedIndices, textOfUcs2Hex, wireMessage } from "../sms.ts";

/**
 * What ZTE's two interfaces share for SMS: the goform pages and the zWRT ubus object name the same
 * store the same way (its rows and tags, its counts, its message times, its id lists, and the status
 * slot a send or a delete reports through).
 */

const two = (n: number): string => String(n).padStart(2, "0");

/** ZTE's message time, `yy,MM,dd,HH,mm,ss,±zone` (commas or semicolons), as the mirror keeps it. */
export function zteSmsDate(raw: string): string {
  return dateOfParts(raw.split(/[,;]/));
}

/** The time a ZTE send carries: `yy;MM;dd;HH;mm;ss;±h`, local time and its offset in hours, as the router's page writes it. */
export function zteSmsTime(now: Date): string {
  const offsetHours = Math.trunc(-now.getTimezoneOffset() / 60);
  const zone = offsetHours > 0 ? `+${offsetHours}` : String(offsetHours);
  return [two(now.getFullYear() % 100), two(now.getMonth() + 1), two(now.getDate()), two(now.getHours()), two(now.getMinutes()), two(now.getSeconds()), zone].join(";");
}

/** ZTE's ids joined the way its page joins them: each followed by `;`. */
export function zteIdList(indices: ReadonlyArray<number>): string {
  return storedIndices(indices)
    .map((id) => `${id};`)
    .join("");
}

/** ZTE's tags: `0` read, `1` unread, `2` sent, `3` not sent, `4` draft. */
const ZTE_TAG_UNREAD = "1";
const ZTE_TAG_SENT = "2";

function plainText(value: unknown): string | null {
  if (typeof value === "string") return value;
  return typeof value === "number" && Number.isFinite(value) ? String(value) : null;
}

/**
 * The rows of a ZTE listing (`messages`: `id`, `number`, `content`, `tag`, `date`) as stored
 * messages. `field` turns a number or a body as the router sent it into plain text (`null`: not
 * readable, the row is left out); bodies are UTF-16 hexadecimal underneath. Drafts and sends that
 * never went out are not messages; a long message is one row, joined by the router.
 */
export function parseZteSmsRows(rows: unknown, field: (raw: string, kind: "number" | "content") => string | null = (raw) => raw): SmsWireMessage[] {
  if (!Array.isArray(rows)) return [];
  const out: SmsWireMessage[] = [];
  for (const row of rows.slice(0, 2000)) {
    if (typeof row !== "object" || row === null || Array.isArray(row)) continue;
    const record = row as Record<string, unknown>;
    const id = Number.parseInt(plainText(record["id"]) ?? "", 10);
    const tag = plainText(record["tag"]) ?? "0";
    if (!Number.isSafeInteger(id) || id <= 0 || tag === "3" || tag === "4") continue;
    const number = field(plainText(record["number"]) ?? "", "number");
    const body = field(plainText(record["content"]) ?? "", "content");
    if (number === null || body === null) continue;
    out.push(
      wireMessage({
        index: id,
        phone: number.trim(),
        // A body that is not hexadecimal text is shown as the router sent it
        content: textOfUcs2Hex(body) ?? body,
        date: zteSmsDate(plainText(record["date"]) ?? ""),
        unread: tag === ZTE_TAG_UNREAD,
        outgoing: tag === ZTE_TAG_SENT,
      })
    );
  }
  return out;
}

function count(value: unknown): number | null {
  const text = plainText(value);
  if (text === null || !/^\d{1,6}$/.test(text.trim())) return null;
  return Number.parseInt(text.trim(), 10);
}

/**
 * The counts of the router's own store from ZTE's capacity fields (`sms_nv_*`: received, sent,
 * drafts, capacity) and its unread count. `null`: the answer names no store, so this firmware has no SMS.
 */
export function zteSmsCounters(capacity: Record<string, unknown>, unread: unknown): SmsCounters | null {
  const max = count(capacity["sms_nv_total"]);
  const inbox = count(capacity["sms_nv_rev_total"]);
  if (max === null || inbox === null) return null;
  return {
    localUnread: Math.min(inbox, count(unread) ?? count(capacity["sms_dev_unread_num"]) ?? 0),
    localInbox: inbox,
    localOutbox: count(capacity["sms_nv_send_total"]) ?? 0,
    localDraft: count(capacity["sms_nv_draftbox_total"]) ?? 0,
    localMax: max > 0 ? max : 100,
  };
}

/**
 * What ZTE's send and delete report through their status slot: `3` done, `2` failed, anything else
 * (an empty slot included) still under way.
 */
export function zteCommandStatus(answer: Record<string, unknown>): "done" | "failed" | "pending" {
  const result = plainText(answer["sms_cmd_status_result"]);
  return result === "3" ? "done" : result === "2" ? "failed" : "pending";
}

/** ZTE's status slots. */
export const ZTE_SMS_CMD_SEND = 4;
export const ZTE_SMS_CMD_DELETE = 6;

/**
 * Ask a status slot every `intervalMs` (a second, as the router's page does) until it says done or
 * failed, or `timeoutMs` passed. A read that fails ends the wait as undecided: the command was taken,
 * and is never sent again.
 */
export async function awaitZteCommand(
  read: () => Promise<Record<string, unknown>>,
  opts: { timeoutMs: number; intervalMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number }
): Promise<"done" | "failed" | "pending"> {
  const now = opts.now ?? (() => performance.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const intervalMs = Math.max(1, opts.intervalMs ?? 1000);
  const startedAt = now();
  const polls = Math.max(1, Math.ceil(opts.timeoutMs / intervalMs));
  for (let attempt = 0; attempt < polls && now() - startedAt < opts.timeoutMs; attempt++) {
    try {
      await sleep(intervalMs);
      const status = zteCommandStatus(await read());
      if (status !== "pending") return status;
    } catch {
      return "pending";
    }
  }
  return "pending";
}
