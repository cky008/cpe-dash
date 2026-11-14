import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WriteCheck } from "../src/device-access.ts";
import { assembleSegments, countListed, dateOfParts, settleSmsCount, settleSmsListing, settleSmsSend, storedIndices, wireMessage } from "../src/drivers/sms.ts";
import { type SmsSegment } from "../src/protocols/at/sms.ts";

/** What the drivers share for SMS, whichever router they speak to. Reserved test numbers only. */

const FRIEND = "+353830000001";

function newCheck(): WriteCheck {
  return { endpoints: [], readback: "none", reason: null };
}

function segment(over: Partial<SmsSegment> & Pick<SmsSegment, "index" | "text">): SmsSegment {
  return { phone: FRIEND, date: "2026-11-10 12:00:00", unread: false, outgoing: false, concat: null, ...over };
}

describe("driver SMS: a stored message in one shape", () => {
  it("writes the status the mirror reads, and never calls a sent message unread", () => {
    assert.deepEqual(wireMessage({ index: 1, phone: FRIEND, content: "hi", date: "", unread: true, outgoing: false }), { index: 1, phone: FRIEND, content: "hi", date: "", smstat: "0", isUnread: true, direction: "in" });
    assert.equal(wireMessage({ index: 1, phone: FRIEND, content: "hi", date: "", unread: false, outgoing: false }).smstat, "1");
    assert.deepEqual([wireMessage({ index: 1, phone: FRIEND, content: "hi", date: "", unread: true, outgoing: true }).smstat, wireMessage({ index: 1, phone: FRIEND, content: "hi", date: "", unread: true, outgoing: true }).isUnread], ["3", false]);
  });

  it("keeps what a router sent as bounded text without control characters", () => {
    const message = wireMessage({ index: 1, phone: ` ${FRIEND}\u0000 `, content: `a\u0007b${"x".repeat(50_000)}`, date: "", unread: false, outgoing: false });
    assert.equal(message.phone, FRIEND);
    assert.ok(message.content.startsWith("ab"));
    assert.equal(message.content.length, 39_999);
  });

  it("writes only handles a router can have", () => {
    assert.deepEqual(storedIndices([3, 3, 0, -1, 2.5, Number.NaN, 7]), [3, 7]);
  });

  it("reads a date from its parts, two-digit or four-digit year", () => {
    assert.equal(dateOfParts(["26", "1", "2", "3", "4", "5"]), "2026-01-02 03:04:05");
    assert.equal(dateOfParts(["2026", "11", "10", "23", "59", "59", "+8"]), "2026-11-10 23:59:59");
    for (const bad of [["26", "1", "2"], ["26", "0", "2", "3", "4", "5"], ["26", "1", "32", "3", "4", "5"], ["26", "1", "2", "24", "4", "5"], ["26", "1", "2", "3", "60", "5"], ["26", "1", "2", "3", "4", "61"], ["x", "1", "2", "3", "4", "5"]]) {
      assert.equal(dateOfParts(bad), "", bad.join(","));
    }
  });
});

describe("driver SMS: joining the parts of a long message", () => {
  it("joins the parts of one sender and reference in sequence order, under the first stored part's handle", () => {
    const joined = assembleSegments([
      segment({ index: 7, text: "third.", concat: { reference: 9, total: 3, sequence: 3 }, date: "2026-11-10 12:00:02" }),
      segment({ index: 5, text: "first, ", concat: { reference: 9, total: 3, sequence: 1 }, unread: true }),
      segment({ index: 6, text: "second, ", concat: { reference: 9, total: 3, sequence: 2 } }),
      segment({ index: 2, text: "short" }),
    ]);
    assert.deepEqual(joined.map((j) => [j.message.index, j.message.content, j.parts]), [
      [2, "short", [2]],
      [5, "first, second, third.", [5, 6, 7]],
    ]);
    // Unread while any part is; the time of the first stored part
    assert.deepEqual([joined[1]?.message.isUnread, joined[1]?.message.date], [true, "2026-11-10 12:00:00"]);
  });

  it("keeps messages apart that only share a reference: another sender, another total, the other direction", () => {
    const concat = { reference: 1, total: 2, sequence: 1 };
    const joined = assembleSegments([
      segment({ index: 1, text: "a", concat }),
      segment({ index: 2, text: "b", concat, phone: "DemoBank" }),
      segment({ index: 3, text: "c", concat: { ...concat, total: 3 } }),
      segment({ index: 4, text: "d", concat, outgoing: true }),
    ]);
    assert.deepEqual(joined.map((j) => j.message.content), ["a", "b", "c", "d"]);
    assert.equal(joined[3]?.message.direction, "out");
  });

  it("shows what has arrived of an incomplete message, and counts a part stored twice once", () => {
    const joined = assembleSegments([
      segment({ index: 4, text: "end", concat: { reference: 2, total: 3, sequence: 3 } }),
      segment({ index: 3, text: "start ", concat: { reference: 2, total: 3, sequence: 1 } }),
      segment({ index: 9, text: "start ", concat: { reference: 2, total: 3, sequence: 1 } }),
    ]);
    assert.deepEqual([joined[0]?.message.content, joined[0]?.parts], ["start end", [3, 4, 9]]);
    assert.deepEqual(assembleSegments([]), []);
  });
});

describe("driver SMS: counts and read-backs", () => {
  it("counts a listing, with no unread count where the router keeps none worth showing", () => {
    const messages = [
      wireMessage({ index: 1, phone: FRIEND, content: "a", date: "", unread: true, outgoing: false }),
      wireMessage({ index: 2, phone: FRIEND, content: "b", date: "", unread: false, outgoing: false }),
      wireMessage({ index: 3, phone: FRIEND, content: "c", date: "", unread: false, outgoing: true }),
    ];
    assert.deepEqual(countListed(messages, 50, { unread: true }), { localUnread: 1, localInbox: 2, localOutbox: 1, localDraft: 0, localMax: 50 });
    assert.equal(countListed(messages, 50, { unread: false }).localUnread, 0);
  });

  it("settles a send by what the router said of each recipient", () => {
    const settle = (states: Array<"sent" | "failed" | "unconfirmed">): Array<string | null> => {
      const check = newCheck();
      settleSmsSend(check, states.map((state) => ({ state, code: null })));
      return [check.readback, check.reason];
    };
    assert.deepEqual(settle(["sent", "sent"]), ["match", null]);
    assert.deepEqual(settle(["sent", "failed"]), ["mismatch", "send_failed"]);
    assert.deepEqual(settle(["sent", "unconfirmed"]), ["unknown", "send_unconfirmed"]);
    assert.deepEqual(settle([]), ["unknown", "send_unconfirmed"]);
  });

  it("settles a change by the count before and after", () => {
    const settle = (before: number | null, after: number | null, expected: number): Array<string | null> => {
      const check = newCheck();
      settleSmsCount(check, before, after, expected);
      return [check.readback, check.reason];
    };
    assert.deepEqual(settle(5, 3, 2), ["match", null]);
    assert.deepEqual(settle(5, 5, 2), ["mismatch", "no_change"]);
    assert.deepEqual(settle(5, 4, 2), ["unknown", "unclear_change"]);
    assert.deepEqual(settle(null, 4, 2), ["unknown", "unreadable"]);
    assert.deepEqual(settle(5, null, 2), ["unknown", "unreadable"]);
  });

  it("settles a write by the listing after it", () => {
    const unread = [wireMessage({ index: 1, phone: FRIEND, content: "a", date: "", unread: true, outgoing: false }), wireMessage({ index: 2, phone: FRIEND, content: "b", date: "", unread: false, outgoing: false })];
    const settle = (after: typeof unread | null, indices: number[], want: "gone" | "read"): Array<string | null> => {
      const check = newCheck();
      settleSmsListing(check, after, indices, want);
      return [check.readback, check.reason];
    };
    assert.deepEqual(settle(unread, [2], "read"), ["match", null]);
    assert.deepEqual(settle(unread, [1], "read"), ["mismatch", "no_change"]);
    assert.deepEqual(settle(unread, [1, 2], "read"), ["unknown", "unclear_change"]);
    assert.deepEqual(settle(unread, [3], "gone"), ["match", null]);
    assert.deepEqual(settle(unread, [1, 2], "gone"), ["mismatch", "no_change"]);
    assert.deepEqual(settle(null, [1], "gone"), ["unknown", "unreadable"]);
  });
});
