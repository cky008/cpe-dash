import crypto from "node:crypto";
import fs from "node:fs";
import type { AccessControlSnapshot } from "./access-control.ts";
import type {
  GlobalTelemetrySnapshot,
  NeighborScanSnapshot,
  PersistedLockState,
  RouterSettingsSnapshot,
  TerminalTopologySnapshot,
} from "./cpe-domain.ts";
import { type ReadRecord, isReadRecord } from "./device-access.ts";
import { type DeviceProbeResult, type LoginScheme, isDeviceProbeResult } from "./device-profile.ts";
import { AtomicFileWriter, StorageCipher, assertKnownDataFormat } from "./encrypted-file.ts";
import type { SerializedTimeSeriesSnapshot } from "./timeseries.ts";
import type { CircuitBreakerState } from "./types.ts";

export interface AlertEventRecord {
  id: string;
  tsIso: string;
  severity: "info" | "warning" | "critical";
  code: string;
  messageZh: string;
  messageEn: string;
}

export interface PersistedRuntimeState {
  schemaVersion: 1;
  savedAtIso: string;
  circuitBreaker: CircuitBreakerState;
  lockState: PersistedLockState;
  latestTelemetry: GlobalTelemetrySnapshot | null;
  latestNeighbors: NeighborScanSnapshot | null;
  latestTopology: TerminalTopologySnapshot | null;
  latestSettings: RouterSettingsSnapshot | null;
  latestAccessControl: AccessControlSnapshot | null;
  recentAlerts: AlertEventRecord[];
  timeseries: SerializedTimeSeriesSnapshot | null;
  /** The unverified model / firmware build `FIRMWARE_UNVERIFIED` was raised for (once per build). */
  firmwareNotice: { fingerprint: string; notifiedAtIso: string } | null;
  /** The last identification and capability probe (daemon start, or the console's connection test). */
  deviceProbe: DeviceProbeResult | null;
  /**
   * How the router in use logs in, as a background session or a saved connection last found it (a
   * SCRAM router then never gets a legacy password). A console test that is not saved never changes
   * it; state written before it existed falls back to the stored identification.
   */
  knownLoginScheme: LoginScheme | null;
  /** What a model nobody verified answered per read section (it decides which cards and tools show). */
  deviceReads: ReadRecord | null;
}

function createDefaultState(): PersistedRuntimeState {
  return {
    schemaVersion: 1,
    savedAtIso: new Date().toISOString(),
    circuitBreaker: {
      tripped: false,
      code: null,
      reason: null,
      trippedAtIso: null,
      remainCount: null,
      waitTime: null,
      passwordFingerprintHex: null,
    },
    lockState: {
      mode: "unlocked",
      updatedAtIso: new Date().toISOString(),
      lteBands: "all",
      nrBands: [],
      cellLock: null,
    },
    latestTelemetry: null,
    latestNeighbors: null,
    latestTopology: null,
    latestSettings: null,
    latestAccessControl: null,
    recentAlerts: [],
    timeseries: null,
    firmwareNotice: null,
    deviceProbe: null,
    knownLoginScheme: null,
    deviceReads: null,
  };
}

const KNOWN_LOGIN_SCHEMES: ReadonlySet<unknown> = new Set<LoginScheme>(["scram", "sha256", "base64"]);

/**
 * Fill device fields added after a snapshot was persisted (identifiers came with Phase 3), so the
 * cached snapshot served before the first poll still matches `GlobalTelemetrySnapshot`.
 */
function upgradeTelemetry(snapshot: GlobalTelemetrySnapshot | null): GlobalTelemetrySnapshot | null {
  if (!snapshot?.device) return snapshot;
  const device: Partial<GlobalTelemetrySnapshot["device"]> = snapshot.device;
  return {
    ...snapshot,
    device: {
      ...snapshot.device,
      imei: device.imei ?? "",
      imsi: device.imsi ?? "",
      msisdn: device.msisdn ?? "",
      macAddress: device.macAddress ?? "",
      sensitiveRedacted: device.sensitiveRedacted ?? false,
    },
  };
}

/**
 * Encrypted, crash-safe, NAS-hibernation-friendly state persistence store (`0600` AES-256-GCM).
 *
 * - Serializes async disk writes (`fs.promises.open` + `sync()` + atomic `rename`) so disk spin-up never
 *   stalls SSE streams or holds open an ephemeral CPE session.
 * - Gracefully recovers if `DATA_ENCRYPTION_KEY` / `CPE_PASSWORD` was rotated (renames unreadable file to
 *   `*.unreadable-<ts>` instead of crash-looping).
 */
/** Snapshots saved before `isLocalDevice` existed read it as `false`. */
function upgradeTopology(snapshot: TerminalTopologySnapshot | null): TerminalTopologySnapshot | null {
  if (!snapshot || !Array.isArray(snapshot.hosts)) return snapshot;
  return { ...snapshot, hosts: snapshot.hosts.map((host) => ({ ...host, isLocalDevice: host.isLocalDevice === true })) };
}

export class EncryptedStateStore {
  readonly filePath: string;
  #cipher: StorageCipher;
  #state: PersistedRuntimeState;
  #writer: AtomicFileWriter;

  /** Throws on an empty key: runtime state (WAN IPs, locks, breaker) is never written unencrypted. */
  constructor(opts: { filePath: string; encryptionKey: string }) {
    this.filePath = opts.filePath;
    this.#cipher = new StorageCipher(opts.encryptionKey);
    this.#state = createDefaultState();
    this.#writer = new AtomicFileWriter(opts.filePath);
  }

  /**
   * Load persisted state at startup; archives unreadable files safely if key rotated.
   */
  load(): PersistedRuntimeState {
    if (!fs.existsSync(this.filePath)) {
      return this.#state;
    }
    const loaded = this.#cipher.readJsonFileOrQuarantine<Partial<PersistedRuntimeState>>(this.filePath);
    assertKnownDataFormat(this.filePath, loaded?.schemaVersion, 1);
    if (!loaded) {
      this.#state = createDefaultState();
    } else if (loaded.schemaVersion === 1) {
      this.#state = {
        ...createDefaultState(),
        ...loaded,
        latestTelemetry: upgradeTelemetry(loaded.latestTelemetry ?? null),
        latestTopology: upgradeTopology(loaded.latestTopology ?? null),
        deviceProbe: isDeviceProbeResult(loaded.deviceProbe) ? loaded.deviceProbe : null,
        knownLoginScheme: KNOWN_LOGIN_SCHEMES.has(loaded.knownLoginScheme) ? (loaded.knownLoginScheme ?? null) : null,
        deviceReads: isReadRecord(loaded.deviceReads) ? loaded.deviceReads : null,
        recentAlerts: Array.isArray(loaded.recentAlerts) ? loaded.recentAlerts.slice(-100) : [],
      };
    }
    return this.#state;
  }

  rotateEncryptionKey(newKey: string): void {
    this.#cipher = new StorageCipher(newKey);
  }

  getState(): Readonly<PersistedRuntimeState> {
    return this.#state;
  }

  update(patch: Partial<Omit<PersistedRuntimeState, "schemaVersion" | "savedAtIso">>): void {
    this.#state = {
      ...this.#state,
      ...patch,
      savedAtIso: new Date().toISOString(),
    };
  }

  appendAlert(alert: Omit<AlertEventRecord, "id" | "tsIso">): AlertEventRecord {
    const record: AlertEventRecord = {
      id: crypto.randomUUID(),
      tsIso: new Date().toISOString(),
      ...alert,
    };
    const next = [...this.#state.recentAlerts, record];
    if (next.length > 100) {
      next.splice(0, next.length - 100);
    }
    this.#state = {
      ...this.#state,
      recentAlerts: next,
      savedAtIso: record.tsIso,
    };
    return record;
  }

  /**
   * Enqueue an asynchronous crash-safe atomic write (`0600` + `fsync` + `rename`).
   */
  async flushAsync(): Promise<void> {
    const snapshot = {
      ...this.#state,
      savedAtIso: new Date().toISOString(),
    };
    await this.#writer.write(() => this.#cipher.serializeJson(snapshot));
  }
}
