import crypto from "node:crypto";
import fs from "node:fs";
import type {
  GlobalTelemetrySnapshot,
  NeighborScanSnapshot,
  PersistedLockState,
  RouterSettingsSnapshot,
  TerminalTopologySnapshot,
} from "./cpe-domain.ts";
import { AtomicFileWriter, StorageCipher } from "./encrypted-file.ts";
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
  recentAlerts: AlertEventRecord[];
  timeseries: SerializedTimeSeriesSnapshot | null;
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
    recentAlerts: [],
    timeseries: null,
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
export class EncryptedStateStore {
  readonly filePath: string;
  #cipher: StorageCipher;
  #state: PersistedRuntimeState;
  #writer: AtomicFileWriter;

  constructor(opts: { filePath: string; encryptionKey: string }) {
    this.filePath = opts.filePath;
    this.#cipher = StorageCipher.fromSecret(opts.encryptionKey);
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
    if (!loaded) {
      this.#state = createDefaultState();
    } else if (loaded.schemaVersion === 1) {
      this.#state = {
        ...createDefaultState(),
        ...loaded,
        recentAlerts: Array.isArray(loaded.recentAlerts) ? loaded.recentAlerts.slice(-100) : [],
      };
    }
    return this.#state;
  }

  rotateEncryptionKey(newKey: string): void {
    this.#cipher = StorageCipher.fromSecret(newKey);
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
