import crypto from "node:crypto";
import { AtomicFileWriter, StorageCipher } from "../encrypted-file.ts";
import { extractVerificationCode } from "./codec.ts";
import type { ContactBook } from "./contacts.ts";
import { canonicalThreadKey, extractBrandSignature, parseSenderInfo } from "./phone.ts";
import type { SmsListingPath } from "./protocol.ts";
import type {
  ContactBrief,
  EnrichedSmsMessage,
  SmsCounters,
  SmsMessageRecord,
  SmsThreadDetail,
  SmsThreadFilter,
  SmsThreadSummary,
  SmsWireMessage,
} from "./types.ts";

const MAX_NOTIFIED = 3000;
const MAX_MESSAGES = 5000;
const MAX_SEARCH_QUERY = 100;

/**
 * Opaque, stable message id derived from `(index, date, phone)`. A reused CPE index carrying a
 * different message gets a different uid, so stale UI/agent references can never hit it.
 */
export function computeSmsUid(m: Pick<SmsWireMessage, "index" | "date" | "phone">): string {
  return crypto.createHash("sha256").update(`${m.index}\u0000${m.date}\u0000${m.phone}`, "utf8").digest("hex").slice(0, 20);
}

export interface SmsMirrorMeta {
  seeded: boolean;
  lastSyncAt: string | null;
  lastFullSyncAt: string | null;
  via: SmsListingPath | null;
  counters: SmsCounters | null;
}

export interface SmsIngestResult {
  added: SmsMessageRecord[];
  updated: SmsMessageRecord[];
  removed: SmsMessageRecord[];
}

interface PersistedSmsMirror extends SmsMirrorMeta {
  version: 1;
  savedAtIso: string;
  notified: string[];
  messages: SmsMessageRecord[];
}

function newestFirst(a: SmsMessageRecord, b: SmsMessageRecord): number {
  return a.date === b.date ? b.index - a.index : a.date > b.date ? -1 : 1;
}

function defaultMeta(): SmsMirrorMeta {
  return { seeded: false, lastSyncAt: null, lastFullSyncAt: null, via: null, counters: null };
}

/**
 * Encrypted local mirror of the router's SMS store. The CPE stays the source of truth: full syncs
 * replace the mirror, incremental syncs upsert. Also holds the new-message notification cursor so
 * restarts neither re-notify old messages nor miss ones that arrived while the daemon was down.
 */
export class SmsMirrorStore {
  readonly filePath: string;
  readonly defaultCountryCode: string;
  readonly contacts: ContactBook;
  #cipher: StorageCipher;
  #writer: AtomicFileWriter;
  #messages = new Map<string, SmsMessageRecord>();
  #notified = new Set<string>();
  #meta: SmsMirrorMeta = defaultMeta();

  constructor(opts: { filePath: string; cipher: StorageCipher; defaultCountryCode: string; contacts: ContactBook }) {
    this.filePath = opts.filePath;
    this.defaultCountryCode = opts.defaultCountryCode;
    this.contacts = opts.contacts;
    this.#cipher = opts.cipher;
    this.#writer = new AtomicFileWriter(opts.filePath);
  }

  load(): void {
    const parsed = this.#cipher.readJsonFileOrQuarantine<Partial<PersistedSmsMirror>>(this.filePath);
    this.#messages.clear();
    this.#notified.clear();
    this.#meta = defaultMeta();
    if (!parsed || parsed.version !== 1) return;
    for (const m of Array.isArray(parsed.messages) ? parsed.messages : []) {
      if (m && typeof m.uid === "string") this.#messages.set(m.uid, m);
    }
    for (const uid of Array.isArray(parsed.notified) ? parsed.notified : []) {
      if (typeof uid === "string") this.#notified.add(uid);
    }
    this.#meta = {
      seeded: parsed.seeded === true,
      lastSyncAt: typeof parsed.lastSyncAt === "string" ? parsed.lastSyncAt : null,
      lastFullSyncAt: typeof parsed.lastFullSyncAt === "string" ? parsed.lastFullSyncAt : null,
      via: parsed.via === "sms-list" || parsed.via === "contact-list" ? parsed.via : null,
      counters: parsed.counters && typeof parsed.counters === "object" ? parsed.counters : null,
    };
  }

  async flush(): Promise<void> {
    const payload: PersistedSmsMirror = {
      version: 1,
      savedAtIso: new Date().toISOString(),
      ...this.#meta,
      notified: [...this.#notified],
      messages: [...this.#messages.values()],
    };
    await this.#writer.write(() => this.#cipher.serializeJson(payload));
  }

  rotateEncryptionKey(secret: string): void {
    this.#cipher = StorageCipher.fromSecret(secret);
  }

  get size(): number {
    return this.#messages.size;
  }

  getMeta(): SmsMirrorMeta {
    return { ...this.#meta, counters: this.#meta.counters ? { ...this.#meta.counters } : null };
  }

  get(uid: string): SmsMessageRecord | undefined {
    const hit = this.#messages.get(uid);
    return hit ? { ...hit } : undefined;
  }

  list(): SmsMessageRecord[] {
    return [...this.#messages.values()].sort(newestFirst).map((m) => ({ ...m }));
  }

  findByUids(uids: ReadonlyArray<string>): SmsMessageRecord[] {
    return uids.flatMap((uid) => {
      const hit = this.#messages.get(uid);
      return hit ? [{ ...hit }] : [];
    });
  }

  /**
   * Upsert CPE messages; a `full` sync also removes everything the router no longer stores
   * (including provisional sends). A real outgoing copy replaces its provisional record.
   */
  ingest(
    messages: ReadonlyArray<SmsWireMessage>,
    mode: "incremental" | "full",
    info: { counters?: SmsCounters; via?: SmsListingPath } = {}
  ): SmsIngestResult {
    const result: SmsIngestResult = { added: [], updated: [], removed: [] };
    const seen = new Set<string>();
    for (const wire of messages) {
      const uid = computeSmsUid(wire);
      seen.add(uid);
      const existing = this.#messages.get(uid);
      const record: SmsMessageRecord = {
        ...wire,
        uid,
        verificationCode: wire.direction === "in" ? extractVerificationCode(wire.content) : null,
      };
      if (!existing) {
        this.#messages.set(uid, record);
        result.added.push(record);
        if (record.direction === "out") {
          const replaced = this.#takeMatchingPending(record);
          if (replaced) result.removed.push(replaced);
        }
      } else if (existing.isUnread !== wire.isUnread || existing.smstat !== wire.smstat || existing.content !== wire.content) {
        this.#messages.set(uid, record);
        result.updated.push(record);
      }
    }

    const nowIso = new Date().toISOString();
    if (mode === "full") {
      for (const [uid, record] of this.#messages) {
        if (!seen.has(uid)) {
          this.#messages.delete(uid);
          result.removed.push(record);
        }
      }
      this.#meta.lastFullSyncAt = nowIso;
    }
    this.#meta.lastSyncAt = nowIso;
    if (info.counters) this.#meta.counters = { ...info.counters };
    if (info.via) this.#meta.via = info.via;
    this.#enforceCap();
    this.#commit();
    return result;
  }

  /** Provisional outgoing record shown until the router copy is read back. */
  addPending(phone: string, content: string, date: string): SmsMessageRecord {
    const record: SmsMessageRecord = {
      uid: `pending-${crypto.randomUUID()}`,
      index: 0,
      phone,
      content,
      date,
      smstat: "3",
      isUnread: false,
      direction: "out",
      verificationCode: null,
      pending: true,
    };
    this.#messages.set(record.uid, record);
    this.#commit();
    return { ...record };
  }

  markRead(uids: ReadonlyArray<string>): SmsMessageRecord[] {
    const changed: SmsMessageRecord[] = [];
    for (const uid of uids) {
      const hit = this.#messages.get(uid);
      if (hit?.isUnread) {
        const next: SmsMessageRecord = { ...hit, isUnread: false, smstat: "1" };
        this.#messages.set(uid, next);
        changed.push(next);
      }
    }
    if (changed.length > 0) this.#commit();
    return changed;
  }

  remove(uids: ReadonlyArray<string>): SmsMessageRecord[] {
    const removed: SmsMessageRecord[] = [];
    for (const uid of uids) {
      const hit = this.#messages.get(uid);
      if (hit) {
        this.#messages.delete(uid);
        removed.push(hit);
      }
    }
    if (removed.length > 0) this.#commit();
    return removed;
  }

  isNotified(uid: string): boolean {
    return this.#notified.has(uid);
  }

  markNotified(uids: ReadonlyArray<string>): void {
    for (const uid of uids) this.#notified.add(uid);
    for (const oldest of this.#notified) {
      if (this.#notified.size <= MAX_NOTIFIED) break;
      this.#notified.delete(oldest);
    }
    this.#commit();
  }

  markSeeded(): void {
    this.#meta.seeded = true;
    this.#commit();
  }

  enrich(record: SmsMessageRecord): EnrichedSmsMessage {
    return {
      ...record,
      threadKey: canonicalThreadKey(record.phone, this.defaultCountryCode),
      sender: parseSenderInfo(record.phone, record.content, this.defaultCountryCode),
      contact: this.#contactBrief(record.phone),
    };
  }

  /**
   * Conversation list (newest activity first) with unread / OTP filters and search over names,
   * numbers, country, bodies and OTP codes.
   */
  listThreads(opts: { filter?: SmsThreadFilter; search?: string; limit?: number } = {}): SmsThreadSummary[] {
    const q = (opts.search ?? "").trim().toLowerCase().slice(0, MAX_SEARCH_QUERY);
    const threads = new Map<string, SmsThreadSummary>();
    for (const msg of [...this.#messages.values()].sort(newestFirst)) {
      const key = canonicalThreadKey(msg.phone, this.defaultCountryCode);
      let thread = threads.get(key);
      if (!thread) {
        const sender = parseSenderInfo(msg.phone, msg.content, this.defaultCountryCode);
        const contact = this.#contactBrief(msg.phone);
        thread = {
          threadKey: key,
          phone: msg.phone,
          replyPhone: sender.dialable ? (sender.e164 ?? msg.phone) : null,
          dialable: sender.dialable,
          sender,
          contact,
          displayName:
            contact?.name ??
            (sender.type === "alphanumeric"
              ? msg.phone
              : sender.brandHint
                ? `${msg.phone} (${sender.brandHint})`
                : (sender.e164 ?? msg.phone)),
          unreadCount: 0,
          totalCount: 0,
          hasOtp: false,
          latestOtp: null,
          latestMessage: { ...msg },
        };
        threads.set(key, thread);
      } else if (!thread.sender.brandHint && !thread.contact) {
        const hint = extractBrandSignature(msg.content);
        if (hint) {
          thread.sender = { ...thread.sender, brandHint: hint };
          if (thread.sender.type !== "alphanumeric") thread.displayName = `${thread.phone} (${hint})`;
        }
      }
      thread.totalCount += 1;
      if (msg.isUnread) thread.unreadCount += 1;
      if (msg.verificationCode) {
        thread.hasOtp = true;
        thread.latestOtp ??= msg.verificationCode;
      }
      if (q && thread.matchedPreview === undefined) {
        if (msg.content.toLowerCase().includes(q) || Boolean(msg.verificationCode?.includes(q))) {
          thread.matchedPreview = msg.content;
        }
      }
    }

    let list = [...threads.values()];
    if (opts.filter === "unread") list = list.filter((t) => t.unreadCount > 0);
    else if (opts.filter === "otp") list = list.filter((t) => t.hasOtp);
    if (q) {
      list = list.filter(
        (t) =>
          t.displayName.toLowerCase().includes(q) ||
          t.phone.toLowerCase().includes(q) ||
          Boolean(t.sender.e164?.toLowerCase().includes(q)) ||
          t.sender.countryZh.toLowerCase().includes(q) ||
          t.sender.countryEn.toLowerCase().includes(q) ||
          t.matchedPreview !== undefined
      );
    }
    return opts.limit !== undefined ? list.slice(0, Math.max(1, opts.limit)) : list;
  }

  /** Full conversation (oldest first) for a thread key (`+353…`, `alpha:<brand>`) or any phone spelling. */
  getThread(keyOrPhone: string): SmsThreadDetail {
    const key =
      keyOrPhone.startsWith("alpha:") || keyOrPhone === "unknown"
        ? keyOrPhone
        : canonicalThreadKey(keyOrPhone, this.defaultCountryCode);
    const messages = [...this.#messages.values()]
      .filter((m) => canonicalThreadKey(m.phone, this.defaultCountryCode) === key)
      .sort((a, b) => newestFirst(b, a))
      .map((m) => this.enrich(m));
    const phone = messages[messages.length - 1]?.phone ?? keyOrPhone.replace(/^alpha:/, "");
    const brandSample = [...messages].reverse().find((m) => m.sender.brandHint)?.content ?? "";
    const sender = parseSenderInfo(phone, brandSample, this.defaultCountryCode);
    return {
      threadKey: key,
      phone,
      replyPhone: sender.dialable ? (sender.e164 ?? phone) : null,
      dialable: sender.dialable,
      sender,
      contact: this.#contactBrief(phone),
      messages,
    };
  }

  stats(): { messagesTotal: number; unreadTotal: number; threadsTotal: number } {
    const keys = new Set<string>();
    let unread = 0;
    for (const m of this.#messages.values()) {
      keys.add(canonicalThreadKey(m.phone, this.defaultCountryCode));
      if (m.isUnread) unread += 1;
    }
    return { messagesTotal: this.#messages.size, unreadTotal: unread, threadsTotal: keys.size };
  }

  #contactBrief(phone: string): ContactBrief | null {
    const hit = this.contacts.resolvePhone(phone);
    if (!hit) return null;
    return hit.note ? { id: hit.id, name: hit.name, note: hit.note } : { id: hit.id, name: hit.name };
  }

  #takeMatchingPending(real: SmsMessageRecord): SmsMessageRecord | null {
    const key = canonicalThreadKey(real.phone, this.defaultCountryCode);
    const content = real.content.trim();
    for (const [uid, record] of this.#messages) {
      if (
        record.pending &&
        record.content.trim() === content &&
        canonicalThreadKey(record.phone, this.defaultCountryCode) === key
      ) {
        this.#messages.delete(uid);
        return record;
      }
    }
    return null;
  }

  #enforceCap(): void {
    if (this.#messages.size <= MAX_MESSAGES) return;
    const oldest = [...this.#messages.values()].sort((a, b) => newestFirst(b, a));
    for (const record of oldest.slice(0, this.#messages.size - MAX_MESSAGES)) {
      this.#messages.delete(record.uid);
    }
  }

  #commit(): void {
    void this.flush().catch(() => undefined);
  }
}
