import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CpeApiError } from "../src/session-errors.ts";
import { SectionUnavailableError } from "../src/cpe-domain.ts";
import type { WriteCheck } from "../src/device-access.ts";
import { awaitZteCommand, parseZteSmsRows, textOfUcs2Hex, ucs2Hex, zteCommandStatus, zteIdList, zteSmsCounters, zteSmsDate, zteSmsTime } from "../src/drivers/sms.ts";
import type { DriverSmsSendOptions } from "../src/drivers/types.ts";
import { zwrtDecryptField, zwrtEncryptField, zwrtKeyEnvelope } from "../src/drivers/zte-zwrt.ts";
import { DeviceWriteDisabledError } from "../src/scheduler.ts";
import { createBrandSmsFixture, smsOf, smsWritesOf } from "./helpers/sms-brand-fixture.ts";
import { LanHttp } from "../src/drivers/transport.ts";
import { zteGoformProtocol, zteReqprocPassword } from "../src/drivers/zte-goform.ts";
import { LanRouterMock } from "./helpers/lan-router.ts";
import { ZTE_PASSWORD, ZTE_RANDOM_LOGIN, zteRouter, zteSms } from "./helpers/zte-goform-router.ts";
import { ZWRT_PASSWORD, zwrtRouter } from "./helpers/zte-zwrt-router.ts";

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

describe("zte-goform: the reqproc spelling of the interface", () => {
  it("finds the spelling the router answers, signs in with the nonce and the user name, and signs writes with a fresh token", async () => {
    const { client, mock, state } = zteRouter({ reqproc: true, sms: inbox() });
    const identity = await client.withSession((s) => s.identify());
    // The firmware names no model: the platform its version string starts with stands in
    assert.deepEqual(identity, { model: "CPE_NV8645", softwareVersion: "CPE_NV8645_230A_E-P42U17", hardwareVersion: null, variant: "reqproc" });
    assert.deepEqual(mock.trail, [
      // Before the password: the lock status, asked the goform way first, then this router's
      "GET /goform/goform_get_cmd_process",
      "GET /reqproc/proc_get",
      // The versions, both ways again; the nonce; the token (empty before a login)
      "GET /goform/goform_get_cmd_process",
      "GET /reqproc/proc_get",
      "GET /reqproc/proc_get",
      "GET /reqproc/proc_get",
      "POST /reqproc/proc_post",
      // The logout, with its own token
      "GET /reqproc/proc_get",
      "POST /reqproc/proc_post",
    ]);
    const firstPost = mock.requests.find((r) => r.method === "POST");
    assert.ok(firstPost);
    const login = LanRouterMock.form(firstPost);
    assert.deepEqual([login.get("goformId"), login.get("username"), login.get("CSRFToken"), login.has("AD")], ["LOGIN", "YWRtaW4=", "", false]);
    assert.equal(login.get("password"), zteReqprocPassword(ZTE_RANDOM_LOGIN, ZTE_PASSWORD));
    assert.deepEqual(state.posts.map((p) => [p.goformId, p.fields.get("CSRFToken"), p.fields.has("AD")]), [["LOGOUT", "tok1", false]]);
    assert.equal(state.loggedIn, false);
  });

  it("reads, sends, marks read and deletes SMS over it with the same fields", async () => {
    const { client, mock, state } = zteRouter({ reqproc: true, sms: inbox() });
    const listed = await client.withSession((s) => smsOf(s).list());
    assert.deepEqual(listed?.map((m) => m.index), [4, 3, 2, 1]);
    assert.deepEqual(await client.withSession((s) => smsOf(s).counters()), { localUnread: 2, localInbox: 3, localOutbox: 2, localDraft: 1, localMax: 100 });
    assert.deepEqual(await client.withSession((s) => smsWritesOf(s).send(FRIEND, "你好", newCheck(), sendOptions())), { state: "sent", code: null });
    const check = newCheck();
    await client.withSession(async (s) => {
      await smsWritesOf(s).markRead([2], check);
      await smsWritesOf(s).delete([1], check);
    });
    assert.deepEqual(check, { endpoints: ["zte-goform:SET_MSG_READ", "zte-goform:DELETE_SMS"], readback: "match", reason: null });
    assert.deepEqual(state.posts.filter((p) => p.goformId !== "LOGOUT").map((p) => p.goformId), ["SEND_SMS", "SET_MSG_READ", "DELETE_SMS"]);
    // Every write carried the token handed out right before it, and none an AD
    assert.ok(state.posts.every((p) => /^tok\d+$/.test(p.fields.get("CSRFToken") ?? "") && !p.fields.has("AD")));
    assert.ok(mock.requests.every((r) => !r.path.startsWith("/goform/") || r.method === "GET"), "nothing was written the goform way");
    assert.ok(mock.requests.some((r) => r.path === "/reqproc/proc_get" && r.query.get("cmd") === "sms_cmd_status_info" && r.query.get("sms_cmd") === "6"));
  });

  it("latches the breaker on a refused password, yields to someone signed in, and sends nothing without a nonce", async () => {
    const wrong = zteRouter({ reqproc: true, loginResult: "3" });
    await assert.rejects(wrong.client.withSession((s) => s.identify()), (err: unknown) => err instanceof CpeApiError && err.code === "108006" && err.remainCount === 5);
    const before = wrong.mock.requests.length;
    await assert.rejects(wrong.client.withSession((s) => s.identify()), (err: unknown) => err instanceof CpeApiError && err.code === "108006");
    assert.equal(wrong.mock.requests.length, before);

    const busy = zteRouter({ reqproc: true, loginResult: "4" });
    assert.equal((await busy.client.withSessionDetailed((s) => s.identify())).status, "yielded");

    const locked = zteRouter({ reqproc: true, lock: { left: "0", wait: "300" } });
    await assert.rejects(locked.client.withSession((s) => s.identify()), (err: unknown) => err instanceof CpeApiError && err.code === "108007");
    assert.ok(!locked.mock.requests.some((r) => r.method === "POST"));

    const noNonce = zteRouter({ reqproc: true });
    const original = noNonce.mock.handler;
    noNonce.mock.handler = (req) => (req.query.get("cmd") === "get_random_login" ? { json: { random_login: "" } } : original(req));
    await assert.rejects(noNonce.client.withSession((s) => s.identify()), /no login nonce/);
    assert.ok(!noNonce.mock.requests.some((r) => r.method === "POST"));
  });

  it("names the network mode the way this firmware does, and switches to no 5G mode on it", async () => {
    const { client, state } = zteRouter({ reqproc: true });
    await client.withSession((s) => s.setBandLock({ lte: [1, 3], nr: null, networkMode: "auto" }, newCheck()));
    assert.equal(state.posts.find((p) => p.goformId === "SET_BEARER_PREFERENCE")?.fields.get("BearerPreference"), "NETWORK_auto");
    await client.withSession((s) => s.setBandLock({ lte: [1, 3], nr: null, networkMode: "lte" }, newCheck()));
    assert.equal(state.posts.filter((p) => p.goformId === "SET_BEARER_PREFERENCE").at(-1)?.fields.get("BearerPreference"), "Only_LTE");
    // Asked for a 5G mode: refused before anything is written in that session
    const before = state.posts.length;
    await assert.rejects(client.withSession((s) => s.setBandLock({ lte: [1, 3], nr: null, networkMode: "nr_sa" }, newCheck())), /4G firmware/);
    assert.deepEqual(state.posts.slice(before).map((p) => p.goformId), ["LOGOUT"]);
    // The mode it reports reads back as automatic, so an unlock leaves it alone
    state.values["net_select"] = "NETWORK_auto";
    const unlock = newCheck();
    await client.withSession((s) => s.unlockAll(unlock));
    assert.ok(!unlock.endpoints.includes("zte-goform:SET_BEARER_PREFERENCE"));
    // A goform router keeps its own names
    const goform = zteRouter();
    await goform.client.withSession((s) => s.setBandLock({ lte: [1, 3], nr: null, networkMode: "auto" }, newCheck()));
    assert.equal(goform.state.posts.find((p) => p.goformId === "SET_BEARER_PREFERENCE")?.fields.get("BearerPreference"), "WL_AND_5G");
  });

  it("is told apart before any password: either spelling that names a firmware is this brand", async () => {
    const http = (mock: LanRouterMock): LanHttp => new LanHttp({ baseUrl: "http://192.168.0.1", fetchImpl: mock.fetchImpl, timeoutMs: 1000, signal: new AbortController().signal });
    assert.equal(await zteGoformProtocol.detect(http(zteRouter({ reqproc: true }).mock)), true);
    assert.equal(await zteGoformProtocol.detect(http(zteRouter().mock)), true);
    assert.equal(await zteGoformProtocol.detect(http(new LanRouterMock(() => ({ status: 404, text: "" })))), false);
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
      assert.deepEqual(fx.service.getStatus().abilities, { send: true, delete: "message", markRead: "router" });
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

describe("zte-zwrt SMS: the encrypted fields", () => {
  const key = Buffer.alloc(32, 7);

  it("writes a field as Base64 of IV, tag and ciphertext, and reads it back", () => {
    const sealed = zwrtEncryptField(key, "4F60597D", Buffer.alloc(12, 1));
    const raw = Buffer.from(sealed, "base64");
    assert.equal(raw.length, 12 + 16 + 8);
    assert.deepEqual(raw.subarray(0, 12), Buffer.alloc(12, 1));
    assert.equal(zwrtDecryptField(key, sealed), "4F60597D");
    // A fresh IV each time
    assert.notEqual(zwrtEncryptField(key, "a"), zwrtEncryptField(key, "a"));
  });

  it("reads nothing out of what is not such a field: plain text, a short one, another key, a changed tag", () => {
    const sealed = zwrtEncryptField(key, "hello");
    assert.equal(zwrtDecryptField(key, "+353830000001"), null);
    assert.equal(zwrtDecryptField(key, "not base64 !"), null);
    assert.equal(zwrtDecryptField(key, "AAAA"), null);
    assert.equal(zwrtDecryptField(Buffer.alloc(32, 8), sealed), null);
    const tampered = Buffer.from(sealed, "base64");
    tampered[14] = (tampered[14] ?? 0) ^ 0xff;
    assert.equal(zwrtDecryptField(key, tampered.toString("base64")), null);
  });

  it("wraps the key for the router's public key only when it is one", () => {
    assert.equal(zwrtKeyEnvelope("not a key", key), null);
    assert.equal(zwrtKeyEnvelope("-----BEGIN PUBLIC KEY-----AAAA-----END PUBLIC KEY-----", key), null);
  });
});

describe("zte-zwrt SMS: the driver", () => {
  it("agrees a key once, then lists the store with numbers and bodies decrypted", async () => {
    const { client, calls, state } = zwrtRouter({ sms: inbox() });
    const listed = await client.withSession((s) => smsOf(s).list());
    assert.deepEqual(listed?.map((m) => [m.index, m.phone, m.direction, m.isUnread]), [
      [4, FRIEND, "in", true],
      [3, FRIEND, "out", false],
      [2, FRIEND, "in", true],
      [1, "DemoBank", "in", false],
    ]);
    assert.equal(listed?.find((m) => m.index === 2)?.content, "晚上七点吃饭？");
    assert.equal(listed?.find((m) => m.index === 4)?.content, LONG);
    assert.deepEqual(
      calls.filter((c) => c.session !== "00000000000000000000000000000000").map((c) => `${c.object}.${c.method}`),
      ["zwrt_web.web_crt_get", "zwrt_web.web_http_enstr_set", "uci.get", "zwrt_wms.zte_libwms_get_sms_data", "zwrt_web.web_logout"]
    );
    assert.deepEqual(calls.find((c) => c.method === "zte_libwms_get_sms_data")?.args, { page: 0, data_per_page: 500, mem_store: 1, tags: 10, order_by: "order by id desc" });
    // The key ends with the session
    assert.equal(state.key, null);
  });

  it("reads numbers the firmware writes as hexadecimal, and plain fields on a firmware without the key exchange", async () => {
    const hex = zwrtRouter({ sms: inbox(), hexNumbers: true });
    assert.deepEqual((await hex.client.withSession((s) => smsOf(s).list()))?.map((m) => m.phone), [FRIEND, FRIEND, FRIEND, "DemoBank"]);
    const plain = zwrtRouter({ sms: inbox(), encryption: false });
    const listed = await plain.client.withSession((s) => smsOf(s).list());
    assert.equal(listed?.find((m) => m.index === 2)?.content, "晚上七点吃饭？");
    assert.ok(!plain.calls.some((c) => c.method === "web_http_enstr_set"));
  });

  it("counts without the key exchange, and has no SMS on a firmware without the object", async () => {
    const { client, calls } = zwrtRouter({ sms: inbox() });
    assert.deepEqual(await client.withSession((s) => smsOf(s).counters()), { localUnread: 2, localInbox: 3, localOutbox: 2, localDraft: 1, localMax: 100 });
    assert.ok(!calls.some((c) => c.method === "web_crt_get"));
    const none = zwrtRouter({ sms: false });
    await assert.rejects(none.client.withSession((s) => smsOf(s).counters()), SectionUnavailableError);
    await assert.rejects(none.client.withSession((s) => smsOf(s).list()), SectionUnavailableError);
    // Any other refusal is an error, not "no SMS here"
    const denied = zwrtRouter({ sms: inbox(), fail: "zwrt_wms.zwrt_wms_get_wms_capacity" });
    await assert.rejects(denied.client.withSession((s) => smsOf(s).counters()), (err: unknown) => err instanceof CpeApiError && err.code === "ubus-6");
    const deniedList = zwrtRouter({ sms: inbox(), fail: "zwrt_wms.zte_libwms_get_sms_data" });
    await assert.rejects(deniedList.client.withSession((s) => smsOf(s).list()), (err: unknown) => err instanceof CpeApiError && err.code === "ubus-6");
  });

  it("sends once with the number and the body encrypted, then asks the send slot", async () => {
    const { client, calls, state } = zwrtRouter({ sms: [] });
    const check = newCheck();
    const options = sendOptions();
    assert.deepEqual(await client.withSession((s) => smsWritesOf(s).send(FRIEND, "你好", check, options)), { state: "sent", code: null });
    assert.equal(options.accepted, 1);
    const sends = calls.filter((c) => c.method === "zte_libwms_send_sms");
    assert.equal(sends.length, 1);
    const args = sends[0]?.args ?? {};
    assert.deepEqual([args["id"], args["encode_type"]], ["-1", "UNICODE"]);
    assert.match(String(args["sms_time"]), /^\d\d;\d\d;\d\d;\d\d;\d\d;\d\d;[+-]?\d{1,2}$/);
    // Neither field travels readable; the router reads them with the key it was handed
    assert.ok(!JSON.stringify(args).includes("353830000001") && !JSON.stringify(args).includes("4F60597D"));
    assert.deepEqual(state.lastSend, { number: FRIEND, body: "4F60597D" });
    assert.deepEqual(check.endpoints, ["zte-zwrt:zwrt_wms.zte_libwms_send_sms"]);
    assert.ok(calls.some((c) => c.method === "zwrt_wms_get_cmd_status" && c.args["sms_cmd"] === 4));
  });

  it("sends plain fields where the firmware has no key exchange, and reports failed and unsettled sends", async () => {
    const plain = zwrtRouter({ sms: [], encryption: false });
    await plain.client.withSession((s) => smsWritesOf(s).send("10010", "balance", newCheck(), sendOptions()));
    const args = plain.calls.find((c) => c.method === "zte_libwms_send_sms")?.args ?? {};
    assert.deepEqual([args["number"], args["message_body"], args["encode_type"]], ["10010", ucs2Hex("balance"), "GSM7_default"]);

    const failed = zwrtRouter({ sms: [], sendStatus: "2" });
    assert.deepEqual(await failed.client.withSession((s) => smsWritesOf(s).send(FRIEND, "hi", newCheck(), sendOptions())), { state: "failed", code: null });
    const slow = zwrtRouter({ sms: [], sendStatus: "1" });
    assert.deepEqual(await slow.client.withSession((s) => smsWritesOf(s).send(FRIEND, "hi", newCheck(), sendOptions())), { state: "unconfirmed", code: null });
    assert.equal(slow.calls.filter((c) => c.method === "zte_libwms_send_sms").length, 1);

    const refused = zwrtRouter({ sms: [], fail: "zwrt_wms.zte_libwms_send_sms", status: 2 });
    const never = sendOptions();
    await assert.rejects(refused.client.withSession((s) => smsWritesOf(s).send(FRIEND, "hi", newCheck(), never)), (err: unknown) => err instanceof CpeApiError && err.code === "ubus-2");
    assert.equal(never.accepted, 0);
  });

  it("marks read and deletes by id list, and reads each back from the listing", async () => {
    const { client, calls, state } = zwrtRouter({ sms: inbox() });
    const read = newCheck();
    await client.withSession((s) => smsWritesOf(s).markRead([2, 4], read));
    assert.deepEqual(calls.find((c) => c.method === "zwrt_wms_modify_tag")?.args, { id: "2;4;", tag: 0 });
    assert.deepEqual(read, { endpoints: ["zte-zwrt:zwrt_wms.zwrt_wms_modify_tag"], readback: "match", reason: null });

    const gone = newCheck();
    await client.withSession((s) => smsWritesOf(s).delete([1, 2], gone));
    assert.deepEqual(calls.find((c) => c.method === "zwrt_wms_delete_sms")?.args, { id: "1;2;" });
    assert.ok(calls.some((c) => c.method === "zwrt_wms_get_cmd_status" && c.args["sms_cmd"] === 6));
    assert.deepEqual(state.sms.map((row) => row.id).sort(), [3, 4, 5, 6]);
    assert.deepEqual(gone, { endpoints: ["zte-zwrt:zwrt_wms.zwrt_wms_delete_sms"], readback: "match", reason: null });
  });

  it("catches a delete the firmware answers as done without deleting, and stops one it says failed", async () => {
    const { client, mock, state } = zwrtRouter({ sms: inbox() });
    const original = mock.handler;
    mock.handler = async (req) => {
      const before = state.sms.map((row) => ({ ...row }));
      const reply = await original(req);
      if (req.body.includes("zwrt_wms_delete_sms")) state.sms = before;
      return reply;
    };
    const check = newCheck();
    await client.withSession((s) => smsWritesOf(s).delete([1], check));
    assert.deepEqual([check.readback, check.reason], ["mismatch", "no_change"]);

    mock.handler = async (req) => {
      const reply = await original(req);
      if (req.body.includes("zwrt_wms_delete_sms")) state.smsStatus["6"] = "2";
      return reply;
    };
    await assert.rejects(client.withSession((s) => smsWritesOf(s).delete([1], newCheck())), /did not delete/);
  });
});

describe("zte-zwrt SMS: through the SMS service", () => {
  it("counts on the telemetry session, syncs, sends, marks read and deletes like every other brand", async () => {
    const router = zwrtRouter({ sms: [zteSms(1, "DemoBank", "Your code is 482913", "1")] });
    const fx = createBrandSmsFixture({ family: "zte-zwrt", cpeUrl: "http://192.168.0.1", password: ZWRT_PASSWORD, fetchImpl: router.mock.fetchImpl, model: "MC8512", service: { seedExistingOnStart: false } });
    try {
      const snap = await fx.core.monitor.refreshTelemetry();
      assert.deepEqual(snap?.sms, { localUnread: 1, localInbox: 1, localOutbox: 0, localDraft: 0, localMax: 100 });
      assert.equal(router.calls.filter((c) => c.method === "web_login").length, 1);

      const synced = await fx.service.sync("full");
      assert.deepEqual([synced?.via, synced?.added, synced?.newIncoming], ["driver", 1, 1]);
      const thread = fx.service.listThreads()[0];
      assert.deepEqual([thread?.phone, thread?.latestOtp, thread?.unreadCount], ["DemoBank", "482913", 1]);

      const sent = await fx.service.send({ phones: [FRIEND], content: "On my way", source: "web" });
      assert.deepEqual([sent.result.ok, sent.result.sentPhones], [true, [FRIEND]]);
      assert.equal(router.calls.filter((c) => c.method === "zte_libwms_send_sms").length, 1);

      await fx.service.markRead({ threadKey: thread?.threadKey ?? "" });
      assert.equal(router.state.sms.find((row) => row.id === 1)?.tag, "0");
      await fx.service.deleteMessages({ uids: [fx.service.getThread("DemoBank").messages[0]?.uid ?? ""] });
      assert.ok(!router.state.sms.some((row) => row.id === 1));
      assert.equal(fx.service.listTrash().length, 1);
      assert.deepEqual(fx.scheduler.genericWrites.map((r) => [r.action, r.readback]), [
        ["sms_send", "match"],
        ["sms_mark_read", "match"],
        ["sms_delete", "match"],
      ]);
      // Nothing of a message is kept in a write's record
      assert.ok(!JSON.stringify(fx.scheduler.genericWrites).includes("0001"));
    } finally {
      await fx.cleanup();
    }
  });
});
