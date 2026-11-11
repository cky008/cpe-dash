import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CpeControlValidationError } from "../src/control-error.ts";
import { SectionUnavailableError, sectionUnavailableCode } from "../src/cpe-domain.ts";
import type { WriteCheck } from "../src/device-access.ts";
import { DriverCpeClient } from "../src/drivers/client.ts";
import {
  FIBERHOME_PRO_TOKEN,
  FIBERHOME_PRO_VARIANT,
  checkFiberhomeSmsText,
  fiberhomeDecrypt,
  fiberhomeEncrypt,
  fiberhomeProDecrypt,
  fiberhomeProEncrypt,
  fiberhomeProKey,
  fiberhomeProtocol,
  parseFiberhomeProTelemetry,
  parseFiberhomeSms,
} from "../src/drivers/fiberhome.ts";
import { CpeApiError } from "../src/cpe-client.ts";
import { deviceSupportRow } from "../src/device-catalog.ts";
import { ROUTER_FAMILY_FACTS } from "../src/router-family.ts";
import { DeviceReadOnlyError } from "../src/scheduler.ts";
import { DriverLoginMethodError } from "../src/drivers/login.ts";
import type { DriverSession, DriverSmsSendOptions } from "../src/drivers/types.ts";
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
      assert.deepEqual(fx.service.getStatus().abilities, { send: true, delete: "conversation", markRead: "router" });
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

/** A FiberHome Pro router: `/fh_api/`, the web login, TR-069 nodes, encrypted or plain as `is_encrypt` says. */
function fiberhomeProRouter(opts: { encrypt?: boolean; token?: string; login?: Record<string, unknown>; sms?: Conversations } = {}) {
  let counter = 0;
  let current = "";
  let loggedIn = false;
  const encrypting = opts.encrypt !== false;
  const token = opts.token ?? FIBERHOME_PRO_TOKEN;
  const state = { sms: opts.sms ?? seed(), calls: [] as Array<{ path: string; method: string; data: Record<string, unknown> | null }>, logouts: 0, bodies: [] as string[] };
  const smsData = (): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    let session = 0;
    for (const [phone, messages] of Object.entries(state.sms)) {
      const conversation: Record<string, unknown> = { session_phone: phone };
      messages.forEach((m, i) => {
        conversation[`msg${i}`] = { msg_content: m.text, time: m.time, childnode: String(m.node), isOpened: m.opened ? "1" : "0", rcvorsend: m.sent ? "send" : "recv" };
      });
      out[`session${session++}`] = conversation;
    }
    return out;
  };
  const nodes: Record<string, string> = {
    ModelName: "LG6851F",
    SoftwareVersion: "RP0301",
    HardwareVersion: "WKE2.094.476A01",
    RSRP: "-90",
    RSSI: "-60",
    SINR: "21",
    RSRQ: "-11",
    BAND: "78",
    PCI: "142",
    SSB_RSRP: "-79",
    CarrierName: "Three",
    Modem5GTemperature: "46500",
    Modem4GTemperature: "41000",
    MonthTxBytes: "5368709120",
    MonthRxBytes: "85899345920",
  };
  const mock = new LanRouterMock((req) => {
    // The first series' path is not on this router
    if (req.path.startsWith("/api/")) return { status: 404, text: "" };
    if (req.method === "GET" && req.path === "/fh_api/tmp/FHNCAPIS") {
      if (req.query.get("ajaxmethod") === "is_encrypt") return { json: encrypting ? { enable: "1", data: "c2VhbGVkLXRva2Vu" } : { enable: "0" } };
      current = `sid${String(++counter).padStart(29, "0")}`;
      return { json: { sessionid: current } };
    }
    state.bodies.push(req.body);
    // The router's own key for this session (its page's token, which a mock is free to vary)
    const key = encrypting ? fiberhomeProKey(current, token) : null;
    const plain = encrypting ? fiberhomeProDecrypt(req.body, key) : req.body;
    if (plain === null || (encrypting && req.body.startsWith("{"))) return { text: "error" };
    const body = JSON.parse(plain) as { dataObj: Record<string, unknown> | null; ajaxmethod: string; sessionid: string };
    if (body.sessionid !== current) return { text: "error" };
    state.calls.push({ path: req.path, method: body.ajaxmethod, data: body.dataObj });
    const reply = (payload: unknown) => ({ text: key ? `ab12cd${fiberhomeProEncrypt(JSON.stringify(payload), key).slice(6)}` : JSON.stringify(payload) });
    if (req.path === "/fh_api/tmp/FHNCAPIS" && body.ajaxmethod === "get_device_info") return reply({ model_name: "LG6851F" });
    if (req.path === "/fh_api/sign/DO_WEB_LOGIN") {
      if (opts.login) return reply(opts.login);
      if (body.dataObj?.["password"] !== PASSWORD) return reply({ result: 4 });
      loggedIn = true;
      return reply({ result: 0 });
    }
    if (req.path === "/fh_api/sign/DO_WEB_LOGOUT") {
      loggedIn = false;
      state.logouts += 1;
      return reply({ result: 0 });
    }
    if (!loggedIn) return reply({ result: "timeout" });
    if (body.ajaxmethod === "get_value_by_xmlnode") {
      const asked = body.dataObj ?? {};
      return reply(Object.fromEntries(Object.keys(asked).map((name) => [name, nodes[name] ?? ""])));
    }
    if (body.ajaxmethod === "get_sms_data") return reply(smsData());
    if (body.ajaxmethod === "set_value_by_xmlnode") {
      const urls = (body.dataObj?.["url"] ?? {}) as Record<string, string>;
      for (const path of Object.values(urls)) {
        const node = Number(/SMS_RecvMsg\.(\d+)\.isOpened$/.exec(path)?.[1]);
        for (const messages of Object.values(state.sms)) for (const m of messages) if (!m.sent && m.node === node) m.opened = true;
      }
      return reply({ result: 0 });
    }
    return reply({});
  });
  const client = new DriverCpeClient({ protocol: fiberhomeProtocol, cpeUrl: "http://192.168.8.1", cpeUsername: "admin", cpePassword: PASSWORD, fetchImpl: mock.fetchImpl, requestTimeoutMs: 2000 });
  return { mock, state, client };
}

describe("fiberhome Pro: the key and the wire", () => {
  it("works the key out of the session id and the token, as the page does", () => {
    const sid = "0123456789abcdefghijklmnopqrstuv";
    const key = fiberhomeProKey(sid, "JJ8Hs");
    assert.equal(key.length, 16);
    // The second character's code mod 3, minus 1, moves the token's characters (here "1": 49 % 3 - 1 = 0)
    assert.deepEqual([key[5], key[7], key[10], key[11], key[13]], [..."JJ8Hs"].map((c) => c.charCodeAt(0)));
    // The others: the session id backwards in steps of four, one down; past its start, forwards and one up
    assert.equal(key[0], "u".charCodeAt(0) - 1);
    assert.equal(key[1], "q".charCodeAt(0) - 1);
    assert.equal(key[8], sid.charCodeAt(1) + 1);
    assert.equal(key[15], sid.charCodeAt(29) + 1);
    // Another second character moves the token's characters too
    assert.equal(fiberhomeProKey("0223456789abcdefghijklmnopqrstuv", "JJ8Hs")[5], "J".charCodeAt(0) + 1);
    assert.throws(() => fiberhomeProKey(sid, "JJ"), /too short/);
    assert.throws(() => fiberhomeProKey("x", "JJ8Hs"), /too short/);
  });

  it("sends six characters before the hexadecimal and reads an answer with six before it, or plain JSON", () => {
    const key = fiberhomeProKey("0123456789abcdefghijklmnopqrstuv");
    const body = fiberhomeProEncrypt('{"ajaxmethod":"get_sms_data"}', key);
    assert.match(body, /^[0-9a-z]{6}[0-9a-f]+$/);
    assert.equal(fiberhomeProDecrypt(body, key), '{"ajaxmethod":"get_sms_data"}');
    assert.equal(fiberhomeProDecrypt(`"${body}"`, key), '{"ajaxmethod":"get_sms_data"}');
    assert.equal(fiberhomeProDecrypt(' {"result":0} ', null), '{"result":0}');
    for (const bad of ["", "ab12cd", "ab12cdzz", body.slice(0, -2)]) assert.equal(fiberhomeProDecrypt(bad, key), null, bad);
    assert.equal(fiberhomeProDecrypt(body, fiberhomeProKey("0123456789abcdefghijklmnopqrstxv")), null, "another key opens nothing");
    assert.equal(fiberhomeProDecrypt(body, null), null);
  });

  it("reads the nodes into one serving cell: NR where the SSB RSRP is given, else LTE", () => {
    const nr = parseFiberhomeProTelemetry({ ModelName: "LG6851F", SoftwareVersion: "RP0301", BAND: "78", PCI: "142", SSB_RSRP: "-79", RSRP: "-90", SINR: "21", Modem5GTemperature: "46500", Modem4GTemperature: "41000", MonthRxBytes: "100", CarrierName: "Three" });
    assert.deepEqual([nr.nr?.band, nr.nr?.pci, nr.nr?.rsrpDbm, nr.nr?.sinrDb, nr.lte, nr.temperatureC, nr.operatorName, nr.traffic?.monthDownloadBytes], [78, 142, -79, 21, null, 46.5, "Three", 100n]);
    const lte = parseFiberhomeProTelemetry({ BAND: "1", PCI: "211", RSRP: "-95", SSB_RSRP: "" });
    assert.deepEqual([lte.lte?.band, lte.lte?.pci, lte.lte?.rsrpDbm, lte.nr, lte.traffic, lte.temperatureC], [1, 211, -95, null, null, null]);
    const none = parseFiberhomeProTelemetry({});
    assert.deepEqual([none.lte, none.nr, none.mode], [null, null, null]);
  });
});

describe("fiberhome Pro: the driver", () => {
  it("is told apart by its own path, settles the key on a login-free call, then signs in once and reads", async () => {
    const { client, state, mock } = fiberhomeProRouter();
    const t = await client.withSession((s) => s.telemetry());
    assert.deepEqual([t?.model, t?.softwareVersion, t?.nr?.band, t?.nr?.pci], ["LG6851F", "RP0301", 78, 142]);
    assert.deepEqual(state.calls.map((c) => `${c.path} ${c.method}`), [
      "/fh_api/tmp/FHNCAPIS get_device_info",
      "/fh_api/sign/DO_WEB_LOGIN DO_WEB_LOGIN",
      "/fh_api/tmp/FHAPIS get_value_by_xmlnode",
      "/fh_api/sign/DO_WEB_LOGOUT DO_WEB_LOGOUT",
    ]);
    assert.equal(state.logouts, 1);
    // The password never travels readable: every body is the encrypted form
    assert.ok(state.bodies.every((body) => /^[0-9a-z]{6}[0-9a-f]+$/.test(body)));
    assert.ok(!mock.requests.some((r) => r.body.includes(PASSWORD)));
    const login = state.calls.find((c) => c.method === "DO_WEB_LOGIN");
    assert.deepEqual(login?.data, { username: "admin", password: PASSWORD });
  });

  it("sends no password to a firmware whose key the token on record does not open", async () => {
    const { client, state } = fiberhomeProRouter({ token: "Xy7Qz" });
    await assert.rejects(client.withSession((s) => s.telemetry()), DriverLoginMethodError);
    assert.ok(!state.calls.some((c) => c.method === "DO_WEB_LOGIN"));
    assert.equal(client.getCircuitBreakerState().tripped, false);
  });

  it("speaks plain JSON to a Pro router that does not encrypt", async () => {
    const { client, state } = fiberhomeProRouter({ encrypt: false });
    assert.equal((await client.withSession((s) => s.identify()))?.model, "LG6851F");
    assert.ok(state.bodies.every((body) => body.startsWith("{")));
    assert.ok(!state.calls.some((c) => c.method === "get_device_info"), "no key to settle");
  });

  it("yields, latches and refuses as the web login answers", async () => {
    const busy = fiberhomeProRouter({ login: { result: 1 } });
    assert.equal((await busy.client.withSessionDetailed((s) => s.telemetry())).status, "yielded");
    const wrong = fiberhomeProRouter();
    const bad = new DriverCpeClient({ protocol: fiberhomeProtocol, cpeUrl: "http://192.168.8.1", cpeUsername: "admin", cpePassword: "not-the-password", fetchImpl: wrong.mock.fetchImpl, requestTimeoutMs: 2000 });
    await assert.rejects(bad.withSession((s) => s.telemetry()), (err: unknown) => err instanceof CpeApiError && err.code === "108006");
    const locked = fiberhomeProRouter({ login: { result: 2 } });
    await assert.rejects(locked.client.withSession((s) => s.telemetry()), (err: unknown) => err instanceof CpeApiError && err.code === "108007" && err.waitTime === 60);
    const disabled = fiberhomeProRouter({ login: { result: 3 } });
    await assert.rejects(disabled.client.withSession((s) => s.telemetry()), (err: unknown) => err instanceof CpeApiError && err.latchesBreaker);
  });

  it("refuses in its session what its interface has no record of, sending nothing", async () => {
    const { client, state } = fiberhomeProRouter();
    const runs: Array<(s: DriverSession) => Promise<unknown>> = [(s: DriverSession) => s.lockState(), (s: DriverSession) => s.setBandLock({ lte: [1], nr: null, networkMode: null }, newCheck()), (s: DriverSession) => s.reboot(newCheck()), (s: DriverSession) => s.neighbours()];
    for (const run of runs) {
      await assert.rejects(client.withSession(run));
    }
    assert.ok(!state.calls.some((c) => !["DO_WEB_LOGIN", "DO_WEB_LOGOUT", "get_device_info"].includes(c.method)));
  });

  it("lists SMS and marks read, and has no send or delete", async () => {
    const { client, state } = fiberhomeProRouter();
    const listed = await client.withSession((s) => smsOf(s).list());
    assert.equal(listed?.length, 4);
    const check = newCheck();
    await client.withSession((s) => {
      const sms = smsOf(s);
      assert.ok(sms.markRead);
      return sms.markRead([3], check);
    });
    assert.deepEqual(check, { endpoints: ["fiberhome:set_value_by_xmlnode"], readback: "match", reason: null });
    assert.ok(state.sms[FRIEND]?.find((m) => m.node === 2)?.opened);
    assert.deepEqual(await client.withSession(async (s) => [smsOf(s).send, smsOf(s).delete]), [undefined, undefined]);
  });
});

describe("fiberhome Pro: the gate", () => {
  it("identifies the Pro series through its driver and opens only what its notes have, before any session", async () => {
    const router = fiberhomeProRouter();
    const fx = createBrandSmsFixture({ family: "fiberhome", cpeUrl: "http://192.168.8.1", password: PASSWORD, fetchImpl: router.mock.fetchImpl, model: null });
    try {
      const probe = await fx.core.monitor.identifyDevice();
      assert.deepEqual([probe?.identity.model, probe?.identity.variant], ["LG6851F", FIBERHOME_PRO_VARIANT]);
      // The driver's name for the series is the family's, and the model it is on record with
      assert.ok(ROUTER_FAMILY_FACTS.fiberhome.variants?.[FIBERHOME_PRO_VARIANT]?.models.includes("LG6851F"));
      const device = fx.core.scheduler.getStatus().device;
      assert.deepEqual([device.features.bandLock, device.features.cellLock, device.features.reboot, device.features.smsWrite], ["not_implemented", "not_implemented", "not_implemented", "enabled"]);
      assert.equal(device.reads.neighbors.state, "unavailable");
      // Refused as not implemented here, with no session: nothing reaches the router
      const requests = router.mock.requests.length;
      await assert.rejects(fx.core.controls.lockBands({ lteBands: [1, 3] }), (err: unknown) => err instanceof DeviceReadOnlyError && err.errorCode === "DEVICE_UNVERIFIED_READ_ONLY" && err.feature === "bandLock");
      await assert.rejects(fx.core.controls.unlockAllLocks(), DeviceReadOnlyError);
      await assert.rejects(fx.core.controls.rebootRouter({ confirm: true }), DeviceReadOnlyError);
      assert.equal(router.mock.requests.length, requests);
      // The row of Settings → Device follows the same form
      assert.equal(deviceSupportRow("fiberhome", "LG6851F", { variant: fx.core.scheduler.device.variant }).modules[4]?.mark, "");
      // The variant is kept with the stored identification: the next run starts from it
      fx.core.scheduler.device.forget();
      assert.equal(fx.core.scheduler.device.variant, "pro");
    } finally {
      await fx.cleanup();
    }
  });

  it("checks the form in the write's own session when the router was not identified in this run", async () => {
    const router = fiberhomeProRouter();
    const fx = createBrandSmsFixture({ family: "fiberhome", cpeUrl: "http://192.168.8.1", password: PASSWORD, fetchImpl: router.mock.fetchImpl, model: null });
    try {
      // A first-series model name stored by mistake: the session's own identification says Pro
      fx.core.scheduler.device.remember("LG6121F", "1.0");
      fx.core.scheduler.device.noteVariant("LG6121F", null);
      await assert.rejects(fx.core.controls.lockBands({ lteBands: [1, 3] }), DeviceReadOnlyError);
      assert.equal(fx.core.scheduler.device.variant, "pro");
      assert.ok(!router.state.calls.some((c) => c.method !== "DO_WEB_LOGIN" && c.method !== "DO_WEB_LOGOUT" && c.method !== "get_device_info" && c.method !== "get_value_by_xmlnode"), "nothing but the login and the identification");
    } finally {
      await fx.cleanup();
    }
  });
});

describe("fiberhome Pro: through the SMS service", () => {
  it("syncs, tells the console it cannot send or delete there, and marks read on the router", async () => {
    const router = fiberhomeProRouter();
    const fx = createBrandSmsFixture({ family: "fiberhome", cpeUrl: "http://192.168.8.1", password: PASSWORD, fetchImpl: router.mock.fetchImpl, model: "LG6851F", service: { seedExistingOnStart: false } });
    try {
      const snap = await fx.core.monitor.refreshTelemetry();
      assert.deepEqual([snap?.device.deviceName, snap?.sms?.localInbox], ["LG6851F", 3]);
      const synced = await fx.service.sync("full");
      assert.deepEqual([synced?.added, synced?.newIncoming], [4, 2]);
      assert.deepEqual(fx.service.getStatus().abilities, { send: false, delete: "none", markRead: "router" });
      await fx.service.markRead({ threadKey: fx.service.getThread(FRIEND).threadKey });
      assert.ok(router.state.sms[FRIEND]?.every((m) => m.opened));
      await assert.rejects(fx.service.send({ phones: [FRIEND], content: "hi", source: "web" }), /no way to send/);
    } finally {
      await fx.cleanup();
    }
  });
});
