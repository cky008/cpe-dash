import { CpeControlService } from "./cpe-controls.ts";
import type { HuaweiCpeClient } from "./cpe-client.ts";
import { type DeviceReport, buildDeviceReport } from "./device-profile.ts";
import { sanitizeDeviceReport } from "./sanitize.ts";
import { FENGSUI_VERSION } from "./version.ts";
import type { GlobalTelemetrySnapshot } from "./cpe-domain.ts";
import { CpeMonitor, type CpeMonitorOptions } from "./cpe-monitor.ts";
import { MutexSessionScheduler, type MutexSessionSchedulerOptions } from "./scheduler.ts";
import type { EncryptedStateStore } from "./state-store.ts";
import type { TimeSeriesRingBuffer } from "./timeseries.ts";

/**
 * The CPE-facing core shared by every adapter (REST, SSE, MCP, Telegram, SMS, alerts):
 * one scheduler (the only path to an admin session), the read side and the write side.
 *
 * Dependency direction: adapters → `monitor` / `controls` → `scheduler` → `HuaweiCpeClient`.
 */
export interface FengSuiCore {
  readonly stateStore: EncryptedStateStore;
  readonly scheduler: MutexSessionScheduler;
  readonly monitor: CpeMonitor;
  readonly controls: CpeControlService;
}

export interface FengSuiCoreOptions
  extends Omit<MutexSessionSchedulerOptions, "client" | "stateStore">,
    Omit<CpeMonitorOptions, "scheduler" | "stateStore" | "timeseries"> {
  client: HuaweiCpeClient;
  stateStore: EncryptedStateStore;
  timeseries: TimeSeriesRingBuffer;
}

export function createFengSuiCore(options: FengSuiCoreOptions): FengSuiCore {
  const { client, stateStore, timeseries } = options;
  const scheduler = new MutexSessionScheduler({
    client,
    stateStore,
    maxQueueDepth: options.maxQueueDepth,
    layer2InitialBackoffMs: options.layer2InitialBackoffMs,
    layer2MaxBackoffMs: options.layer2MaxBackoffMs,
    stopGraceMs: options.stopGraceMs,
    allowLegacyLoginAfterScram: options.allowLegacyLoginAfterScram,
  });
  const monitor = new CpeMonitor({
    scheduler,
    stateStore,
    timeseries,
    pollIntervalMs: options.pollIntervalMs,
    neighborScanIntervalMs: options.neighborScanIntervalMs,
    stateFlushIntervalMs: options.stateFlushIntervalMs,
    smsCountersEnabled: options.smsCountersEnabled,
  });
  const controls = new CpeControlService({ scheduler, monitor, stateStore });
  // A generic redial or reboot on a model nobody verified is checked by the polls that follow it
  monitor.on("telemetry", (snapshot: GlobalTelemetrySnapshot) => scheduler.notePollForWrites(snapshot));
  return { stateStore, scheduler, monitor, controls };
}

/** Stop polling, drain the in-flight session (`finally` logout) and flush encrypted state. */
export async function stopFengSuiCore(core: FengSuiCore): Promise<void> {
  core.monitor.stop();
  await core.scheduler.stop();
}

/**
 * The desensitized device report (structure only: endpoints, codes, read-backs, never a value from the
 * router), as Settings → Device and the agents' `get_device_report` hand it out to be shared.
 */
export function deviceReportOf(core: FengSuiCore): DeviceReport {
  return sanitizeDeviceReport(
    buildDeviceReport({
      probe: core.monitor.getDeviceProbe(),
      apiErrors: core.scheduler.apiErrorSnapshot(),
      fengsuiVersion: FENGSUI_VERSION,
      generatedAtIso: new Date().toISOString(),
      access: core.scheduler.device.snapshot(),
      writes: core.scheduler.genericWrites,
    })
  );
}
