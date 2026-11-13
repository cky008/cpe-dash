import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { type EphemeralCpeSession, HuaweiCpeClient } from "../src/protocols/hilink/client.ts";
import { CpeAnswerFormatError, CpeApiError } from "../src/session-errors.ts";
import { CpeControlValidationError } from "../src/cpe-domain.ts";
import { genericBandLock, genericMobileData, genericReboot, genericReconnect, readWanRepairBlockerTolerant } from "../src/protocols/hilink/generic-writes.ts";
import { newWriteCheck } from "../src/device-access.ts";
import { validateGenericBandLock } from "../src/control-input.ts";
import { genericDeleteSms, genericMarkSmsRead, genericSendSms } from "../src/sms/protocol.ts";
import { prepareSmsSubmission } from "../src/sms/submission.ts";
import { validateGenericSmsContent } from "../src/sms/text-mode.ts";
import { type CpeFamilyOptions, type FamilySms, type FamilyWrites, blockNetwork, createCpeFamily } from "./helpers/cpe-family.ts";

/**
 * Multi-model phase 3: the generic writes FengSui may do on a model nobody verified, once its owner
 * consents, in exactly the request formats of docs/dev/protocol.md appendix A.11. Each one
 * is read back in its own session where it can be (the redial and the reboot are left pending for
 * the next polls), never retried, and records the endpoints it wrote without any value. The mock
 * routers answer only those forms. Placeholders only, no network.
 */

const ADVERTISED = [1, 3, 7, 8, 20, 32];
const NET_MODE = "<response><NetworkMode>03</NetworkMode><NetworkBand>3FFFFFFF</NetworkBand><LTEBand>800800C5</LTEBand></response>";
const MAILBOX: ReadonlyArray<FamilySms> = [
  { index: 40001, phone: "+353830000001", content: "Dinner at 7?", date: "2026-11-02 18:00:00", smstat: "0", box: 1 },
  { index: 40002, phone: "DemoBank", content: "Your DemoBank code is 482913", date: "2026-11-02 19:00:00", smstat: "0", box: 1 },
  { index: 39001, phone: "+353830000001", content: "See you there", date: "2026-11-02 18:05:00", smstat: "3", box: 2 },
];

function router(writes: FamilyWrites = {}, extra: Partial<CpeFamilyOptions> = {}) {
  const cpe = createCpeFamily({ login: "sha256", tokenFlow: "token", model: "B535-232", endpoints: { "/api/net/net-mode": NET_MODE }, sms: MAILBOX, writes, ...extra });
  const client = new HuaweiCpeClient({ cpeUrl: "http://192.168.8.1", cpePassword: cpe.password, fetchImpl: cpe.fetchImpl, requestTimeoutMs: 2000 });
  /** One session; the requests it sent between login and logout. */
  const session = async <T>(fn: (s: EphemeralCpeSession) => Promise<T>): Promise<{ value: T; inside: string[] }> => {
    const start = cpe.stats.requests.length;
    const value = await client.withSession(fn);
    const sent = cpe.stats.requests.slice(start).map((r) => `${r.method} ${r.path}`);
    const from = sent.findIndex((r) => r === "POST /api/user/login") + 1;
    const to = sent.lastIndexOf("POST /api/user/logout");
    assert.ok(from > 0 && to > from, "logged in and out");
    return { value: value as T, inside: sent.slice(from, to).filter((r) => r !== "GET /api/webserver/token") };
  };
  return { cpe, session };
}

const posts = (cpe: ReturnType<typeof router>["cpe"]): Array<{ path: string; body: string }> =>
  cpe.stats.writes.map((w) => ({ path: w.path, body: w.body.replace(/^<\?xml[^>]*\?>/, "") }));

let restore: () => void;
before(() => {
  restore = blockNetwork();
});
after(() => restore());

describe("generic writes: LTE band lock (net/net-mode)", () => {
  it("sends the router's own mode and 2G/3G bands back, changes only LTEBand, and reads it back", async () => {
    const { cpe, session } = router();
    const check = newWriteCheck();
    const { value, inside } = await session((s) => genericBandLock(s, check, [1, 3], ADVERTISED));
    // The mask it replaced comes back too (lowercase, as A.11 writes it), for an AI agent's test to be undone
    assert.deepEqual(value, { bands: [1, 3], before: "800800c5" });
    assert.deepEqual(posts(cpe), [{ path: "/api/net/net-mode", body: "<request><NetworkMode>03</NetworkMode><NetworkBand>3FFFFFFF</NetworkBand><LTEBand>5</LTEBand></request>" }]);
    assert.deepEqual(inside, ["GET /api/net/net-mode", "POST /api/net/net-mode", "GET /api/net/net-mode"]);
    assert.deepEqual(check, { endpoints: ["/api/net/net-mode"], readback: "match", reason: null });
    assert.equal(cpe.settings.netMode.LTEBand, "5");
  });

  it("unlocks with the all-bands mask, and a read-back naming every advertised band counts as unlocked", async () => {
    const plain = router();
    const check = newWriteCheck();
    await plain.session((s) => genericBandLock(s, check, "all", ADVERTISED));
    assert.equal(posts(plain.cpe)[0]?.body, "<request><NetworkMode>03</NetworkMode><NetworkBand>3FFFFFFF</NetworkBand><LTEBand>7fffffffffffffff</LTEBand></request>");
    assert.equal(check.readback, "match");
    // A firmware that shows its own band mask after an unlock (the H168-383 does so)
    const own = router({ ignore: true });
    const ownCheck = newWriteCheck();
    await own.session((s) => genericBandLock(s, ownCheck, "all", ADVERTISED));
    assert.deepEqual([ownCheck.readback, ownCheck.reason], ["match", null]);
    // With no advertised bands to compare against, only the all-bands mask itself shows an unlock
    const blind = router({ ignore: true });
    const blindCheck = newWriteCheck();
    await blind.session((s) => genericBandLock(s, blindCheck, "all", []));
    assert.deepEqual([blindCheck.readback, blindCheck.reason], ["unknown", "unreadable"]);
  });

  it("writes a saved mask back as it was and reads it back: the setting from before an AI agent's test", async () => {
    const { cpe, session } = router();
    await session((s) => genericBandLock(s, newWriteCheck(), [1, 3], ADVERTISED));
    const check = newWriteCheck();
    const { value, inside } = await session((s) => genericBandLock(s, check, { savedMask: "800800c5" }, ADVERTISED));
    assert.equal(posts(cpe)[1]?.body, "<request><NetworkMode>03</NetworkMode><NetworkBand>3FFFFFFF</NetworkBand><LTEBand>800800c5</LTEBand></request>");
    assert.deepEqual(inside, ["GET /api/net/net-mode", "POST /api/net/net-mode", "GET /api/net/net-mode"]);
    assert.deepEqual(check, { endpoints: ["/api/net/net-mode"], readback: "match", reason: null });
    // That mask turns on every advertised band: unlocked again
    assert.deepEqual(value, { bands: "all", before: "5" });
    // A saved lock comes back as that lock
    assert.deepEqual((await session((s) => genericBandLock(s, newWriteCheck(), { savedMask: "5" }, ADVERTISED))).value, { bands: [1, 3], before: "800800c5" });
    // Anything that is not a mask is never sent
    await assert.rejects(session((s) => genericBandLock(s, newWriteCheck(), { savedMask: "5</LTEBand>" }, ADVERTISED)), CpeControlValidationError);
    assert.equal(posts(cpe).length, 3);
  });

  it("reports a router that acknowledges the lock but keeps its old bands", async () => {
    const { session } = router({ ignore: true });
    const check = newWriteCheck();
    await session((s) => genericBandLock(s, check, [3], ADVERTISED));
    assert.deepEqual(check, { endpoints: ["/api/net/net-mode"], readback: "mismatch", reason: "differs" });
  });

  it("allows only bands the router advertises, LTE only, before any session", () => {
    assert.deepEqual(validateGenericBandLock({ lteBands: ["B3", 1] }, ADVERTISED), [1, 3]);
    assert.equal(validateGenericBandLock({ lteBands: "all" }, ADVERTISED), "all");
    const refused = (command: Parameters<typeof validateGenericBandLock>[0], bands: ReadonlyArray<number> | null = ADVERTISED) =>
      assert.throws(() => validateGenericBandLock(command, bands), CpeControlValidationError);
    refused({ lteBands: [1, 28] }, ADVERTISED);
    refused({ lteBands: [] });
    refused({ nrBands: ["N78"] });
    refused({ lteBands: [1], nrBands: "all" });
    refused({});
    refused({ lteBands: [1] }, null);
    refused({ lteBands: [1] }, []);
  });

  it("is refused once and never retried; nothing is guessed when net-mode lacks a field", async () => {
    const { cpe, session } = router({ errors: { "/api/net/net-mode": "100003" } });
    const check = newWriteCheck();
    await assert.rejects(
      session((s) => genericBandLock(s, check, [1], ADVERTISED)),
      (err) => err instanceof CpeApiError && err.code === "100003"
    );
    assert.equal(posts(cpe).length, 1, "one POST, no retry");
    assert.deepEqual(check, { endpoints: ["/api/net/net-mode"], readback: "none", reason: null });

    // A net-mode answer without NetworkBand: nothing to send back, so nothing is written
    const writes: string[] = [];
    const bare = {
      get: async () => "<response><NetworkMode>00</NetworkMode><LTEBand>5</LTEBand></response>",
      postXml: async (apiPath: string) => {
        writes.push(apiPath);
        return "<response>OK</response>";
      },
    } as unknown as EphemeralCpeSession;
    await assert.rejects(genericBandLock(bare, newWriteCheck(), [1], ADVERTISED), CpeAnswerFormatError);
    assert.deepEqual(writes, []);
  });

  it("says unknown when the read-back cannot be read, without failing a write the router took", async () => {
    let gets = 0;
    const session = {
      get: async () => {
        gets += 1;
        if (gets > 1) throw new CpeApiError("100004");
        return NET_MODE;
      },
      postXml: async () => "<response>OK</response>",
    } as unknown as EphemeralCpeSession;
    const check = newWriteCheck();
    assert.deepEqual(await genericBandLock(session, check, [1], ADVERTISED), { bands: [1], before: "800800c5" });
    assert.deepEqual(check, { endpoints: ["/api/net/net-mode"], readback: "unknown", reason: "unreadable" });
  });
});

describe("generic writes: mobile data, redial, reboot", () => {
  it("switches mobile data and reads the switch back", async () => {
    const { cpe, session } = router();
    const off = newWriteCheck();
    const { inside } = await session((s) => genericMobileData(s, off, false));
    assert.deepEqual(inside, ["POST /api/dialup/mobile-dataswitch", "GET /api/dialup/mobile-dataswitch"]);
    assert.equal(posts(cpe)[0]?.body, "<request><dataswitch>0</dataswitch></request>");
    assert.deepEqual(off, { endpoints: ["/api/dialup/mobile-dataswitch"], readback: "match", reason: null });
    assert.equal(cpe.settings.mobileData(), "0");

    const ignored = router({ ignore: true });
    const check = newWriteCheck();
    await ignored.session((s) => genericMobileData(s, check, false));
    assert.deepEqual([check.readback, check.reason], ["mismatch", "differs"]);
  });

  it("redials with ReconnectAction and reboots with Control 1 only, leaving the check to the next polls", async () => {
    const { cpe, session } = router();
    const redial = newWriteCheck();
    const reboot = newWriteCheck();
    await session((s) => genericReconnect(s, redial));
    await session((s) => genericReboot(s, reboot));
    assert.deepEqual(posts(cpe), [
      { path: "/api/net/reconnect", body: "<request><ReconnectAction>1</ReconnectAction></request>" },
      { path: "/api/device/control", body: "<request><Control>1</Control></request>" },
    ]);
    assert.deepEqual([cpe.stats.reconnects, cpe.stats.reboots], [1, 1]);
    assert.deepEqual(redial, { endpoints: ["/api/net/reconnect"], readback: "pending", reason: null });
    assert.deepEqual(reboot, { endpoints: ["/api/device/control"], readback: "pending", reason: null });
  });

  it("checks the WAN before a repair without failing on a switch the model lacks", async () => {
    const answers = (status: string, dataswitch: string | Error) =>
      ({
        get: async (apiPath: string) => {
          if (apiPath === "/api/monitoring/status") return `<response><ConnectionStatus>${status}</ConnectionStatus></response>`;
          if (dataswitch instanceof Error) throw dataswitch;
          return `<response><dataswitch>${dataswitch}</dataswitch></response>`;
        },
      }) as unknown as EphemeralCpeSession;
    assert.equal(await readWanRepairBlockerTolerant(answers("901", "1")), "wan_up");
    assert.equal(await readWanRepairBlockerTolerant(answers("902", "0")), "mobile_data_off");
    assert.equal(await readWanRepairBlockerTolerant(answers("902", "1")), null);
    assert.equal(await readWanRepairBlockerTolerant(answers("902", new CpeApiError("100002"))), null, "a model without the switch does not block the repair");
    await assert.rejects(readWanRepairBlockerTolerant(answers("902", new TypeError("fetch failed"))), TypeError, "a broken session still fails it");
  });
});

describe("generic writes: plaintext SMS", () => {
  it("sends in the reference form, polls send-status in the clear, and calls a settled send a match", async () => {
    const { cpe, session } = router();
    const check = newWriteCheck();
    const prepared = prepareSmsSubmission(["+353830000002"], "Ok, 7 it is & <see> you \"there\"");
    let accepted = false;
    const { value, inside } = await session((s) =>
      genericSendSms(s, check, prepared, { sleep: async () => undefined, onAccepted: () => (accepted = true) })
    );
    const sent = posts(cpe)[0];
    assert.equal(sent?.path, "/api/sms/send-sms");
    assert.match(
      sent?.body ?? "",
      /^<request><Index>-1<\/Index><Phones><Phone>\+353830000002<\/Phone><\/Phones><Sca><\/Sca><Content>Ok, 7 it is &amp; &lt;see&gt; you "there"<\/Content><Length>31<\/Length><Reserved>1<\/Reserved><Date>\d{4}-\d\d-\d\d \d\d:\d\d:\d\d<\/Date><\/request>$/
    );
    assert.deepEqual(inside, ["POST /api/sms/send-sms", "GET /api/sms/send-status", "GET /api/sms/send-status"]);
    assert.ok(accepted);
    assert.deepEqual([value.ok, value.sentPhones, value.timedOutWaitingStatus], [true, ["+353830000002"], false]);
    assert.deepEqual(check, { endpoints: ["/api/sms/send-sms"], readback: "match", reason: null });
  });

  it("marks UCS-2 text, refuses characters outside the basic plane, and reads failed or unsettled sends as such", async () => {
    const { cpe, session } = router();
    await session((s) => genericSendSms(s, newWriteCheck(), prepareSmsSubmission(["+353830000002"], "晚上见"), { sleep: async () => undefined }));
    assert.match(posts(cpe)[0]?.body ?? "", /<Content>晚上见<\/Content><Length>3<\/Length><Reserved>0<\/Reserved>/);
    assert.throws(() => validateGenericSmsContent("See you 🙂"), CpeControlValidationError);
    validateGenericSmsContent("See you, café");
    // The send checks it too, before any request (the check before queueing may have seen another model)
    const emoji = router();
    await assert.rejects(
      emoji.session((s) => genericSendSms(s, newWriteCheck(), prepareSmsSubmission(["+353830000002"], "See you 🙂"), { sleep: async () => undefined })),
      CpeControlValidationError
    );
    assert.deepEqual(posts(emoji.cpe), []);

    const failed = router({ smsOutcome: "failed" });
    const failedCheck = newWriteCheck();
    const result = await failed.session((s) => genericSendSms(s, failedCheck, prepareSmsSubmission(["+353830000002"], "hi"), { sleep: async () => undefined }));
    assert.deepEqual([result.value.ok, result.value.failCode, failedCheck.readback, failedCheck.reason], [false, "113018", "mismatch", "send_failed"]);

    const stuck = router({ smsOutcome: "never" });
    const stuckCheck = newWriteCheck();
    let clock = 0;
    const stuckResult = await stuck.session((s) =>
      genericSendSms(s, stuckCheck, prepareSmsSubmission(["+353830000002"], "hi"), { sleep: async (ms) => void (clock += ms), now: () => clock, statusTimeoutMs: 6000 })
    );
    assert.deepEqual([stuckResult.value.ok, stuckResult.value.timedOutWaitingStatus, stuckCheck.readback, stuckCheck.reason], [true, true, "unknown", "send_unconfirmed"]);
    assert.equal(stuck.cpe.stats.writes.filter((w) => w.path === "/api/sms/send-sms").length, 1, "a send is never repeated");
  });

  it("calls a send a match only when send-status names its recipients as delivered", async () => {
    // A status with none of the fields FengSui reads: the send is reported as before, its read-back proves nothing
    const silent = router({ smsOutcome: "silent" });
    const silentCheck = newWriteCheck();
    const quiet = await silent.session((s) => genericSendSms(s, silentCheck, prepareSmsSubmission(["+353830000002"], "hi"), { sleep: async () => undefined }));
    assert.deepEqual([quiet.value.ok, quiet.value.timedOutWaitingStatus], [true, false]);
    assert.deepEqual(silentCheck, { endpoints: ["/api/sms/send-sms"], readback: "unknown", reason: "unreadable" });
    assert.equal(silent.cpe.stats.writes.filter((w) => w.path === "/api/sms/send-sms").length, 1, "a send is never repeated");

    // Two recipients, one named as delivered and none as failed: not a match either
    const partial = router({ smsOutcome: "partial" });
    const partialCheck = newWriteCheck();
    await partial.session((s) => genericSendSms(s, partialCheck, prepareSmsSubmission(["+353830000002", "+353830000003"], "hi"), { sleep: async () => undefined }));
    assert.deepEqual([partialCheck.readback, partialCheck.reason], ["unknown", "unreadable"]);
    const both = router();
    const bothCheck = newWriteCheck();
    await both.session((s) => genericSendSms(s, bothCheck, prepareSmsSubmission(["+353830000002", "+353830000003"], "hi"), { sleep: async () => undefined }));
    assert.deepEqual([bothCheck.readback, bothCheck.reason], ["match", null]);
  });

  it("marks read and deletes one message per request, and checks the counts", async () => {
    const { cpe, session } = router();
    const read = newWriteCheck();
    const { value: marked, inside } = await session((s) => genericMarkSmsRead(s, read, [40001, 40002]));
    assert.equal(marked, 2);
    assert.deepEqual(inside, ["GET /api/sms/sms-count", "POST /api/sms/set-read", "POST /api/sms/set-read", "GET /api/sms/sms-count"]);
    assert.deepEqual(posts(cpe).map((p) => p.body), ["<request><Index>40001</Index></request>", "<request><Index>40002</Index></request>"]);
    assert.deepEqual(read, { endpoints: ["/api/sms/set-read"], readback: "match", reason: null });

    const del = newWriteCheck();
    await session((s) => genericDeleteSms(s, del, [39001]));
    assert.deepEqual(posts(cpe).at(-1), { path: "/api/sms/delete-sms", body: "<request><Index>39001</Index></request>" });
    assert.deepEqual(del, { endpoints: ["/api/sms/delete-sms"], readback: "match", reason: null });

    const ignored = router({ ignore: true });
    const stale = newWriteCheck();
    await ignored.session((s) => genericDeleteSms(s, stale, [39001]));
    assert.deepEqual([stale.readback, stale.reason], ["mismatch", "no_change"]);
  });
});
