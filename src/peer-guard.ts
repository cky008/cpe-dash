import crypto from "node:crypto";
import dgram from "node:dgram";
import { EventEmitter } from "node:events";
import { parseJsonSafeNullProto } from "./json-safe.ts";

/**
 * Cross-host guard against a second FengSui daemon driving the same CPE (e.g. one on the Mac and
 * one on the NAS). The data-directory lock only stops a second daemon on the same directory; two
 * hosts would run two schedulers against one single-admin router and two Telegram pollers.
 *
 * Every daemon broadcasts a small signed beacon on the LAN and listens for others. The key is
 * derived from `CPE_PASSWORD` (anything that can drive this CPE knows it; nothing else can forge a
 * beacon to put a daemon on standby). Two live daemons for the same CPE agree on one leader without
 * comparing clocks: the earlier `startedAtMs` wins, ties broken by instance id. The other goes on
 * standby (no CPE sessions, no Telegram polling) until the leader's beacons stop.
 */

export const DEFAULT_PEER_PORT = 18385;
const BEACON_VERSION = 1;
const MAX_BEACON_BYTES = 1024;

export interface PeerTransport {
  send(payload: Buffer): void;
  onMessage(handler: (payload: Buffer, address: string) => void): void;
  close(): void;
}

/** UDP broadcast transport (`node:dgram`). Docker bridge networks do not forward broadcasts: use host networking. */
export function createUdpPeerTransport(opts: { port?: number; targetAddress?: string } = {}): PeerTransport {
  const port = opts.port ?? DEFAULT_PEER_PORT;
  const target = opts.targetAddress ?? "255.255.255.255";
  const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
  const handlers: Array<(payload: Buffer, address: string) => void> = [];
  socket.on("message", (msg, rinfo) => {
    for (const handler of handlers) handler(msg, rinfo.address);
  });
  // Discovery is best-effort: a busy port or a network without broadcast must not stop the daemon
  socket.on("error", () => undefined);
  socket.bind(port, () => {
    try {
      socket.setBroadcast(true);
    } catch {
      // Unsupported on this interface; beacons then stay local
    }
  });
  socket.unref();
  return {
    send: (payload) => socket.send(payload, port, target, () => undefined),
    onMessage: (handler) => handlers.push(handler),
    close: () => {
      try {
        socket.close();
      } catch {
        // Already closed
      }
    },
  };
}

export interface PeerBeacon {
  v: typeof BEACON_VERSION;
  id: string;
  startedAtMs: number;
  sentAtMs: number;
  /** Keyed fingerprint of the CPE host (no cleartext address on the wire). */
  cpe: string;
}

export interface PeerInfo {
  id: string;
  address: string;
  startedAtIso: string;
  lastSeenIso: string;
}

export interface PeerGuardState {
  enabled: boolean;
  instanceId: string;
  /** `true` while a live peer for the same CPE leads and this daemon stays off the CPE. */
  standby: boolean;
  peers: PeerInfo[];
}

export interface PeerDaemonGuardOptions {
  secret: string;
  cpeHost: string;
  transport: PeerTransport;
  intervalMs?: number;
  /** A peer counts as gone after this long without a valid beacon (default 3 intervals). */
  peerTimeoutMs?: number;
  /** Beacons whose `sentAtMs` differs from local time by more than this are ignored (replay guard). */
  maxClockSkewMs?: number;
  now?: () => number;
  instanceId?: string;
  startedAtMs?: number;
}

function canonical(beacon: PeerBeacon): string {
  return `${beacon.v}|${beacon.id}|${beacon.startedAtMs}|${beacon.sentAtMs}|${beacon.cpe}`;
}

/**
 * Emits `peer` (a new live peer, with `{ peer, standby }`), `standby` (this daemon must stay off
 * the CPE, with the leading peer) and `resume` (the leader is gone).
 */
export class PeerDaemonGuard extends EventEmitter {
  readonly instanceId: string;
  readonly startedAtMs: number;
  readonly intervalMs: number;
  readonly peerTimeoutMs: number;
  readonly #key: Buffer;
  readonly #cpe: string;
  readonly #transport: PeerTransport;
  readonly #maxSkewMs: number;
  readonly #now: () => number;
  #peers = new Map<string, { address: string; startedAtMs: number; lastSeenMs: number }>();
  #standby = false;
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: PeerDaemonGuardOptions) {
    super();
    if (!options.secret) throw new Error("PeerDaemonGuard requires the CPE password as its key");
    this.#now = options.now ?? Date.now;
    this.instanceId = options.instanceId ?? crypto.randomBytes(8).toString("hex");
    this.startedAtMs = options.startedAtMs ?? this.#now();
    this.intervalMs = Math.max(1000, options.intervalMs ?? 15_000);
    this.peerTimeoutMs = options.peerTimeoutMs ?? this.intervalMs * 3;
    this.#maxSkewMs = options.maxClockSkewMs ?? 120_000;
    this.#key = Buffer.from(
      crypto.hkdfSync("sha256", Buffer.from(options.secret, "utf8"), Buffer.from("fengsui-peer-beacon-v1"), Buffer.from("beacon"), 32)
    );
    this.#cpe = crypto.createHmac("sha256", this.#key).update(options.cpeHost.trim().toLowerCase()).digest("hex").slice(0, 16);
    this.#transport = options.transport;
    this.#transport.onMessage((payload, address) => this.handle(payload, address));
  }

  start(): void {
    if (this.#timer) return;
    this.announce();
    this.#timer = setInterval(() => {
      this.announce();
      this.sweep();
    }, this.intervalMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.#transport.close();
  }

  getState(): PeerGuardState {
    return {
      enabled: true,
      instanceId: this.instanceId,
      standby: this.#standby,
      peers: [...this.#peers.entries()].map(([id, p]) => ({
        id,
        address: p.address,
        startedAtIso: new Date(p.startedAtMs).toISOString(),
        lastSeenIso: new Date(p.lastSeenMs).toISOString(),
      })),
    };
  }

  /** Broadcast one signed beacon. */
  announce(): void {
    const beacon: PeerBeacon = {
      v: BEACON_VERSION,
      id: this.instanceId,
      startedAtMs: this.startedAtMs,
      sentAtMs: this.#now(),
      cpe: this.#cpe,
    };
    const mac = crypto.createHmac("sha256", this.#key).update(canonical(beacon)).digest("hex");
    this.#transport.send(Buffer.from(JSON.stringify({ ...beacon, mac }), "utf8"));
  }

  /** Verify and record one received datagram; anything unsigned, stale, foreign or ours is dropped. */
  handle(payload: Buffer, address: string): void {
    if (payload.length > MAX_BEACON_BYTES) return;
    let parsed: unknown;
    try {
      parsed = parseJsonSafeNullProto(payload.toString("utf8"));
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object") return;
    const obj = parsed as Record<string, unknown>;
    const { v, id, startedAtMs, sentAtMs, cpe, mac } = obj;
    if (
      v !== BEACON_VERSION ||
      typeof id !== "string" ||
      !/^[0-9a-f]{16}$/.test(id) ||
      typeof startedAtMs !== "number" ||
      typeof sentAtMs !== "number" ||
      typeof cpe !== "string" ||
      typeof mac !== "string"
    ) {
      return;
    }
    const beacon: PeerBeacon = { v: BEACON_VERSION, id, startedAtMs, sentAtMs, cpe };
    const expected = crypto.createHmac("sha256", this.#key).update(canonical(beacon)).digest();
    const given = Buffer.from(mac, "hex");
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return;
    const nowMs = this.#now();
    if (id === this.instanceId || cpe !== this.#cpe || Math.abs(nowMs - sentAtMs) > this.#maxSkewMs) return;

    const known = this.#peers.has(id);
    this.#peers.set(id, { address, startedAtMs, lastSeenMs: nowMs });
    if (!known) {
      this.#reevaluate();
      this.emit("peer", { peer: this.getState().peers.find((p) => p.id === id), standby: this.#standby });
      // Answer at once so the newcomer learns about us without waiting a full interval
      this.announce();
    }
  }

  /** Forget peers whose beacons stopped and resume when no leader is left. */
  sweep(): void {
    const nowMs = this.#now();
    for (const [id, peer] of this.#peers) {
      if (nowMs - peer.lastSeenMs > this.peerTimeoutMs) this.#peers.delete(id);
    }
    this.#reevaluate();
  }

  #reevaluate(): void {
    const leader = [...this.#peers.entries()].find(
      ([id, p]) => p.startedAtMs < this.startedAtMs || (p.startedAtMs === this.startedAtMs && id < this.instanceId)
    );
    if (leader && !this.#standby) {
      this.#standby = true;
      this.emit("standby", { id: leader[0], address: leader[1].address, startedAtIso: new Date(leader[1].startedAtMs).toISOString() });
    } else if (!leader && this.#standby) {
      this.#standby = false;
      this.emit("resume");
    }
  }
}
