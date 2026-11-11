import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CpeApiError } from "../src/cpe-client.ts";
import { SectionUnavailableError } from "../src/cpe-domain.ts";
import type { WriteCheck } from "../src/device-access.ts";
import { awaitZteCommand, parseZteSmsRows, textOfUcs2Hex, ucs2Hex, zteCommandStatus, zteIdList, zteSmsCounters, zteSmsDate, zteSmsTime } from "../src/drivers/sms.ts";
import type { DriverSmsSendOptions } from "../src/drivers/types.ts";
import { DeviceWriteDisabledError } from "../src/scheduler.ts";
import { createBrandSmsFixture, smsOf, smsWritesOf } from "./helpers/sms-brand-fixture.ts";
import { ZTE_PASSWORD, zteRouter, zteSms } from "./helpers/zte-goform-router.ts";

/**
 * SMS on ZTE routers: the goform pages' store, through the driver and through the whole SMS stack.
 * Mock routers only; numbers are the reserved test ranges, senders invented.
 */

const FRIEND = "+353830000001";
const LONG = "长短信".repeat(60);

function newCheck(): WriteCheck {
  return { endpoints: [], readback: "none", reason: null };
}

function sendOptions(over: Partial<DriverSmsSendOptions> = {}): DriverSmsSendOptions & { accepted: number } {
  const options = {
    accepted: 0,
    statusTimeoutMs: 3000,
    sleep: async (): Promise<void> => undefined,
    onAccepted: (): void => {
      options.accepted += 1;
    },
    ...over,
  };
  return options;
}

function inbox() {
  return [
    zteSms(1, "DemoBank", "Your code is 482913", "0", "26,11,09,08,00,00,+0"),
    zteSms(2, FRIEND, "晚上七点吃饭？", "1", "26,11,10,18,00,00,+4"),
    zteSms(3, FRIEND, "Sure", "2", "26;11;10;18;05;00;+4"),
    zteSms(4, FRIEND, LONG, "1"),
    zteSms(5, FRIEND, "a draft", "4"),
    zteSms(6, FRIEND, "never went out", "3"),
  ];
}

describe("ZTE SMS: the formats both ZTE interfaces share", () => {
  it("writes and reads message text as UTF-16 hexadecimal, surrogate pairs included", () => {
    assert.equal(ucs2Hex("Hi"), "00480069");
    assert.equal(ucs2Hex("你好"), "4F60597D");
    assert.equal(ucs2Hex("\u{1F600}"), "D83DDE00");
    assert.equal(textOfUcs2Hex("00480069"), "Hi");
    assert.equal(textOfUcs2Hex("d83dde00"), "\u{1F600}");
    // NUL padding and tabs are dropped, as the router's page drops them
    assert.equal(textOfUcs2Hex("0048000900690000"), "Hi");
    assert.equal(textOfUcs2Hex(""), "");
    assert.equal(textOfUcs2Hex("004"), null);
    assert.equal(textOfUcs2Hex("plain text"), null);
  });

  it("reads the router's message time with commas or semicolons, and writes the time of a send", () => {
    assert.equal(zteSmsDate("26,11,10,12,34,56,+0"), "2026-11-10 12:34:56");
    assert.equal(zteSmsDate("26;01;02;03;04;05;-4"), "2026-01-02 03:04:05");
    assert.equal(zteSmsDate("2026,11,10,12,34,56"), "2026-11-10 12:34:56");
    for (const bad of ["", "26,11,10", "26,13,10,12,34,56,+0", "26,11,10,25,34,56,+0", "aa,11,10,12,34,56"]) assert.equal(zteSmsDate(bad), "", bad);
    assert.match(zteSmsTime(new Date(2026, 10, 10, 9, 8, 7)), /^26;11;10;09;08;07;(?:\+\d{1,2}|-\d{1,2}|0)$/);
  });

  it("joins ids the way the page does and names no id twice", () => {
    assert.equal(zteIdList([659, 658]), "659;658;");
    assert.equal(zteIdList([3, 3, 0, -1, 1.5]), "3;");
    assert.equal(zteIdList([]), "");
  });

  it("turns the listing's rows into messages: drafts and unsent left out, an unreadable row skipped", () => {
    const rows = [
      { id: "7", number: "DemoBank", content: ucs2Hex("code 482913"), tag: "1", date: "26,11,10,12,34,56,+0" },
      { id: 8, number: FRIEND, content: ucs2Hex("sent"), tag: "2", date: "" },
      { id: "9", number: FRIEND, content: "not hexadecimal", tag: "0", date: "bad" },
      { id: "10", number: FRIEND, content: ucs2Hex("draft"), tag: "4" },
      { id: "11", number: FRIEND, content: ucs2Hex("unsent"), tag: "3" },
      { id: "0", number: FRIEND, content: "" },
      { id: "x", number: FRIEND, content: "" },
      "junk",
      null,
      ["an", "array"],
    ];
    assert.deepEqual(parseZteSmsRows(rows), [
      { index: 7, phone: "DemoBank", content: "code 482913", date: "2026-11-10 12:34:56", smstat: "0", isUnread: true, direction: "in" },
      { index: 8, phone: FRIEND, content: "sent", date: "", smstat: "3", isUnread: false, direction: "out" },
      { index: 9, phone: FRIEND, content: "not hexadecimal", date: "", smstat: "1", isUnread: false, direction: "in" },
    ]);
    assert.deepEqual(parseZteSmsRows("nothing"), []);
    // A field the caller cannot read (a failed decryption) leaves that row out
    assert.deepEqual(parseZteSmsRows([{ id: 1, number: "n", content: "c", tag: "1" }], () => null), []);
  });

  it("counts the router's own store, and says when a firmware has none", () => {
    assert.deepEqual(zteSmsCounters({ sms_nv_total: "100", sms_nv_rev_total: "7", sms_nv_send_total: "2", sms_nv_draftbox_total: "1" }, "3"), { localUnread: 3, localInbox: 7, localOutbox: 2, localDraft: 1, localMax: 100 });
    // The unread count of the capacity answer, where the firmware carries it there; never above the inbox
    assert.equal(zteSmsCounters({ sms_nv_total: 100, sms_nv_rev_total: 2, sms_dev_unread_num: 9 }, undefined)?.localUnread, 2);
    assert.equal(zteSmsCounters({ sms_nv_total: "0", sms_nv_rev_total: "0" }, "")?.localMax, 100);
    assert.equal(zteSmsCounters({ sms_capacity_info: "" }, "0"), null);
    assert.equal(zteSmsCounters({ sms_nv_total: "many", sms_nv_rev_total: "1" }, "0"), null);
  });

  it("reads a status slot: done, failed, and an idle slot as still under way", async () => {
    assert.equal(zteCommandStatus({ sms_cmd_status_result: "3" }), "done");
    assert.equal(zteCommandStatus({ sms_cmd_status_result: 2 }), "failed");
    assert.equal(zteCommandStatus({ sms_cmd_status_result: "1" }), "pending");
    assert.equal(zteCommandStatus({ messages: [] }), "pending");
    const sleep = async (): Promise<void> => undefined;
    let reads = 0;
    assert.equal(
      await awaitZteCommand(
        async () => {
          reads += 1;
          return { sms_cmd_status_result: reads < 3 ? "1" : "3" };
        },
        { timeoutMs: 10_000, sleep }
      ),
      "done"
    );
    assert.equal(reads, 3);
    // Never settles: undecided once the time is up, and a failing read ends the wait at once
    assert.equal(await awaitZteCommand(async () => ({}), { timeoutMs: 2000, sleep }), "pending");
    assert.equal(await awaitZteCommand(() => Promise.reject(new Error("connection reset")), { timeoutMs: 60_000, sleep }), "pending");
    let clock = 0;
    assert.equal(await awaitZteCommand(async () => ({}), { timeoutMs: 5000, intervalMs: 100, sleep, now: () => (clock += 3000) }), "pending");
    // Without a sleep of its own it waits for real
    assert.equal(await awaitZteCommand(async () => ({ sms_cmd_status_result: "3" }), { timeoutMs: 50, intervalMs: 1 }), "done");
  });
});

describe("zte-goform SMS: the driver", () => {
  it("lists the router's store: Chinese, a long message as one, sent messages, and nothing for an empty one", async () => {
    const { client, mock, state } = zteRouter({ sms: inbox() });
    const listed = await client.withSession((s) => smsOf(s).list());
    assert.deepEqual(
      listed?.map((m) => [m.index, m.phone, m.direction, m.isUnread, m.date]),
      [
        [6 - 2, FRIEND, "in", true, "2026-11-10 12:34:56"],
        [3, FRIEND, "out", false, "2026-11-10 18:05:00"],
        [2, FRIEND, "in", true, "2026-11-10 18:00:00"],
        [1, "DemoBank", "in", false, "2026-11-09 08:00:00"],
      ]
    );
    assert.equal(listed?.find((m) => m.index === 2)?.content, "晚上七点吃饭？");
    assert.equal(listed?.find((m) => m.index === 4)?.content, LONG);
    const listing = mock.requests.find((r) => r.query.get("cmd") === "sms_data_total");
    assert.deepEqual(
      ["page", "data_per_page", "mem_store", "tags", "order_by"].map((key) => listing?.query.get(key)),
      ["0", "500", "1", "10", "order by id desc"]
    );
    // The session ends with a logout, like every other
    assert.equal(state.posts.at(-1)?.goformId, "LOGOUT");
    assert.equal(state.loggedIn, false);

    const empty = zteRouter({ sms: [] });
    assert.deepEqual(await empty.client.withSession((s) => smsOf(s).list()), []);
  });

  it("asks for the next page after a full one, and stops when a page brings nothing new", async () => {
    const many = Array.from({ length: 620 }, (_, i) => zteSms(i + 1, FRIEND, `m${i}`, "0"));
    const paged = zteRouter({ sms: many });
    assert.equal((await paged.client.withSession((s) => smsOf(s).list()))?.length, 620);
    assert.deepEqual(paged.mock.requests.filter((r) => r.query.get("cmd") === "sms_data_total").map((r) => r.query.get("page")), ["0", "1"]);
    // A firmware that ignores the page hands back the same rows: asked twice, not for ever
    const stuck = zteRouter({ sms: many, smsIgnoresPage: true });
    assert.equal((await stuck.client.withSession((s) => smsOf(s).list()))?.length, 500);
    assert.equal(stuck.mock.requests.filter((r) => r.query.get("cmd") === "sms_data_total").length, 2);
  });

  it("reads a listing whose bodies carry raw control characters", async () => {
    const { client, mock } = zteRouter({ sms: [] });
    const original = mock.handler;
    mock.handler = (req) => (req.query.get("cmd") === "sms_data_total" ? { text: `{"messages":[{"id":"1","number":"DemoBank","content":"${ucs2Hex("ok")}","tag":"1","date":"26,11,10,12,34,56,+0\u0001"}]}` } : original(req));
    assert.equal((await client.withSession((s) => smsOf(s).list()))?.[0]?.content, "ok");
  });

  it("counts with the capacity and the unread count, and has no SMS on a firmware without the store", async () => {
    const { client, mock } = zteRouter({ sms: inbox() });
    assert.deepEqual(await client.withSession((s) => smsOf(s).counters()), { localUnread: 2, localInbox: 3, localOutbox: 2, localDraft: 1, localMax: 100 });
    assert.ok(mock.requests.some((r) => r.query.get("cmd") === "sms_capacity_info" && r.query.get("multi_data") === null));
    const none = zteRouter({ sms: false });
    await assert.rejects(none.client.withSession((s) => smsOf(s).counters()), SectionUnavailableError);
    await assert.rejects(none.client.withSession((s) => smsOf(s).list()), SectionUnavailableError);
  });

  it("sends once with the page's fields, then asks the send slot until the router says it went out", async () => {
    const { client, state } = zteRouter({ sms: [] });
    const check = newCheck();
    const options = sendOptions();
    const outcome = await client.withSession((s) => smsWritesOf(s).send(FRIEND, "你好", check, options));
    assert.deepEqual(outcome, { state: "sent", code: null });
    assert.equal(options.accepted, 1);
    const sends = state.posts.filter((p) => p.goformId === "SEND_SMS");
    assert.equal(sends.length, 1);
    const fields = sends[0]?.fields;
    assert.deepEqual(
      ["Number", "MessageBody", "ID", "encode_type", "notCallback"].map((key) => fields?.get(key)),
      [FRIEND, "4F60597D", "-1", "UNICODE", "true"]
    );
    assert.match(fields?.get("sms_time") ?? "", /^\d\d;\d\d;\d\d;\d\d;\d\d;\d\d;[+-]?\d{1,2}$/);
    assert.ok(fields?.get("AD"));
    assert.deepEqual(check.endpoints, ["zte-goform:SEND_SMS"]);

    const latin = zteRouter({ sms: [] });
    await latin.client.withSession((s) => smsWritesOf(s).send("10010", "balance {now}", newCheck(), sendOptions()));
    assert.equal(latin.state.posts.find((p) => p.goformId === "SEND_SMS")?.fields.get("encode_type"), "GSM7_default");
  });

  it("reports a send the router says failed, one it never settles, and one it refuses outright", async () => {
    const failed = zteRouter({ sms: [], sendStatus: "2" });
    assert.deepEqual(await failed.client.withSession((s) => smsWritesOf(s).send(FRIEND, "hi", newCheck(), sendOptions())), { state: "failed", code: null });

    const slow = zteRouter({ sms: [], sendStatus: "1" });
    const options = sendOptions();
    assert.deepEqual(await slow.client.withSession((s) => smsWritesOf(s).send(FRIEND, "hi", newCheck(), options)), { state: "unconfirmed", code: null });
    assert.equal(slow.state.posts.filter((p) => p.goformId === "SEND_SMS").length, 1);
    assert.equal(options.accepted, 1);

    const refused = zteRouter({ sms: [], sendResult: "failure" });
    const never = sendOptions();
    await assert.rejects(refused.client.withSession((s) => smsWritesOf(s).send(FRIEND, "hi", newCheck(), never)), (err: unknown) => err instanceof CpeApiError && err.code === "failure");
    assert.equal(never.accepted, 0);
  });

  it("marks messages read and reads the listing back", async () => {
    const { client, state } = zteRouter({ sms: inbox() });
    const check = newCheck();
    await client.withSession((s) => smsWritesOf(s).markRead([2, 4], check));
    const post = state.posts.find((p) => p.goformId === "SET_MSG_READ");
    assert.deepEqual([post?.fields.get("msg_id"), post?.fields.get("tag")], ["2;4;", "0"]);
    assert.deepEqual(state.sms.filter((row) => row.tag === "1"), []);
    assert.deepEqual(check, { endpoints: ["zte-goform:SET_MSG_READ"], readback: "match", reason: null });
  });

  it("deletes in batches of twenty, waits for the delete slot, and reads the listing back", async () => {
    const many = Array.from({ length: 25 }, (_, i) => zteSms(100 + i, FRIEND, `message ${i}`, "0"));
    const { client, state, mock } = zteRouter({ sms: many });
    const check = newCheck();
    await client.withSession((s) => smsWritesOf(s).delete(many.map((row) => row.id), check));
    const deletes = state.posts.filter((p) => p.goformId === "DELETE_SMS");
    assert.deepEqual(deletes.map((p) => (p.fields.get("msg_id") ?? "").split(";").filter(Boolean).length), [20, 5]);
    assert.equal(deletes[0]?.fields.get("notCallback"), "true");
    assert.equal(mock.requests.filter((r) => r.query.get("cmd") === "sms_cmd_status_info" && r.query.get("sms_cmd") === "6").length, 2);
    assert.deepEqual(state.sms, []);
    assert.deepEqual(check, { endpoints: ["zte-goform:DELETE_SMS"], readback: "match", reason: null });
  });

  it("says so when a write changed nothing, changed only part, or could not be read back", async () => {
    const { client, mock, state } = zteRouter({ sms: inbox() });
    const original = mock.handler;
    // A router that answers success and deletes nothing
    mock.handler = async (req) => {
      const before = state.sms.map((row) => ({ ...row }));
      const reply = await original(req);
      if (req.method === "POST" && req.body.includes("goformId=DELETE_SMS")) state.sms = before;
      return reply;
    };
    const nothing = newCheck();
    await client.withSession((s) => smsWritesOf(s).delete([1, 2], nothing));
    assert.deepEqual([nothing.readback, nothing.reason], ["mismatch", "no_change"]);

    const part = newCheck();
    mock.handler = async (req) => {
      const reply = await original(req);
      if (req.method === "POST" && req.body.includes("goformId=SET_MSG_READ")) {
        const row = state.sms.find((r) => r.id === 4);
        if (row) row.tag = "1";
      }
      return reply;
    };
    await client.withSession((s) => smsWritesOf(s).markRead([2, 4], part));
    assert.deepEqual([part.readback, part.reason], ["unknown", "unclear_change"]);

    const unread = newCheck();
    mock.handler = (req) => (req.query.get("cmd") === "sms_data_total" ? { status: 500, text: "" } : original(req));
    await client.withSession((s) => smsWritesOf(s).markRead([2], unread));
    assert.deepEqual([unread.readback, unread.reason], ["unknown", "unreadable"]);
  });

  it("stops a delete the router says failed", async () => {
    const { client, mock, state } = zteRouter({ sms: inbox() });
    const original = mock.handler;
    mock.handler = async (req) => {
      const reply = await original(req);
      if (req.method === "POST" && req.body.includes("goformId=DELETE_SMS")) state.smsStatus["6"] = "2";
      return reply;
    };
    await assert.rejects(client.withSession((s) => smsWritesOf(s).delete([1], newCheck())), /did not delete/);
  });
});

describe("zte-goform SMS: through the SMS service", () => {
  function fixture(opts: Parameters<typeof zteRouter>[0] = {}) {
    const router = zteRouter({ sms: inbox(), ...opts });
    const fx = createBrandSmsFixture({ family: "zte-goform", cpeUrl: "http://192.168.0.1", password: ZTE_PASSWORD, fetchImpl: router.mock.fetchImpl, model: "MC888" });
    const logins = (): number => router.mock.requests.filter((r) => r.method === "POST" && r.body.includes("goformId=LOGIN")).length;
    return { ...fx, router, logins };
  }

  it("carries the SMS counts on the telemetry session, with no login of their own", async () => {
    const fx = fixture();
    try {
      const snap = await fx.core.monitor.refreshTelemetry();
      assert.deepEqual(snap?.sms, { localUnread: 2, localInbox: 3, localOutbox: 2, localDraft: 1, localMax: 100 });
      assert.equal(fx.logins(), 1);
      assert.equal(fx.scheduler.getStatus().device.reads.sms.state, "available");
    } finally {
      await fx.cleanup();
    }
  });

  it("keeps the poll's readings when the SMS counts cannot be read, and leaves SMS alone on a firmware without it", async () => {
    const broken = fixture();
    try {
      const original = broken.router.mock.handler;
      broken.router.mock.handler = (req) => (req.query.get("cmd") === "sms_capacity_info" ? Promise.reject(new Error("socket hang up")) : original(req));
      const snap = await broken.core.monitor.refreshTelemetry();
      assert.equal(snap?.rf.pci, 211);
      assert.equal(snap?.sms, null);
    } finally {
      await broken.cleanup();
    }
    const none = fixture({ sms: false });
    try {
      assert.equal((await none.core.monitor.refreshTelemetry())?.sms, null);
      assert.equal(none.scheduler.getStatus().device.reads.sms.state, "unavailable");
      const asked = none.router.mock.requests.length;
      // Not asked again on the next poll
      await none.core.monitor.refreshTelemetry();
      assert.ok(!none.router.mock.requests.slice(asked).some((r) => (r.query.get("cmd") ?? "").startsWith("sms_")));
      assert.equal(await none.service.sync("full"), null);
    } finally {
      await none.cleanup();
    }
  });

  it("syncs the store into conversations and announces what is new and unread", async () => {
    const fx = fixture({ sms: [zteSms(1, "DemoBank", "Your code is 482913", "0", "26,11,09,08,00,00,+0")] });
    try {
      // What is there at the first sync is history
      const first = await fx.service.sync("full");
      assert.deepEqual([first?.mode, first?.via, first?.added, first?.newIncoming], ["full", "driver", 1, 0]);
      fx.router.state.sms.push(zteSms(2, FRIEND, "晚上七点吃饭？", "1", "26,11,10,18,00,00,+4"), zteSms(4, FRIEND, LONG, "1"));
      // Asked for the newest only: this family lists everything, so it is a full sync all the same
      const second = await fx.service.sync("incremental");
      assert.deepEqual([second?.mode, second?.added, second?.newIncoming], ["full", 2, 2]);
      const announced = fx.named("sms:new") as Array<{ content: string; phone: string; verificationCode: string | null }>;
      assert.deepEqual(announced.map((m) => m.content), ["晚上七点吃饭？", LONG]);
      const threads = fx.service.listThreads();
      assert.deepEqual(threads.map((t) => [t.phone, t.totalCount, t.unreadCount]), [
        [FRIEND, 2, 2],
        ["DemoBank", 1, 0],
      ]);
      assert.equal(threads[1]?.latestOtp, "482913");
      assert.equal(fx.service.getStatus().via, "driver");
      assert.equal(fx.logins(), 2);
    } finally {
      await fx.cleanup();
    }
  });

  it("sends once, shows the message at once, and takes the router's copy at the next sync", async () => {
    const fx = fixture({ sms: [] });
    try {
      const outcome = await fx.service.send({ phones: ["083 000 0001"], content: "On my way", source: "web" });
      assert.deepEqual([outcome.result.ok, outcome.result.timedOutWaitingStatus, outcome.result.sentPhones, outcome.result.encoding], [true, false, [FRIEND], "7BIT"]);
      assert.equal(fx.router.state.posts.filter((p) => p.goformId === "SEND_SMS").length, 1);
      assert.equal(outcome.messages[0]?.pending, true);
      // The broadcast and the audit trail name the recipient masked, and never the text
      const applied = fx.controls.find((c) => c.action === "sms_send");
      assert.ok(applied && !applied.summaryEn.includes(FRIEND) && !applied.summaryEn.includes("On my way"));
      assert.deepEqual(applied.check, { endpoints: ["zte-goform:SEND_SMS"], readback: "match", reason: null });
      const record = fx.scheduler.genericWrites.at(-1);
      assert.deepEqual([record?.action, record?.feature, record?.outcome, record?.readback], ["sms_send", "smsWrite", "applied", "match"]);
      assert.ok(!JSON.stringify(record).includes("0001"));

      await fx.service.sync("full");
      const thread = fx.service.getThread(FRIEND);
      assert.deepEqual(thread.messages.map((m) => [m.content, m.direction, m.pending ?? false]), [["On my way", "out", false]]);
    } finally {
      await fx.cleanup();
    }
  });

  it("tells a send the router says failed from one it never settles, and never sends twice", async () => {
    const failed = fixture({ sms: [], sendStatus: "2" });
    try {
      const outcome = await failed.service.send({ phones: [FRIEND], content: "hi", source: "mcp" });
      assert.deepEqual([outcome.result.ok, outcome.result.failedPhones, outcome.messages.length], [false, [FRIEND], 0]);
      assert.equal(failed.scheduler.genericWrites.at(-1)?.readback, "mismatch");
      assert.equal(failed.scheduler.getRecentAlerts().at(-1)?.code, "WRITE_READBACK_MISMATCH");
    } finally {
      await failed.cleanup();
    }
    const slow = fixture({ sms: [], sendStatus: "1" });
    try {
      const outcome = await slow.service.send({ phones: [FRIEND], content: "hi", source: "telegram" });
      assert.deepEqual([outcome.result.ok, outcome.result.timedOutWaitingStatus], [true, true]);
      assert.equal(slow.router.state.posts.filter((p) => p.goformId === "SEND_SMS").length, 1);
    } finally {
      await slow.cleanup();
    }
  });

  it("sends to each recipient once; after the first went out, a refusal fails the rest instead of the send", async () => {
    const fx = fixture({ sms: [] });
    try {
      const original = fx.router.mock.handler;
      let sends = 0;
      fx.router.mock.handler = async (req) => {
        if (req.method === "POST" && req.body.includes("goformId=SEND_SMS") && ++sends === 2) {
          // Count the write as the router does (its RD moved on), then refuse it
          await original(req);
          fx.router.state.sms.pop();
          return { json: { result: "failure" } };
        }
        return original(req);
      };
      const outcome = await fx.service.send({ phones: [FRIEND, "+353830000002", "+353830000003"], content: "hi", source: "web" });
      assert.deepEqual([outcome.result.ok, outcome.result.sentPhones, outcome.result.failedPhones, outcome.result.failCode], [false, [FRIEND], ["+353830000002", "+353830000003"], "failure"]);
      assert.equal(sends, 2);
    } finally {
      await fx.cleanup();
    }
  });

  it("refuses a first send the router refuses, as an error with nothing recorded as sent", async () => {
    const fx = fixture({ sms: [], sendResult: "failure" });
    try {
      await assert.rejects(fx.service.send({ phones: [FRIEND], content: "hi", source: "web" }), (err: unknown) => err instanceof CpeApiError && err.code === "failure");
      assert.equal(fx.named("sms:sent").length, 0);
      assert.equal(fx.scheduler.genericWrites.at(-1)?.outcome, "failed");
    } finally {
      await fx.cleanup();
    }
  });

  it("marks read and deletes on the router; what is deleted stays in Recently deleted and can be restored", async () => {
    const fx = fixture();
    try {
      await fx.service.sync("full");
      const thread = fx.service.getThread(FRIEND);
      const read = await fx.service.markRead({ threadKey: thread.threadKey });
      assert.equal(read.count, 2);
      assert.deepEqual(fx.router.state.sms.filter((row) => row.tag === "1"), []);

      const uid = thread.messages.find((m) => m.content === LONG)?.uid ?? "";
      const deleted = await fx.service.deleteMessages({ uids: [uid] });
      assert.deepEqual([deleted.deleted, deleted.trashDays], [1, 30]);
      assert.ok(!fx.router.state.sms.some((row) => row.id === 4));
      assert.deepEqual(fx.service.listTrash().map((m) => m.content), [LONG]);
      // A full sync does not bring it back, and restoring it needs no router
      await fx.service.sync("full");
      const before = fx.router.mock.requests.length;
      await fx.service.restoreMessages({ uids: [uid] });
      assert.equal(fx.router.mock.requests.length, before);
      assert.equal(fx.mirror.get(uid)?.localOnly, true);
      await fx.service.sync("full");
      assert.ok(fx.mirror.get(uid));
      assert.deepEqual(fx.scheduler.genericWrites.map((r) => [r.action, r.readback]), [
        ["sms_mark_read", "match"],
        ["sms_delete", "match"],
      ]);
    } finally {
      await fx.cleanup();
    }
  });

  it("sends nothing once the owner turned SMS writes off for this model", async () => {
    const fx = fixture();
    try {
      await fx.service.sync("full");
      fx.scheduler.device.setDisabledWrites([{ model: "MC888", feature: "smsWrite" }]);
      const before = fx.router.mock.requests.length;
      await assert.rejects(fx.service.send({ phones: [FRIEND], content: "hi", source: "mcp" }), DeviceWriteDisabledError);
      await assert.rejects(fx.service.markRead({ threadKey: fx.service.getThread(FRIEND).threadKey }), DeviceWriteDisabledError);
      assert.equal(fx.router.mock.requests.length, before);
      // Reading goes on
      assert.ok(await fx.service.sync("full"));
    } finally {
      await fx.cleanup();
    }
  });

  it("asks nothing of the router while a person is signed in to it: no login-free count on this brand", async () => {
    const fx = fixture();
    try {
      const before = fx.router.mock.requests.length;
      await fx.service.pollWhileYielding();
      assert.equal(fx.router.mock.requests.length, before);
    } finally {
      await fx.cleanup();
    }
  });
});
