import { stripInvalidControlChars } from "../crypto.ts";
import { CpeApiError, type EphemeralCpeSession, type HuaweiCpeClient } from "../cpe-client.ts";
import { CpeControlValidationError } from "../cpe-domain.ts";
import { PreEscapedXmlText, formatHuaweiDate, getXmlBlocks, getXmlTag } from "../xml.ts";
import { MAX_SMS_SEGMENTS, detectSmsTextMode, parseSmsCounters, parseSmsMessageBlock } from "./codec.ts";
import type { SmsCounters, SmsSendResult, SmsTextModeInfo, SmsWireMessage } from "./types.ts";

export { parseSmsCounters } from "./codec.ts";

/**
 * H168-383 SMS wire operations. Every function runs inside an `EphemeralCpeSession` handed out by
 * `MutexSessionScheduler`, so SMS traffic shares the single admin session, browser avoidance and
 * the `108006` breaker with telemetry and controls.
 *
 * Listing prefers plain `POST /api/sms/sms-list`; when the router rejects it with a CPE error code
 * it falls back to the AES-256-GCM contact (`enc-type=1`) and per-phone (`enc-type=3`) listings.
 */

export const MAX_SMS_RECIPIENTS = 5;
const SMS_LIST_PAGE_SIZE = 50;
const CONTACT_PAGE_SIZE = 20;
const INDEX_BATCH_SIZE = 20;
const MAX_LIST_PAGES = 40;

export type SmsListingPath = "sms-list" | "contact-list";

export interface SmsFetchResult {
  counters: SmsCounters;
  messages: SmsWireMessage[];
  via: SmsListingPath;
}

function readInt(xml: string, tag: string, fallback: number): number {
  const parsed = Number.parseInt(getXmlTag(xml, tag) ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export async function readSmsCounters(session: EphemeralCpeSession): Promise<SmsCounters> {
  return parseSmsCounters(await session.get("/api/sms/sms-count"));
}

/**
 * Unauthenticated `GET /api/monitoring/check-notifications`: unread count and storage-full flag
 * without occupying the admin session (usable while yielding to a human browser session).
 */
export async function checkSmsNotifications(
  client: HuaweiCpeClient
): Promise<{ unreadMessages: number; storageFull: boolean }> {
  const xml = await client.getPublic("/api/monitoring/check-notifications");
  return {
    unreadMessages: readInt(xml, "UnreadMessage", 0),
    storageFull: getXmlTag(xml, "SmsStorageFull") === "1",
  };
}

async function listBoxPage(
  session: EphemeralCpeSession,
  box: 1 | 2,
  page: number,
  count: number
): Promise<SmsWireMessage[]> {
  const xml = await session.postXml("/api/sms/sms-list", {
    PageIndex: page,
    ReadCount: count,
    BoxType: box,
    SortType: 0,
    Ascending: 0,
    UnreadPreferred: 0,
  });
  return getXmlBlocks(xml, "Message").map((b) => parseSmsMessageBlock(b, box === 1 ? "0" : "1"));
}

async function listContactPage(session: EphemeralCpeSession, page: number, count: number): Promise<SmsWireMessage[]> {
  const xml = await session.postEncrypted("/api/sms/sms-list-contact", { pageindex: page, readcount: count }, 1);
  return getXmlBlocks(xml, "message").map((b) => parseSmsMessageBlock(b));
}

async function countPhoneMessages(session: EphemeralCpeSession, phone: string): Promise<number> {
  const xml = await session.postEncrypted(
    "/api/sms/sms-count-contact",
    { phone: PreEscapedXmlText.fromHuaweiXss(phone) },
    2
  );
  return readInt(xml, "count", 0);
}

async function listPhonePage(
  session: EphemeralCpeSession,
  phone: string,
  page: number,
  count: number
): Promise<SmsWireMessage[]> {
  const xml = await session.postEncrypted(
    "/api/sms/sms-list-phone",
    { phone, pageindex: page, readcount: count },
    3
  );
  return getXmlBlocks(xml, "message").map((b) => parseSmsMessageBlock(b));
}

/**
 * Newest messages of one conversation (both directions), e.g. to read back a just-sent message.
 */
export async function fetchPhoneThread(
  session: EphemeralCpeSession,
  phone: string,
  count = CONTACT_PAGE_SIZE
): Promise<SmsWireMessage[]> {
  if ((await countPhoneMessages(session, phone)) === 0) return [];
  return await listPhonePage(session, phone, 1, Math.min(CONTACT_PAGE_SIZE, Math.max(1, count)));
}

function dedupeByIndex(messages: ReadonlyArray<SmsWireMessage>): SmsWireMessage[] {
  const seen = new Map<number, SmsWireMessage>();
  for (const m of messages) seen.set(m.index, m);
  return [...seen.values()];
}

/**
 * Incremental sync: newest inbox page via `sms-list`, or (fallback) the newest message of each
 * conversation plus a full first page of every conversation `expandThread` selects.
 */
export async function fetchRecentMessages(
  session: EphemeralCpeSession,
  opts: { count?: number; expandThread?: (latest: SmsWireMessage) => boolean } = {}
): Promise<SmsFetchResult> {
  const counters = await readSmsCounters(session);
  const count = Math.min(SMS_LIST_PAGE_SIZE, Math.max(1, opts.count ?? 20));
  try {
    return { counters, messages: await listBoxPage(session, 1, 1, count), via: "sms-list" };
  } catch (err) {
    if (!(err instanceof CpeApiError)) throw err;
  }

  const latest = await listContactPage(session, 1, Math.min(CONTACT_PAGE_SIZE, count));
  const messages = [...latest];
  for (const m of latest) {
    if (m.phone && (opts.expandThread?.(m) ?? true)) {
      messages.push(...(await fetchPhoneThread(session, m.phone)));
    }
  }
  return { counters, messages: dedupeByIndex(messages), via: "contact-list" };
}

/**
 * Full sync of every stored message (inbox + outbox), used to (re)build the local mirror.
 */
export async function fetchAllMessages(session: EphemeralCpeSession): Promise<SmsFetchResult> {
  const counters = await readSmsCounters(session);
  try {
    const messages: SmsWireMessage[] = [];
    for (const [box, total] of [
      [1, counters.localInbox],
      [2, counters.localOutbox],
    ] as const) {
      const pages = Math.min(MAX_LIST_PAGES, Math.ceil(total / SMS_LIST_PAGE_SIZE));
      for (let page = 1; page <= pages; page++) {
        const items = await listBoxPage(session, box, page, SMS_LIST_PAGE_SIZE);
        messages.push(...items);
        if (items.length < SMS_LIST_PAGE_SIZE) break;
      }
    }
    return { counters, messages: dedupeByIndex(messages), via: "sms-list" };
  } catch (err) {
    if (!(err instanceof CpeApiError)) throw err;
  }

  const contactTotal = readInt(await session.get("/api/sms/sms-count-contact"), "count", 0);
  const phones = new Set<string>();
  for (let page = 1; page <= Math.min(MAX_LIST_PAGES, Math.ceil(contactTotal / CONTACT_PAGE_SIZE)); page++) {
    for (const m of await listContactPage(session, page, CONTACT_PAGE_SIZE)) {
      if (m.phone) phones.add(m.phone);
    }
  }
  const messages: SmsWireMessage[] = [];
  for (const phone of phones) {
    const total = await countPhoneMessages(session, phone);
    for (let page = 1; page <= Math.min(MAX_LIST_PAGES, Math.ceil(total / CONTACT_PAGE_SIZE)); page++) {
      messages.push(...(await listPhonePage(session, phone, page, CONTACT_PAGE_SIZE)));
    }
  }
  return { counters, messages: dedupeByIndex(messages), via: "contact-list" };
}

export interface PreparedSmsSubmission {
  phones: string[];
  content: string;
  mode: SmsTextModeInfo;
}

/**
 * Validate recipients and body before any CPE session is queued (throws `CpeControlValidationError`).
 */
export function prepareSmsSubmission(phones: ReadonlyArray<string>, content: string): PreparedSmsSubmission {
  const normalized = [...new Set(phones.map((p) => p.trim().replace(/[\s-]/g, "")).filter(Boolean))];
  if (normalized.length === 0) {
    throw new CpeControlValidationError("Provide at least one recipient number");
  }
  if (normalized.length > MAX_SMS_RECIPIENTS) {
    throw new CpeControlValidationError(`Send to at most ${MAX_SMS_RECIPIENTS} recipients at once`);
  }
  for (const phone of normalized) {
    if (!/^\+?[0-9]{3,20}$/.test(phone)) {
      throw new CpeControlValidationError(`Recipient "${phone}" is not a dialable number`);
    }
  }
  const clean = stripInvalidControlChars(content).trim();
  if (!clean) {
    throw new CpeControlValidationError("Message content is empty");
  }
  const mode = detectSmsTextMode(clean);
  if (mode.segments > MAX_SMS_SEGMENTS) {
    throw new CpeControlValidationError(
      `Message needs ${mode.segments} segments; the CPE accepts at most ${MAX_SMS_SEGMENTS} segments per send`
    );
  }
  return { phones: normalized, content: clean, mode };
}

export interface SubmitSmsOptions {
  /** Upper bound for polling `send-status` inside the session (default 45 s, as verified on H168-383). */
  statusTimeoutMs?: number;
  statusIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

function splitPhoneList(raw: string | null): string[] {
  return (raw ?? "")
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Submit `POST /api/sms/send-sms` (`enc-type=2`) and poll `send-status` (`enc-type=1`) until the
 * router reports the recipients as delivered/failed or the bounded timeout elapses.
 */
export async function submitSms(
  session: EphemeralCpeSession,
  prepared: PreparedSmsSubmission,
  opts: SubmitSmsOptions = {}
): Promise<SmsSendResult> {
  const content = PreEscapedXmlText.fromHuaweiXss(prepared.content);
  await session.postEncrypted(
    "/api/sms/send-sms",
    {
      Index: -1,
      Phones: { Phone: prepared.phones },
      Sca: "",
      Content: content,
      Length: content.value.length,
      Reserved: prepared.mode.textMode,
      Date: formatHuaweiDate(new Date()),
    },
    2
  );

  const intervalMs = Math.max(1, opts.statusIntervalMs ?? 2000);
  const maxPolls = Math.max(1, Math.ceil((opts.statusTimeoutMs ?? 45_000) / intervalMs));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const base = { submitted: true, encoding: prepared.mode.encoding, segments: prepared.mode.segments };

  for (let attempt = 0; attempt < maxPolls; attempt++) {
    await sleep(intervalMs);
    const status = await session.postEncrypted("/api/sms/send-status", {}, 1);
    if ((getXmlTag(status, "Phone") ?? "") !== "") continue;

    const sentPhones = splitPhoneList(getXmlTag(status, "SucPhone"));
    const failedPhones = splitPhoneList(getXmlTag(status, "FailPhone"));
    const rawCode = getXmlTag(status, "SendFailCode") ?? "";
    const failCode = rawCode && rawCode !== "0" ? rawCode : null;
    const ok = failedPhones.length === 0 && (sentPhones.length > 0 || failCode === null);
    return {
      ...base,
      ok,
      timedOutWaitingStatus: false,
      sentPhones: sentPhones.length > 0 ? sentPhones : ok ? [...prepared.phones] : [],
      failedPhones,
      failCode,
    };
  }

  return {
    ...base,
    ok: true,
    timedOutWaitingStatus: true,
    sentPhones: [...prepared.phones],
    failedPhones: [],
    failCode: null,
  };
}

function sanitizeIndices(indices: ReadonlyArray<number>): number[] {
  return [...new Set(indices.filter((n) => Number.isSafeInteger(n) && n > 0))];
}

async function postIndexBatches(session: EphemeralCpeSession, apiPath: string, indices: ReadonlyArray<number>): Promise<number> {
  const clean = sanitizeIndices(indices);
  for (let i = 0; i < clean.length; i += INDEX_BATCH_SIZE) {
    await session.postXml(apiPath, { Index: clean.slice(i, i + INDEX_BATCH_SIZE) });
  }
  return clean.length;
}

export async function markSmsRead(session: EphemeralCpeSession, indices: ReadonlyArray<number>): Promise<number> {
  return await postIndexBatches(session, "/api/sms/set-read", indices);
}

export async function deleteSmsByIndex(session: EphemeralCpeSession, indices: ReadonlyArray<number>): Promise<number> {
  return await postIndexBatches(session, "/api/sms/delete-sms", indices);
}
