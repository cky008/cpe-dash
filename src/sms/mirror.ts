import crypto from "node:crypto";
import { AtomicFileWriter, StorageCipher, assertKnownDataFormat } from "../encrypted-file.ts";
import type { ContactBook } from "./contacts.ts";
import { extractVerificationCode } from "./otp.ts";
import { canonicalThreadKey } from "./phone.ts";
import { type ThreadViewContext, enrichSmsMessage, getSmsThread, listSmsThreads, newestFirst, smsThreadStats } from "./thread-view.ts";
import type {
  ContactBrief,
  EnrichedSmsMessage,
  SmsCounters,
  SmsListingPath,
  SmsMessageRecord,
  SmsThreadDetail,
  SmsThreadFilter,
  SmsThreadSummary,
  SmsTrashRecord,
  SmsWireMessage,
} from "./types.ts";

const MAX_NOTIFIED = 3000;
const MAX_MESSAGES = 5000;
const MAX_TRASH = 5000;

/**
 * Opaque, stable message id derived from `(index, date, phone)`. A reused CPE index carrying a
 * different message gets a different uid, so stale UI/agent references can never hit it.
 */
/**
 * The time the mirror keeps a message under when FengSui itself dates it (a send the router has not
 * listed yet): `yyyy-MM-dd HH:mm:ss` in local time, the form the routers' own message times are
 * turned into.
 */
export function mirrorDate(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

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
  /** Recently deleted (absent before 1.8.0). */
  trash?: SmsTrashRecord[];
}

function defaultMeta(): SmsMirrorMeta {
  return { seeded: false, lastSyncAt: null, lastFullSyncAt: null, via: null, counters: null };
}

/**
 * Encrypted local mirror of the router's SMS store. The CPE stays the source of truth: full syncs
 * replace the mirror, incremental syncs upsert. Also holds the new-message notification cursor so
 * restarts neither re-notify old messages nor miss ones that arrived while the daemon was down, and
 * Recently deleted: messages FengSui deleted from the router, kept until they are restored (as
 * FengSui's own copies, which full syncs leave) or purged.
 */
export class SmsMirrorStore {
  readonly filePath: string;
  readonly contacts: ContactBook;
  #cipher: StorageCipher;
  #writer: AtomicFileWriter;
  #messages = new Map<string, SmsMessageRecord>();
  #notified = new Set<string>();
  #trash = new Map<string, SmsTrashRecord>();
  #meta: SmsMirrorMeta = defaultMeta();
  #view: ThreadViewContext;

  constructor(opts: { filePath: string; cipher: StorageCipher; defaultCountryCode: string; contacts: ContactBook }) {
    this.filePath = opts.filePath;
    this.contacts = opts.contacts;
    this.#view = { defaultCountryCode: opts.defaultCountryCode, contactOf: (phone) => this.#contactBrief(phone) };
    this.#cipher = opts.cipher;
    this.#writer = new AtomicFileWriter(opts.filePath);
  }

  /** Dial code local numbers are grouped in (`""`: none known yet). */
  get defaultCountryCode(): string {
    return this.#view.defaultCountryCode;
  }

  /** The default country became known (read from the SIM): threads group local numbers in it from now on. */
  setDefaultCountryCode(code: string): void {
    this.#view = { ...this.#view, defaultCountryCode: code };
  }

  load(): void {
    const parsed = this.#cipher.readJsonFileOrQuarantine<Partial<PersistedSmsMirror>>(this.filePath);
    assertKnownDataFormat(this.filePath, parsed?.version, 1);
    this.#messages.clear();
    this.#notified.clear();
    this.#trash.clear();
    this.#meta = defaultMeta();
    if (!parsed || parsed.version !== 1) return;
    for (const m of Array.isArray(parsed.messages) ? parsed.messages : []) {
      if (m && typeof m.uid === "string") this.#messages.set(m.uid, m);
    }
    for (const m of Array.isArray(parsed.trash) ? parsed.trash : []) {
      if (m && typeof m.uid === "string" && typeof m.deletedAtIso === "string" && Number.isFinite(Date.parse(m.deletedAtIso))) this.#trash.set(m.uid, m);
    }
    for (const uid of Array.isArray(parsed.notified) ? parsed.notified : []) {
      if (typeof uid === "string") this.#notified.add(uid);
    }
    this.#meta = {
      seeded: parsed.seeded === true,
      lastSyncAt: typeof parsed.lastSyncAt === "string" ? parsed.lastSyncAt : null,
      lastFullSyncAt: typeof parsed.lastFullSyncAt === "string" ? parsed.lastFullSyncAt : null,
      via: parsed.via === "sms-list" || parsed.via === "contact-list" || parsed.via === "driver" ? parsed.via : null,
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
      trash: [...this.#trash.values()],
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
   * (including provisional sends). A real outgoing copy replaces its provisional record. With
   * `keepReadState` a message FengSui already holds keeps the read state FengSui has for it: the
   * router's own says nothing there (it cannot be told a message was read, or calls every message it
   * lists read).
   */
  ingest(
    messages: ReadonlyArray<SmsWireMessage>,
    mode: "incremental" | "full",
    info: { counters?: SmsCounters; via?: SmsListingPath; keepReadState?: boolean } = {}
  ): SmsIngestResult {
    const result: SmsIngestResult = { added: [], updated: [], removed: [] };
    const seen = new Set<string>();
    for (const listed of messages) {
      const uid = computeSmsUid(listed);
      seen.add(uid);
      // Deleted by the owner: a listing from before the delete (or a router that ignored it) does not bring it back
      if (this.#trash.has(uid)) continue;
      const existing = this.#messages.get(uid);
      const wire: SmsWireMessage = info.keepReadState && existing && !existing.localOnly ? { ...listed, isUnread: existing.isUnread, smstat: existing.smstat } : listed;
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
      } else if (existing.localOnly || existing.isUnread !== wire.isUnread || existing.smstat !== wire.smstat || existing.content !== wire.content) {
        // A restored copy the router lists again is the router's copy again
        this.#messages.set(uid, record);
        result.updated.push(record);
      }
    }

    const nowIso = new Date().toISOString();
    if (mode === "full") {
      for (const [uid, record] of this.#messages) {
        // A message restored from Recently deleted is FengSui's own copy: the router never has it again
        if (!seen.has(uid) && !record.localOnly) {
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

  /**
   * A message that went out through a router which keeps no copy of what it sends: FengSui's own
   * copy is the only one, so it stays through full syncs like a restored message does.
   */
  addSent(phone: string, content: string, date: string): SmsMessageRecord {
    const record: SmsMessageRecord = {
      uid: `sent-${crypto.randomUUID()}`,
      index: 0,
      phone,
      content,
      date,
      smstat: "3",
      isUnread: false,
      direction: "out",
      verificationCode: null,
      localOnly: true,
    };
    this.#messages.set(record.uid, record);
    this.#enforceCap();
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

  /**
   * Move messages into Recently deleted, stamped `deletedAtIso` (their router copies are gone); a
   * provisional send is only dropped. Returns what left the threads.
   */
  trash(uids: ReadonlyArray<string>, deletedAtIso: string): SmsMessageRecord[] {
    const moved: SmsMessageRecord[] = [];
    for (const uid of uids) {
      const hit = this.#messages.get(uid);
      if (!hit) continue;
      this.#messages.delete(uid);
      moved.push(hit);
      if (!hit.pending) this.#trash.set(uid, { ...hit, deletedAtIso });
    }
    for (const oldest of [...this.#trash.values()].sort(byDeletion).slice(MAX_TRASH)) this.#trash.delete(oldest.uid);
    if (moved.length > 0) this.#commit();
    return moved;
  }

  /** Recently deleted, the newest deletion first. */
  listTrash(): SmsTrashRecord[] {
    return [...this.#trash.values()].sort(byDeletion).map((m) => ({ ...m }));
  }

  findTrash(uids: ReadonlyArray<string>): SmsTrashRecord[] {
    return uids.flatMap((uid) => {
      const hit = this.#trash.get(uid);
      return hit ? [{ ...hit }] : [];
    });
  }

  /** Back into their threads from Recently deleted, as FengSui's own copies (`localOnly`). */
  restore(uids: ReadonlyArray<string>): SmsMessageRecord[] {
    const restored: SmsMessageRecord[] = [];
    for (const uid of uids) {
      const hit = this.#trash.get(uid);
      if (!hit) continue;
      const { deletedAtIso: _deleted, ...record } = hit;
      const back: SmsMessageRecord = { ...record, localOnly: true };
      this.#trash.delete(uid);
      this.#messages.set(uid, back);
      restored.push(back);
    }
    if (restored.length > 0) {
      this.#enforceCap();
      this.#commit();
    }
    return restored;
  }

  /** Delete for good from Recently deleted. */
  purge(uids: ReadonlyArray<string>): SmsTrashRecord[] {
    return this.#purgeWhere((record) => uids.includes(record.uid));
  }

  purgeAll(): SmsTrashRecord[] {
    return this.#purgeWhere(() => true);
  }

  /** Delete for good what was deleted before `cutoffIso` (its retention ran out). */
  purgeDeletedBefore(cutoffIso: string): SmsTrashRecord[] {
    const cutoff = Date.parse(cutoffIso);
    return this.#purgeWhere((record) => Date.parse(record.deletedAtIso) < cutoff);
  }

  #purgeWhere(match: (record: SmsTrashRecord) => boolean): SmsTrashRecord[] {
    const purged = [...this.#trash.values()].filter(match).sort(byDeletion);
    for (const record of purged) this.#trash.delete(record.uid);
    if (purged.length > 0) this.#commit();
    return purged;
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
    return enrichSmsMessage(record, this.#view);
  }

  /**
   * Conversation list (newest activity first) with unread / OTP filters and search over names,
   * numbers, country, bodies and OTP codes.
   */
  listThreads(opts: { filter?: SmsThreadFilter; search?: string; limit?: number } = {}): SmsThreadSummary[] {
    return listSmsThreads(this.#messages.values(), this.#view, opts);
  }

  /** Full conversation (oldest first) for a thread key (`+353…`, `alpha:<brand>`) or any phone spelling. */
  getThread(keyOrPhone: string): SmsThreadDetail {
    return getSmsThread(this.#messages.values(), this.#view, keyOrPhone);
  }

  stats(): { messagesTotal: number; unreadTotal: number; threadsTotal: number; trashTotal: number } {
    return { ...smsThreadStats(this.#messages.values(), this.defaultCountryCode), trashTotal: this.#trash.size };
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

/** The newest deletion first. */
function byDeletion(a: SmsTrashRecord, b: SmsTrashRecord): number {
  return Date.parse(b.deletedAtIso) - Date.parse(a.deletedAtIso);
}
