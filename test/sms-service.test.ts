import assert from "node:assert/strict";
import { createFengSuiCore, stopFengSuiCore } from "../src/core.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { HuaweiCpeClient } from "../src/cpe-client.ts";
import { CpeControlValidationError, type GlobalTelemetrySnapshot } from "../src/cpe-domain.ts";
import { StorageCipher } from "../src/encrypted-file.ts";
import type { ControlAppliedEvent } from "../src/scheduler.ts";
import { ContactBook } from "../src/sms/contacts.ts";
import { SmsMirrorStore } from "../src/sms/mirror.ts";
import { MAX_DELETE_BATCH, SmsService, type SmsServiceOptions } from "../src/sms/service.ts";
import type { EnrichedSmsMessage } from "../src/sms/types.ts";
import { EncryptedStateStore } from "../src/state-store.ts";
import { TimeSeriesRingBuffer } from "../src/timeseries.ts";
import { type MockSms, type MockSmsCpeOptions, createMockSmsCpe } from "./helpers/mock-sms-cpe.ts";

const HUMAN_LOGGED_IN = "<response><State>0</State><lockstatus>0</lockstatus><remainwaittime>0</remainwaittime></response>";

function seed(): MockSms[] {
  return [
    { index: 40001, phone: "Three", content: "Welcome to Three 5G", date: "2026-10-27 21:00:00", smstat: "1", box: 1 },
    { index: 40002, phone: "+353830000001", content: "Dinner at 7?", date: "2026-10-28 18:00:00", smstat: "0", box: 1 },
    { index: 40003, phone: "+353830000001", content: "Sure", date: "2026-10-28 18:05:00", smstat: "3", box: 2 },
  ];
}

function createSmsFixture(
  opts: {
    mock?: MockSmsCpeOptions;
    service?: Partial<SmsServiceOptions>;
    smsCountersEnabled?: boolean;
  } = {}
) {
  const mock = createMockSmsCpe({ messages: seed(), ...opts.mock });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fengsui-sms-svc-"));
  const stateStore = new EncryptedStateStore({ filePath: path.join(tmpDir, "state.json"), encryptionKey: "svc_key" });
  const client = new HuaweiCpeClient({ cpeUrl: "http://192.168.8.1", cpePassword: mock.password, fetchImpl: mock.fetchImpl });
  const core = createFengSuiCore({
    client,
    stateStore,
    timeseries: new TimeSeriesRingBuffer({ retentionHours: 24 }),
    pollIntervalMs: 60_000,
    neighborScanIntervalMs: 120_000,
    smsCountersEnabled: opts.smsCountersEnabled ?? true,
  });
  const scheduler = core.scheduler;
  core.monitor.init();
  const cipher = StorageCipher.fromSecret("svc_key");
  const contacts = new ContactBook({ filePath: path.join(tmpDir, "contacts.json"), cipher, defaultCountryCode: "+353" });
  const mirror = new SmsMirrorStore({ filePath: path.join(tmpDir, "sms.json"), cipher, defaultCountryCode: "+353", contacts });
  const service = new SmsService({
    scheduler,
    monitor: core.monitor,
    mirror,
    contacts,
    defaultCountryCode: "+353",
    sleep: async () => undefined,
    ...opts.service,
  });
  const events: Array<{ name: string; payload: unknown }> = [];
  for (const name of ["sms:new", "sms:sent", "sms:updated", "sms:sync", "sms:status", "contacts:updated"]) {
    service.on(name, (payload: unknown) => events.push({ name, payload }));
  }
  const controls: ControlAppliedEvent[] = [];
  scheduler.on("control:applied", (ev: ControlAppliedEvent) => controls.push(ev));
  const smsRequests = (needle: string) => mock.requests.filter((r) => r.path.includes(needle)).length;
  const cleanup = async (): Promise<void> => {
    await service.stop();
    await stopFengSuiCore(core);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  };
  return { mock, core, scheduler, service, mirror, contacts, events, controls, smsRequests, cleanup };
}

const named = (events: Array<{ name: string; payload: unknown }>, name: string) =>
  events.filter((e) => e.name === name).map((e) => e.payload);

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("Telemetry piggyback of SMS counters", () => {
  it("adds sms-count to the existing telemetry session only when enabled", async () => {
    const enabled = createSmsFixture();
    const before = enabled.mock.getLoginCount();
    const snap = await enabled.core.monitor.refreshTelemetry();
    assert.deepEqual(snap?.sms, { localUnread: 1, localInbox: 2, localOutbox: 1, localDraft: 0, localMax: 500 });
    assert.equal(enabled.mock.getLoginCount(), before + 1);
    await enabled.cleanup();

    const disabled = createSmsFixture({ smsCountersEnabled: false });
    const plain = await disabled.core.monitor.refreshTelemetry();
    assert.equal(plain?.sms, null);
    assert.equal(disabled.smsRequests("/api/sms/sms-count"), 0);
    await disabled.cleanup();
  });
});

describe("SmsService sync, change detection and notifications", () => {
  it("seeds history on the first full sync, then announces new SMS detected via telemetry counters", async () => {
    const fx = createSmsFixture();
    fx.contacts.upsert({ phone: "0830000001", name: "Aoife" });
    fx.service.start();
    const seeded = await fx.service.sync("full");
    assert.equal(seeded?.mode, "full");
    assert.equal(seeded?.added, 3);
    assert.equal(seeded?.newIncoming, 0);
    assert.equal(named(fx.events, "sms:new").length, 0);
    assert.equal(fx.service.getStatus().seeded, true);
    assert.equal(fx.mirror.size, 3);

    // Unchanged counters on the next telemetry tick do not queue a sync
    const listCallsBefore = fx.smsRequests("/api/sms/sms-list");
    await fx.core.monitor.refreshTelemetry();
    assert.equal(fx.service.getStatus().syncInProgress, false);
    assert.equal(fx.smsRequests("/api/sms/sms-list"), listCallsBefore);

    fx.mock.pushIncoming({ phone: "0830000001", content: "Your verification code is 482913", date: "2026-10-30 09:00:00" });
    await fx.core.monitor.refreshTelemetry();
    const incremental = await fx.service.sync("incremental");
    assert.equal(incremental?.mode, "incremental");
    assert.equal(incremental?.newIncoming, 1);
    const announced = named(fx.events, "sms:new") as EnrichedSmsMessage[];
    assert.equal(announced.length, 1);
    assert.equal(announced[0]?.verificationCode, "482913");
    assert.equal(announced[0]?.contact?.name, "Aoife");
    assert.equal(announced[0]?.threadKey, "+353830000001");

    // A second identical sync never re-announces
    await fx.service.sync("full");
    assert.equal(named(fx.events, "sms:new").length, 1);
    await fx.cleanup();
  });

  it("reconciles deletions made elsewhere with a full sync when counters shrink", async () => {
    const fx = createSmsFixture();
    await fx.service.sync("full");
    fx.service.start();
    await fx.service.sync("full");
    fx.mock.store.splice(fx.mock.store.findIndex((m) => m.index === 40001), 1);
    await fx.core.monitor.refreshTelemetry();
    const summary = await fx.service.sync("full");
    assert.equal(summary?.removed, 1);
    assert.equal(fx.mirror.size, 2);
    await fx.cleanup();
  });

  it("keeps the unread badge live via the unauthenticated probe while yielding, then syncs after the human leaves", async () => {
    const fx = createSmsFixture();
    await fx.service.sync("full");
    fx.service.start();
    await fx.service.sync("full");
    fx.mock.control.stateLoginXml = () => HUMAN_LOGGED_IN;
    fx.mock.pushIncoming({ phone: "+353830000002", content: "Are you home?", date: "2026-10-30 10:00:00" });
    assert.equal(await fx.core.monitor.refreshTelemetry(), null);
    assert.equal(await fx.service.sync("incremental"), null);

    const loginsWhileYielding = fx.mock.getLoginCount();
    await fx.service.pollWhileYielding();
    const status = fx.service.getStatus();
    assert.equal(status.unreadOnCpe, 2);
    assert.equal(status.syncPending, true);
    assert.equal(fx.mock.getLoginCount(), loginsWhileYielding);

    fx.mock.control.stateLoginXml = undefined;
    await fx.core.monitor.refreshTelemetry();
    await fx.service.sync("incremental");
    assert.equal(named(fx.events, "sms:new").length, 1);
    assert.equal(fx.service.getStatus().syncPending, false);
    // Probe is a no-op when not yielding
    const requestsBefore = fx.mock.requests.length;
    await fx.service.pollWhileYielding();
    assert.equal(fx.mock.requests.length, requestsBefore);
    await fx.cleanup();
  });

  it("announces existing unread messages on first sync when seeding is disabled, and auto-marks them read", async () => {
    const fx = createSmsFixture({ service: { seedExistingOnStart: false, autoMarkRead: true } });
    const summary = await fx.service.sync("full");
    assert.equal(summary?.newIncoming, 1);
    assert.equal((named(fx.events, "sms:new")[0] as EnrichedSmsMessage).index, 40002);
    await waitFor(() => fx.mock.setReadBatches.length > 0);
    assert.deepEqual(fx.mock.setReadBatches[0], [40002]);
    await waitFor(() => named(fx.events, "sms:updated").length > 0);
    assert.equal(fx.mirror.stats().unreadTotal, 0);
    await fx.cleanup();
  });

  it("backs off after a failed sync and coalesces concurrent sync requests", async () => {
    let failCounts = true;
    const fx = createSmsFixture({
      mock: {
        intercept: (p) => {
          if (p === "/api/sms/sms-count" && failCounts) throw new TypeError("fetch failed");
          return undefined;
        },
      },
    });
    await assert.rejects(() => fx.service.sync("full"), /fetch failed/);
    const requestsAfterFailure = fx.mock.requests.length;
    fx.service.observeCounters({ localUnread: 9, localInbox: 9, localOutbox: 0, localDraft: 0, localMax: 500 });
    assert.equal(fx.service.getStatus().syncInProgress, false);
    assert.equal(fx.mock.requests.length, requestsAfterFailure);

    failCounts = false;
    const [a, b, c] = await Promise.all([fx.service.sync("full"), fx.service.sync("full"), fx.service.sync("incremental")]);
    assert.ok(a);
    assert.equal(a, b);
    assert.equal(a, c);

    // A full request during an incremental sync is chained after it
    const incremental = fx.service.sync("incremental");
    const chainedFull = fx.service.sync("full");
    assert.equal((await incremental)?.mode, "incremental");
    assert.equal((await chainedFull)?.mode, "full");
    await fx.cleanup();
  });

  it("stops listening to telemetry and flushes the stores on stop()", async () => {
    const fx = createSmsFixture();
    fx.service.start();
    await fx.service.sync("full");
    await fx.service.stop();
    fx.scheduler.emit("telemetry", {
      sms: { localUnread: 5, localInbox: 5, localOutbox: 5, localDraft: 0, localMax: 500 },
    } as unknown as GlobalTelemetrySnapshot);
    assert.equal(fx.service.getStatus().syncInProgress, false);
    await fx.cleanup();
  });
});

describe("SmsService writes: send, mark read, delete and contacts", () => {
  it("sends with E.164 resolution, reads the router copy back and records it in the mirror", async () => {
    const fx = createSmsFixture();
    await fx.service.sync("full");
    const outcome = await fx.service.send({ phones: ["083 000 0001"], content: " Hello there ", source: "web" });
    assert.deepEqual(outcome.resolvedPhones, ["+353830000001"]);
    assert.equal(outcome.result.ok, true);
    assert.equal(outcome.messages.length, 1);
    assert.equal(outcome.messages[0]?.pending, undefined);
    assert.ok((outcome.messages[0]?.index ?? 0) > 40003);
    assert.equal(outcome.messages[0]?.content, "Hello there");
    assert.equal(fx.mirror.size, 4);
    const sent = named(fx.events, "sms:sent")[0] as { source: string; messages: EnrichedSmsMessage[] };
    assert.equal(sent.source, "web");
    const control = fx.controls.find((c) => c.action === "sms_send");
    assert.match(control?.summaryEn ?? "", /\+353\*+01/);
    assert.doesNotMatch(control?.summaryEn ?? "", /353830000001/);
    assert.equal(fx.service.knowsRecipient("0830000001"), true);
    await fx.cleanup();
  });

  it("falls back to a provisional record when read-back fails, replaced by the next full sync", async () => {
    const fx = createSmsFixture({
      mock: {
        intercept: (p, method) =>
          p === "/api/sms/sms-count-contact" && method === "POST" ? "<error><code>100003</code></error>" : undefined,
      },
    });
    await fx.service.sync("full");
    const outcome = await fx.service.send({ phones: ["+353830000009"], content: "Ping", source: "telegram" });
    assert.equal(outcome.messages[0]?.pending, true);
    assert.equal(fx.service.knowsRecipient("+353830000009"), false);
    const summary = await fx.service.sync("full");
    assert.ok((summary?.removed ?? 0) >= 1);
    const thread = fx.service.getThread("+353830000009");
    assert.equal(thread.messages.length, 1);
    assert.equal(thread.messages[0]?.pending, undefined);
    assert.equal(fx.service.knowsRecipient("+353830000009"), true);
    await fx.cleanup();
  });

  it("reports router send failures without touching the mirror, and validates before queueing", async () => {
    const fx = createSmsFixture({ mock: { sendOutcome: "fail", pendingStatusPolls: 0 } });
    await fx.service.sync("full");
    const failed = await fx.service.send({ phones: ["+353830000001"], content: "x", source: "mcp" });
    assert.equal(failed.result.ok, false);
    assert.deepEqual(failed.messages, []);
    assert.equal(fx.mirror.size, 3);
    assert.match(fx.controls.find((c) => c.action === "sms_send")?.summaryEn ?? "", /failed \(code 113018\)/);

    const logins = fx.mock.getLoginCount();
    await assert.rejects(() => fx.service.send({ phones: ["abc"], content: "x", source: "web" }), CpeControlValidationError);
    await assert.rejects(() => fx.service.send({ phones: ["+353830000001"], content: "好".repeat(400), source: "web" }), /4 segments/);
    assert.equal(fx.mock.getLoginCount(), logins);
    await fx.cleanup();
  });

  it("reports an accepted send as submitted-but-unconfirmed when send-status polling fails, never as an error", async () => {
    for (const statusFault of ["transport", "cpe-error"] as const) {
      let failStatus = true;
      const fx = createSmsFixture({
        mock: {
          intercept: (p) => {
            if (p !== "/api/sms/send-status" || !failStatus) return undefined;
            if (statusFault === "transport") throw new TypeError("fetch failed (socket hang up)");
            return "<error><code>125002</code><message></message></error>";
          },
        },
      });
      await fx.service.sync("full");
      const outcome = await fx.service.send({ phones: ["+353830000001"], content: "Accepted then lost", source: "web" });
      assert.equal(outcome.result.ok, true, statusFault);
      assert.equal(outcome.result.submitted, true);
      assert.equal(outcome.result.timedOutWaitingStatus, true, "delivery status is reported as unconfirmed");
      assert.deepEqual(outcome.result.failedPhones, []);
      assert.equal(fx.mock.sentRequests.length, 1, "the router received exactly one send-sms");
      assert.equal(fx.mock.store.filter((m) => m.box === 2 && m.content === "Accepted then lost").length, 1);
      failStatus = false;
      await fx.cleanup();
    }
  });

  it("marks threads or uids read on the router and skips the session when nothing is unread", async () => {
    const fx = createSmsFixture();
    await fx.service.sync("full");
    const result = await fx.service.markRead({ threadKey: "0830000001" });
    assert.equal(result.count, 1);
    assert.deepEqual(fx.mock.setReadBatches, [[40002]]);
    assert.equal(fx.mirror.stats().unreadTotal, 0);
    assert.deepEqual((named(fx.events, "sms:updated")[0] as { action: string }).action, "read");

    const logins = fx.mock.getLoginCount();
    assert.deepEqual(await fx.service.markRead({ threadKey: "+353830000001" }), { count: 0, uids: [] });
    assert.equal(fx.mock.getLoginCount(), logins);
    await assert.rejects(() => fx.service.markRead({}), CpeControlValidationError);
    await assert.rejects(() => fx.service.markRead({ uids: Array.from({ length: 201 }, (_, i) => `u${i}`) }), /200/);
    await fx.cleanup();
  });

  it("deletes known uids from the router, rejects unknown or oversized batches before any session", async () => {
    const fx = createSmsFixture({
      mock: { intercept: (p, method) => (p === "/api/sms/sms-count-contact" && method === "POST" ? "<error><code>100003</code></error>" : undefined) },
    });
    await fx.service.sync("full");
    const logins = fx.mock.getLoginCount();
    await assert.rejects(() => fx.service.deleteMessages({ uids: ["nope"] }), /Unknown message uid/);
    await assert.rejects(() => fx.service.deleteMessages({ uids: [] }), CpeControlValidationError);
    await assert.rejects(
      () => fx.service.deleteMessages({ uids: Array.from({ length: MAX_DELETE_BATCH + 1 }, (_, i) => `u${i}`) }),
      /at most 50/
    );
    assert.equal(fx.mock.getLoginCount(), logins);

    const brand = fx.service.getThread("alpha:three").messages[0]!;
    const deleted = await fx.service.deleteMessages({ uids: [brand.uid] });
    assert.deepEqual(deleted, { deleted: 1, uids: [brand.uid] });
    assert.deepEqual(fx.mock.deleteBatches, [[40001]]);

    // Provisional records are dropped locally without a CPE session
    const pending = await fx.service.send({ phones: ["+353830000007"], content: "draft", source: "web" });
    const sessions = fx.mock.getLoginCount();
    await fx.service.deleteMessages({ uids: [pending.messages[0]!.uid] });
    assert.equal(fx.mock.getLoginCount(), sessions);
    assert.equal(fx.mock.deleteBatches.length, 1);
    await fx.cleanup();
  });

  it("exposes previews, countries, status and contact mutations with contacts:updated events", async () => {
    const fx = createSmsFixture({ mock: { smsMax: 4 } });
    await fx.service.sync("full");
    const preview = fx.service.previewSend({ phone: "0830000001", content: "你好" });
    assert.equal(preview.recipient?.ok, true);
    assert.equal(preview.encoding.encoding, "UCS2");
    assert.equal(preview.withinLimit, true);
    assert.equal(fx.service.previewSend({ content: "x".repeat(700) }).withinLimit, false);
    assert.equal(fx.service.previewSend({ content: "hi" }).recipient, null);
    assert.equal(fx.service.countries().length, 54);

    const status = fx.service.getStatus();
    assert.equal(status.storageUsedPercent, 75);
    assert.equal(status.storageFull, false);
    assert.equal(status.mirror.threadsTotal, 2);

    const contact = fx.service.upsertContact({ phone: "0830000002", name: "Brian" });
    assert.equal(fx.service.listContacts("brian")[0]?.id, contact.id);
    assert.equal(fx.service.knowsRecipient("+353830000002"), true);
    assert.equal(fx.service.removeContact(contact.id), true);
    assert.equal(fx.service.removeContact(contact.id), false);
    assert.deepEqual(fx.service.importVcard("BEGIN:VCARD\nFN:Cara\nTEL:0830000003\nEND:VCARD"), {
      parsed: 1,
      added: 1,
      updated: 0,
      total: 1,
    });
    assert.equal(named(fx.events, "contacts:updated").length, 3);
    assert.equal(fx.service.listThreads({ filter: "unread" }).length, 1);
    fx.service.rotateEncryptionKey("svc_key_2");
    await fx.cleanup();
  });
});
