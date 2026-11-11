import { EventEmitter } from "node:events";
import { routerBackendOf } from "../backends/index.ts";
import { CpeControlValidationError, type GlobalTelemetrySnapshot } from "../cpe-domain.ts";
import type { CpeMonitor } from "../cpe-monitor.ts";
import { t } from "../i18n.ts";
import type { RouterBackend, SmsListing, SmsSendOutcome as RouterSendOutcome } from "../router-backend.ts";
import { maskPhoneNumber } from "../sanitize.ts";
import type { ControlSummary, MutexSessionScheduler, SchedulerPriority } from "../scheduler.ts";
import { formatHuaweiDate } from "../xml.ts";
import { MAX_SMS_SEGMENTS, detectSmsTextMode } from "./codec.ts";
import type { ContactBook, VcardImportSummary } from "./contacts.ts";
import { type SmsMirrorStore, computeSmsUid } from "./mirror.ts";
import { COUNTRY_DIAL_CODES, canonicalThreadKey, resolveRecipientPhone } from "./phone.ts";
import { prepareSmsSubmission, unconfirmedSendResult } from "./protocol.ts";
import type {
  ContactRecord,
  CountryDialInfo,
  DeletedSmsMessage,
  EnrichedSmsMessage,
  ResolvedRecipient,
  SmsCounters,
  SmsListingPath,
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
  mirror: { messagesTotal: number; unreadTotal: number; threadsTotal: number; trashTotal: number };
  contactsTotal: number;
  seeded: boolean;
  lastSyncAt: string | null;
  lastFullSyncAt: string | null;
  via: SmsListingPath | null;
  syncInProgress: boolean;
  /** Router counters differ from the last synced state (e.g. new SMS arrived while yielding). */
  syncPending: boolean;
  defaultCountryCode: string;
  /** Days a deleted message stays in Recently deleted (`0`: deleted for good at once). */
  trashDays: number;
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
  action: "read" | "deleted" | "restored" | "purged";
  uids: string[];
  /** `purged` because their time in Recently deleted ran out, not on request. */
  expired?: true;
}

export interface SmsServiceOptions {
  scheduler: MutexSessionScheduler;
  /** Source of the telemetry sessions that piggyback the SMS counters. */
  monitor: CpeMonitor;
  mirror: SmsMirrorStore;
  contacts: ContactBook;
  defaultCountryCode: string;
  /** Safety-net full reconcile interval (default 30 min). */
  fullSyncIntervalMs?: number;
  /** Treat messages already stored at the very first sync as history (no notifications). */
  seedExistingOnStart?: boolean;
  /** Mark newly announced messages as read on the router. */
  /** A value, or a function read per sync (the console's setting, else SMS_AUTO_MARK_READ). */
  autoMarkRead?: boolean | (() => boolean);
  sendStatusTimeoutMs?: number;
  /** Inbox page size for incremental syncs; larger jumps trigger a full sync. */
  recentFetchCount?: number;
  /** Interval of the unauthenticated unread probe while yielding to a human (default 5 s). */
  yieldPollIntervalMs?: number;
  /** Days a deleted message stays in Recently deleted, or a function read each time (the console's setting, else SMS_TRASH_RETENTION_DAYS); default 30. */
  trashDays?: number | (() => number);
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const SYNC_RETRY_BACKOFF_MS = 60_000;
const MAX_UIDS_PER_REQUEST = 200;
const DAY_MS = 24 * 60 * 60_000;
export const MAX_DELETE_BATCH = 50;

function sameCounters(a: SmsCounters, b: SmsCounters): boolean {
  return a.localUnread === b.localUnread && a.localInbox === b.localInbox && a.localOutbox === b.localOutbox && (a.newest ?? 0) === (b.newest ?? 0);
}

/**
 * SMS application service: the only entry point REST, MCP, Telegram and the CLI use for SMS.
 *
 * - Every router access is a verb of `RouterBackend` (listing, the login-free unread count, sending,
 *   marking read, deleting), whatever the brand: each is one session of `MutexSessionScheduler`, so
 *   SMS shares the single admin session, browser avoidance, the breaker and the write gate.
 * - Change detection costs nothing: counters ride on the telemetry session; a sync is queued only
 *   when they differ from the last synced counters (incremental for new inbox messages, full
 *   reconcile otherwise), plus a low-priority safety-net full sync.
 * - Notifications are emitted after the session is released, never while holding it.
 */
export class SmsService extends EventEmitter {
  readonly scheduler: MutexSessionScheduler;
  readonly monitor: CpeMonitor;
  readonly mirror: SmsMirrorStore;
  readonly contacts: ContactBook;
  /** The backend of the router's family: every SMS read and write goes through it, whatever the brand. */
  readonly #backend: () => RouterBackend;
  #defaultCountryCode: string;
  readonly fullSyncIntervalMs: number;
  readonly seedExistingOnStart: boolean;
  readonly #autoMarkRead: () => boolean;
  readonly #trashDays: () => number;
  readonly #now: () => number;
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
    this.monitor = opts.monitor;
    this.mirror = opts.mirror;
    this.contacts = opts.contacts;
    this.#backend = routerBackendOf(opts.scheduler);
    this.#defaultCountryCode = opts.defaultCountryCode;
    this.fullSyncIntervalMs = Math.max(60_000, opts.fullSyncIntervalMs ?? 30 * 60_000);
    this.seedExistingOnStart = opts.seedExistingOnStart !== false;
    const markRead = opts.autoMarkRead;
    this.#autoMarkRead = typeof markRead === "function" ? markRead : () => markRead === true;
    const trashDays = opts.trashDays ?? 30;
    this.#trashDays = typeof trashDays === "function" ? trashDays : () => trashDays;
    this.#now = opts.now ?? Date.now;
    this.sendStatusTimeoutMs = opts.sendStatusTimeoutMs ?? 45_000;
    this.recentFetchCount = Math.min(50, Math.max(5, opts.recentFetchCount ?? 20));
    this.yieldPollIntervalMs = Math.max(1000, opts.yieldPollIntervalMs ?? 5000);
    this.#sleep = opts.sleep;
  }

  /**
   * Dial code a number typed without `+` is sent to, and local numbers are grouped in: `DEFAULT_COUNTRY_CODE`, or
   * else the SIM's country once it has been read; `""` while neither is known (such a number is then refused).
   */
  get autoMarkRead(): boolean {
    return this.#autoMarkRead();
  }

  /** Days a deleted message stays in Recently deleted (`0`: deleted for good at once). */
  get trashDays(): number {
    return this.#trashDays();
  }

  get defaultCountryCode(): string {
    return this.#defaultCountryCode;
  }

  /** The SIM's country became known (or changed with the SIM): contacts and threads follow it. */
  setDefaultCountryCode(code: string): void {
    if (code === this.#defaultCountryCode) return;
    this.#defaultCountryCode = code;
    this.contacts.setDefaultCountryCode(code);
    this.mirror.setDefaultCountryCode(code);
  }

  /** Subscribe to telemetry counters, start the safety-net and yield timers, and run the initial full sync. */
  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.monitor.on("telemetry", this.#onTelemetry);
    this.purgeExpiredTrash();
    this.#fullTimer = setInterval(() => {
      this.purgeExpiredTrash();
      // A model without SMS is not asked again in the background
      if (this.scheduler.device.skips("sms")) return;
      void this.sync("full", { priority: "low" }).catch(() => undefined);
    }, this.fullSyncIntervalMs);
    this.#fullTimer.unref?.();
    this.#yieldTimer = setInterval(() => {
      void this.pollWhileYielding();
    }, this.yieldPollIntervalMs);
    this.#yieldTimer.unref?.();
    if (!this.scheduler.device.skips("sms")) void this.sync("full", { priority: "normal" }).catch(() => undefined);
  }

  async stop(): Promise<void> {
    this.#started = false;
    this.monitor.off("telemetry", this.#onTelemetry);
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
      trashDays: this.#trashDays(),
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

  /**
   * `true` when `phone` is in the contact book or has received an SMS from this router before. With
   * `ownerSavedOnly` (the MCP send policy), contacts an MCP agent filed itself do not count.
   */
  knowsRecipient(phone: string, opts: { ownerSavedOnly?: boolean } = {}): boolean {
    if (this.contacts.knowsNumber(phone, opts)) return true;
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
      const probe = await this.#backend().peekSmsUnread();
      // A family without a login-free count: the next telemetry session brings the counts
      if (!probe) return;
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

    let accepted = false;
    let sendOutcome: RouterSendOutcome;
    try {
      sendOutcome = await this.#backend().sendSms(
        prepared,
        {
          statusTimeoutMs: this.sendStatusTimeoutMs,
          sleep: this.#sleep,
          onAccepted: () => {
            accepted = true;
          },
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
    } catch (err) {
      // Once send-sms was accepted the message is on its way: a later failure (hold deadline,
      // shutdown, lost connection) must not read as a failed send, or the caller would resend it.
      if (!accepted) throw err;
      sendOutcome = { result: unconfirmedSendResult(prepared), readBack: new Map(), routerKeepsSent: true };
    }

    const { result, readBack, routerKeepsSent } = sendOutcome;
    // What went out is shown at once. A send that failed for some recipients is left to the next sync,
    // unless the router keeps no copy of what it sends: then FengSui's copy is the only one there will be
    const delivered = result.ok ? prepared.phones : routerKeepsSent ? [] : result.sentPhones;
    const messages = this.#recordSent(delivered, prepared.content, readBack, routerKeepsSent);
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

    const indices = unread.filter(onRouter).map((m) => m.index);
    if (indices.length > 0) {
      await this.#backend().markSmsRead(
        indices,
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

  /**
   * Delete messages from the router; FengSui keeps them in Recently deleted for `trashDays` (none
   * when `0`). Unknown uids are rejected before any session.
   */
  async deleteMessages(input: { uids: ReadonlyArray<string> }): Promise<{ deleted: number; uids: string[]; trashDays: number }> {
    const uids = [...new Set(input.uids)];
    if (uids.length === 0) throw new CpeControlValidationError("Provide at least one message uid");
    if (uids.length > MAX_DELETE_BATCH) {
      throw new CpeControlValidationError(`Delete at most ${MAX_DELETE_BATCH} messages per request`);
    }
    const records = this.mirror.findByUids(uids);
    if (records.length !== uids.length) {
      throw new CpeControlValidationError("Unknown message uid; refresh the conversation and retry");
    }
    const indices = records.filter(onRouter).map((m) => m.index);
    if (indices.length > 0) {
      await this.#backend().deleteSms(
        indices,
        (count): ControlSummary => ({
          zh: t("zh-CN", "sms.deleted_summary", { count }),
          en: t("en", "sms.deleted_summary", { count }),
        })
      );
    }
    const trashDays = this.#trashDays();
    const removed = (trashDays > 0 ? this.mirror.trash(uids, new Date(this.#now()).toISOString()) : this.mirror.remove(uids)).map((m) => m.uid);
    this.#safeEmit("sms:updated", { action: "deleted", uids: removed } satisfies SmsUpdatedEvent);
    this.#emitStatus();
    return { deleted: removed.length, uids: removed, trashDays };
  }

  /** Recently deleted, the newest deletion first, each with when it is deleted for good. */
  listTrash(): DeletedSmsMessage[] {
    const keepMs = this.#trashDays() * DAY_MS;
    return this.mirror.listTrash().map((record) => ({
      ...this.mirror.enrich(record),
      deletedAtIso: record.deletedAtIso,
      purgeAtIso: new Date(Date.parse(record.deletedAtIso) + keepMs).toISOString(),
    }));
  }

  /** Back into their threads from Recently deleted, as FengSui's own copies (their router copies are gone). No session. */
  async restoreMessages(input: { uids: ReadonlyArray<string> }): Promise<{ restored: number; uids: string[] }> {
    const uids = this.#trashUids(input.uids);
    const restored = this.mirror.restore(uids).map((m) => m.uid);
    this.#safeEmit("sms:updated", { action: "restored", uids: restored } satisfies SmsUpdatedEvent);
    this.#emitStatus();
    return { restored: restored.length, uids: restored };
  }

  /** Delete for good from Recently deleted: the named messages, or all of them. */
  purgeTrash(input: { uids?: ReadonlyArray<string>; all?: boolean }): { purged: number; uids: string[] } {
    const purged = (input.all === true ? this.mirror.purgeAll() : this.mirror.purge(this.#trashUids(input.uids ?? []))).map((m) => m.uid);
    if (purged.length > 0) {
      this.#safeEmit("sms:updated", { action: "purged", uids: purged } satisfies SmsUpdatedEvent);
      this.#emitStatus();
    }
    return { purged: purged.length, uids: purged };
  }

  /** Delete for good what stayed in Recently deleted longer than the retention now in force; how many. */
  purgeExpiredTrash(): number {
    const cutoff = new Date(this.#now() - this.#trashDays() * DAY_MS).toISOString();
    const purged = this.mirror.purgeDeletedBefore(cutoff).map((m) => m.uid);
    if (purged.length > 0) {
      this.#safeEmit("sms:updated", { action: "purged", uids: purged, expired: true } satisfies SmsUpdatedEvent);
      this.#emitStatus();
    }
    return purged.length;
  }

  /** The uids of a Recently deleted request: 1–200, each in the bin. */
  #trashUids(raw: ReadonlyArray<string>): string[] {
    const uids = [...new Set(raw)];
    if (uids.length === 0) throw new CpeControlValidationError("Provide at least one message uid");
    if (uids.length > MAX_UIDS_PER_REQUEST) throw new CpeControlValidationError(`At most ${MAX_UIDS_PER_REQUEST} uids per request`);
    if (this.mirror.findTrash(uids).length !== uids.length) {
      throw new CpeControlValidationError("Unknown message uid; refresh Recently deleted and retry");
    }
    return uids;
  }

  upsertContact(input: { phone: string; name: string; note?: string }, opts: { source?: "manual" | "mcp" } = {}): ContactRecord {
    const contact = this.contacts.upsert(input, opts);
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
    let fetched: SmsListing | null;
    try {
      // A router without SMS (or without a listing FengSui reads) has nothing to sync
      fetched = await this.#backend().listSms({
        mode,
        recentCount: this.recentFetchCount,
        expandThread: (latest) => this.mirror.get(computeSmsUid(latest)) === undefined,
        priority,
      });
    } catch (err) {
      this.#retryNotBeforeMs = Date.now() + SYNC_RETRY_BACKOFF_MS;
      throw err;
    }
    if (!fetched) return null;

    this.#synced = fetched.counters;
    this.#observed = fetched.counters;
    this.#probeUnread = null;
    // A listing that holds everything is a full sync, whatever was asked for: what it lacks is gone from the router
    const synced: SmsSyncMode = fetched.complete ? "full" : mode;
    const ingest = this.mirror.ingest(fetched.messages, synced, { counters: fetched.counters, via: fetched.via, keepReadState: fetched.readState === "fengsui" });
    const fresh = this.#announceFreshIncoming(ingest.added);
    const summary: SmsSyncSummary = {
      mode: synced,
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
    if (this.#autoMarkRead() && fresh.length > 0) {
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

  /**
   * Show what was sent: the router's own copy where one was read back; else a provisional record the
   * next sync replaces with it, or (a router that keeps no copy) FengSui's own copy, which stays.
   */
  #recordSent(phones: ReadonlyArray<string>, content: string, readBack: ReadonlyMap<string, SmsWireMessage[]>, routerKeepsSent: boolean): EnrichedSmsMessage[] {
    const recorded: EnrichedSmsMessage[] = [];
    for (const phone of phones) {
      const back = readBack.get(phone) ?? [];
      const copies = back.filter((m) => m.direction === "out" && m.content.trim() === content);
      if (copies.length > 0) {
        const ingest = this.mirror.ingest(back, "incremental");
        this.#announceFreshIncoming(ingest.added);
        const newest = copies.reduce((a, b) => (b.date > a.date || (b.date === a.date && b.index > a.index) ? b : a));
        const stored = this.mirror.get(computeSmsUid(newest));
        if (stored) recorded.push(this.mirror.enrich(stored));
      } else {
        const date = formatHuaweiDate(new Date());
        recorded.push(this.mirror.enrich(routerKeepsSent ? this.mirror.addPending(phone, content, date) : this.mirror.addSent(phone, content, date)));
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
    // Each listener on its own: a failing one (e.g. a disconnected SSE client) must never break SMS sync, nor keep
    // the event from the listeners after it (the notification hub). Raw listeners keep `once` working.
    for (const listener of this.rawListeners(event)) {
      try {
        Reflect.apply(listener, this, [payload]);
      } catch {
        // Already isolated: the other listeners still get the event
      }
    }
  }
}

/** A message the router still stores: not a provisional send, not FengSui's own restored copy. */
function onRouter(m: SmsMessageRecord): boolean {
  return !m.pending && !m.localOnly && m.index > 0;
}
