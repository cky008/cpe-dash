import type {
  ContactRecord,
  DeletedSmsMessage,
  EnrichedSmsMessage,
  SmsSendPreview,
  SmsSendResult,
  SmsStatusSnapshot,
  SmsSyncSummary,
  SmsThreadDetail,
  SmsThreadSummary,
  VcardImportSummary,
} from "../../../src/api-contract.ts";
import { extractVerificationCode } from "../../../src/sms/otp.ts";
import { buildPhoneLookupKeys, resolveRecipientPhone } from "../../../src/sms/phone.ts";
import { MAX_SMS_SEGMENTS, detectSmsTextMode } from "../../../src/sms/text-mode.ts";
import { type ThreadViewContext, enrichSmsMessage, getSmsThread, listSmsThreads, smsThreadStats } from "../../../src/sms/thread-view.ts";
import type { ContactBrief, SmsCounters, SmsMessageRecord, SmsThreadFilter, SmsTrashRecord } from "../../../src/sms/types.ts";
import { parseVcardContacts } from "../../../src/sms/vcard.ts";
import { formatRouterDate } from "./seed.ts";

/**
 * The demo's SMS store and contact book, in memory. Conversation views, number parsing, OTP
 * extraction, segment counting and vCard parsing are the daemon's own shared modules; the limits
 * and error messages below mirror src/sms (service, protocol, contacts, http-routes).
 */

export class DemoValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DemoValidationError";
  }
}

const MAX_SMS_RECIPIENTS = 5;
const MAX_UIDS_PER_REQUEST = 200;
const MAX_DELETE_BATCH = 50;
const MAX_CONTACTS = 5000;
const MAX_NAME_LENGTH = 64;
const MAX_NOTE_LENGTH = 200;
const MAX_SEARCH_QUERY = 100;

export interface DemoSmsSeed {
  status: SmsStatusSnapshot;
  messages: SmsMessageRecord[];
  contacts: ContactRecord[];
}

export interface DemoSmsSendOutcome {
  result: SmsSendResult;
  resolvedPhones: string[];
  messages: EnrichedSmsMessage[];
}

function randomId(): string {
  const bytes = new Uint8Array(10);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function copyContact(c: ContactRecord): ContactRecord {
  return { ...c, phones: [...c.phones] };
}

const DAY_MS = 24 * 60 * 60_000;

/** A message the router still stores: not a provisional send, not FengSui's own restored copy (src/sms/service.ts). */
function storedOnRouter(m: SmsMessageRecord): boolean {
  return !m.pending && !m.localOnly && m.index > 0;
}

/** The newest deletion first. */
function byDeletion(a: SmsTrashRecord, b: SmsTrashRecord): number {
  return Date.parse(b.deletedAtIso) - Date.parse(a.deletedAtIso);
}

export class DemoSmsBox {
  readonly defaultCountryCode: string;
  #messages = new Map<string, SmsMessageRecord>();
  /** Recently deleted, as the daemon keeps it. */
  #trash = new Map<string, SmsTrashRecord>();
  readonly #trashDays: () => number;
  #contacts: ContactRecord[];
  #lookup = new Map<string, ContactRecord>();
  #status: SmsStatusSnapshot;
  #nextIndex: number;
  readonly #now: () => number;
  readonly #view: ThreadViewContext;

  constructor(seed: DemoSmsSeed, now: () => number, trashDays: () => number = () => 30) {
    this.defaultCountryCode = seed.status.defaultCountryCode;
    this.#now = now;
    this.#trashDays = trashDays;
    for (const m of seed.messages) this.#messages.set(m.uid, { ...m });
    this.#contacts = seed.contacts.map(copyContact);
    this.#status = { ...seed.status };
    this.#nextIndex = Math.max(40_000, ...seed.messages.map((m) => m.index)) + 1;
    this.#view = { defaultCountryCode: this.defaultCountryCode, contactOf: (phone) => this.#contactBrief(phone) };
    this.#rebuildIndex();
  }

  counters(): SmsCounters {
    const all = [...this.#messages.values()];
    return {
      localUnread: all.filter((m) => m.isUnread).length,
      localInbox: all.filter((m) => m.direction === "in").length,
      localOutbox: all.filter((m) => m.direction === "out").length,
      localDraft: 0,
      localMax: this.#status.counters?.localMax ?? 500,
    };
  }

  status(): SmsStatusSnapshot {
    const counters = this.counters();
    const stored = counters.localInbox + counters.localOutbox + counters.localDraft;
    return {
      ...this.#status,
      counters,
      unreadOnCpe: counters.localUnread,
      storageFull: counters.localMax > 0 && stored >= counters.localMax,
      storageUsedPercent: counters.localMax > 0 ? Math.round((stored / counters.localMax) * 100) : null,
      mirror: { ...smsThreadStats(this.#messages.values(), this.defaultCountryCode), trashTotal: this.#trash.size },
      contactsTotal: this.#contacts.length,
      syncInProgress: false,
      syncPending: false,
      trashDays: this.#trashDays(),
      // Both demo routers are Huawei HiLink models: they send and delete one message at a time
      abilities: { send: true, delete: "message", markRead: "router" },
    };
  }

  /** Days a deleted message stays in Recently deleted (`0`: deleted for good at once). */
  get trashDays(): number {
    return this.#trashDays();
  }

  threads(filter: SmsThreadFilter, search: string, limit: number): SmsThreadSummary[] {
    return listSmsThreads(this.#messages.values(), this.#view, { filter, search, limit });
  }

  thread(keyOrPhone: string): SmsThreadDetail {
    return getSmsThread(this.#messages.values(), this.#view, keyOrPhone);
  }

  contacts(query: string, limit: number): { total: number; contacts: ContactRecord[] } {
    const q = query.trim().toLowerCase().slice(0, MAX_SEARCH_QUERY);
    const matches = q
      ? this.#contacts.filter(
          (c) => c.name.toLowerCase().includes(q) || Boolean(c.note?.toLowerCase().includes(q)) || c.phones.some((p) => p.toLowerCase().includes(q))
        )
      : this.#contacts;
    return { total: this.#contacts.length, contacts: matches.slice(0, Math.max(1, limit)).map(copyContact) };
  }

  preview(input: { phone?: string; content: string; countryCode?: string }): SmsSendPreview {
    const encoding = detectSmsTextMode(input.content);
    return {
      recipient: input.phone ? resolveRecipientPhone(input.phone, input.countryCode ?? this.defaultCountryCode) : null,
      encoding,
      maxSegments: MAX_SMS_SEGMENTS,
      withinLimit: encoding.segments <= MAX_SMS_SEGMENTS,
    };
  }

  /** Store the outgoing copies; nothing leaves the page. `beforeSend` sees the checked text first and may refuse the send. */
  send(input: { phones: ReadonlyArray<string>; content: string; countryCode?: string }, beforeSend: (content: string) => void = () => undefined): DemoSmsSendOutcome {
    const countryCode = input.countryCode ?? this.defaultCountryCode;
    const resolved = input.phones.map((raw) => {
      const r = resolveRecipientPhone(raw, countryCode);
      if (!r.ok) throw new DemoValidationError(r.error);
      return r.phone;
    });
    const phones = [...new Set(resolved.map((p) => p.trim().replace(/[\s-]/g, "")).filter(Boolean))];
    if (phones.length === 0) throw new DemoValidationError("Provide at least one recipient number");
    if (phones.length > MAX_SMS_RECIPIENTS) throw new DemoValidationError(`Send to at most ${MAX_SMS_RECIPIENTS} recipients at once`);
    const content = input.content.trim();
    if (!content) throw new DemoValidationError("Message content is empty");
    const mode = detectSmsTextMode(content);
    if (mode.segments > MAX_SMS_SEGMENTS) {
      throw new DemoValidationError(`Message needs ${mode.segments} segments; the CPE accepts at most ${MAX_SMS_SEGMENTS} segments per send`);
    }
    beforeSend(content);
    const messages = phones.map((phone) => enrichSmsMessage(this.#store(phone, content, "out"), this.#view));
    return {
      result: {
        ok: true,
        submitted: true,
        timedOutWaitingStatus: false,
        sentPhones: phones,
        failedPhones: [],
        failCode: null,
        encoding: mode.encoding,
        segments: mode.segments,
      },
      resolvedPhones: phones,
      messages,
    };
  }

  /** A message arriving on the router. */
  receive(phone: string, content: string): EnrichedSmsMessage {
    return enrichSmsMessage(this.#store(phone, content, "in"), this.#view);
  }

  /** `beforeWrite` hears how many of the unread messages the router stores, and may refuse the write first. */
  markRead(input: { uids?: ReadonlyArray<string>; threadKey?: string }, beforeWrite: (onRouter: number) => void = () => undefined): string[] {
    if (input.threadKey === undefined && (!input.uids || input.uids.length === 0)) {
      throw new DemoValidationError("Provide message uids or a threadKey");
    }
    if ((input.uids?.length ?? 0) > MAX_UIDS_PER_REQUEST) throw new DemoValidationError(`At most ${MAX_UIDS_PER_REQUEST} uids per request`);
    const targets =
      input.threadKey !== undefined
        ? this.thread(input.threadKey).messages.map((m) => this.#messages.get(m.uid))
        : (input.uids ?? []).map((uid) => this.#messages.get(uid));
    const unread = targets.filter((m): m is SmsMessageRecord => m?.isUnread === true);
    const onRouter = unread.filter(storedOnRouter).length;
    if (onRouter > 0) beforeWrite(onRouter);
    for (const m of unread) {
      m.isUnread = false;
      m.smstat = "1";
    }
    return unread.map((m) => m.uid);
  }

  /** `beforeWrite` hears how many of the messages the router stores, and may refuse the write first. */
  delete(rawUids: ReadonlyArray<string>, beforeWrite: (onRouter: number) => void = () => undefined): string[] {
    const uids = [...new Set(rawUids)];
    if (uids.length === 0) throw new DemoValidationError("Provide at least one message uid");
    if (uids.length > MAX_DELETE_BATCH) throw new DemoValidationError(`Delete at most ${MAX_DELETE_BATCH} messages per request`);
    if (uids.some((uid) => !this.#messages.has(uid))) {
      throw new DemoValidationError("Unknown message uid; refresh the conversation and retry");
    }
    const onRouter = uids.filter((uid) => {
      const message = this.#messages.get(uid);
      return message !== undefined && storedOnRouter(message);
    }).length;
    if (onRouter > 0) beforeWrite(onRouter);
    const days = this.#trashDays();
    const deletedAtIso = new Date(this.#now()).toISOString();
    for (const uid of uids) {
      const message = this.#messages.get(uid);
      this.#messages.delete(uid);
      if (message && days > 0) this.#trash.set(uid, { ...message, deletedAtIso });
    }
    return uids;
  }

  /** Recently deleted, the newest deletion first, after purging what outlived the retention. */
  trash(): DeletedSmsMessage[] {
    this.purgeExpired();
    const keepMs = this.#trashDays() * DAY_MS;
    return [...this.#trash.values()].sort(byDeletion).map((record) => ({
      ...enrichSmsMessage(record, this.#view),
      deletedAtIso: record.deletedAtIso,
      purgeAtIso: new Date(Date.parse(record.deletedAtIso) + keepMs).toISOString(),
    }));
  }

  /** Back into their threads, as FengSui's own copies. */
  restore(rawUids: ReadonlyArray<string>): string[] {
    const uids = this.#trashUids(rawUids);
    for (const uid of uids) {
      const record = this.#trash.get(uid);
      if (!record) continue;
      const { deletedAtIso: _deleted, ...message } = record;
      this.#trash.delete(uid);
      this.#messages.set(uid, { ...message, localOnly: true });
    }
    return uids;
  }

  /** Delete for good: the named messages, or all of them. */
  purge(input: { uids?: ReadonlyArray<string>; all?: boolean }): string[] {
    const uids = input.all === true ? [...this.#trash.keys()] : this.#trashUids(input.uids ?? []);
    for (const uid of uids) this.#trash.delete(uid);
    return uids;
  }

  /** Delete for good what stayed longer than the retention now in force. */
  purgeExpired(): string[] {
    const cutoff = this.#now() - this.#trashDays() * DAY_MS;
    const expired = [...this.#trash.values()].filter((record) => Date.parse(record.deletedAtIso) < cutoff).map((record) => record.uid);
    for (const uid of expired) this.#trash.delete(uid);
    return expired;
  }

  #trashUids(raw: ReadonlyArray<string>): string[] {
    const uids = [...new Set(raw)];
    if (uids.length === 0) throw new DemoValidationError("Provide at least one message uid");
    if (uids.length > MAX_UIDS_PER_REQUEST) throw new DemoValidationError(`At most ${MAX_UIDS_PER_REQUEST} uids per request`);
    if (uids.some((uid) => !this.#trash.has(uid))) throw new DemoValidationError("Unknown message uid; refresh Recently deleted and retry");
    return uids;
  }

  sync(mode: "full" | "incremental"): SmsSyncSummary {
    const syncedAtIso = new Date(this.#now()).toISOString();
    this.#status = { ...this.#status, lastSyncAt: syncedAtIso, ...(mode === "full" ? { lastFullSyncAt: syncedAtIso } : {}) };
    return { mode, via: this.#status.via ?? "sms-list", added: 0, updated: 0, removed: 0, newIncoming: 0, counters: this.counters(), syncedAtIso };
  }

  upsertContact(input: { phone: string; name: string; note?: string }): ContactRecord {
    const name = input.name.trim();
    if (!name) throw new DemoValidationError("Contact name is required");
    if (name.length > MAX_NAME_LENGTH) throw new DemoValidationError(`Contact name must be at most ${MAX_NAME_LENGTH} characters`);
    const note = input.note?.trim();
    if (note !== undefined && note.length > MAX_NOTE_LENGTH) throw new DemoValidationError(`Contact note must be at most ${MAX_NOTE_LENGTH} characters`);
    const resolved = resolveRecipientPhone(input.phone, this.defaultCountryCode);
    if (!resolved.ok) throw new DemoValidationError(resolved.error);
    const now = new Date(this.#now()).toISOString();
    const existing = this.#find(resolved.phone);
    if (existing) {
      existing.name = name;
      if (note !== undefined) {
        if (note) existing.note = note;
        else delete existing.note;
      }
      if (!existing.phones.includes(resolved.phone)) existing.phones.unshift(resolved.phone);
      existing.source = "manual";
      existing.updatedAt = now;
      this.#rebuildIndex();
      return copyContact(existing);
    }
    if (this.#contacts.length >= MAX_CONTACTS) throw new DemoValidationError(`Contact book is full (${MAX_CONTACTS} entries)`);
    const created: ContactRecord = { id: globalThis.crypto.randomUUID(), name, phones: [resolved.phone], ...(note ? { note } : {}), source: "manual", updatedAt: now };
    this.#contacts.unshift(created);
    this.#rebuildIndex();
    return copyContact(created);
  }

  removeContact(id: string): boolean {
    const before = this.#contacts.length;
    this.#contacts = this.#contacts.filter((c) => c.id !== id);
    this.#rebuildIndex();
    return this.#contacts.length !== before;
  }

  importVcard(vcfText: string): VcardImportSummary {
    const parsed = parseVcardContacts(vcfText, MAX_CONTACTS);
    let added = 0;
    let updated = 0;
    const now = new Date(this.#now()).toISOString();
    for (const entry of parsed) {
      const phones = [
        ...new Set(
          entry.phones.map((p) => {
            const r = resolveRecipientPhone(p, this.defaultCountryCode);
            return r.ok ? r.phone : p;
          })
        ),
      ];
      const matched = phones.map((p) => this.#find(p)).find(Boolean) ?? null;
      if (matched) {
        if (matched.source !== "manual") matched.name = entry.name;
        for (const p of phones) if (!matched.phones.includes(p)) matched.phones.push(p);
        matched.updatedAt = now;
        updated += 1;
      } else if (this.#contacts.length < MAX_CONTACTS) {
        this.#contacts.push({
          id: globalThis.crypto.randomUUID(),
          name: entry.name.slice(0, MAX_NAME_LENGTH),
          phones,
          ...(entry.org ? { note: entry.org.slice(0, MAX_NOTE_LENGTH) } : {}),
          source: "vcard",
          updatedAt: now,
        });
        added += 1;
      }
      this.#rebuildIndex();
    }
    return { parsed: parsed.length, added, updated, total: this.#contacts.length };
  }

  #store(phone: string, content: string, direction: "in" | "out"): SmsMessageRecord {
    const record: SmsMessageRecord = {
      index: this.#nextIndex++,
      phone,
      content,
      date: formatRouterDate(this.#now()),
      smstat: direction === "in" ? "0" : "3",
      isUnread: direction === "in",
      direction,
      uid: randomId(),
      verificationCode: direction === "in" ? extractVerificationCode(content) : null,
    };
    this.#messages.set(record.uid, record);
    return { ...record };
  }

  #contactBrief(phone: string): ContactBrief | null {
    const hit = this.#find(phone);
    if (!hit) return null;
    return hit.note ? { id: hit.id, name: hit.name, note: hit.note } : { id: hit.id, name: hit.name };
  }

  #find(rawPhone: string): ContactRecord | null {
    for (const key of buildPhoneLookupKeys(rawPhone, this.defaultCountryCode)) {
      const hit = this.#lookup.get(key);
      if (hit) return hit;
    }
    return null;
  }

  #rebuildIndex(): void {
    this.#lookup.clear();
    // Manual contacts are indexed last so they win over imported duplicates of the same number
    const ordered = [...this.#contacts].sort((a, b) => (a.source === b.source ? 0 : a.source === "manual" ? 1 : -1));
    for (const c of ordered) {
      for (const p of c.phones) {
        for (const key of buildPhoneLookupKeys(p, this.defaultCountryCode)) this.#lookup.set(key, c);
      }
    }
  }
}
