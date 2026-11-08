import type {
  AccessControlSnapshot,
  AccessGuardInfo,
  AlertEventRecord,
  AvoidanceBroadcastPayload,
  GlobalTelemetrySnapshot,
  LockVerification,
  NeighborScanSnapshot,
  PersistedLockState,
  RouterSettingsSnapshot,
  SchedulerStatusSnapshot,
  SmsStatusSnapshot,
  TerminalTopologySnapshot,
  TimeSeriesBucketPoint,
} from "../../../src/api-contract.ts";
import type { SelfHealStatus } from "../../../src/self-heal-status.ts";
import type { SseEvent, SseStatus } from "./sse.ts";

/**
 * Dashboard state and the pure reducer that folds `/api/events` frames into it. Views subscribe to
 * topics and re-render only their slice; nothing here touches the DOM.
 */

export interface LiveSample {
  tsMs: number;
  downloadBps: number;
  uploadBps: number;
}

export interface AppState {
  sse: SseStatus;
  scheduler: SchedulerStatusSnapshot | null;
  /** What WAN self-healing will do next (from `GET /api/session/status`, "scheduler" topic). */
  selfHeal: SelfHealStatus | null;
  avoidance: AvoidanceBroadcastPayload | null;
  telemetry: GlobalTelemetrySnapshot | null;
  lockState: PersistedLockState | null;
  lockVerification: LockVerification | null;
  neighbors: NeighborScanSnapshot | null;
  topology: TerminalTopologySnapshot | null;
  settings: RouterSettingsSnapshot | null;
  /** Wi-Fi MAC filter and internet time rules (`GET /api/access-control`, then `access-control` frames). */
  accessControl: AccessControlSnapshot | null;
  /** Devices this browser may not cut off (FengSui's host, this device), from `GET /api/access-control`. */
  accessGuard: AccessGuardInfo | null;
  /** `null` until known; the daemon sends `hello.sms = null` when SMS is disabled. */
  sms: SmsStatusSnapshot | null;
  smsEnabled: boolean;
  /** Oldest first, at most `MAX_ALERTS`. */
  alerts: AlertEventRecord[];
  /** Live throughput ring from `speed` frames, oldest first. */
  live: LiveSample[];
  /** Bumped by SMS events so the messaging views refetch (the payloads are deltas, not lists). */
  smsRevision: number;
  contactsRevision: number;
}

export type Topic =
  | "sse"
  | "scheduler"
  | "telemetry"
  | "locks"
  | "neighbors"
  | "topology"
  | "settings"
  | "accessControl"
  | "sms"
  | "smsMessages"
  | "contacts"
  | "alerts"
  | "live";

export const MAX_ALERTS = 100;
/** One hour of 5 s samples. */
export const LIVE_CAPACITY = 720;

export function initialState(): AppState {
  return {
    sse: { state: "stopped", attempt: 0, nextRetryAtMs: null },
    scheduler: null,
    selfHeal: null,
    avoidance: null,
    telemetry: null,
    lockState: null,
    lockVerification: null,
    neighbors: null,
    topology: null,
    settings: null,
    accessControl: null,
    accessGuard: null,
    sms: null,
    smsEnabled: true,
    alerts: [],
    live: [],
    smsRevision: 0,
    contactsRevision: 0,
  };
}

export function appendLive(live: ReadonlyArray<LiveSample>, sample: LiveSample, capacity = LIVE_CAPACITY): LiveSample[] {
  const last = live[live.length - 1];
  // Out-of-order or duplicate ticks (manual refresh racing the poll) would fold the curve back
  if (last && sample.tsMs <= last.tsMs) return [...live];
  const next = live.length >= capacity ? live.slice(live.length - capacity + 1) : [...live];
  next.push(sample);
  return next;
}

/**
 * Prepend the daemon's recent 5 s history to the live ring so the live chart is not blank after a
 * page load. Only buckets that closed before the first live sample are taken, so a bucket never
 * duplicates a frame the SSE stream already delivered.
 */
export function seedLive(
  live: ReadonlyArray<LiveSample>,
  history: ReadonlyArray<Pick<TimeSeriesBucketPoint, "tsMs" | "dlAvgBps" | "ulAvgBps">>,
  bucketMs: number,
  capacity = LIVE_CAPACITY
): LiveSample[] {
  const firstLiveMs = live[0]?.tsMs ?? Number.POSITIVE_INFINITY;
  const seeded: LiveSample[] = [];
  for (const point of [...history].sort((a, b) => a.tsMs - b.tsMs)) {
    if (point.tsMs + bucketMs > firstLiveMs || point.tsMs === seeded.at(-1)?.tsMs) continue;
    seeded.push({ tsMs: point.tsMs, downloadBps: point.dlAvgBps, uploadBps: point.ulAvgBps });
  }
  const merged = [...seeded, ...live];
  return merged.length > capacity ? merged.slice(merged.length - capacity) : merged;
}

export function mergeAlerts(current: ReadonlyArray<AlertEventRecord>, incoming: ReadonlyArray<AlertEventRecord>): AlertEventRecord[] {
  const byId = new Map<string, AlertEventRecord>();
  for (const alert of [...current, ...incoming]) byId.set(alert.id, alert);
  return [...byId.values()].sort((a, b) => a.tsIso.localeCompare(b.tsIso)).slice(-MAX_ALERTS);
}

export interface Reduction {
  patch: Partial<AppState>;
  topics: Topic[];
}

/** Fold one SSE frame into state. Side effects (toasts, notifications) stay in the UI layer. */
export function reduceSseEvent(state: Readonly<AppState>, event: SseEvent): Reduction {
  switch (event.name) {
    case "hello": {
      const d = event.data;
      return {
        patch: {
          scheduler: d.schedulerStatus,
          avoidance: d.avoidance,
          telemetry: d.telemetry ?? state.telemetry,
          lockState: d.lockState,
          lockVerification: d.lockVerification,
          sms: d.sms,
          smsEnabled: d.sms !== null,
          smsRevision: state.smsRevision + 1,
        },
        topics: ["scheduler", "telemetry", "locks", "sms", "smsMessages"],
      };
    }
    case "speed":
      return {
        patch: {
          live: appendLive(state.live, { tsMs: event.data.tsMs, downloadBps: event.data.downloadBps, uploadBps: event.data.uploadBps }),
        },
        topics: ["live"],
      };
    case "telemetry":
      return { patch: { telemetry: event.data }, topics: ["telemetry"] };
    case "neighbors":
      return { patch: { neighbors: event.data }, topics: ["neighbors"] };
    case "topology":
      return { patch: { topology: event.data }, topics: ["topology"] };
    case "settings":
      return { patch: { settings: event.data }, topics: ["settings"] };
    case "access-control":
      return { patch: { accessControl: event.data }, topics: ["accessControl"] };
    case "session:avoidance": {
      const scheduler = state.scheduler ? { ...state.scheduler, avoidance: event.data } : null;
      return { patch: { avoidance: event.data, scheduler }, topics: ["scheduler"] };
    }
    case "control:applied":
      return event.data.lockState ? { patch: { lockState: event.data.lockState }, topics: ["locks"] } : { patch: {}, topics: [] };
    case "alert":
      return { patch: { alerts: mergeAlerts(state.alerts, [event.data]) }, topics: ["alerts"] };
    case "sms:status":
      return { patch: { sms: event.data, smsEnabled: true }, topics: ["sms"] };
    case "sms:new":
    case "sms:sent":
    case "sms:updated":
    case "sms:sync":
      return { patch: { smsRevision: state.smsRevision + 1 }, topics: ["smsMessages"] };
    case "contacts:updated":
      return { patch: { contactsRevision: state.contactsRevision + 1 }, topics: ["contacts", "smsMessages"] };
  }
}

/** Bell badge: warnings and criticals newer than the last look at the alerts panel (`seenAtIso`); info never counts. */
export function unseenAlertCount(alerts: ReadonlyArray<AlertEventRecord>, seenAtIso: string): number {
  return alerts.filter((alert) => alert.severity !== "info" && alert.tsIso > seenAtIso).length;
}

/** Unread badge: the mirror's count, or the router's while new messages wait for a sync. */
export function unreadBadgeCount(sms: SmsStatusSnapshot | null): number {
  if (!sms) return 0;
  return Math.max(sms.mirror.unreadTotal, sms.unreadOnCpe ?? 0);
}

export class Store {
  #state: AppState;
  readonly #listeners = new Map<Topic, Set<() => void>>();

  constructor(state: AppState = initialState()) {
    this.#state = state;
  }

  get state(): Readonly<AppState> {
    return this.#state;
  }

  update(patch: Partial<AppState>, topics: ReadonlyArray<Topic>): void {
    this.#state = { ...this.#state, ...patch };
    const notified = new Set<() => void>();
    for (const topic of topics) {
      for (const listener of this.#listeners.get(topic) ?? []) {
        if (notified.has(listener)) continue;
        notified.add(listener);
        listener();
      }
    }
  }

  apply(reduction: Reduction): void {
    if (reduction.topics.length > 0) this.update(reduction.patch, reduction.topics);
  }

  subscribe(topics: Topic | ReadonlyArray<Topic>, listener: () => void): () => void {
    const list = typeof topics === "string" ? [topics] : topics;
    for (const topic of list) {
      let set = this.#listeners.get(topic);
      if (!set) {
        set = new Set();
        this.#listeners.set(topic, set);
      }
      set.add(listener);
    }
    return () => {
      for (const topic of list) this.#listeners.get(topic)?.delete(listener);
    };
  }
}
