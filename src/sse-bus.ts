import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { FengSuiCore } from "./core.ts";
import type { AccessControlSnapshot } from "./access-control.ts";
import type { GlobalTelemetrySnapshot, TerminalTopologySnapshot } from "./cpe-domain.ts";
import { redactAccessControl, redactTelemetry, redactTopology } from "./redact.ts";
import type { SmsService } from "./sms/service.ts";

export type SseEventName =
  | "hello"
  | "telemetry"
  | "speed"
  | "neighbors"
  | "topology"
  | "settings"
  | "access-control"
  | "session:avoidance"
  | "alert"
  | "control:applied"
  | "sms:new"
  | "sms:sent"
  | "sms:updated"
  | "sms:sync"
  | "sms:status"
  | "contacts:updated";

const SMS_SSE_EVENTS = ["sms:new", "sms:sent", "sms:updated", "sms:sync", "sms:status", "contacts:updated"] as const;

interface SseClientEntry {
  id: string;
  clientIp: string;
  sessionId: string | null;
  /** The Bearer token a stream was opened with (closed when the token is revoked). */
  tokenId: string | null;
  expiresAtMs: number | null;
  /** Bearer subscriber under REDACT_SENSITIVE_IN_API: receives the redacted copy of an event. */
  redact: boolean;
  /** Receives SMS and contact events (a token without the sms-read permission does not). */
  sms: boolean;
  res: ServerResponse;
  connectedAtMs: number;
  consecutiveBackpressureCount: number;
}

export interface SseEventBusOptions {
  heartbeatMs?: number;
  maxClients?: number;
  maxClientsPerIp?: number;
}

const SAFE_EVENT_RE = /^[a-zA-Z0-9:_-]{1,64}$/;

/**
 * Sub-millisecond Server-Sent Events (`/api/events`) fan-out bus with:
 * - Per-IP and global connection caps;
 * - Single-line `JSON.stringify` framing preventing CRLF / fake-event injection;
 * - Backpressure slow-consumer eviction (`max 3` stalled writes);
 * - Periodic `: heartbeat <unixMs>` keepalive & automatic session-expiry / logout disconnect;
 * - Per-subscriber REDACT_SENSITIVE_IN_API copies of telemetry, topology and access-control events.
 */
export class SseEventBus {
  readonly heartbeatMs: number;
  readonly maxClients: number;
  readonly maxClientsPerIp: number;

  #clients: Map<string, SseClientEntry> = new Map();
  #heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  #seq = 0;
  #detachScheduler: (() => void) | null = null;
  #detachSms: (() => void) | null = null;

  constructor(options: SseEventBusOptions = {}) {
    this.heartbeatMs = Math.max(2000, options.heartbeatMs ?? 15_000);
    this.maxClients = Math.max(1, options.maxClients ?? 32);
    this.maxClientsPerIp = Math.max(1, options.maxClientsPerIp ?? 6);
  }

  start(): void {
    if (this.#heartbeatTimer) return;
    this.#heartbeatTimer = setInterval(() => {
      this.sendHeartbeat();
    }, this.heartbeatMs);
    this.#heartbeatTimer.unref?.();
  }

  stop(): void {
    if (this.#heartbeatTimer) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
    }
    if (this.#detachScheduler) {
      this.#detachScheduler();
      this.#detachScheduler = null;
    }
    this.#detachSms?.();
    this.#detachSms = null;
    for (const client of this.#clients.values()) {
      this.#closeClient(client);
    }
    this.#clients.clear();
  }

  getClientCount(): number {
    return this.#clients.size;
  }

  /**
   * Wire the real-time core events into this SSE bus: telemetry/speed/neighbors/topology/settings
   * from `CpeMonitor`, session:avoidance/alert/control:applied from `MutexSessionScheduler`.
   */
  attachCore(core: Pick<FengSuiCore, "scheduler" | "monitor">): void {
    if (this.#detachScheduler) {
      this.#detachScheduler();
    }
    const { scheduler, monitor } = core;

    const onTelemetry = (data: GlobalTelemetrySnapshot) => this.broadcast("telemetry", data, redactTelemetry);
    const onSpeed = (data: unknown) => this.broadcast("speed", data);
    const onNeighbors = (data: unknown) => this.broadcast("neighbors", data);
    const onTopology = (data: TerminalTopologySnapshot) => this.broadcast("topology", data, redactTopology);
    const onSettings = (data: unknown) => this.broadcast("settings", data);
    const onAccessControl = (data: AccessControlSnapshot) => this.broadcast("access-control", data, redactAccessControl);
    const onAvoidance = (data: unknown) => this.broadcast("session:avoidance", data);
    const onAlert = (data: unknown) => this.broadcast("alert", data);
    const onControl = (data: unknown) => this.broadcast("control:applied", data);

    monitor.on("telemetry", onTelemetry);
    monitor.on("speed", onSpeed);
    monitor.on("neighbors", onNeighbors);
    monitor.on("topology", onTopology);
    monitor.on("settings", onSettings);
    monitor.on("access-control", onAccessControl);
    scheduler.on("session:avoidance", onAvoidance);
    scheduler.on("alert", onAlert);
    scheduler.on("control:applied", onControl);

    this.#detachScheduler = () => {
      monitor.off("telemetry", onTelemetry);
      monitor.off("speed", onSpeed);
      monitor.off("neighbors", onNeighbors);
      monitor.off("topology", onTopology);
      monitor.off("settings", onSettings);
      monitor.off("access-control", onAccessControl);
      scheduler.off("session:avoidance", onAvoidance);
      scheduler.off("alert", onAlert);
      scheduler.off("control:applied", onControl);
    };
  }

  /**
   * Forward SMS domain events (`sms:new`, `sms:sent`, `sms:updated`, `sms:sync`, `sms:status`,
   * `contacts:updated`) to every subscriber.
   */
  attachSms(sms: SmsService): void {
    this.#detachSms?.();
    const handlers = SMS_SSE_EVENTS.map((name) => {
      const handler = (data: unknown): void => {
        this.broadcast(name, data);
      };
      sms.on(name, handler);
      return [name, handler] as const;
    });
    this.#detachSms = () => {
      for (const [name, handler] of handlers) sms.off(name, handler);
    };
  }

  /**
   * Subscribe an authenticated HTTP response stream to `/api/events`.
   */
  subscribe(params: {
    req: IncomingMessage;
    res: ServerResponse;
    clientIp: string;
    sessionId?: string | null;
    tokenId?: string | null;
    expiresAtMs?: number | null;
    /** Send redacted copies of later telemetry / topology events (the initial snapshot is the caller's). */
    redact?: boolean;
    /** Send SMS and contact events (default); `false` for a token without the sms-read permission. */
    sms?: boolean;
    initialSnapshot?: {
      schedulerStatus: unknown;
      avoidance: unknown;
      telemetry: unknown;
      lockState: unknown;
      lockVerification?: unknown;
      sms?: unknown;
    };
  }): { accepted: boolean; reason?: string; clientId?: string } {
    if (this.#clients.size >= this.maxClients) {
      return { accepted: false, reason: "SSE global client limit reached" };
    }
    let ipCount = 0;
    for (const c of this.#clients.values()) {
      if (c.clientIp === params.clientIp) ipCount += 1;
    }
    if (ipCount >= this.maxClientsPerIp) {
      return { accepted: false, reason: "SSE per-IP stream limit reached" };
    }

    const clientId = crypto.randomUUID();
    const { req, res } = params;

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "same-origin",
    });
    res.flushHeaders?.();

    const entry: SseClientEntry = {
      id: clientId,
      clientIp: params.clientIp,
      sessionId: params.sessionId ?? null,
      tokenId: params.tokenId ?? null,
      expiresAtMs: params.expiresAtMs ?? null,
      redact: params.redact === true,
      sms: params.sms !== false,
      res,
      connectedAtMs: Date.now(),
      consecutiveBackpressureCount: 0,
    };
    this.#clients.set(clientId, entry);

    const cleanup = (): void => {
      this.#clients.delete(clientId);
    };
    req.on("close", cleanup);
    req.on("error", cleanup);
    res.on("close", cleanup);
    res.on("error", cleanup);

    // Push immediate hello + initial cached snapshot so UI renders in < 1ms without waiting 5s
    this.#writeFrameToClient(entry, "hello", {
      clientId,
      connectedAtIso: new Date(entry.connectedAtMs).toISOString(),
      heartbeatMs: this.heartbeatMs,
      ...(params.initialSnapshot ?? {}),
    });
    if (params.initialSnapshot?.avoidance) {
      this.#writeFrameToClient(entry, "session:avoidance", params.initialSnapshot.avoidance);
    }
    if (params.initialSnapshot?.telemetry) {
      this.#writeFrameToClient(entry, "telemetry", params.initialSnapshot.telemetry);
    }

    return { accepted: true, clientId };
  }

  /**
   * Disconnect all active SSE streams bound to a specific Cookie session ID (e.g., on logout).
   */
  /** Close the streams opened with a token that was just revoked. */
  disconnectByTokenId(tokenId: string): number {
    let closed = 0;
    for (const [id, entry] of this.#clients.entries()) {
      if (entry.tokenId === tokenId) {
        this.#clients.delete(id);
        this.#closeClient(entry);
        closed += 1;
      }
    }
    return closed;
  }

  disconnectBySessionId(sessionId: string): number {
    let closed = 0;
    for (const [id, entry] of this.#clients.entries()) {
      if (entry.sessionId === sessionId) {
        this.#clients.delete(id);
        this.#closeClient(entry);
        closed += 1;
      }
    }
    return closed;
  }

  /**
   * Disconnect all active SSE streams (e.g., when `API_TOKEN` is rotated via hot-reload).
   */
  disconnectAll(): number {
    let closed = 0;
    for (const [id, entry] of this.#clients.entries()) {
      this.#clients.delete(id);
      this.#closeClient(entry);
      closed += 1;
    }
    return closed;
  }

  /**
   * Broadcast a typed JSON event frame to all active subscribers; with `redact`, subscribers marked
   * `redact` receive `redact(payload)` instead (built once, only when such a subscriber exists).
   */
  broadcast<T>(eventName: SseEventName, payload: T, redact?: (payload: T) => unknown): number {
    if (!SAFE_EVENT_RE.test(eventName)) {
      throw new Error(`Unsafe SSE event name "${eventName}"`);
    }
    const eventId = ++this.#seq;
    const frameOf = (data: unknown): string => `id: ${eventId}\nevent: ${eventName}\ndata: ${JSON.stringify(data ?? null)}\n\n`;
    const frame = frameOf(payload);
    let redactedFrame: string | null = null;

    let delivered = 0;
    const nowMs = Date.now();
    const smsEvent = (SMS_SSE_EVENTS as ReadonlyArray<string>).includes(eventName);
    for (const [id, entry] of this.#clients.entries()) {
      if (entry.expiresAtMs !== null && nowMs >= entry.expiresAtMs) {
        this.#clients.delete(id);
        this.#closeClient(entry);
        continue;
      }
      if (smsEvent && !entry.sms) continue;
      const chunk = entry.redact && redact ? (redactedFrame ??= frameOf(redact(payload))) : frame;
      if (this.#writeRaw(entry, chunk)) {
        delivered += 1;
      } else {
        this.#clients.delete(id);
      }
    }
    return delivered;
  }

  /**
   * Emit an SSE comment heartbeat (`: heartbeat <unixMs>\n\n`) and evict expired/dead sockets.
   */
  sendHeartbeat(nowMs = Date.now()): number {
    const comment = `: heartbeat ${nowMs}\n\n`;
    let alive = 0;
    for (const [id, entry] of this.#clients.entries()) {
      if (entry.expiresAtMs !== null && nowMs >= entry.expiresAtMs) {
        this.#clients.delete(id);
        this.#closeClient(entry);
        continue;
      }
      if (this.#writeRaw(entry, comment)) {
        alive += 1;
      } else {
        this.#clients.delete(id);
      }
    }
    return alive;
  }

  #writeFrameToClient(entry: SseClientEntry, eventName: SseEventName, payload: unknown): boolean {
    const eventId = ++this.#seq;
    const frame = `id: ${eventId}\nevent: ${eventName}\ndata: ${JSON.stringify(payload ?? null)}\n\n`;
    return this.#writeRaw(entry, frame);
  }

  #writeRaw(entry: SseClientEntry, rawChunk: string): boolean {
    if (entry.res.writableEnded || entry.res.destroyed) {
      return false;
    }
    try {
      const ok = entry.res.write(rawChunk);
      if (!ok) {
        entry.consecutiveBackpressureCount += 1;
        if (entry.consecutiveBackpressureCount > 3) {
          this.#closeClient(entry, true);
          return false;
        }
      } else {
        entry.consecutiveBackpressureCount = 0;
      }
      return true;
    } catch {
      this.#closeClient(entry, true);
      return false;
    }
  }

  #closeClient(entry: SseClientEntry, forceDestroy = false): void {
    try {
      if (!entry.res.writableEnded && !entry.res.destroyed) {
        if (forceDestroy && typeof entry.res.destroy === "function") {
          entry.res.destroy();
        } else {
          entry.res.end();
        }
      }
    } catch {
      // Ignore socket teardown errors
    }
  }
}
