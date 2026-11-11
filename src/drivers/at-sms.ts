import { SmsPduError, decodeSmsPdu } from "../sms/pdu.ts";
import type { SmsSegment } from "./sms.ts";

/**
 * SMS through a modem's own AT commands (3GPP TS 27.005), for a router that offers nothing above
 * them: what `AT+CPMS?` and `AT+CMGL=4` answer, as counts and stored message parts. Pure parsing; the
 * driver sends the commands.
 */

/** `<stat>` of a stored message in PDU mode (TS 27.005 §3.1): received unread, received read, stored unsent, stored sent. */
const STAT_UNREAD = 0;
const STAT_UNSENT = 2;
const STAT_SENT = 3;

/**
 * The storage `AT+CPMS?` names first (the one messages are read and deleted from): how many
 * messages it holds and how many fit. `null`: no such answer.
 */
export function parseCpms(answer: string): { used: number; total: number } | null {
  const match = /\+CPMS:\s*(?:"[A-Za-z]{2}"\s*,\s*)?(\d{1,5})\s*,\s*(\d{1,5})/.exec(answer);
  if (!match) return null;
  return { used: Number.parseInt(match[1] ?? "0", 10), total: Number.parseInt(match[2] ?? "0", 10) };
}

/**
 * The parts `AT+CMGL=4` lists (PDU mode: a `+CMGL: <index>,<stat>,[<alpha>],<length>` line, then the
 * PDU). A part's handle is its storage index plus one, so that no handle is zero. Drafts, status
 * reports and PDUs that do not decode are left out.
 */
export function parseCmglPdus(answer: string): SmsSegment[] {
  const lines = answer.split(/\r?\n/).map((line) => line.trim());
  const out: SmsSegment[] = [];
  for (let i = 0; i < lines.length; i++) {
    const head = /^\+CMGL:\s*(\d{1,5})\s*,\s*(\d)\s*,/.exec(lines[i] ?? "");
    if (!head) continue;
    const pdu = lines[i + 1] ?? "";
    const index = Number.parseInt(head[1] ?? "", 10);
    const stat = Number.parseInt(head[2] ?? "", 10);
    if (stat === STAT_UNSENT || !/^[0-9A-Fa-f]{16,700}$/.test(pdu)) continue;
    i += 1;
    try {
      const decoded = decodeSmsPdu(pdu);
      out.push({
        index: index + 1,
        phone: decoded.address,
        date: decoded.date,
        unread: stat === STAT_UNREAD,
        outgoing: stat === STAT_SENT || decoded.kind === "submit",
        text: decoded.text,
        concat: decoded.concat,
      });
    } catch (err) {
      if (!(err instanceof SmsPduError)) throw err;
    }
  }
  return out;
}

/** The numeric code of a `+CMS ERROR: <n>` / `+CME ERROR: <n>` answer, as a router code that may be kept (`null`: none). */
export function atErrorCode(answer: string): string | null {
  const match = /\+CM[SE] ERROR:\s*(\d{1,4})\b/.exec(answer);
  return match ? `cms-${match[1] ?? ""}` : null;
}
