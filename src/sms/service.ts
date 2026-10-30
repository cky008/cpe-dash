import { EventEmitter } from "node:events";
import { CpeControlValidationError, type GlobalTelemetrySnapshot } from "../cpe-domain.ts";
import { t } from "../i18n.ts";
import { maskPhoneNumber } from "../sanitize.ts";
import type { ControlSummary, MutexSessionScheduler, SchedulerPriority } from "../scheduler.ts";
import { formatHuaweiDate } from "../xml.ts";
import { MAX_SMS_SEGMENTS, detectSmsTextMode } from "./codec.ts";
import type { ContactBook, VcardImportSummary } from "./contacts.ts";
import { type SmsMirrorStore, computeSmsUid } from "./mirror.ts";
import { COUNTRY_DIAL_CODES, canonicalThreadKey, resolveRecipientPhone } from "./phone.ts";
import {
  type PreparedSmsSubmission,
  type SmsFetchResult,
  type SmsListingPath,
  checkSmsNotifications,
  deleteSmsByIndex,
  fetchAllMessages,
  fetchPhoneThread,
  fetchRecentMessages,
  markSmsRead,
  prepareSmsSubmission,
  submitSms,
} from "./protocol.ts";
import type {
  ContactRecord,
  CountryDialInfo,
  EnrichedSmsMessage,
  ResolvedRecipient,
  SmsCounters,
  SmsMessageRecord,
  SmsSendResult,
  SmsTextModeInfo,
  SmsThreadDetail,
  SmsThreadFilter,
  SmsThreadSummary,
  SmsWireMessage,
} from "./types.ts";

export type SmsSyncMode = "incremental" | "full";
export type SmsSendSource = "web" | "mcp" | "telegram" | "cli";

export interface SmsSyncSummary {
  mode: SmsSyncMode;
  via: SmsListingPath;
  added: number;
  updated: number;
  removed: number;
  /** New unread inbound messages announced via `sms:new` during this sync. */
  newIncoming: number;
  counters: SmsCounters;
  syncedAtIso: string;
}

export interface SmsStatusSnapshot {
  counters: SmsCounters | null;
  /** Unread count on the router (from the latest counters or the unauthenticated probe while yielding). */
  unreadOnCpe: number | null;
  storageFull: boolean;
  storageUsedPercent: number | null;
  mirror: { messagesTotal: number; unreadTotal: number; threadsTotal: number };
  contactsTotal: number;
  seeded: boolean;
  lastSyncAt: string | null;
  lastFullSyncAt: string | null;
  via: SmsListingPath | null;
  syncInProgress: boolean;
  /** Router counters differ from the last synced state (e.g. new SMS arrived while yielding). */
  syncPending: boolean;
  defaultCountryCode: string;
}

export interface SmsSendPreview {
  recipient: ResolvedRecipient | null;
  encoding: SmsTextModeInfo;
  maxSegments: number;
  withinLimit: boolean;
}

export interface SmsSendOutcome {
  result: SmsSendResult;
  resolvedPhones: string[];
  /** Router copies of the sent message (or provisional records until read back). */
  messages: EnrichedSmsMessage[];
}

export interface SmsSentEvent {
  source: SmsSendSource;
  result: SmsSendResult;
  messages: EnrichedSmsMessage[];
}

export interface SmsUpdatedEvent {
  action: "read" | "deleted";
  uids: string[];
}

export interface SmsServiceOptions {
  scheduler: MutexSessionScheduler;
  mirror: SmsMirrorStore;
  contacts: ContactBook;
  defaultCountryCode: string;
  /** Safety-net full reconcile interval (default 30 min). */
  fullSyncIntervalMs?: number;
  /** Treat messages already stored at the very first sync as history (no notifications). */
  seedExistingOnStart?: boolean;
  /** Mark newly announced messages as read on the router. */
  autoMarkRead?: boolean;
  sendStatusTimeoutMs?: number;
  /** Inbox page size for incremental syncs; larger jumps trigger a full sync. */
  recentFetchCount?: number;
  /** Interval of the unauthenticated unread probe while yielding to a human (default 5 s). */
  yieldPollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const SYNC_RETRY_BACKOFF_MS = 60_000;
const MAX_UIDS_PER_REQUEST = 200;
export const MAX_DELETE_BATCH = 50;

function sameCounters(a: SmsCounters, b: SmsCounters): boolean {
  return a.localUnread === b.localUnread && a.localInbox === b.localInbox && a.localOutbox === b.localOutbox;
}

/**
 * SMS application service: the only entry point REST, MCP, Telegram and the CLI use for SMS.
 *
 * - Every CPE access goes through `MutexSessionScheduler` (reads via `executeRead`, writes via
 *   `executeControl`), so SMS shares the single admin session, browser avoidance and the breaker.
 * - Change detection costs nothing: counters ride on the telemetry session; a sync is queued only
 *   when they differ from the last synced counters (incremental for new inbox messages, full
 *   reconcile otherwise), plus a low-priority safety-net full sync.
 * - Notifications are emitted after the session is released, never while holding it.
 */
export class SmsService extends EventEmitter {
  readonly scheduler: MutexSessionScheduler;
  readonly mirror: SmsMirrorStore;
  readonly contacts: ContactBook;
  readonly defaultCountryCode: string;
  readonly fullSyncIntervalMs: number;
  readonly seedExistingOnStart: boolean;
  readonly autoMarkRead: boolean;
  readonly sendStatusTimeoutMs: number;
  readonly recentFetchCount: number;
  readonly yieldPollIntervalMs: number;

  #sleep: ((ms: number) => Promise<void>) | undefined;
  #observed: SmsCounters | null = null;
  #synced: SmsCounters | null = null;
  #probeUnread: number | null = null;
  #probeStorageFull = false;
  #retryNotBeforeMs = 0;
  #inflight: { mode: SmsSyncMode; promise: Promise<SmsSyncSummary | null> } | null = null;
  #fullTimer: ReturnType<typeof setInterval> | null = null;
  #yieldTimer: ReturnType<typeof setInterval> | null = null;
  #started = false;

  readonly #onTelemetry = (snap: GlobalTelemetrySnapshot): void => {
    if (snap.sms) this.observeCounters(snap.sms);
  };

  constructor(opts: SmsServiceOptions) {
    super();
    this.scheduler = opts.scheduler;
    this.mirror = opts.mirror;
    this.contacts = opts.contacts;
    this.defaultCountryCode = opts.defaultCountryCode;
    this.fullSyncIntervalMs = Math.max(60_000, opts.fullSyncIntervalMs ?? 30 * 60_000);
    this.seedExistingOnStart = opts.seedExistingOnStart !== false;
    this.autoMarkRead = opts.autoMarkRead === true;
    this.sendStatusTimeoutMs = opts.sendStatusTimeoutMs ?? 45_000;
    this.recentFetchCount = Math.min(50, Math.max(5, opts.recentFetchCount ?? 20));
    this.yieldPollIntervalMs = Math.max(1000, opts.yieldPollIntervalMs ?? 5000);
    this.#sleep = opts.sleep;
  }

  /** Subscribe to telemetry counters, start the safety-net and yield timers, and run the initial full sync. */
  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.scheduler.on("telemetry", this.#onTelemetry);
    this.#fullTimer = setInterval(() => {
      void this.sync("full", { priority: "low" }).catch(() => undefined);
    }, this.fullSyncIntervalMs);
    this.#fullTimer.unref?.();
    this.#yieldTimer = setInterval(() => {
      void this.pollWhileYielding();
    }, this.yieldPollIntervalMs);
    this.#yieldTimer.unref?.();
    void this.sync("full", { priority: "normal" }).catch(() => undefined);
  }

  async stop(): Promise<void> {
    this.#started = false;
    this.scheduler.off("telemetry", this.#onTelemetry);
    if (this.#fullTimer) clearInterval(this.#fullTimer);
    if (this.#yieldTimer) clearInterval(this.#yieldTimer);
    this.#fullTimer = null;
    this.#yieldTimer = null;
    await Promise.allSettled([this.mirror.flush(), this.contacts.flush()]);
  }

  rotateEncryptionKey(secret: string): void {
    this.mirror.rotateEncryptionKey(secret);
    this.contacts.rotateEncryptionKey(secret);
  }

  getStatus(): SmsStatusSnapshot {
    const meta = this.mirror.getMeta();
    const counters = this.#observed ?? meta.counters;
    const stored = counters ? counters.localInbox + counters.localOutbox + counters.localDraft : 0;
    return {
      counters,
      unreadOnCpe: this.#probeUnread ?? counters?.localUnread ?? null,
      storageFull: this.#probeStorageFull || Boolean(counters && counters.localMax > 0 && stored >= counters.localMax),
      storageUsedPercent: counters && counters.localMax > 0 ? Math.round((stored / counters.localMax) * 100) : null,
      mirror: this.mirror.stats(),
      contactsTotal: this.contacts.size,
      seeded: meta.seeded,
      lastSyncAt: meta.lastSyncAt,
      lastFullSyncAt: meta.lastFullSyncAt,
      via: meta.via,
      syncInProgress: this.#inflight !== null,
      syncPending: this.#isSyncPending(meta.lastSyncAt),
      defaultCountryCode: this.defaultCountryCode,
    };
  }

  countries(): readonly CountryDialInfo[] {
    return COUNTRY_DIAL_CODES;
  }

  listThreads(opts: { filter?: SmsThreadFilter; search?: string; limit?: number } = {}): SmsThreadSummary[] {
    return this.mirror.listThreads(opts);
  }

  getThread(keyOrPhone: string): SmsThreadDetail {
    return this.mirror.getThread(keyOrPhone);
  }

  listContacts(query = "", limit = 500): ContactRecord[] {
    return this.contacts.search(query, limit);
  }

  previewSend(input: { phone?: string; content: string; countryCode?: string }): SmsSendPreview {
    const encoding = detectSmsTextMode(input.content);
    return {
      recipient: input.phone ? resolveRecipientPhone(input.phone, input.countryCode ?? this.defaultCountryCode) : null,
      encoding,
      maxSegments: MAX_SMS_SEGMENTS,
      withinLimit: encoding.segments <= MAX_SMS_SEGMENTS,
    };
  }

  /** `true` when `phone` is in the contact book or has received an SMS from this router before. */
  knowsRecipient(phone: string): boolean {
    if (this.contacts.knowsNumber(phone)) return true;
    const key = canonicalThreadKey(phone, this.defaultCountryCode);
    return this.mirror
      .list()
      .some((m) => m.direction === "out" && !m.pending && canonicalThreadKey(m.phone, this.defaultCountryCode) === key);
  }

  /** Feed router counters (telemetry piggyback) and queue a sync when they moved since the last sync. */
  observeCounters(counters: SmsCounters): void {
    const changed = !this.#observed || !sameCounters(this.#observed, counters);
    this.#observed = counters;
    this.#probeUnread = null;
    if (changed) this.#emitStatus();
    if (this.#inflight || Date.now() < this.#retryNotBeforeMs) return;
    const synced = this.#synced;
    if (synced && sameCounters(synced, counters)) return;
    let mode: SmsSyncMode = "full";
    if (synced) {
      const inboxGrowth = counters.localInbox - synced.localInbox;
      const grew = inboxGrowth > 0 || counters.localUnread > synced.localUnread;
      if (grew && inboxGrowth <= this.recentFetchCount && counters.localOutbox === synced.localOutbox) {
        mode = "incremental";
      }
    }
    void this.sync(mode, { priority: mode === "incremental" ? "normal" : "low" }).catch(() => undefined);
  }

  /** Unauthenticated unread probe while yielding to a human session (keeps the badge live, no admin slot). */
  async pollWhileYielding(): Promise<void> {
    if (!this.scheduler.getAvoidanceState().active) return;
    try {
      const probe = await checkSmsNotifications(this.scheduler.client);
      const changed = probe.unreadMessages !== this.#probeUnread || probe.storageFull !== this.#probeStorageFull;
      this.#probeUnread = probe.unreadMessages;
      this.#probeStorageFull = probe.storageFull;
      if (changed) this.#emitStatus();
    } catch {
      // Best-effort probe; the next telemetry session reconciles
    }
  }

  /**
   * Single-flight sync. A full sync satisfies concurrent incremental requests; a full request made
   * while an incremental runs is chained after it. Resolves `null` when skipped (yield / breaker / cooldown).
   */
  sync(mode: SmsSyncMode = "full", opts: { priority?: SchedulerPriority } = {}): Promise<SmsSyncSummary | null> {
    const inflight = this.#inflight;
    if (inflight) {
      if (inflight.mode === "full" || mode === "incremental") return inflight.promise;
      return inflight.promise.catch(() => null).then(() => this.sync("full", opts));
    }
    const promise = this.#runSync(mode, opts.priority ?? (mode === "full" ? "low" : "normal"));
    this.#inflight = { mode, promise };
    const clear = (): void => {
      if (this.#inflight?.promise === promise) this.#inflight = null;
    };
    promise.then(clear, clear);
    return promise;
  }

  async send(input: {
    phones: ReadonlyArray<string>;
    content: string;
    countryCode?: string;
    source: SmsSendSource;
  }): Promise<SmsSendOutcome> {
    const countryCode = input.countryCode ?? this.defaultCountryCode;
    const resolved = input.phones.map((raw) => {
      const r = resolveRecipientPhone(raw, countryCode);
      if (!r.ok) throw new CpeControlValidationError(r.error);
      return r.phone;
    });
    const prepared = prepareSmsSubmission(resolved, input.content);
    const to = prepared.phones.map(maskPhoneNumber).join(", ");

    const { result, readBack } = await this.scheduler.executeControl(
      "sms_send",
      async (session) => {
        const sendResult = await submitSms(session, prepared, {
          statusTimeoutMs: this.sendStatusTimeoutMs,
          sleep: this.#sleep,
        });
        const back = new Map<string, SmsWireMessage[]>();
        if (sendResult.ok) {
          for (const phone of prepared.phones) {
            back.set(phone, await fetchPhoneThread(session, phone, 10).catch(() => []));
          }
        }
        return { result: sendResult, readBack: back };
      },
      (value): ControlSummary =>
        value.result.ok
          ? {
              zh: t("zh-CN", "sms.sent_summary", { to, segments: prepared.mode.segments }),
              en: t("en", "sms.sent_summary", { to, segments: prepared.mode.segments }),
            }
          : {
              zh: t("zh-CN", "sms.send_failed_summary", { to, code: value.result.failCode ?? "unknown" }),
              en: t("en", "sms.send_failed_summary", { to, code: value.result.failCode ?? "unknown" }),
            }
    );

    const messages = result.ok ? this.#recordSent(prepared, readBack) : [];
    this.#safeEmit("sms:sent", { source: input.source, result, messages } satisfies SmsSentEvent);
    this.#emitStatus();
    return { result, resolvedPhones: prepared.phones, messages };
  }

  async markRead(input: { uids?: ReadonlyArray<string>; threadKey?: string }): Promise<{ count: number; uids: string[] }> {
    if (input.threadKey === undefined && (!input.uids || input.uids.length === 0)) {
      throw new CpeControlValidationError("Provide message uids or a threadKey");
    }
    if ((input.uids?.length ?? 0) > MAX_UIDS_PER_REQUEST) {
      throw new CpeControlValidationError(`At most ${MAX_UIDS_PER_REQUEST} uids per request`);
    }
    const targets =
      input.threadKey !== undefined ? this.mirror.getThread(input.threadKey).messages : this.mirror.findByUids(input.uids ?? []);
    const unread = targets.filter((m) => m.isUnread);
    if (unread.length === 0) return { count: 0, uids: [] };

    const indices = unread.filter((m) => !m.pending && m.index > 0).map((m) => m.index);
    if (indices.length > 0) {
      await this.scheduler.executeControl(
        "sms_mark_read",
        (session) => markSmsRead(session, indices),
        (count): ControlSummary => ({
          zh: t("zh-CN", "sms.marked_read_summary", { count }),
          en: t("en", "sms.marked_read_summary", { count }),
        })
      );
    }
    const uids = this.mirror.markRead(unread.map((m) => m.uid)).map((m) => m.uid);
    this.#safeEmit("sms:updated", { action: "read", uids } satisfies SmsUpdatedEvent);
    this.#emitStatus();
    return { count: uids.length, uids };
  }

  /** Delete messages from the router (and the mirror). Unknown uids are rejected before any session. */
  async deleteMessages(input: { uids: ReadonlyArray<string> }): Promise<{ deleted: number; uids: string[] }> {
    const uids = [...new Set(input.uids)];
    if (uids.length === 0) throw new CpeControlValidationError("Provide at least one message uid");
    if (uids.length > MAX_DELETE_BATCH) {
      throw new CpeControlValidationError(`Delete at most ${MAX_DELETE_BATCH} messages per request`);
    }
    const records = this.mirror.findByUids(uids);
    if (records.length !== uids.length) {
      throw new CpeControlValidationError("Unknown message uid; refresh the conversation and retry");
    }
    const indices = records.filter((m) => !m.pending && m.index > 0).map((m) => m.index);
    if (indices.length > 0) {
      await this.scheduler.executeControl(
        "sms_delete",
        (session) => deleteSmsByIndex(session, indices),
        (count): ControlSummary => ({
          zh: t("zh-CN", "sms.deleted_summary", { count }),
          en: t("en", "sms.deleted_summary", { count }),
        })
      );
    }
    const removed = this.mirror.remove(uids).map((m) => m.uid);
    this.#safeEmit("sms:updated", { action: "deleted", uids: removed } satisfies SmsUpdatedEvent);
    this.#emitStatus();
    return { deleted: removed.length, uids: removed };
  }

  upsertContact(input: { phone: string; name: string; note?: string }): ContactRecord {
    const contact = this.contacts.upsert(input);
    this.#contactsChanged();
    return contact;
  }

  removeContact(id: string): boolean {
    const removed = this.contacts.remove(id);
    if (removed) this.#contactsChanged();
    return removed;
  }

  importVcard(vcfText: string): VcardImportSummary {
    const summary = this.contacts.importVcard(vcfText);
    this.#contactsChanged();
    return summary;
  }

  async #runSync(mode: SmsSyncMode, priority: SchedulerPriority): Promise<SmsSyncSummary | null> {
    let fetched: SmsFetchResult | null;
    try {
      fetched = await this.scheduler.executeRead(
        (session) =>
          mode === "full"
            ? fetchAllMessages(session)
            : fetchRecentMessages(session, {
                count: this.recentFetchCount,
                expandThread: (latest) => this.mirror.get(computeSmsUid(latest)) === undefined,
              }),
        { priority }
      );
    } catch (err) {
      this.#retryNotBeforeMs = Date.now() + SYNC_RETRY_BACKOFF_MS;
      throw err;
    }
    if (!fetched) return null;

    this.#synced = fetched.counters;
    this.#observed = fetched.counters;
    this.#probeUnread = null;
    const ingest = this.mirror.ingest(fetched.messages, mode, { counters: fetched.counters, via: fetched.via });
    const fresh = this.#announceFreshIncoming(ingest.added);
    const summary: SmsSyncSummary = {
      mode,
      via: fetched.via,
      added: ingest.added.length,
      updated: ingest.updated.length,
      removed: ingest.removed.length,
      newIncoming: fresh.length,
      counters: fetched.counters,
      syncedAtIso: new Date().toISOString(),
    };
    this.#safeEmit("sms:sync", summary);
    this.#emitStatus();
    if (this.autoMarkRead && fresh.length > 0) {
      void this.markRead({ uids: fresh.map((m) => m.uid) }).catch(() => undefined);
    }
    return summary;
  }

  /**
   * Announce new unread inbound messages exactly once. On the very first sync everything already
   * stored is history (when `seedExistingOnStart`), so a fresh install never floods notifications.
   */
  #announceFreshIncoming(added: ReadonlyArray<SmsMessageRecord>): EnrichedSmsMessage[] {
    if (!this.mirror.getMeta().seeded) {
      this.mirror.markSeeded();
      if (this.seedExistingOnStart) {
        this.mirror.markNotified(this.mirror.list().filter((m) => m.direction === "in").map((m) => m.uid));
        return [];
      }
    }
    const inbound = added.filter((m) => m.direction === "in" && !m.pending && !this.mirror.isNotified(m.uid));
    if (inbound.length === 0) return [];
    this.mirror.markNotified(inbound.map((m) => m.uid));
    const fresh = inbound
      .filter((m) => m.isUnread)
      .sort((a, b) => a.index - b.index)
      .map((m) => this.mirror.enrich(m));
    for (const message of fresh) this.#safeEmit("sms:new", message);
    return fresh;
  }

  #recordSent(prepared: PreparedSmsSubmission, readBack: ReadonlyMap<string, SmsWireMessage[]>): EnrichedSmsMessage[] {
    const recorded: EnrichedSmsMessage[] = [];
    for (const phone of prepared.phones) {
      const back = readBack.get(phone) ?? [];
      const copies = back.filter((m) => m.direction === "out" && m.content.trim() === prepared.content);
      if (copies.length > 0) {
        const ingest = this.mirror.ingest(back, "incremental");
        this.#announceFreshIncoming(ingest.added);
        const newest = copies.reduce((a, b) => (b.date > a.date || (b.date === a.date && b.index > a.index) ? b : a));
        const stored = this.mirror.get(computeSmsUid(newest));
        if (stored) recorded.push(this.mirror.enrich(stored));
      } else {
        recorded.push(this.mirror.enrich(this.mirror.addPending(phone, prepared.content, formatHuaweiDate(new Date()))));
      }
    }
    return recorded;
  }

  #isSyncPending(lastSyncAt: string | null): boolean {
    const synced = this.#synced;
    if (!synced) return lastSyncAt === null;
    if (this.#probeUnread !== null && this.#probeUnread !== synced.localUnread) return true;
    return this.#observed !== null && !sameCounters(this.#observed, synced);
  }

  #contactsChanged(): void {
    this.#safeEmit("contacts:updated", { total: this.contacts.size });
  }

  #emitStatus(): void {
    this.#safeEmit("sms:status", this.getStatus());
  }

  #safeEmit(event: string, payload: unknown): void {
    try {
      this.emit(event, payload);
    } catch {
      // A failing listener (e.g. a disconnected SSE client) must never break SMS sync
    }
  }
}
