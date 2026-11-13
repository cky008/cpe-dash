import { getXmlTag, getXmlTextPreserve } from "../xml.ts";
import type { SmsCounters, SmsWireMessage } from "./types.ts";

function readCount(xml: string, tag: string, fallback: number): number {
  const parsed = Number.parseInt(getXmlTag(xml, tag) ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** Parse `GET /api/sms/sms-count`; returns `null` when the response carries no SMS counters. */
export function parseSmsCountersOrNull(xml: string): SmsCounters | null {
  if (!xml || getXmlTag(xml, "LocalInbox") === null) return null;
  return parseSmsCounters(xml);
}

export function parseSmsCounters(xml: string): SmsCounters {
  return {
    localUnread: readCount(xml, "LocalUnread", 0),
    localInbox: readCount(xml, "LocalInbox", 0),
    localOutbox: readCount(xml, "LocalOutbox", 0),
    localDraft: readCount(xml, "LocalDraft", 0),
    localMax: readCount(xml, "LocalMax", 500) || 500,
  };
}

/**
 * Parse one CPE `<Message>` (plain `sms-list`) or `<message>` (encrypted contact/phone lists) block.
 * `boxHint` is the box requested by the listing call; an explicit `<curbox>` or an outgoing
 * `<smstat>` (`3`/`4`) always wins.
 */
export function parseSmsMessageBlock(block: string, boxHint: "0" | "1" | null = null): SmsWireMessage {
  const smstat = getXmlTag(block, "smstat") || "1";
  const curbox = getXmlTag(block, "curbox") || boxHint || (smstat === "3" || smstat === "4" ? "1" : "0");
  const outgoing = curbox === "1" || smstat === "3" || smstat === "4";
  return {
    index: Number.parseInt(getXmlTag(block, "index") ?? "0", 10) || 0,
    phone: getXmlTag(block, "phone") ?? "",
    content: getXmlTextPreserve(block, "content"),
    date: getXmlTag(block, "date") ?? "",
    smstat,
    isUnread: smstat === "0" && !outgoing,
    direction: outgoing ? "out" : "in",
  };
}
