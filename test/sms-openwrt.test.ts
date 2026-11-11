import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CpeControlValidationError } from "../src/control-error.ts";
import { CpeApiError } from "../src/cpe-client.ts";
import { SectionUnavailableError } from "../src/cpe-domain.ts";
import type { WriteCheck } from "../src/device-access.ts";
import { atErrorCode, parseCmglPdus, parseCpms } from "../src/drivers/at-sms.ts";
import { qmodemText } from "../src/drivers/openwrt.ts";
import type { DriverSession, DriverSms, DriverSmsSendOptions } from "../src/drivers/types.ts";
import { decodeSmsPdu, encodeSmsSubmit, gsm7Septets, packSeptets } from "../src/sms/pdu.ts";
import { OPENWRT_PASSWORD, type StoredPdu, openwrtRouter } from "./helpers/openwrt-router.ts";
import { createBrandSmsFixture, smsOf } from "./helpers/sms-brand-fixture.ts";

/**
 * SMS on an OpenWrt router with a Quectel or Fibocom module: the modem's own AT commands (PDU mode)
 * for reading, counting and deleting, QModem's PDU sender for sending. Mock routers only; reserved
 * test numbers, invented senders.
 */

const FRIEND = "+353830000001";
/** `+353830000001` as an originating address, and the service centre in front of a stored delivery. */
const FROM = "0C91538303000010";
const SMSC = "0791538303000010";

function sendOf(session: DriverSession): NonNullable<DriverSms["send"]> {
  const send = smsOf(session).send;
  if (!send) throw new Error("this session cannot send");
  return send;
}

function deleteOf(session: DriverSession): NonNullable<DriverSms["delete"]> {
  const remove = smsOf(session).delete;
  if (!remove) throw new Error("this session cannot delete");
  return remove;
}

/** An alphanumeric sender as an originating address: 7-bit packed, its length in semi-octets. */
function alphaSender(name: string): string {
  const packed = packSeptets((gsm7Septets(name) ?? []).flat());
  return `${(packed.length * 2).toString(16).toUpperCase().padStart(2, "0")}D0${packed.toString("hex").toUpperCase()}`;
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

/** A stored delivery from `FRIEND`: 7-bit text, at 2026-11-10 12:34:56. */
function delivered(text: string, opts: { from?: string; stamp?: string } = {}): string {
  const septets = (gsm7Septets(text) ?? []).flat();
  const length = septets.length.toString(16).toUpperCase().padStart(2, "0");
  return `${SMSC}04${opts.from ?? FROM}0000${opts.stamp ?? "62110121436500"}${length}${packSeptets(septets).toString("hex").toUpperCase()}`;
}

/** A stored delivery of UCS-2 text. */
function deliveredUcs2(text: string): string {
  const body = Buffer.alloc(text.length * 2);
  for (let i = 0; i < text.length; i++) body.writeUInt16BE(text.charCodeAt(i), i * 2);
  return `${SMSC}04${FROM}0008${"62110121436500"}${body.length.toString(16).toUpperCase().padStart(2, "0")}${body.toString("hex").toUpperCase()}`;
}

/** The two parts of a long UCS-2 message, as deliveries (the encoder's parts carry the same header). */
function deliveredParts(text: string, reference: number): string[] {
  return encodeSmsSubmit(FRIEND, text, reference).pdus.map((submit) => {
    // The user data of the submission (after first octet, reference, address, PID, DCS) is the delivery's
    const userData = submit.slice(2 + 2 + 2 + 16 + 2 + 2);
    return `${SMSC}44${FROM}0008${"62110121436500"}${userData}`;
  });
}

const LONG = "长短信".repeat(40);

function storage(): StoredPdu[] {
  const [first, second] = deliveredParts(LONG, 0x2a);
  return [
    { index: 0, stat: 1, pdu: delivered("Your code is 482913", { from: alphaSender("DemoBank") }) },
    { index: 1, stat: 0, pdu: deliveredUcs2("晚上七点吃饭？") },
    { index: 2, stat: 0, pdu: second ?? "" },
    { index: 3, stat: 0, pdu: first ?? "" },
    { index: 4, stat: 2, pdu: encodeSmsSubmit(FRIEND, "a draft").pdus[0] ?? "" },
    { index: 5, stat: 3, pdu: encodeSmsSubmit(FRIEND, "stored and sent").pdus[0] ?? "" },
  ];
}

describe("AT SMS: what the modem answers", () => {
  it("reads the storage's count from AT+CPMS?", () => {
    assert.deepEqual(parseCpms('+CPMS: "ME",3,50,"ME",3,50,"ME",3,50\n\nOK'), { used: 3, total: 50 });
    assert.deepEqual(parseCpms("+CPMS: 12,30,12,30,12,30\r\n\r\nOK"), { used: 12, total: 30 });
    assert.equal(parseCpms("ERROR"), null);
    assert.equal(parseCpms(""), null);
  });

  it("reads the listed PDUs as parts, one handle above the storage index, leaving out drafts and what does not decode", () => {
    const listed = [
      `+CMGL: 0,1,,${24}`,
      delivered("hello"),
      "+CMGL: 7,0,,30",
      deliveredUcs2("你好"),
      "+CMGL: 8,2,,20",
      encodeSmsSubmit(FRIEND, "draft").pdus[0],
      "+CMGL: 9,3,,20",
      encodeSmsSubmit(FRIEND, "sent").pdus[0],
      "+CMGL: 10,1,,20",
      "0791538303000010",
      "+CMGL: 11,1,,20",
      "not a pdu",
      "+CMGL: 12,1,,26",
      "00060C9153830300000062110121436500621101214365000000",
      "",
      "OK",
    ].join("\r\n");
    assert.deepEqual(
      parseCmglPdus(listed).map((p) => [p.index, p.phone, p.text, p.unread, p.outgoing, p.date]),
      [
        [1, FRIEND, "hello", false, false, "2026-11-10 12:34:56"],
        [8, FRIEND, "你好", true, false, "2026-11-10 12:34:56"],
        [10, FRIEND, "sent", false, true, ""],
      ]
    );
    assert.deepEqual(parseCmglPdus("OK"), []);
  });

  it("keeps the modem's error number, nothing else of an error", () => {
    assert.equal(atErrorCode("+CMS ERROR: 321"), "cms-321");
    assert.equal(atErrorCode("\r\n+CME ERROR: 10\r\n"), "cms-10");
    assert.equal(atErrorCode("ERROR"), null);
    assert.equal(atErrorCode("+CMS ERROR: SIM busy"), null);
  });

  it("finds the modem's text in what QModem answers", () => {
    assert.equal(qmodemText({ at_cfg: { status: "1", res: " OK\n" } }), "OK");
    assert.equal(qmodemText({ result: { res: "+CMGS: 3\n\nOK" } }), "+CMGS: 3\n\nOK");
    assert.equal(qmodemText({ res: "ERROR" }), "ERROR");
    assert.equal(qmodemText({ result: { status: "0" } }), "");
    assert.equal(qmodemText("text"), "");
  });
});

describe("openwrt SMS: the driver", () => {
  it("lists the storage in PDU mode: an alphanumeric sender, Chinese, and a long message joined from parts stored out of order", async () => {
    const { client, state } = openwrtRouter({ sms: storage() });
    const listed = await client.withSession((s) => smsOf(s).list());
    assert.deepEqual(
      listed?.map((m) => [m.index, m.phone, m.direction, m.isUnread]),
      [
        [1, "DemoBank", "in", false],
        [2, FRIEND, "in", true],
        [3, FRIEND, "in", true],
        [6, FRIEND, "out", false],
      ]
    );
    assert.equal(listed?.[0]?.content, "Your code is 482913");
    assert.equal(listed?.[1]?.content, "晚上七点吃饭？");
    assert.equal(listed?.[2]?.content, LONG);
    assert.deepEqual(state.executedCommands.filter((c) => c.startsWith("AT+CM")), ["AT+CMGF=0", "AT+CMGL=4"]);
    assert.equal(state.destroyed, true, "the session is logged out");

    const empty = openwrtRouter({ sms: [] });
    assert.deepEqual(await empty.client.withSession((s) => smsOf(s).list()), []);
  });

  it("counts the storage, and has no SMS on a module without the commands", async () => {
    const { client } = openwrtRouter({ sms: storage() });
    assert.deepEqual(await client.withSession((s) => smsOf(s).counters()), { localUnread: 0, localInbox: 6, localOutbox: 0, localDraft: 0, localMax: 50 });
    const none = openwrtRouter({ sms: false });
    await assert.rejects(none.client.withSession((s) => smsOf(s).counters()), SectionUnavailableError);
    await assert.rejects(none.client.withSession((s) => smsOf(s).list()), SectionUnavailableError);
    // The mode is set but the listing refused (a SIM that is not ready): an error, not "no SMS"
    const busy = openwrtRouter({ sms: storage(), atErrors: ["AT+CMGL"] });
    await assert.rejects(busy.client.withSession((s) => smsOf(s).list()), (err: unknown) => err instanceof CpeApiError && err.code === "at-error");
  });

  it("has no way to mark a message read: listing does that on the modem, and FengSui keeps the state", async () => {
    const { client } = openwrtRouter({ sms: storage() });
    assert.equal(await client.withSession(async (s) => smsOf(s).markRead), undefined);
  });

  it("sends one PDU per part through QModem, and counts the modem's +CMGS as sent", async () => {
    const { client, state, calls } = openwrtRouter({ sms: [], qmodem: true });
    const check = newCheck();
    const options = sendOptions();
    assert.deepEqual(await client.withSession((s) => sendOf(s)(FRIEND, "你好", check, options)), { state: "sent", code: null });
    assert.equal(options.accepted, 1);
    assert.equal(state.sentPdus.length, 1);
    assert.deepEqual(decodeSmsPdu(state.sentPdus[0] ?? ""), { kind: "submit", address: FRIEND, date: "", text: "你好", concat: null });
    assert.deepEqual(calls.find((c) => c.method === "send_raw_pdu")?.args["config_section"], "modem1");
    assert.deepEqual(check.endpoints, ["openwrt:qmodem.send_raw_pdu"]);

    const long = openwrtRouter({ sms: [], qmodem: true });
    await long.client.withSession((s) => sendOf(s)(FRIEND, LONG, newCheck(), sendOptions()));
    const parts = long.state.sentPdus.map((pdu) => decodeSmsPdu(pdu));
    assert.equal(parts.length, 2);
    assert.equal(parts.map((p) => p.text).join(""), LONG);
    assert.equal(parts[0]?.concat?.reference, parts[1]?.concat?.reference);
  });

  it("reports a part the modem refused, and one it did not confirm; sends nothing without QModem", async () => {
    const refused = openwrtRouter({ sms: [], qmodem: true, sendAnswer: "+CMS ERROR: 38" });
    const never = sendOptions();
    assert.deepEqual(await refused.client.withSession((s) => sendOf(s)(FRIEND, "hi", newCheck(), never)), { state: "failed", code: "cms-38" });
    assert.equal(never.accepted, 0);

    const quiet = openwrtRouter({ sms: [], qmodem: true, sendAnswer: "OK" });
    assert.deepEqual(await quiet.client.withSession((s) => sendOf(s)(FRIEND, "hi", newCheck(), sendOptions())), { state: "unconfirmed", code: null });

    const plain = openwrtRouter({ sms: [] });
    const check = newCheck();
    await assert.rejects(plain.client.withSession((s) => sendOf(s)(FRIEND, "hi", check, sendOptions())), (err: unknown) => err instanceof CpeControlValidationError && /QModem/.test(err.message));
    assert.deepEqual(check.endpoints, []);
    assert.ok(!plain.state.executedCommands.some((c) => c.startsWith("AT+CMGS")));
  });

  it("deletes every stored part of a message and reads the storage's count back", async () => {
    const { client, state } = openwrtRouter({ sms: storage() });
    const check = newCheck();
    // The long message (handle 3: parts at storage 2 and 3) and the first one
    await client.withSession((s) => deleteOf(s)([3, 1], check));
    assert.deepEqual(state.executedCommands.filter((c) => c.startsWith("AT+CMGD")), ["AT+CMGD=2", "AT+CMGD=3", "AT+CMGD=0"]);
    assert.deepEqual(state.sms.map((part) => part.index), [1, 4, 5]);
    assert.deepEqual(check, { endpoints: ["openwrt:AT+CMGD"], readback: "match", reason: null });
  });

  it("sends nothing for a message already gone, and stops at a delete the modem refuses", async () => {
    const { client, state } = openwrtRouter({ sms: storage() });
    const gone = newCheck();
    await client.withSession((s) => deleteOf(s)([40], gone));
    assert.deepEqual([gone.endpoints, gone.readback], [[], "none"]);
    assert.ok(!state.executedCommands.some((c) => c.startsWith("AT+CMGD")));

    const refused = openwrtRouter({ sms: storage(), atErrors: ["AT+CMGD"] });
    await assert.rejects(refused.client.withSession((s) => deleteOf(s)([1], newCheck())), (err: unknown) => err instanceof CpeApiError && err.code === "at-error");
  });

  it("speaks to a router that has only QModem's own AT method, naming its modem section and port", async () => {
    const { client, calls, state } = openwrtRouter({ sms: storage(), qmodem: true, modemRpcObject: "qmodem" });
    const listed = await client.withSession((s) => smsOf(s).list());
    assert.equal(listed?.length, 4);
    const at = calls.filter((c) => c.object === "qmodem" && c.method === "send_at");
    assert.deepEqual(at[0]?.args, { config_section: "modem1", params: { at: "ATI", port: "/dev/ttyUSB2" } });
    assert.ok(state.executedCommands.includes("AT+CMGL=4"));
    // Looked for once
    assert.equal(calls.filter((c) => c.object === "uci").length, 1);
  });
});

describe("openwrt SMS: through the SMS service", () => {
  function fixture(opts: Parameters<typeof openwrtRouter>[0] = {}) {
    const router = openwrtRouter({ sms: storage(), qmodem: true, ...opts });
    const fx = createBrandSmsFixture({ family: "openwrt", cpeUrl: "http://192.168.1.1", username: "root", password: OPENWRT_PASSWORD, fetchImpl: router.mock.fetchImpl, model: "RM520N-GL", service: { seedExistingOnStart: false } });
    return { ...fx, router };
  }

  it("carries the storage's count on the telemetry session and syncs when it moves", async () => {
    const fx = fixture();
    try {
      const snap = await fx.core.monitor.refreshTelemetry();
      assert.deepEqual(snap?.sms, { localUnread: 0, localInbox: 6, localOutbox: 0, localDraft: 0, localMax: 50 });
      const synced = await fx.service.sync("full");
      assert.deepEqual([synced?.mode, synced?.via, synced?.added, synced?.newIncoming], ["full", "driver", 4, 2]);
      assert.deepEqual((fx.named("sms:new") as Array<{ content: string }>).map((m) => m.content), ["晚上七点吃饭？", LONG]);
      // The counts of the listing are the same as the poll's: nothing more to sync
      assert.equal(fx.service.getStatus().syncPending, false);
      assert.equal(fx.service.getStatus().unreadOnCpe, 0);
    } finally {
      await fx.cleanup();
    }
  });

  it("keeps a message unread until the owner reads it, though the modem calls it read once listed, and writes nothing to mark it", async () => {
    const fx = fixture();
    try {
      await fx.service.sync("full");
      // The modem now lists both as read
      assert.ok(fx.router.state.sms.every((part) => part.stat !== 0));
      await fx.service.sync("full");
      const thread = fx.service.getThread(FRIEND);
      assert.equal(thread.messages.filter((m) => m.isUnread).length, 2);
      const before = fx.router.mock.requests.length;
      const read = await fx.service.markRead({ threadKey: thread.threadKey });
      assert.equal(read.count, 2);
      assert.equal(fx.router.mock.requests.length, before, "no session, nothing written");
      await fx.service.sync("full");
      assert.equal(fx.service.getThread(FRIEND).messages.filter((m) => m.isUnread).length, 0);
      assert.equal(fx.scheduler.genericWrites.length, 0);
    } finally {
      await fx.cleanup();
    }
  });

  it("sends through QModem and keeps its own copy, which the next full sync leaves in place", async () => {
    const fx = fixture({ sms: [] });
    try {
      const outcome = await fx.service.send({ phones: [FRIEND], content: "On my way", source: "web" });
      assert.deepEqual([outcome.result.ok, outcome.result.timedOutWaitingStatus, outcome.result.sentPhones], [true, false, [FRIEND]]);
      assert.equal(fx.router.state.sentPdus.length, 1);
      assert.deepEqual([outcome.messages[0]?.localOnly, outcome.messages[0]?.pending], [true, undefined]);
      await fx.service.sync("full");
      assert.deepEqual(fx.service.getThread(FRIEND).messages.map((m) => [m.content, m.direction]), [["On my way", "out"]]);
      const record = fx.scheduler.genericWrites.at(-1);
      assert.deepEqual([record?.action, record?.readback, record?.endpoints], ["sms_send", "match", ["openwrt:qmodem.send_raw_pdu"]]);
    } finally {
      await fx.cleanup();
    }
  });

  it("refuses a send where the router has no QModem, with nothing sent and nothing recorded as a write", async () => {
    const fx = fixture({ sms: [], qmodem: false });
    try {
      await assert.rejects(fx.service.send({ phones: [FRIEND], content: "hi", source: "mcp" }), (err: unknown) => err instanceof CpeControlValidationError && /QModem/.test(err.message));
      assert.equal(fx.named("sms:sent").length, 0);
      assert.equal(fx.scheduler.genericWrites.length, 0);
    } finally {
      await fx.cleanup();
    }
  });

  it("deletes a long message with all its parts, and keeps it in Recently deleted", async () => {
    const fx = fixture();
    try {
      await fx.service.sync("full");
      const uid = fx.service.getThread(FRIEND).messages.find((m) => m.content === LONG)?.uid ?? "";
      await fx.service.deleteMessages({ uids: [uid] });
      assert.deepEqual(fx.router.state.sms.map((part) => part.index), [0, 1, 4, 5]);
      assert.deepEqual(fx.service.listTrash().map((m) => m.content), [LONG]);
      assert.deepEqual(fx.scheduler.genericWrites.map((r) => [r.action, r.readback, r.endpoints]), [["sms_delete", "match", ["openwrt:AT+CMGD"]]]);
    } finally {
      await fx.cleanup();
    }
  });
});
