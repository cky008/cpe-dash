import type { SseEventPayloads } from "../../../src/api-contract.ts";

/**
 * `/api/events` connection manager. The browser's built-in EventSource retry is a fixed ~3 s loop
 * that keeps hammering a restarting daemon and silently gives up on a 401; this client closes the
 * stream on every error and reconnects itself with capped, jittered exponential backoff, asking the
 * REST API whether the session is still valid before each retry. Exactly one EventSource is open at a
 * time, and `stop()` clears every timer and listener it created.
 */

export type SseEventName = keyof SseEventPayloads;

/** Every named event of contract §3.2; the record type makes a missing or extra name a compile error. */
const EVENT_NAME_SET: Readonly<Record<SseEventName, true>> = {
  hello: true,
  speed: true,
  telemetry: true,
  neighbors: true,
  topology: true,
  settings: true,
  "session:avoidance": true,
  "control:applied": true,
  alert: true,
  "sms:new": true,
  "sms:sent": true,
  "sms:updated": true,
  "sms:sync": true,
  "sms:status": true,
  "contacts:updated": true,
};

export const SSE_EVENT_NAMES = Object.keys(EVENT_NAME_SET) as ReadonlyArray<SseEventName>;

/** The subset of `EventSource` this client uses (tests inject a fake). */
export interface EventSourceLike {
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void;
  close(): void;
}

export type SseConnectionState = "connecting" | "live" | "reconnecting" | "unauthorized" | "stopped";

export interface SseStatus {
  state: SseConnectionState;
  /** Consecutive failed attempts since the last `hello`. */
  attempt: number;
  /** When the next reconnect fires (`reconnecting` only). */
  nextRetryAtMs: number | null;
}

/** One parsed frame, discriminated by name so a `switch` narrows the payload. */
export type SseEvent = { [K in SseEventName]: { name: K; data: SseEventPayloads[K] } }[SseEventName];

export interface SseClientOptions {
  url: string;
  createEventSource: (url: string) => EventSourceLike;
  onEvent: (event: SseEvent) => void;
  onStatus: (status: SseStatus) => void;
  /** Resolves `false` when the cookie session is gone (the stream then stops for good). */
  isAuthenticated: () => Promise<boolean>;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  now?: () => number;
  random?: () => number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

/** "Full jitter" backoff: uniform in [base/2, min(max, base·2^attempt)]. */
export function backoffDelayMs(attempt: number, random: () => number, baseDelayMs = 1000, maxDelayMs = 30_000): number {
  const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.min(Math.max(0, attempt), 16));
  const floor = Math.min(ceiling, baseDelayMs / 2);
  return Math.round(floor + random() * (ceiling - floor));
}

export class SseClient {
  readonly #opts: SseClientOptions;
  readonly #setTimer: (fn: () => void, ms: number) => unknown;
  readonly #clearTimer: (handle: unknown) => void;
  readonly #now: () => number;
  readonly #random: () => number;
  #source: EventSourceLike | null = null;
  #retryTimer: unknown = null;
  #attempt = 0;
  #generation = 0;
  #state: SseConnectionState = "stopped";

  constructor(options: SseClientOptions) {
    this.#opts = options;
    this.#setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.#clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.#now = options.now ?? (() => Date.now());
    this.#random = options.random ?? Math.random;
  }

  get state(): SseConnectionState {
    return this.#state;
  }

  start(): void {
    if (this.#state !== "stopped" && this.#state !== "unauthorized") return;
    this.#attempt = 0;
    this.#open("connecting");
  }

  stop(): void {
    this.#teardown();
    this.#setStatus("stopped", null);
  }

  /** Reconnect now (e.g. after the tab regains network) instead of waiting out the backoff. */
  reconnectNow(): void {
    if (this.#state !== "reconnecting") return;
    this.#teardown();
    this.#open("reconnecting");
  }

  #open(state: SseConnectionState): void {
    const generation = ++this.#generation;
    this.#setStatus(state, null);
    const source = this.#opts.createEventSource(this.#opts.url);
    this.#source = source;
    for (const name of SSE_EVENT_NAMES) {
      source.addEventListener(name, (event) => {
        if (generation !== this.#generation) return;
        if (name === "hello") {
          this.#attempt = 0;
          this.#setStatus("live", null);
        }
        this.#dispatch(name, event.data);
      });
    }
    source.addEventListener("error", () => {
      if (generation !== this.#generation) return;
      void this.#handleError();
    });
  }

  #dispatch(name: SseEventName, raw: unknown): void {
    if (typeof raw !== "string") return;
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }
    if (data === null || typeof data !== "object") return;
    // The daemon's bus serializes exactly these payload types (src/api-contract.ts)
    this.#opts.onEvent({ name, data } as SseEvent);
  }

  async #handleError(): Promise<void> {
    this.#source?.close();
    this.#source = null;
    // A new generation: late frames from the closed stream are ignored from here on
    const generation = ++this.#generation;
    this.#setStatus("reconnecting", null);
    let authenticated = true;
    try {
      authenticated = await this.#opts.isAuthenticated();
    } catch {
      authenticated = true; // daemon unreachable: keep retrying, the session may still be valid
    }
    if (generation !== this.#generation) return;
    if (!authenticated) {
      this.#generation += 1;
      this.#setStatus("unauthorized", null);
      return;
    }
    const delay = backoffDelayMs(this.#attempt, this.#random, this.#opts.baseDelayMs, this.#opts.maxDelayMs);
    this.#attempt += 1;
    this.#setStatus("reconnecting", this.#now() + delay);
    this.#retryTimer = this.#setTimer(() => {
      this.#retryTimer = null;
      if (generation !== this.#generation) return;
      this.#open("reconnecting");
    }, delay);
  }

  #teardown(): void {
    this.#generation += 1;
    if (this.#retryTimer !== null) {
      this.#clearTimer(this.#retryTimer);
      this.#retryTimer = null;
    }
    this.#source?.close();
    this.#source = null;
  }

  #setStatus(state: SseConnectionState, nextRetryAtMs: number | null): void {
    this.#state = state;
    this.#opts.onStatus({ state, attempt: this.#attempt, nextRetryAtMs });
  }
}
