import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HuaweiCpeClient, type EphemeralCpeSession } from "../src/protocols/hilink/client.ts";
import { CpeControlValidationError } from "../src/cpe-domain.ts";
import { checkSmsNotifications, deleteSmsByIndex, fetchAllMessages, fetchPhoneThread, fetchRecentMessages, markSmsRead, readSmsCounters, submitSms } from "../src/sms/protocol.ts";
import { parseSmsCounters } from "../src/protocols/hilink/sms.ts";
import { MAX_SMS_RECIPIENTS, prepareSmsSubmission } from "../src/sms/submission.ts";
import { getXmlTag } from "../src/protocols/hilink/xml.ts";
import { createMockSmsCpe, type MockSms } from "./helpers/mock-sms-cpe.ts";

const noSleep = async (): Promise<void> => undefined;

function seedMessages(): MockSms[] {
  return [
    { index: 40001, phone: "Three", content: "Welcome to Three 5G", date: "2026-10-27 21:00:00", smstat: "1", box: 1 },
    { index: 40002, phone: "+353830000001", content: "Dinner at 7? (bring wine & cheese)", date: "2026-10-28 18:00:00", smstat: "0", box: 1 },
    { index: 40003, phone: "+353830000001", content: "Sure, see you", date: "2026-10-28 18:05:00", smstat: "3", box: 2 },
    { index: 40004, phone: "DemoBank", content: "Your verification code is 482913", date: "2026-10-29 09:00:00", smstat: "0", box: 1 },
  ];
}

async function inSession<T>(
  mock: ReturnType<typeof createMockSmsCpe>,
  fn: (session: EphemeralCpeSession) => Promise<T>
): Promise<T> {
  const client = new HuaweiCpeClient({ cpeUrl: "http://192.168.8.1", cpePassword: mock.password, fetchImpl: mock.fetchImpl });
  const value = await client.withSession(fn);
  assert.notEqual(value, null);
  return value as T;
}

describe("SMS protocol: counters, listings and encrypted fallbacks", () => {
  it("parses sms-count counters with safe defaults", async () => {
    assert.deepEqual(parseSmsCounters(""), { localUnread: 0, localInbox: 0, localOutbox: 0, localDraft: 0, localMax: 500 });
    const mock = createMockSmsCpe({ messages: seedMessages(), smsMax: 300 });
    const counters = await inSession(mock, (s) => readSmsCounters(s));
    assert.deepEqual(counters, { localUnread: 2, localInbox: 3, localOutbox: 1, localDraft: 0, localMax: 300 });
  });

  it("reads the unauthenticated check-notifications probe without opening a session", async () => {
    const mock = createMockSmsCpe({ messages: seedMessages(), storageFull: true });
    const client = new HuaweiCpeClient({ cpeUrl: "http://192.168.8.1", cpePassword: mock.password, fetchImpl: mock.fetchImpl });
    const probe = { probePublic: (apiPath: string) => client.getPublic(apiPath) };
    assert.deepEqual(await checkSmsNotifications(probe), { unreadMessages: 2, storageFull: true });
    assert.equal(mock.getLoginCount(), 0);
  });

  it("fetches the newest inbox page through plain sms-list", async () => {
    const mock = createMockSmsCpe({ messages: seedMessages() });
    const result = await inSession(mock, (s) => fetchRecentMessages(s, { count: 2 }));
    assert.equal(result.via, "sms-list");
    assert.deepEqual(result.messages.map((m) => m.index), [40004, 40002]);
    assert.ok(result.messages.every((m) => m.direction === "in"));
    assert.equal(result.messages[1]?.content, "Dinner at 7? (bring wine & cheese)");
    assert.equal(result.counters.localUnread, 2);
  });

  it("falls back to encrypted contact + phone listings when sms-list is unsupported (100002)", async () => {
    const mock = createMockSmsCpe({ messages: seedMessages(), smsListUnsupported: true });
    const expanded: string[] = [];
    const result = await inSession(mock, (s) =>
      fetchRecentMessages(s, {
        count: 20,
        expandThread: (latest) => {
          expanded.push(latest.phone);
          return latest.phone === "+353830000001";
        },
      })
    );
    assert.equal(result.via, "contact-list");
    assert.deepEqual(expanded.sort(), ["+353830000001", "DemoBank", "Three"]);
    // Expanded thread returns both directions; others contribute only their latest message
    const byIndex = new Map(result.messages.map((m) => [m.index, m]));
    assert.deepEqual([...byIndex.keys()].sort(), [40001, 40002, 40003, 40004]);
    assert.equal(byIndex.get(40003)?.direction, "out");
    assert.equal(byIndex.get(40002)?.content, "Dinner at 7? (bring wine & cheese)");
    assert.ok(mock.requests.some((r) => r.path === "/api/sms/sms-list-phone" && r.encType === "3"));
    assert.ok(mock.requests.some((r) => r.path === "/api/sms/sms-list-contact" && r.encType === "1"));
  });

  it("paginates every inbox and outbox page through sms-list for a full sync", async () => {
    const many: MockSms[] = [];
    for (let i = 0; i < 61; i++) {
      many.push({
        index: 41000 + i,
        phone: `+3538300000${String(i % 10).padStart(2, "0")}`,
        content: `Inbox ${i}`,
        date: `2026-10-29 ${String(10 + Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00`,
        smstat: "1",
        box: 1,
      });
    }
    many.push({ index: 42000, phone: "+353830000001", content: "Out 1", date: "2026-10-29 12:00:00", smstat: "3", box: 2 });
    const mock = createMockSmsCpe({ messages: many });
    const result = await inSession(mock, (s) => fetchAllMessages(s));
    assert.equal(result.via, "sms-list");
    assert.equal(result.messages.length, 62);
    assert.equal(new Set(result.messages.map((m) => m.index)).size, 62);
    assert.equal(result.messages.filter((m) => m.direction === "out").length, 1);
    assert.equal(mock.requests.filter((r) => r.path === "/api/sms/sms-list").length, 3);
  });

  it("rebuilds a full sync from encrypted per-phone listings without duplicating partial sms-list results", async () => {
    const mock = createMockSmsCpe({ messages: seedMessages() });
    let listCalls = 0;
    const flaky = createMockSmsCpe({
      messages: seedMessages(),
      intercept: (p) => {
        if (p === "/api/sms/sms-list" && ++listCalls === 2) return "<error><code>100002</code></error>";
        return undefined;
      },
    });
    const viaContacts = await inSession(flaky, (s) => fetchAllMessages(s));
    assert.equal(viaContacts.via, "contact-list");
    assert.equal(viaContacts.messages.length, 4);
    assert.equal(new Set(viaContacts.messages.map((m) => m.index)).size, 4);
    // Healthy router: same content via plain listing
    const viaList = await inSession(mock, (s) => fetchAllMessages(s));
    assert.deepEqual(
      viaList.messages.map((m) => m.index).sort(),
      viaContacts.messages.map((m) => m.index).sort()
    );
  });

  it("does not mask transport failures as an unsupported sms-list", async () => {
    const mock = createMockSmsCpe({
      messages: seedMessages(),
      intercept: (p) => {
        if (p === "/api/sms/sms-list") throw new TypeError("fetch failed");
        return undefined;
      },
    });
    const client = new HuaweiCpeClient({ cpeUrl: "http://192.168.8.1", cpePassword: mock.password, fetchImpl: mock.fetchImpl });
    await assert.rejects(() => client.withSession((s) => fetchRecentMessages(s)), /fetch failed/);
    assert.equal(mock.requests.some((r) => r.path === "/api/sms/sms-list-contact"), false);
  });

  it("reads back a single phone thread and short-circuits empty threads", async () => {
    const mock = createMockSmsCpe({ messages: seedMessages() });
    const thread = await inSession(mock, (s) => fetchPhoneThread(s, "+353830000001", 10));
    assert.deepEqual(thread.map((m) => m.index), [40003, 40002]);
    const none = await inSession(mock, (s) => fetchPhoneThread(s, "+353830000099"));
    assert.deepEqual(none, []);
  });
});

describe("SMS protocol: send, status polling, read and delete", () => {
  it("validates recipients and content before any CPE traffic", () => {
    assert.throws(() => prepareSmsSubmission([], "hi"), CpeControlValidationError);
    assert.throws(() => prepareSmsSubmission(["not-a-number"], "hi"), /dialable/);
    assert.throws(
      () => prepareSmsSubmission(Array.from({ length: MAX_SMS_RECIPIENTS + 1 }, (_, i) => `+35383000000${i}`), "hi"),
      /at most 5/
    );
    assert.throws(() => prepareSmsSubmission(["+353830000001"], " \u0001 "), /empty/);
    assert.throws(() => prepareSmsSubmission(["+353830000001"], "好".repeat(300)), /4 segments/);
    const ok = prepareSmsSubmission([" +353 83 000 0001 ", "+353830000001"], " Hello\u0002 ");
    assert.deepEqual(ok.phones, ["+353830000001"]);
    assert.equal(ok.content, "Hello");
    assert.equal(ok.mode.encoding, "7BIT");
  });

  it("submits the verified encrypted wire payload and polls send-status until delivered", async () => {
    const mock = createMockSmsCpe({ pendingStatusPolls: 2 });
    const prepared = prepareSmsSubmission(["+353830000001"], "Tom & Jerry (a/b) <ok>");
    const result = await inSession(mock, (s) => submitSms(s, prepared, { sleep: noSleep, statusIntervalMs: 10 }));
    assert.deepEqual(result, {
      ok: true,
      submitted: true,
      timedOutWaitingStatus: false,
      sentPhones: ["+353830000001"],
      failedPhones: [],
      failCode: null,
      encoding: "7BIT",
      segments: 1,
    });
    const wire = mock.sentRequests[0] ?? "";
    assert.match(wire, /<Content>Tom &amp; Jerry &#40;a&#x2F;b&#41; &lt;ok&gt;<\/Content>/);
    assert.equal(getXmlTag(wire, "Length"), String("Tom &amp; Jerry &#40;a&#x2F;b&#41; &lt;ok&gt;".length));
    assert.equal(getXmlTag(wire, "Reserved"), "1");
    assert.equal(getXmlTag(wire, "Index"), "-1");
    assert.match(wire, /<Phones><Phone>\+353830000001<\/Phone><\/Phones>/);
    assert.match(getXmlTag(wire, "Date") ?? "", /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    assert.equal(mock.requests.filter((r) => r.path === "/api/sms/send-status").length, 3);
    assert.equal(mock.store.find((m) => m.box === 2)?.content, "Tom & Jerry (a/b) <ok>");
  });

  it("reports CPE send failures with the failure code and gives up after the status timeout", async () => {
    const failing = createMockSmsCpe({ sendOutcome: "fail", pendingStatusPolls: 0 });
    const failed = await inSession(failing, (s) =>
      submitSms(s, prepareSmsSubmission(["+353830000001"], "你好"), { sleep: noSleep })
    );
    assert.equal(failed.ok, false);
    assert.deepEqual(failed.failedPhones, ["+353830000001"]);
    assert.equal(failed.failCode, "113018");
    assert.equal(failed.encoding, "UCS2");

    const stuck = createMockSmsCpe({ sendOutcome: "stuck" });
    const sleeps: number[] = [];
    const timedOut = await inSession(stuck, (s) =>
      submitSms(s, prepareSmsSubmission(["+353830000001"], "ping"), {
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        statusIntervalMs: 1000,
        statusTimeoutMs: 3000,
      })
    );
    assert.equal(timedOut.timedOutWaitingStatus, true);
    assert.equal(timedOut.ok, true);
    assert.deepEqual(timedOut.sentPhones, ["+353830000001"]);
    assert.deepEqual(sleeps, [1000, 1000, 1000]);
  });

  it("bounds send-status polling by elapsed time as well as by poll count, and reports acceptance first", async () => {
    // A slow router: each poll costs 20 s of wall time, so 45 s allows three polls, not ceil(45 / 2) = 23
    const stuck = createMockSmsCpe({ sendOutcome: "stuck" });
    let clockMs = 1_000_000;
    const order: string[] = [];
    const result = await inSession(stuck, (s) =>
      submitSms(s, prepareSmsSubmission(["+353830000001"], "slow router"), {
        statusTimeoutMs: 45_000,
        statusIntervalMs: 2000,
        now: () => clockMs,
        sleep: async () => {
          clockMs += 20_000;
        },
        onAccepted: () => order.push(`accepted after ${stuck.sentRequests.length} send-sms`),
      })
    );
    assert.deepEqual(order, ["accepted after 1 send-sms"]);
    assert.equal(result.ok, true);
    assert.equal(result.timedOutWaitingStatus, true);
    assert.equal(stuck.requests.filter((r) => r.path === "/api/sms/send-status").length, 3);

    // A refused submission is never reported as accepted
    const refused = createMockSmsCpe({ intercept: (p) => (p === "/api/sms/send-sms" ? "<error><code>113004</code></error>" : undefined) });
    let accepted = false;
    await assert.rejects(
      () => inSession(refused, (s) => submitSms(s, prepareSmsSubmission(["+353830000001"], "x"), { sleep: noSleep, onAccepted: () => (accepted = true) })),
      /113004/
    );
    assert.equal(accepted, false);
  });

  it("marks read and deletes by index in batches of 20, ignoring invalid and duplicate indices", async () => {
    const indices = Array.from({ length: 45 }, (_, i) => 50000 + i);
    const messages: MockSms[] = indices.map((index) => ({
      index,
      phone: "+353830000001",
      content: `m${index}`,
      date: "2026-10-29 10:00:00",
      smstat: "0",
      box: 1,
    }));
    const mock = createMockSmsCpe({ messages });
    const readCount = await inSession(mock, (s) => markSmsRead(s, [...indices, 50000, -1, 0, 1.5]));
    assert.equal(readCount, 45);
    assert.deepEqual(mock.setReadBatches.map((b) => b.length), [20, 20, 5]);
    assert.ok(mock.store.every((m) => m.smstat === "1"));

    const deleted = await inSession(mock, (s) => deleteSmsByIndex(s, indices.slice(0, 21)));
    assert.equal(deleted, 21);
    assert.deepEqual(mock.deleteBatches.map((b) => b.length), [20, 1]);
    assert.equal(mock.store.length, 24);

    const before = mock.requests.length;
    assert.equal(await inSession(mock, (s) => markSmsRead(s, [0, -5])), 0);
    assert.equal(await inSession(mock, (s) => deleteSmsByIndex(s, [])), 0);
    assert.equal(mock.requests.filter((r, i) => i >= before && /set-read|delete-sms/.test(r.path)).length, 0);
  });
});
