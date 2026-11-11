import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CpeControlValidationError } from "../src/control-error.ts";
import { SectionUnavailableError, sectionUnavailableCode } from "../src/cpe-domain.ts";
import type { WriteCheck } from "../src/device-access.ts";
import { DriverCpeClient } from "../src/drivers/client.ts";
import { checkFiberhomeSmsText, fiberhomeDecrypt, fiberhomeEncrypt, fiberhomeProtocol, parseFiberhomeSms } from "../src/drivers/fiberhome.ts";
import type { DriverSmsSendOptions } from "../src/drivers/types.ts";
import { LanRouterMock } from "./helpers/lan-router.ts";
import { createBrandSmsFixture, smsOf, smsWritesOf } from "./helpers/sms-brand-fixture.ts";

/**
 * SMS on FiberHome routers: the web page's encrypted endpoint, asked in the session the driver's
 * own login opened. Mock routers only; reserved test numbers, invented senders.
 */

const PASSWORD = "test-password";
const FRIEND = "+353830000001";

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

interface StoredMessage {
  node: number;
  sent: boolean;
  opened: boolean;
  text: string;
  time: string;
}

type Conversations = Record<string, StoredMessage[]>;

function seed(): Conversations {
  return {
    DemoBank: [{ node: 1, sent: false, opened: true, text: "Your code is 482913", time: "2026-11-09 08:00:00" }],
    [FRIEND]: [
      { node: 2, sent: false, opened: false, text: "晚上七点吃饭？", time: "2026-11-10 18:00:00" },
      { node: 1, sent: true, opened: true, text: "Sure", time: "2026-11-10 18:05:00" },
      { node: 3, sent: false, opened: false, text: "长短信".repeat(60), time: "2026-11-10 18:06:00" },
    ],
  };
}

function fiberhomeRouter(opts: { sms?: Conversations; web?: "open" | "forbidden" | "plain"; storesSent?: boolean } = {}) {
  let counter = 0;
  let current = "";
  let loggedIn = false;
  const state = { sms: opts.sms ?? seed(), calls: [] as Array<{ method: string; data: Record<string, unknown> | null }>, logouts: 0, nextSentNode: 50 };
  const smsData = (): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    let session = 0;
    for (const [phone, messages] of Object.entries(state.sms)) {
      const conversation: Record<string, unknown> = { session_phone: phone, session_id: String(session) };
      messages.forEach((m, i) => {
        conversation[`msg${i}`] = { msg_content: m.text, time: m.time, childnode: String(m.node), isOpened: m.opened ? "1" : "0", rcvorsend: m.sent ? "send" : "recv" };
      });
      out[`session${session++}`] = conversation;
    }
    return out;
  };
  const mock = new LanRouterMock((req) => {
    if (req.method === "GET" && req.path === "/api/tmp/FHNCAPIS") {
      current = `sid${String(++counter).padStart(13, "0")}abcdef`;
      return { json: { sessionid: current }, setCookie: ["fh=1; Path=/"] };
    }
    if (req.method === "GET" && req.path === "/api/tmp/FHTOOLAPIS") return loggedIn ? { json: { modelName: "LG6121F", Software_version: "RP0108", WorkMode: "SA", PLMN: "27201", SSB_RSRP: "-79", BAND: "78", PCI: "142", NR_ARFCN: "650000" } } : { text: "timeout" };
    if (req.path === "/api/tmp/FHAPIS") {
      if (opts.web === "forbidden") return { status: 403, text: "403 Forbidden" };
      if (opts.web === "plain") return { text: "<html>login</html>" };
      const plain = fiberhomeDecrypt(req.body, current);
      if (plain === null || !loggedIn) return { text: "timeout" };
      const body = JSON.parse(plain) as { dataObj: Record<string, unknown> | null; ajaxmethod: string; sessionid: string };
      if (body.sessionid !== current) return { text: "timeout" };
      state.calls.push({ method: body.ajaxmethod, data: body.dataObj });
      const reply = (payload: unknown) => ({ text: fiberhomeEncrypt(JSON.stringify(payload), current) });
      if (body.ajaxmethod === "get_sms_data") return reply(smsData());
      if (body.ajaxmethod === "set_value_by_xmlnode") {
        const urls = (body.dataObj?.["url"] ?? {}) as Record<string, string>;
        for (const path of Object.values(urls)) {
          const node = Number(/SMS_RecvMsg\.(\d+)\.isOpened$/.exec(path)?.[1]);
          for (const messages of Object.values(state.sms)) for (const m of messages) if (!m.sent && m.node === node) m.opened = true;
        }
        return reply({ result: "0" });
      }
      if (body.ajaxmethod === "send_msg") {
        const to = String(body.dataObj?.["recv_number"]);
        if (opts.storesSent !== false) (state.sms[to] ??= []).push({ node: state.nextSentNode++, sent: true, opened: true, text: String(body.dataObj?.["content"]), time: "2026-11-10 19:00:00" });
        return reply({});
      }
      if (body.ajaxmethod === "sms_del_session") {
        delete state.sms[String(body.dataObj?.["del_phone"])];
        return reply({ result: "0" });
      }
      return reply({});
    }
    const body = JSON.parse(req.body) as { dataObj: Record<string, unknown> | null; ajaxmethod: string; sessionid: string };
    if (body.sessionid !== current) return { text: "timeout" };
    if (body.ajaxmethod === "app_get_login_status") return { json: { login_status: "0", lockstatus: "0", remaintime: "0" } };
    if (body.ajaxmethod === "app_do_login") {
      if (body.dataObj?.["password"] !== PASSWORD) return { json: { login_result: "1" } };
      loggedIn = true;
      return { json: { login_result: "0" } };
    }
    if (body.ajaxmethod === "app_do_logout") {
      loggedIn = false;
      state.logouts += 1;
      return { json: { login_status: "0" } };
    }
    return { json: {} };
  });
  const client = new DriverCpeClient({ protocol: fiberhomeProtocol, cpeUrl: "http://192.168.8.1", cpeUsername: "admin", cpePassword: PASSWORD, fetchImpl: mock.fetchImpl, requestTimeoutMs: 2000 });
  return { mock, state, client };
}

describe("fiberhome SMS: the encrypted web endpoint", () => {
  const SID = "0123456789abcdefXYZ";

  it("encrypts a request under the session id's first 16 characters and the page's fixed IV, in hexadecimal", () => {
    const sealed = fiberhomeEncrypt('{"ajaxmethod":"get_sms_data"}', SID);
    assert.match(sealed, /^[0-9a-f]+$/);
    assert.equal(sealed.length % 32, 0);
    assert.equal(fiberhomeDecrypt(sealed, SID), '{"ajaxmethod":"get_sms_data"}');
    assert.equal(fiberhomeDecrypt(sealed.toUpperCase(), SID), '{"ajaxmethod":"get_sms_data"}');
    // The rest of the session id is not part of the key
    assert.equal(fiberhomeDecrypt(sealed, "0123456789abcdef-another-tail"), '{"ajaxmethod":"get_sms_data"}');
  });

  it("reads nothing out of what is not such an answer", () => {
    const sealed = fiberhomeEncrypt("hello", SID);
    for (const bad of ["", "timeout", "<html>", sealed.slice(2), `${sealed}00`]) assert.equal(fiberhomeDecrypt(bad, SID), null, bad);
    assert.equal(fiberhomeDecrypt(sealed, "fedcba9876543210"), null);
    assert.equal(fiberhomeDecrypt(sealed, "short"), null);
  });

  it("reads conversations with their messages: handles above zero, sent ones apart, the read flag and the time", () => {
    const parsed = parseFiberhomeSms({
      session0: { session_phone: FRIEND, a: { msg_content: "hi", time: "2026-11-10 18:00:00", childnode: "0", isOpened: "0", rcvorsend: "recv" }, b: { msg_content: "ok", time: "2026/11/10 18:05:00", childnode: 0, isOpened: "1", rcvorsend: "send" } },
      session1: { session_phone: "DemoBank", a: { msg_content: "code", time: "yesterday", childnode: "7", isOpened: "1", rcvorsend: "recv" }, junk: "text", odd: { msg_content: "no number" }, neg: { msg_content: "x", childnode: "-1" } },
      empty: { session_phone: "nobody" },
      notAConversation: 5,
    });
    assert.deepEqual(parsed, [
      {
        phone: FRIEND,
        messages: [
          { index: 1, phone: FRIEND, content: "hi", date: "2026-11-10 18:00:00", smstat: "0", isUnread: true, direction: "in" },
          { index: 1_000_001, phone: FRIEND, content: "ok", date: "2026-11-10 18:05:00", smstat: "3", isUnread: false, direction: "out" },
        ],
      },
      { phone: "DemoBank", messages: [{ index: 8, phone: "DemoBank", content: "code", date: "", smstat: "1", isUnread: false, direction: "in" }] },
    ]);
    assert.deepEqual(parseFiberhomeSms("nothing"), []);
  });

  it("refuses to hand the router text its command line would act on, or text outside plain ASCII", () => {
    for (const text of ["On my way", "Code: 482913 (valid 5 min) - don't share!", "a|b;c&d <e> 'f' #g ~h *i"]) checkFiberhomeSmsText(text);
    for (const text of ["x`id`", "cost $5", 'say "hi"', "back\\slash", "$(reboot)"]) assert.throws(() => checkFiberhomeSmsText(text), /command line/, text);
    for (const text of ["你好", "café", "line\nbreak", "tab\there", "emoji \u{1F600}"]) assert.throws(() => checkFiberhomeSmsText(text), /plain English text only/, text);
  });
});

describe("fiberhome SMS: the driver", () => {
  it("lists every conversation in the driver's own session, and counts from the listing", async () => {
    const { client, state, mock } = fiberhomeRouter();
    const listed = await client.withSession((s) => smsOf(s).list());
    assert.deepEqual(listed?.map((m) => [m.index, m.phone, m.direction, m.isUnread]).sort((a, b) => Number(a[0]) - Number(b[0])), [
      [2, "DemoBank", "in", false],
      [3, FRIEND, "in", true],
      [4, FRIEND, "in", true],
      [1_000_002, FRIEND, "out", false],
    ]);
    assert.equal(listed?.find((m) => m.index === 3)?.content, "晚上七点吃饭？");
    assert.equal(listed?.find((m) => m.index === 4)?.content, "长短信".repeat(60));
    assert.deepEqual(state.calls.map((c) => c.method), ["get_sms_data"]);
    // One password, the app login's; the session is logged out
    assert.equal(mock.requests.filter((r) => r.body.includes("app_do_login")).length, 1);
    assert.equal(state.logouts, 1);
    const web = mock.requests.find((r) => r.path === "/api/tmp/FHAPIS");
    assert.deepEqual([web?.method, web?.headers["referer"], /^[0-9a-f]+$/.test(web?.body ?? "")], ["POST", "http://192.168.8.1/main.html", true]);

    assert.deepEqual(await client.withSession((s) => smsOf(s).counters()), { localUnread: 2, localInbox: 3, localOutbox: 1, localDraft: 0, localMax: 0 });
    assert.deepEqual(await client.withSession(async (s) => smsOf(s).counters(await smsOf(s).list())), { localUnread: 2, localInbox: 3, localOutbox: 1, localDraft: 0, localMax: 0 });
    assert.deepEqual(await fiberhomeRouter({ sms: {} }).client.withSession((s) => smsOf(s).list()), []);
  });

  it("counts SMS as not on a router that answers the web endpoint with nothing this session can read", async () => {
    for (const web of ["forbidden", "plain"] as const) {
      const { client, mock } = fiberhomeRouter({ web });
      const error = await client.withSession((s) => smsOf(s).list()).then(
        () => null,
        (err: unknown) => err
      );
      assert.equal(sectionUnavailableCode(error), null, web);
      assert.ok(!(error instanceof SectionUnavailableError));
      // No second password went out for it
      assert.equal(mock.requests.filter((r) => r.path.includes("DO_WEB_LOGIN")).length, 0);
    }
  });

  it("sends once, and takes a new sent message in the listing as the router's word that it went out", async () => {
    const { client, state } = fiberhomeRouter();
    const check = newCheck();
    const options = sendOptions();
    assert.deepEqual(await client.withSession((s) => smsWritesOf(s).send(FRIEND, "On my way", check, options)), { state: "sent", code: null });
    assert.equal(options.accepted, 1);
    assert.deepEqual(state.calls.filter((c) => c.method === "send_msg").map((c) => c.data), [{ recv_number: FRIEND, encode_schema: "GSM_8BIT", content: "On my way" }]);
    assert.deepEqual(check.endpoints, ["fiberhome:send_msg"]);

    // The same text again: only a message that was not there before counts
    const again = await client.withSession((s) => smsWritesOf(s).send(FRIEND, "On my way", newCheck(), sendOptions()));
    assert.deepEqual(again, { state: "sent", code: null });
    const silent = fiberhomeRouter({ storesSent: false });
    assert.deepEqual(await silent.client.withSession((s) => smsWritesOf(s).send(FRIEND, "On my way", newCheck(), sendOptions())), { state: "unconfirmed", code: null });
  });

  it("sends nothing when the text could act on the router's command line", async () => {
    const { client, state } = fiberhomeRouter();
    const options = sendOptions();
    const check = newCheck();
    await assert.rejects(client.withSession((s) => smsWritesOf(s).send(FRIEND, "x`reboot`", check, options)), CpeControlValidationError);
    await assert.rejects(client.withSession((s) => smsWritesOf(s).send(FRIEND, "你好", check, options)), CpeControlValidationError);
    assert.deepEqual([state.calls.length, options.accepted, check.endpoints], [0, 0, []]);
  });

  it("marks received messages opened by their node, in one call, and reads the listing back", async () => {
    const { client, state } = fiberhomeRouter();
    const check = newCheck();
    await client.withSession((s) => smsWritesOf(s).markRead([3, 4, 1_000_002], check));
    assert.deepEqual(state.calls.find((c) => c.method === "set_value_by_xmlnode")?.data, {
      url: { smsIsopend2: "InternetGatewayDevice.X_FH_MobileNetwork.SMS_Recv.SMS_RecvMsg.2.isOpened", smsIsopend3: "InternetGatewayDevice.X_FH_MobileNetwork.SMS_Recv.SMS_RecvMsg.3.isOpened" },
      value: { smsIsopend2: "1", smsIsopend3: "1" },
    });
    assert.deepEqual(check, { endpoints: ["fiberhome:set_value_by_xmlnode"], readback: "match", reason: null });
    // Nothing received among them: nothing to send
    const none = newCheck();
    await client.withSession((s) => smsWritesOf(s).markRead([1_000_002], none));
    assert.deepEqual(none.endpoints, []);
  });

  it("deletes a conversation only when every message of it is named, and never names an unsafe sender on the command line", async () => {
    const { client, state } = fiberhomeRouter();
    const part = newCheck();
    await assert.rejects(client.withSession((s) => smsWritesOf(s).delete([3], part)), (err: unknown) => err instanceof CpeControlValidationError && /whole conversation/.test(err.message));
    assert.deepEqual([part.endpoints, state.calls.filter((c) => c.method === "sms_del_session").length], [[], 0]);

    const whole = newCheck();
    await client.withSession((s) => smsWritesOf(s).delete([3, 4, 1_000_002], whole));
    assert.deepEqual(state.calls.filter((c) => c.method === "sms_del_session").map((c) => c.data), [{ del_phone: FRIEND }]);
    assert.deepEqual(Object.keys(state.sms), ["DemoBank"]);
    assert.deepEqual(whole, { endpoints: ["fiberhome:sms_del_session"], readback: "match", reason: null });

    // Already gone: nothing sent
    const gone = newCheck();
    await client.withSession((s) => smsWritesOf(s).delete([3], gone));
    assert.deepEqual(gone.endpoints, []);

    const odd = fiberhomeRouter({ sms: { "Bank';reboot;'": [{ node: 1, sent: false, opened: true, text: "hi", time: "2026-11-10 18:00:00" }] } });
    await assert.rejects(odd.client.withSession((s) => smsWritesOf(s).delete([2], newCheck())), (err: unknown) => err instanceof CpeControlValidationError && /does not pass/.test(err.message));
    assert.equal(odd.state.calls.filter((c) => c.method === "sms_del_session").length, 0);
  });
});

describe("fiberhome SMS: through the SMS service", () => {
  function fixture(opts: Parameters<typeof fiberhomeRouter>[0] = {}) {
    const router = fiberhomeRouter(opts);
    const fx = createBrandSmsFixture({ family: "fiberhome", cpeUrl: "http://192.168.8.1", password: PASSWORD, fetchImpl: router.mock.fetchImpl, model: "LG6121F", service: { seedExistingOnStart: false } });
    return { ...fx, router };
  }

  it("carries the counts on the telemetry session, syncs, marks read on the router and deletes a whole conversation", async () => {
    const fx = fixture();
    try {
      const snap = await fx.core.monitor.refreshTelemetry();
      assert.deepEqual(snap?.sms, { localUnread: 2, localInbox: 3, localOutbox: 1, localDraft: 0, localMax: 0 });
      assert.equal(fx.router.mock.requests.filter((r) => r.body.includes("app_do_login")).length, 1);

      const synced = await fx.service.sync("full");
      assert.deepEqual([synced?.via, synced?.added, synced?.newIncoming], ["driver", 4, 2]);
      // A whole conversation at a time: the console offers one delete per conversation
      assert.deepEqual(fx.service.getStatus().abilities, { send: true, delete: "conversation" });
      const thread = fx.service.getThread(FRIEND);
      await fx.service.markRead({ threadKey: thread.threadKey });
      assert.ok(fx.router.state.sms[FRIEND]?.every((m) => m.opened));

      // One message of three: refused, and it stays in FengSui too
      const one = thread.messages[0]?.uid ?? "";
      await assert.rejects(fx.service.deleteMessages({ uids: [one] }), CpeControlValidationError);
      assert.ok(fx.mirror.get(one));
      const all = await fx.service.deleteMessages({ uids: thread.messages.map((m) => m.uid) });
      assert.equal(all.deleted, 3);
      assert.equal(fx.router.state.sms[FRIEND], undefined);
      assert.equal(fx.service.listTrash().length, 3);
      assert.deepEqual(fx.scheduler.genericWrites.map((r) => [r.action, r.readback]), [
        ["sms_mark_read", "match"],
        ["sms_delete", "match"],
      ]);
    } finally {
      await fx.cleanup();
    }
  });

  it("sends plain text once and refuses the rest before anything goes out", async () => {
    const fx = fixture();
    try {
      const outcome = await fx.service.send({ phones: [FRIEND], content: "On my way", source: "web" });
      assert.deepEqual([outcome.result.ok, outcome.result.timedOutWaitingStatus], [true, false]);
      await assert.rejects(fx.service.send({ phones: [FRIEND], content: "马上到", source: "web" }), CpeControlValidationError);
      assert.equal(fx.router.state.calls.filter((c) => c.method === "send_msg").length, 1);
    } finally {
      await fx.cleanup();
    }
  });

  it("leaves SMS alone on a router whose web endpoint this session cannot read", async () => {
    const fx = fixture({ web: "forbidden" });
    try {
      const snap = await fx.core.monitor.refreshTelemetry();
      assert.equal(snap?.device.deviceName, "LG6121F", "the poll keeps its readings");
      assert.equal(snap?.sms, null);
      assert.equal(fx.scheduler.getStatus().device.reads.sms.state, "unavailable");
      assert.equal(await fx.service.sync("full"), null);
    } finally {
      await fx.cleanup();
    }
  });
});
