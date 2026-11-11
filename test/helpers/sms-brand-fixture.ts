import path from "node:path";
import { createFengSuiCore, stopFengSuiCore } from "../../src/core.ts";
import { HuaweiCpeClient } from "../../src/cpe-client.ts";
import { StorageCipher } from "../../src/encrypted-file.ts";
import type { RouterFamily } from "../../src/router-family.ts";
import type { ControlAppliedEvent } from "../../src/scheduler.ts";
import { ContactBook } from "../../src/sms/contacts.ts";
import { SmsMirrorStore } from "../../src/sms/mirror.ts";
import { SmsService, type SmsServiceOptions } from "../../src/sms/service.ts";
import { EncryptedStateStore } from "../../src/state-store.ts";
import { TimeSeriesRingBuffer } from "../../src/timeseries.ts";
import type { DriverSession, DriverSms } from "../../src/drivers/types.ts";
import { removeTempDir, tempDir } from "./temp-dir.ts";

/** The SMS methods of a driver session that must have them. */
export function smsOf(session: DriverSession): DriverSms {
  if (!session.sms) throw new Error("this session has no SMS");
  return session.sms;
}

/** The same, for a family whose interface sends, marks read and deletes. */
export function smsWritesOf(session: DriverSession): Required<DriverSms> {
  const sms = smsOf(session);
  if (!sms.send || !sms.markRead || !sms.delete) throw new Error("this session lacks an SMS write");
  return sms as Required<DriverSms>;
}

/**
 * The whole SMS stack (scheduler, monitor, mirror, contacts, service) on a mock router of any brand:
 * what REST, MCP, Telegram and the alerts stand on. The connection goes through the scheduler like
 * the daemon's, so sessions queue, yield and log out as they do there.
 */
export function createBrandSmsFixture(opts: {
  family: RouterFamily;
  cpeUrl: string;
  username?: string;
  password: string;
  fetchImpl: typeof fetch;
  /** The model the gate goes by before any poll (`null`: left to the first session). */
  model?: string | null;
  service?: Partial<SmsServiceOptions>;
}) {
  const tmpDir = tempDir("fengsui-sms-brand-");
  const stateStore = new EncryptedStateStore({ filePath: path.join(tmpDir, "state.json"), encryptionKey: "brand_key" });
  const client = new HuaweiCpeClient({ cpeUrl: opts.cpeUrl, cpeUsername: opts.username ?? "admin", cpePassword: opts.password, fetchImpl: opts.fetchImpl, requestTimeoutMs: 2000 });
  const core = createFengSuiCore({
    client,
    stateStore,
    timeseries: new TimeSeriesRingBuffer({ retentionHours: 24 }),
    family: opts.family,
    pollIntervalMs: 600_000,
    neighborScanIntervalMs: 600_000,
    smsCountersEnabled: true,
  });
  core.monitor.init();
  if (opts.model !== null && opts.model !== undefined) core.scheduler.device.see(opts.model, "1.0");
  const cipher = StorageCipher.fromSecret("brand_key");
  const contacts = new ContactBook({ filePath: path.join(tmpDir, "contacts.json"), cipher, defaultCountryCode: "+353" });
  const mirror = new SmsMirrorStore({ filePath: path.join(tmpDir, "sms.json"), cipher, defaultCountryCode: "+353", contacts });
  const service = new SmsService({
    scheduler: core.scheduler,
    monitor: core.monitor,
    mirror,
    contacts,
    defaultCountryCode: "+353",
    sleep: async () => undefined,
    sendStatusTimeoutMs: 3000,
    ...opts.service,
  });
  const events: Array<{ name: string; payload: unknown }> = [];
  for (const name of ["sms:new", "sms:sent", "sms:updated", "sms:sync", "sms:status"]) service.on(name, (payload: unknown) => events.push({ name, payload }));
  const controls: ControlAppliedEvent[] = [];
  core.scheduler.on("control:applied", (ev: ControlAppliedEvent) => controls.push(ev));
  const cleanup = async (): Promise<void> => {
    await service.stop();
    await stopFengSuiCore(core);
    removeTempDir(tmpDir);
  };
  const named = (name: string): unknown[] => events.filter((e) => e.name === name).map((e) => e.payload);
  return { core, scheduler: core.scheduler, service, mirror, contacts, events, named, controls, cleanup };
}
