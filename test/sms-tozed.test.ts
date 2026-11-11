import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CpeControlValidationError } from "../src/control-error.ts";
import { CpeApiError } from "../src/cpe-client.ts";
import { SectionUnavailableError } from "../src/cpe-domain.ts";
import type { WriteCheck } from "../src/device-access.ts";
import { DriverCpeClient } from "../src/drivers/client.ts";
import { TOZED_LOGIN_SESSION, parseTozedSmsPage, tozedLoginPassword, tozedProtocol } from "../src/drivers/tozed.ts";
import type { DriverSmsSendOptions } from "../src/drivers/types.ts";
import { LanRouterMock } from "./helpers/lan-router.ts";
import { createBrandSmsFixture, sendOf, smsOf } from "./helpers/sms-brand-fixture.ts";

/**
 * SMS on Tozed / ZLT routers (the VN007 family): the two boxes `cmd 12` lists and `cmd 13` to send.
 * Mock routers only; reserved test numbers, invented senders.
 */

const PASSWORD = "test-password";
const FRIEND = "+353830000001";
const LOGIN_TOKEN = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const SID = "7c9e1a00000000000000000000000000000000000000000000000000000000ff";
const WRITE_TOKEN = "0fc934a579774306319c63aa17d004d9";

interface StoredSms {
  index: number;
  read: boolean;
  number: string;
  when: string;
  text: string;
}

function entry(sms: StoredSms): string {
  return Buffer.from(`${sms.index} ${sms.read ? "1" : "0"} ${sms.number} ${sms.when} ${sms.text}`, "utf8").toString("base64");
}

function newCheck(): WriteCheck {
  return { endpoints: [], readback: "none", reason: null };
}

function sendOptions(): DriverSmsSendOptions & { accepted: number } {
  const options = {
    accepted: 0,
    statusTimeoutMs: 3000,
    sleep: async (): Promise<void> => undefined,
    onAccepted: (): void => {
      options.accepted += 1;
    },
  };
  return options;
}

function inbox(): StoredSms[] {
  return [
    { index: 0, read: true, number: "DemoBank", when: "2026-11-09 08:00:00", text: "Your code is 482913" },
    { index: 1, read: false, number: FRIEND, when: "2026/11/10 18:00:00", text: "晚上七点 吃饭？ 好吗" },
  ];
}

function tozedRouter(opts: { inbox?: StoredSms[]; sent?: StoredSms[]; sms?: false; pageSize?: number; sendMessage?: string | null; sendSuccess?: boolean; writeToken?: string | null } = {}) {
  const state = { inbox: [...(opts.inbox ?? inbox())], sent: [...(opts.sent ?? [])], sends: [] as Array<Record<string, unknown>>, loggedOut: 0 };
  const pageSize = opts.pageSize ?? 20;
  const mock = new LanRouterMock((req) => {
    const body = JSON.parse(req.body) as Record<string, unknown>;
    const cmd = body["cmd"];
    if (cmd === 232) return { json: { success: true, cmd, token: LOGIN_TOKEN } };
    if (cmd === 100) {
      return body["sessionId"] === TOZED_LOGIN_SESSION && body["passwd"] === tozedLoginPassword(LOGIN_TOKEN, PASSWORD) ? { json: { success: true, cmd, sessionId: SID } } : { json: { success: false, cmd, res: "login_fail", login_times: "1" } };
    }
    if (body["sessionId"] !== SID) return { json: { success: false, cmd } };
    if (cmd === 101) {
      state.loggedOut += 1;
      return { json: { success: true, cmd } };
    }
    if (cmd === 205) return { json: { success: true, cmd, network_type_str: "5G(SA)", currentband_5g: "78", RSRP_5G: "-79", PCI_5G: "142", FREQ_5G: "650000", network_operator: "27201" } };
    if (cmd === 207) return { json: { success: true, cmd, board_type: "VN007+", real_fwversion: "2.10.22" } };
    if (cmd === 233) return opts.writeToken === null ? { json: { success: false, cmd } } : { json: { success: true, cmd, token: opts.writeToken ?? WRITE_TOKEN } };
    if (cmd === 12) {
      if (opts.sms === false) return { json: { success: true, cmd, message: "" } };
      const box = body["subcmd"] === 1 ? state.sent : state.inbox;
      const page = Number(body["page_num"] ?? 1);
      // Newest first, a page at a time
      const rows = [...box].sort((a, b) => b.index - a.index).slice((page - 1) * pageSize, page * pageSize);
      return { json: { success: true, cmd, sms_list: rows.map(entry).join(",") } };
    }
    if (cmd === 13) {
      state.sends.push(body);
      if (opts.sendSuccess === false) return { json: { success: false, cmd } };
      const text = Buffer.from(String(body["content"]), "base64").toString("utf8");
      if ((opts.sendMessage ?? "0") === "0") state.sent.push({ index: state.sent.length, read: true, number: String(body["phoneNo"]), when: "2026-11-10 19:00:00", text });
      return { json: { success: true, cmd, ...(opts.sendMessage === null ? {} : { message: opts.sendMessage ?? "0" }) } };
    }
    return { json: { success: true, cmd } };
  });
  const client = new DriverCpeClient({ protocol: tozedProtocol, cpeUrl: "http://192.168.0.1", cpeUsername: "admin", cpePassword: PASSWORD, fetchImpl: mock.fetchImpl, requestTimeoutMs: 2000 });
  const bodies = (): Array<Record<string, unknown>> => mock.requests.map((r) => JSON.parse(r.body) as Record<string, unknown>);
  return { mock, state, client, bodies };
}

describe("tozed SMS: a box page", () => {
  it("reads each Base64 entry: handle, read flag, number, date and time, and the text with its spaces", () => {
    const page = [entry({ index: 0, read: true, number: "DemoBank", when: "2026-11-09 08:00:00", text: "Your code is 482913" }), entry({ index: 7, read: false, number: FRIEND, when: "2026/11/10 18:00:00", text: "你 好" })].join(",");
    assert.deepEqual(parseTozedSmsPage(page, 0), [
      { index: 1, phone: "DemoBank", content: "Your code is 482913", date: "2026-11-09 08:00:00", smstat: "1", isUnread: false, direction: "in" },
      { index: 8, phone: FRIEND, content: "你 好", date: "2026-11-10 18:00:00", smstat: "0", isUnread: true, direction: "in" },
    ]);
    // The sent box has handles of its own, and nothing in it is unread
    assert.deepEqual(parseTozedSmsPage(entry({ index: 7, read: false, number: FRIEND, when: "2026-11-10 18:00:00", text: "ok" }), 1), [
      { index: 1_000_008, phone: FRIEND, content: "ok", date: "2026-11-10 18:00:00", smstat: "3", isUnread: false, direction: "out" },
    ]);
  });

  it("leaves out what is not such an entry, and reads no date out of one it cannot place", () => {
    const short = Buffer.from("3 1 DemoBank", "utf8").toString("base64");
    const noIndex = Buffer.from("x 1 DemoBank 2026-11-09 08:00:00 hi", "utf8").toString("base64");
    const oddDate = Buffer.from("4 1 DemoBank yesterday noon hello", "utf8").toString("base64");
    assert.deepEqual(parseTozedSmsPage(["", " ", "***", short, noIndex, oddDate].join(","), 0).map((m) => [m.index, m.date, m.content]), [[5, "", "hello"]]);
    assert.deepEqual(parseTozedSmsPage("", 0), []);
    assert.deepEqual(parseTozedSmsPage(undefined, 0), []);
  });
});

describe("tozed SMS: the driver", () => {
  it("lists the inbox and the sent box, page by page until a page brings nothing new", async () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ index: i, read: i < 3, number: FRIEND, when: "2026-11-10 12:00:00", text: `m${i}` }));
    const { client, bodies, state } = tozedRouter({ inbox: many, sent: [{ index: 0, read: true, number: FRIEND, when: "2026-11-10 13:00:00", text: "Sure" }], pageSize: 2 });
    const listed = await client.withSession((s) => smsOf(s).list());
    assert.deepEqual(listed?.map((m) => [m.index, m.direction, m.isUnread]).sort((a, b) => Number(a[0]) - Number(b[0])), [
      [1, "in", false],
      [2, "in", false],
      [3, "in", false],
      [4, "in", true],
      [5, "in", true],
      [1_000_001, "out", false],
    ]);
    assert.deepEqual(
      bodies()
        .filter((b) => b["cmd"] === 12)
        .map((b) => [b["subcmd"], b["page_num"], b["method"]]),
      [
        [0, 1, "GET"],
        [0, 2, "GET"],
        [0, 3, "GET"],
        [0, 4, "GET"],
        [1, 1, "GET"],
        [1, 2, "GET"],
      ]
    );
    assert.equal(state.loggedOut, 1);
    const empty = tozedRouter({ inbox: [] });
    assert.deepEqual(await empty.client.withSession((s) => smsOf(s).list()), []);
  });

  it("counts the inbox's first page with its newest handle, the same way every time, and no unread count", async () => {
    const { client } = tozedRouter();
    const counters = await client.withSession((s) => smsOf(s).counters());
    assert.deepEqual(counters, { localUnread: 0, localInbox: 2, localOutbox: 0, localDraft: 0, localMax: 0, newest: 2 });
    // After a listing too: one read of the same page, whatever was listed
    const again = await client.withSession(async (s) => smsOf(s).counters(await smsOf(s).list()));
    assert.deepEqual(again, counters);
    assert.deepEqual(await tozedRouter({ inbox: [] }).client.withSession((s) => smsOf(s).counters()), { localUnread: 0, localInbox: 0, localOutbox: 0, localDraft: 0, localMax: 0, newest: 0 });
  });

  it("has no SMS on a firmware whose command answers without a list", async () => {
    const { client } = tozedRouter({ sms: false });
    await assert.rejects(client.withSession((s) => smsOf(s).list()), SectionUnavailableError);
    await assert.rejects(client.withSession((s) => smsOf(s).counters()), SectionUnavailableError);
  });

  it("sends once with the write token and the text as Base64, and takes the router's word for the result", async () => {
    const { client, state } = tozedRouter();
    const check = newCheck();
    const options = sendOptions();
    assert.deepEqual(await client.withSession((s) => sendOf(s)(FRIEND, "你好 world", check, options)), { state: "sent", code: null });
    assert.equal(options.accepted, 1);
    assert.equal(state.sends.length, 1);
    const sent = state.sends[0] ?? {};
    assert.deepEqual([sent["method"], sent["phoneNo"], sent["token"], Buffer.from(String(sent["content"]), "base64").toString("utf8")], ["POST", FRIEND, WRITE_TOKEN, "你好 world"]);
    assert.deepEqual(check.endpoints, ["tozed:cmd13"]);
  });

  it("reports a send the router says did not go out, one it does not rule on, and one it refuses", async () => {
    const failed = tozedRouter({ sendMessage: "1" });
    assert.deepEqual(await failed.client.withSession((s) => sendOf(s)(FRIEND, "hi", newCheck(), sendOptions())), { state: "failed", code: "sms-1" });
    const odd = tozedRouter({ sendMessage: "busy" });
    assert.deepEqual(await odd.client.withSession((s) => sendOf(s)(FRIEND, "hi", newCheck(), sendOptions())), { state: "failed", code: null });
    const silent = tozedRouter({ sendMessage: null });
    assert.deepEqual(await silent.client.withSession((s) => sendOf(s)(FRIEND, "hi", newCheck(), sendOptions())), { state: "unconfirmed", code: null });

    const refused = tozedRouter({ sendSuccess: false });
    const never = sendOptions();
    await assert.rejects(refused.client.withSession((s) => sendOf(s)(FRIEND, "hi", newCheck(), never)), (err: unknown) => err instanceof CpeApiError && err.code === "cmd13");
    assert.equal(never.accepted, 0);
    // A firmware that hands out no write token: the send goes with an empty one, as its page would send it
    const tokenless = tozedRouter({ writeToken: null });
    await tokenless.client.withSession((s) => sendOf(s)(FRIEND, "hi", newCheck(), sendOptions()));
    assert.equal(tokenless.state.sends[0]?.["token"], "");
  });

  it("has no way to mark a message read or to delete one", async () => {
    const { client } = tozedRouter();
    assert.deepEqual(await client.withSession(async (s) => [smsOf(s).markRead, smsOf(s).delete]), [undefined, undefined]);
  });
});

describe("tozed SMS: through the SMS service", () => {
  function fixture(opts: Parameters<typeof tozedRouter>[0] = {}) {
    const router = tozedRouter(opts);
    const fx = createBrandSmsFixture({ family: "tozed", cpeUrl: "http://192.168.0.1", password: PASSWORD, fetchImpl: router.mock.fetchImpl, model: "VN007+", service: { seedExistingOnStart: false } });
    return { ...fx, router };
  }

  it("notices a new message from the newest handle, even with a full first page, and syncs it", async () => {
    const full = Array.from({ length: 20 }, (_, i) => ({ index: i, read: true, number: "DemoBank", when: "2026-11-10 12:00:00", text: `code ${100000 + i}` }));
    const fx = fixture({ inbox: full });
    try {
      const first = await fx.core.monitor.refreshTelemetry();
      assert.deepEqual(first?.sms, { localUnread: 0, localInbox: 20, localOutbox: 0, localDraft: 0, localMax: 0, newest: 20 });
      await fx.service.sync("full");
      assert.equal(fx.service.getStatus().syncPending, false);
      fx.router.state.inbox.push({ index: 20, read: false, number: FRIEND, when: "2026-11-10 18:00:00", text: "晚上七点吃饭？" });
      const second = await fx.core.monitor.refreshTelemetry();
      // Still twenty on the page; the newest handle moved
      assert.deepEqual([second?.sms?.localInbox, second?.sms?.newest], [20, 21]);
      fx.service.observeCounters(second?.sms ?? first?.sms ?? { localUnread: 0, localInbox: 0, localOutbox: 0, localDraft: 0, localMax: 0 });
      assert.equal(fx.service.getStatus().syncInProgress, true);
      await fx.service.sync("full");
      assert.deepEqual((fx.named("sms:new") as Array<{ content: string }>).map((m) => m.content), ["晚上七点吃饭？"]);
      assert.equal(fx.service.getStatus().storageUsedPercent, null, "the router names no capacity");
    } finally {
      await fx.cleanup();
    }
  });

  it("keeps the read state itself: marking read writes nothing, and the router's unread flag does not bring it back", async () => {
    const fx = fixture();
    try {
      await fx.service.sync("full");
      // It sends and has no delete: the console offers no delete button
      assert.deepEqual(fx.service.getStatus().abilities, { send: true, delete: "none", markRead: "fengsui" });
      const thread = fx.service.getThread(FRIEND);
      assert.equal(thread.messages[0]?.isUnread, true);
      const before = fx.router.mock.requests.length;
      await fx.service.markRead({ threadKey: thread.threadKey });
      assert.equal(fx.router.mock.requests.length, before);
      await fx.service.sync("full");
      assert.equal(fx.service.getThread(FRIEND).messages[0]?.isUnread, false);
    } finally {
      await fx.cleanup();
    }
  });

  it("sends, and takes the router's copy from its sent box at the next sync", async () => {
    const fx = fixture();
    try {
      const outcome = await fx.service.send({ phones: [FRIEND], content: "On my way", source: "web" });
      assert.deepEqual([outcome.result.ok, outcome.result.sentPhones, outcome.messages[0]?.pending], [true, [FRIEND], true]);
      assert.equal(fx.router.state.sends.length, 1);
      await fx.service.sync("full");
      assert.deepEqual(fx.service.getThread(FRIEND).messages.map((m) => [m.direction, m.pending ?? false]).sort(), [
        ["in", false],
        ["out", false],
      ]);
      assert.deepEqual(fx.scheduler.genericWrites.map((r) => [r.action, r.readback, r.endpoints]), [["sms_send", "match", ["tozed:cmd13"]]]);
    } finally {
      await fx.cleanup();
    }
  });

  it("says plainly that this router's interface cannot delete, and deletes nothing from FengSui either", async () => {
    const fx = fixture();
    try {
      await fx.service.sync("full");
      const uid = fx.service.getThread(FRIEND).messages[0]?.uid ?? "";
      await assert.rejects(fx.service.deleteMessages({ uids: [uid] }), (err: unknown) => err instanceof CpeControlValidationError && /no way to delete a message/.test(err.message));
      assert.ok(fx.mirror.get(uid));
      assert.equal(fx.service.listTrash().length, 0);
      assert.equal(fx.scheduler.genericWrites.length, 0);
    } finally {
      await fx.cleanup();
    }
  });
});
