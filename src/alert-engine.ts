import type { CpeControlService } from "./cpe-controls.ts";
import { type GlobalTelemetrySnapshot, verifyLockState } from "./cpe-domain.ts";
import type { CpeMonitor } from "./cpe-monitor.ts";
import { firmwareFingerprint, isVerifiedFirmware, verifiedFirmwareLabel } from "./firmware.ts";
import { type I18nKey, t } from "./i18n.ts";
import { sanitizeFreeText } from "./sanitize.ts";
import type { MutexSessionScheduler } from "./scheduler.ts";
import type { AlertEventRecord } from "./state-store.ts";

export interface AlertEngineOptions {
  scheduler: MutexSessionScheduler;
  /** Source of `telemetry` events. */
  monitor: CpeMonitor;
  /** Persisted lock state for the `LOCK_DRIFT` rule (rule disabled when absent). */
  controls?: Pick<CpeControlService, "getPersistedLockState">;
  /** Lock drift must persist this long before `LOCK_DRIFT` (default 2 min). */
  lockDriftAfterMs?: number;
  /** CPE transport failures must persist this long before `CPE_UNREACHABLE` (default 60 s). */
  unreachableAfterMs?: number;
  /** `ConnectionStatus != 901` must persist this long before `WAN_DOWN` (default 60 s). */
  wanDownAfterMs?: number;
  /** Primary-RAT degradation must persist this long before `SIGNAL_DEGRADED` (default 5 min). */
  signalDegradedAfterMs?: number;
  /** Good signal (with hysteresis) must persist this long before `SIGNAL_RECOVERED` (default 60 s). */
  signalRecoverAfterMs?: number;
  rsrpThresholdDbm?: number;
  sinrThresholdDb?: number;
  /** Component-carrier count must stay below the stable count this long before `CA_DROPPED` (default 5 min). */
  caDropAfterMs?: number;
  smsStorageWarnPercent?: number;
  evalIntervalMs?: number;
  now?: () => number;
}

const RSRP_RECOVERY_MARGIN_DB = 3;
const SINR_RECOVERY_MARGIN_DB = 2;
const STORAGE_REARM_MARGIN_PERCENT = 5;
const UPTIME_JITTER_SEC = 30;

const UNIT_BYTES: Readonly<Record<string, number>> = {
  KB: 1024,
  MB: 1024 ** 2,
  GB: 1024 ** 3,
  TB: 1024 ** 4,
};

/** Parse Huawei `start_date` `<DataLimit>` values such as `100GB` / `500MB`; `0` means no plan limit. */
export function parseDataLimitBytes(raw: string): number {
  const match = raw.trim().match(/^(\d+(?:\.\d+)?)\s*(KB|MB|GB|TB)$/i);
  if (!match?.[1] || !match[2]) return 0;
  return Number.parseFloat(match[1]) * (UNIT_BYTES[match[2].toUpperCase()] ?? 0);
}

/**
 * Condition that must hold for `holdMs` before firing once; `null` inputs leave the state untouched
 * (unknown readings or states such as "yielding" neither confirm nor clear a fault).
 */
class SustainedCondition {
  sinceMs: number | null = null;
  fired = false;

  update(active: boolean | null, nowMs: number, holdMs: number): "fire" | "clear" | null {
    if (active === null) return null;
    if (active) {
      this.sinceMs ??= nowMs;
      if (!this.fired && nowMs - this.sinceMs >= holdMs) {
        this.fired = true;
        return "fire";
      }
      return null;
    }
    this.sinceMs = null;
    if (this.fired) {
      this.fired = false;
      return "clear";
    }
    return null;
  }
}

type Params = Readonly<Record<string, string | number>>;

/**
 * Rule-based alerting over telemetry and scheduler health. Each rule needs its condition to be
 * sustained (with recovery hysteresis where noise is expected), fires once per episode, and is
 * delivered through `MutexSessionScheduler.raiseAlert` (encrypted history + SSE + notifiers).
 */
export class AlertEngine {
  readonly scheduler: MutexSessionScheduler;
  readonly monitor: CpeMonitor;
  readonly controls: Pick<CpeControlService, "getPersistedLockState"> | null;
  readonly lockDriftAfterMs: number;
  readonly unreachableAfterMs: number;
  readonly wanDownAfterMs: number;
  readonly signalDegradedAfterMs: number;
  readonly signalRecoverAfterMs: number;
  readonly rsrpThresholdDbm: number;
  readonly sinrThresholdDb: number;
  readonly caDropAfterMs: number;
  readonly smsStorageWarnPercent: number;
  readonly evalIntervalMs: number;
  readonly #now: () => number;

  #unreachable = new SustainedCondition();
  #wan = new SustainedCondition();
  #lockDrift = new SustainedCondition();
  #signalDegraded = false;
  #signalSinceMs: number | null = null;
  #caStable: number | null = null;
  #caLowSinceMs: number | null = null;
  #lastUptimeSec: number | null = null;
  #storageHighFired = false;
  #storageFullFired = false;
  #dataFired = false;
  #timer: ReturnType<typeof setInterval> | null = null;

  readonly #onTelemetry = (snap: GlobalTelemetrySnapshot): void => {
    this.ingestTelemetry(snap);
    this.evaluateSchedulerHealth();
  };

  constructor(opts: AlertEngineOptions) {
    this.scheduler = opts.scheduler;
    this.monitor = opts.monitor;
    this.controls = opts.controls ?? null;
    this.lockDriftAfterMs = opts.lockDriftAfterMs ?? 2 * 60_000;
    this.unreachableAfterMs = opts.unreachableAfterMs ?? 60_000;
    this.wanDownAfterMs = opts.wanDownAfterMs ?? 60_000;
    this.signalDegradedAfterMs = opts.signalDegradedAfterMs ?? 5 * 60_000;
    this.signalRecoverAfterMs = opts.signalRecoverAfterMs ?? 60_000;
    this.rsrpThresholdDbm = opts.rsrpThresholdDbm ?? -110;
    this.sinrThresholdDb = opts.sinrThresholdDb ?? 0;
    this.caDropAfterMs = opts.caDropAfterMs ?? 5 * 60_000;
    this.smsStorageWarnPercent = opts.smsStorageWarnPercent ?? 90;
    this.evalIntervalMs = Math.max(1000, opts.evalIntervalMs ?? 5000);
    this.#now = opts.now ?? Date.now;
  }

  start(): void {
    if (this.#timer) return;
    this.monitor.on("telemetry", this.#onTelemetry);
    this.#timer = setInterval(() => this.evaluateSchedulerHealth(), this.evalIntervalMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (!this.#timer) return;
    clearInterval(this.#timer);
    this.#timer = null;
    this.monitor.off("telemetry", this.#onTelemetry);
  }

  /** `CPE_UNREACHABLE` / `CPE_RECOVERED` from the scheduler mode (recovery only on a healthy session). */
  evaluateSchedulerHealth(nowMs = this.#now()): void {
    const status = this.scheduler.getStatus();
    const healthy = status.mode === "idle" || status.mode === "polling";
    const sinceMs = this.#unreachable.sinceMs;
    const action = this.#unreachable.update(
      status.mode === "cpe_unreachable" ? true : healthy ? false : null,
      nowMs,
      this.unreachableAfterMs
    );
    if (action === "fire") {
      const reason = sanitizeFreeText(status.lastError ?? "unknown").slice(0, 160);
      this.#raise("critical", "CPE_UNREACHABLE", "alerts.cpe_unreachable", {
        seconds: Math.round((nowMs - (this.#unreachable.sinceMs ?? nowMs)) / 1000),
        reason,
      });
    } else if (action === "clear") {
      this.#raise("info", "CPE_RECOVERED", "alerts.cpe_recovered", {
        seconds: Math.round((nowMs - (sinceMs ?? nowMs)) / 1000),
      });
    }
  }

  /** Evaluate every telemetry-driven rule against one snapshot (time = `capturedAtMs`). */
  ingestTelemetry(snap: GlobalTelemetrySnapshot): void {
    const nowMs = snap.capturedAtMs;
    this.#evaluateWan(snap, nowMs);
    this.#evaluateSignal(snap, nowMs);
    this.#evaluateCarrierAggregation(snap, nowMs);
    this.#evaluateReboot(snap);
    this.#evaluateSmsStorage(snap);
    this.#evaluateDataUsage(snap);
    this.#evaluateLockDrift(snap, nowMs);
    this.#evaluateFirmware(snap);
  }

  /**
   * `FIRMWARE_UNVERIFIED` once per model / firmware build the protocol was not verified on. Huawei
   * updates the firmware on its own, so this warns (persisted across restarts) instead of blocking.
   */
  #evaluateFirmware(snap: GlobalTelemetrySnapshot): void {
    const { deviceName, softwareVersion } = snap.device;
    if (!softwareVersion.trim()) return;
    const store = this.scheduler.stateStore;
    const notice = store.getState().firmwareNotice;
    if (isVerifiedFirmware(deviceName, softwareVersion)) {
      if (notice) store.update({ firmwareNotice: null });
      return;
    }
    const fingerprint = firmwareFingerprint(deviceName, softwareVersion);
    if (notice?.fingerprint === fingerprint) return;
    store.update({ firmwareNotice: { fingerprint, notifiedAtIso: snap.capturedAtIso } });
    this.#raise("warning", "FIRMWARE_UNVERIFIED", "alerts.firmware_unverified", {
      model: deviceName.trim(),
      version: softwareVersion.trim(),
      verified: verifiedFirmwareLabel(),
    });
  }

  /** `LOCK_DRIFT` when the router stops matching the applied lock; settling/unknown keep the state. */
  #evaluateLockDrift(snap: GlobalTelemetrySnapshot, nowMs: number): void {
    if (!this.controls) return;
    const verification = verifyLockState(this.controls.getPersistedLockState(), snap);
    const active = verification.status === "drift" ? true : verification.status === "consistent" ? false : null;
    const action = this.#lockDrift.update(active, nowMs, this.lockDriftAfterMs);
    if (action === "fire") {
      this.#raise("warning", "LOCK_DRIFT", "alerts.lock_drift", { issue: (verification.issues[0] ?? "").slice(0, 200) });
    } else if (action === "clear") {
      this.#raise("info", "LOCK_REALIGNED", "alerts.lock_realigned");
    }
  }

  #evaluateWan(snap: GlobalTelemetrySnapshot, nowMs: number): void {
    const status = snap.device.connectionStatus;
    const sinceMs = this.#wan.sinceMs;
    const action = this.#wan.update(status ? status !== "901" : null, nowMs, this.wanDownAfterMs);
    if (action === "fire") {
      this.#raise("warning", "WAN_DOWN", "alerts.wan_down", {
        seconds: Math.round((nowMs - (sinceMs ?? nowMs)) / 1000),
        status,
      });
    } else if (action === "clear") {
      this.#raise("info", "WAN_UP", "alerts.wan_up");
    }
  }

  #evaluateSignal(snap: GlobalTelemetrySnapshot, nowMs: number): void {
    const useNr = snap.rf.nrRsrpDbm !== null;
    const rsrp = useNr ? snap.rf.nrRsrpDbm : snap.rf.lteRsrpDbm;
    const sinr = useNr ? snap.rf.nrSinrDb : snap.rf.lteSinrDb;
    if (rsrp === null || sinr === null) return;

    const inTargetState = this.#signalDegraded
      ? rsrp >= this.rsrpThresholdDbm + RSRP_RECOVERY_MARGIN_DB && sinr >= this.sinrThresholdDb + SINR_RECOVERY_MARGIN_DB
      : rsrp < this.rsrpThresholdDbm || sinr < this.sinrThresholdDb;
    if (!inTargetState) {
      this.#signalSinceMs = null;
      return;
    }
    this.#signalSinceMs ??= nowMs;
    const holdMs = this.#signalDegraded ? this.signalRecoverAfterMs : this.signalDegradedAfterMs;
    if (nowMs - this.#signalSinceMs < holdMs) return;

    const params = { rat: useNr ? "5G NR" : "4G LTE", rsrp, sinr, minutes: Math.round(holdMs / 60_000) };
    if (this.#signalDegraded) {
      this.#raise("info", "SIGNAL_RECOVERED", "alerts.signal_recovered", params);
    } else {
      this.#raise("warning", "SIGNAL_DEGRADED", "alerts.signal_degraded", params);
    }
    this.#signalDegraded = !this.#signalDegraded;
    this.#signalSinceMs = null;
  }

  #evaluateCarrierAggregation(snap: GlobalTelemetrySnapshot, nowMs: number): void {
    const count = snap.rf.caComponentCount;
    if (count <= 0) return;
    if (this.#caStable === null || count >= this.#caStable) {
      this.#caStable = count;
      this.#caLowSinceMs = null;
      return;
    }
    this.#caLowSinceMs ??= nowMs;
    if (nowMs - this.#caLowSinceMs >= this.caDropAfterMs) {
      this.#raise("info", "CA_DROPPED", "alerts.ca_dropped", { from: this.#caStable, to: count });
      this.#caStable = count;
      this.#caLowSinceMs = null;
    }
  }

  #evaluateReboot(snap: GlobalTelemetrySnapshot): void {
    const uptime = snap.device.uptimeSec;
    if (uptime <= 0) return;
    if (this.#lastUptimeSec !== null && uptime + UPTIME_JITTER_SEC < this.#lastUptimeSec) {
      this.#raise("warning", "REBOOT_DETECTED", "alerts.reboot_detected", { uptime });
    }
    this.#lastUptimeSec = uptime;
  }

  #evaluateSmsStorage(snap: GlobalTelemetrySnapshot): void {
    const sms = snap.sms;
    if (!sms || sms.localMax <= 0) return;
    const used = sms.localInbox + sms.localOutbox + sms.localDraft;
    const percent = (used / sms.localMax) * 100;
    const params = { used, max: sms.localMax };
    if (percent >= 100) {
      if (!this.#storageFullFired) {
        this.#raise("critical", "SMS_STORAGE_FULL", "alerts.sms_storage_full", params);
        this.#storageFullFired = true;
        this.#storageHighFired = true;
      }
      return;
    }
    this.#storageFullFired = false;
    if (percent >= this.smsStorageWarnPercent) {
      if (!this.#storageHighFired) {
        this.#raise("warning", "SMS_STORAGE_HIGH", "alerts.sms_storage_high", params);
        this.#storageHighFired = true;
      }
    } else if (percent < this.smsStorageWarnPercent - STORAGE_REARM_MARGIN_PERCENT) {
      this.#storageHighFired = false;
    }
  }

  #evaluateDataUsage(snap: GlobalTelemetrySnapshot): void {
    const limit = parseDataLimitBytes(snap.traffic.dataLimitRaw);
    if (limit <= 0) return;
    const percent = snap.traffic.monthThresholdPercent ?? 90;
    const thresholdBytes = (limit * percent) / 100;
    if (snap.traffic.monthTotalBytes >= thresholdBytes) {
      if (!this.#dataFired) {
        this.#raise("warning", "DATA_THRESHOLD", "alerts.data_threshold", {
          used: snap.traffic.monthTotalFormatted,
          percent,
          limit: snap.traffic.dataLimitRaw.trim(),
        });
        this.#dataFired = true;
      }
    } else if (snap.traffic.monthTotalBytes < thresholdBytes / 2) {
      // Usage fell far below the threshold: a new billing month started
      this.#dataFired = false;
    }
  }

  #raise(severity: AlertEventRecord["severity"], code: string, key: I18nKey, params?: Params): void {
    this.scheduler.raiseAlert({
      severity,
      code,
      messageZh: t("zh-CN", key, params),
      messageEn: t("en", key, params),
    });
  }
}
