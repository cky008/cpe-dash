import { stripInvalidControlChars } from "../crypto.ts";
import type { EphemeralCpeSession } from "../cpe-client.ts";
import { CpeApiError } from "../session-errors.ts";
import { CpeControlValidationError } from "../cpe-domain.ts";
import type { WriteCheck } from "../device-access.ts";
import { settleCheck } from "../generic-writes.ts";
import type { MutexSessionScheduler } from "../scheduler.ts";
import { PreEscapedXmlText, formatHuaweiDate, getXmlBlocks, getXmlTag } from "../xml.ts";
import { MAX_SMS_SEGMENTS, detectSmsTextMode, parseSmsCounters, parseSmsCountersOrNull, parseSmsMessageBlock } from "./codec.ts";
import { validateGenericSmsContent } from "./text-mode.ts";
import type { SmsCounters, SmsFetchResult, SmsSendResult, SmsTextModeInfo, SmsWireMessage } from "./types.ts";

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

export type { SmsFetchResult, SmsListingPath } from "./types.ts";

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
  scheduler: Pick<MutexSessionScheduler, "probePublic">
): Promise<{ unreadMessages: number; storageFull: boolean }> {
  const xml = await scheduler.probePublic("/api/monitoring/check-notifications");
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
  /** Monotonic clock in ms for the polling bound (default `performance.now`). */
  now?: () => number;
  /** Called once the router accepted `send-sms`: from then on the message is on its way. */
  onAccepted?: () => void;
}

/** The outcome of an accepted submission whose delivery the router has not confirmed (yet). */
export function unconfirmedSendResult(prepared: PreparedSmsSubmission): SmsSendResult {
  return {
    submitted: true,
    encoding: prepared.mode.encoding,
    segments: prepared.mode.segments,
    ok: true,
    timedOutWaitingStatus: true,
    sentPhones: [...prepared.phones],
    failedPhones: [],
    failCode: null,
  };
}

function splitPhoneList(raw: string | null): string[] {
  return (raw ?? "")
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Submit `POST /api/sms/send-sms` (`enc-type=2`) and poll `send-status` (`enc-type=1`) until the
 * router reports the recipients as delivered/failed or the status timeout elapses. The timeout is
 * wall time: slow polls end the loop early instead of stretching it to `polls × request timeout`.
 *
 * Once `send-sms` was accepted the message is on its way, so a status-polling failure (timeout,
 * reset, expired session) yields `timedOutWaitingStatus: true` instead of an error: reporting it as
 * failed would invite the caller to resend and deliver the message twice.
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
  opts.onAccepted?.();
  return await pollSendStatus(prepared, () => session.postEncrypted("/api/sms/send-status", {}, 1), opts);
}

/**
 * Poll `send-status` (read by `readStatus`) until the router reports the recipients as delivered or
 * failed, or the wall-time timeout elapses; a polling failure means unconfirmed, never failed.
 */
async function pollSendStatus(prepared: PreparedSmsSubmission, readStatus: () => Promise<string>, opts: SubmitSmsOptions): Promise<SmsSendResult> {
  const timeoutMs = opts.statusTimeoutMs ?? 45_000;
  const intervalMs = Math.max(1, opts.statusIntervalMs ?? 2000);
  const maxPolls = Math.max(1, Math.ceil(timeoutMs / intervalMs));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = opts.now ?? (() => performance.now());
  const base = { submitted: true, encoding: prepared.mode.encoding, segments: prepared.mode.segments };
  const unconfirmed = unconfirmedSendResult(prepared);

  const startedAt = now();
  for (let attempt = 0; attempt < maxPolls && now() - startedAt < timeoutMs; attempt++) {
    let status: string;
    try {
      await sleep(intervalMs);
      status = await readStatus();
    } catch {
      return unconfirmed;
    }
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

  return unconfirmed;
}

/** Element text escaped the way the reference project's serializer does it (`&`, `<`, `>` only). */
function escapeElementText(text: string): PreEscapedXmlText {
  return PreEscapedXmlText.fromEscaped(text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"));
}

/**
 * Send on a model nobody verified: plaintext `POST /api/sms/send-sms` with the fields of the
 * reference project in its order (`Length` counts characters, `Reserved` is the text mode), then poll
 * plaintext `GET /api/sms/send-status`. A settled send is the read-back: every recipient named as
 * delivered is a match, failed a mismatch, unsettled unknown, and so is a status naming fewer
 * recipients (a firmware whose status has other fields names none). Never repeated, like the
 * verified send.
 */
export async function genericSendSms(
  session: EphemeralCpeSession,
  check: WriteCheck,
  prepared: PreparedSmsSubmission,
  opts: SubmitSmsOptions = {}
): Promise<SmsSendResult> {
  validateGenericSmsContent(prepared.content);
  check.endpoints.push("/api/sms/send-sms");
  await session.postXml("/api/sms/send-sms", {
    Index: -1,
    Phones: { Phone: prepared.phones },
    Sca: "",
    Content: escapeElementText(prepared.content),
    Length: [...prepared.content].length,
    Reserved: prepared.mode.textMode,
    Date: formatHuaweiDate(new Date()),
  });
  opts.onAccepted?.();
  let status = "";
  const result = await pollSendStatus(prepared, async () => (status = await session.get("/api/sms/send-status")), opts);
  // The send result reads an empty status as sent (the H168-383's way); the read-back wants the router to say so
  const delivered = splitPhoneList(getXmlTag(status, "SucPhone")).length >= prepared.phones.length;
  if (result.timedOutWaitingStatus) settleCheck(check, null, "send_failed", "send_unconfirmed");
  else settleCheck(check, result.ok ? (delivered ? true : null) : false, "send_failed");
  return result;
}

/** The SMS counts before a generic write (a broken session fails it) or after (never fails it). */
async function countsOrNull(session: EphemeralCpeSession, afterWrite: boolean): Promise<SmsCounters | null> {
  try {
    return parseSmsCountersOrNull(await session.get("/api/sms/sms-count"));
  } catch (err) {
    if (afterWrite || err instanceof CpeApiError) return null;
    throw err;
  }
}

/** One message per request (`<Index>`), as the reference project writes them, read back by the counts. */
async function genericIndexWrites(
  session: EphemeralCpeSession,
  check: WriteCheck,
  apiPath: string,
  indices: ReadonlyArray<number>,
  count: (counters: SmsCounters) => number
): Promise<number> {
  const clean = sanitizeIndices(indices);
  if (clean.length === 0) return 0;
  const before = await countsOrNull(session, false);
  check.endpoints.push(apiPath);
  for (const index of clean) await session.postXml(apiPath, { Index: index });
  const after = await countsOrNull(session, true);
  if (!before || !after) {
    settleCheck(check, null);
  } else {
    const moved = count(before) - count(after);
    settleCheck(check, moved === clean.length ? true : moved === 0 ? false : null, "no_change", "unclear_change");
  }
  return clean.length;
}

/** Mark read on a model nobody verified (`POST /api/sms/set-read`); the unread count must drop by as many. */
export async function genericMarkSmsRead(session: EphemeralCpeSession, check: WriteCheck, indices: ReadonlyArray<number>): Promise<number> {
  return await genericIndexWrites(session, check, "/api/sms/set-read", indices, (c) => c.localUnread);
}

/** Delete on a model nobody verified (`POST /api/sms/delete-sms`); the stored count must drop by as many. */
export async function genericDeleteSms(session: EphemeralCpeSession, check: WriteCheck, indices: ReadonlyArray<number>): Promise<number> {
  return await genericIndexWrites(session, check, "/api/sms/delete-sms", indices, (c) => c.localInbox + c.localOutbox + c.localDraft);
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
