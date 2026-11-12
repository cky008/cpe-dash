import path from "node:path";
import { createFengSuiCore, stopFengSuiCore } from "../../src/core.ts";
import { HuaweiCpeClient } from "../../src/cpe-client.ts";
import type { LinkChangeNotice } from "../../src/cpe-controls.ts";
import type { WriteCheck } from "../../src/device-access.ts";
import type { RouterFamily } from "../../src/router-family.ts";
import type { ControlAppliedEvent, ControlAuditEvent } from "../../src/scheduler.ts";
import { EncryptedStateStore } from "../../src/state-store.ts";
import { TimeSeriesRingBuffer } from "../../src/timeseries.ts";
import { removeTempDir, tempDir } from "./temp-dir.ts";

/** A write's record as a session starts it. */
export function newCheck(): WriteCheck {
  return { endpoints: [], readback: "none", reason: null };
}

/** Waits that take no time (the drivers' sleeps are injected). */
export const noWait = { sleep: (): Promise<void> => Promise.resolve() };

/**
 * A daemon core on a mock router of any brand: its writes audited and broadcast, and the changes it
 * hands to self-healing collected. Nothing here talks to a real router.
 */
export function daemonOn(family: RouterFamily, fetchImpl: typeof fetch, url: string, password: string, username = "") {
  const dir = tempDir("fengsui-driver-daemon-");
  const core = createFengSuiCore({
    client: new HuaweiCpeClient({ cpeUrl: url, cpeUsername: username, cpePassword: password, fetchImpl, requestTimeoutMs: 2000 }),
    stateStore: new EncryptedStateStore({ filePath: path.join(dir, "state.json"), encryptionKey: "driver_daemon_key" }),
    timeseries: new TimeSeriesRingBuffer({ retentionHours: 1 }),
    family,
    pollIntervalMs: 600_000,
    neighborScanIntervalMs: 600_000,
  });
  core.monitor.init();
  const audits: ControlAuditEvent[] = [];
  const applied: ControlAppliedEvent[] = [];
  const linkChanges: LinkChangeNotice[] = [];
  core.scheduler.on("control:audit", (event: ControlAuditEvent) => audits.push(event));
  core.scheduler.on("control:applied", (event: ControlAppliedEvent) => applied.push(event));
  core.controls.onLinkChange = (notice) => linkChanges.push(notice);
  return {
    core,
    audits,
    applied,
    linkChanges,
    /** Everything a write left behind that a person or a log could read: summaries, audit details, the write records. */
    trail: (): string => JSON.stringify([audits, applied, core.scheduler.genericWrites, core.scheduler.getStatus()]),
    cleanup: async (): Promise<void> => {
      await stopFengSuiCore(core);
      removeTempDir(dir);
    },
  };
}
