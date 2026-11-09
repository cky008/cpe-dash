import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SmsSendResult } from "../src/api-contract.ts";
import { classifySendError, classifySendResult, daysAgo, formatDayLabel, formatShortTime, initialsOf, isLikelyContactNameQuery, linkifySegments, parseMsgTime, threadGroup, trashDaysLeft } from "../web/src/core/sms.ts";

const NOW = new Date(2026, 9, 31, 12, 0, 0); // local time, Saturday 2026-10-31 12:00

const BASE_RESULT: SmsSendResult = {
  ok: true,
  submitted: true,
  timedOutWaitingStatus: false,
  sentPhones: ["+353830000001"],
  failedPhones: [],
  failCode: null,
  encoding: "7BIT",
  segments: 1,
};

describe("web core: SMS presentation and send outcomes", () => {
  it("formats router-local dates relative to now", () => {
    assert.equal(daysAgo("2026-10-31", NOW), 0);
    assert.equal(daysAgo("2026-10-30", NOW), 1);
    assert.equal(daysAgo("garbage", NOW), Number.POSITIVE_INFINITY);
    assert.equal(parseMsgTime("2026-10-31 12:00:00"), NOW.getTime());
    assert.equal(parseMsgTime("bad"), 0);
    assert.equal(formatShortTime("2026-10-31 09:05:00", "zh-CN", NOW), "09:05");
    assert.equal(formatShortTime("2026-10-30 09:05:00", "en", NOW), "Yesterday");
    assert.equal(formatShortTime("2026-10-27 09:05:00", "zh-CN", NOW), "周二");
    assert.equal(formatShortTime("2026-10-01 09:05:00", "en", NOW), "Oct 1");
    assert.equal(formatShortTime("2025-01-02 09:05:00", "zh-CN", NOW), "2025/1/2");
    assert.equal(formatShortTime("2025-01-02 09:05:00", "en", NOW), "Jan 2, 2025");
    assert.equal(formatShortTime("weird", "en", NOW), "weird");
    assert.equal(formatDayLabel("2026-10-31", "en", NOW), "Today");
    assert.equal(formatDayLabel("2026-10-30", "zh-CN", NOW), "昨天");
    assert.equal(formatDayLabel("2026-10-27", "zh-CN", NOW), "10月27日 周二");
    assert.equal(formatDayLabel("2026-10-27", "en", NOW), "Oct 27, Tue");
    assert.equal(formatDayLabel("2024-02-03", "zh-CN", NOW), "2024年2月3日");
    assert.equal(formatDayLabel("x", "en", NOW), "x");
    assert.deepEqual(
      ["2026-10-31 01:00:00", "2026-10-30 01:00:00", "2026-10-27 01:00:00", "2026-10-10 01:00:00", "2026-01-01 01:00:00"].map((d) =>
        threadGroup(d, NOW)
      ),
      ["today", "yesterday", "week", "month", "earlier"]
    );
  });

  it("derives initials, splits links without markup and spots contact-name searches", () => {
    assert.equal(initialsOf("张三"), "张");
    assert.equal(initialsOf("Demo Bank"), "DB");
    assert.equal(initialsOf("three"), "TH");
    assert.equal(initialsOf("  +353 "), "35");
    assert.equal(initialsOf("!!"), "?");
    assert.deepEqual(linkifySegments("Track https://cpe.example.com/a?b=1. Done"), [
      { text: "Track " },
      { text: "https://cpe.example.com/a?b=1", href: "https://cpe.example.com/a?b=1" },
      { text: ". Done" },
    ]);
    assert.deepEqual(linkifySegments("<b>no link</b>"), [{ text: "<b>no link</b>" }]);
    assert.equal(isLikelyContactNameQuery("Alice"), true);
    assert.equal(isLikelyContactNameQuery("083 000 0001"), false);
    assert.equal(isLikelyContactNameQuery("0830000001"), false);
    assert.equal(isLikelyContactNameQuery(""), false);
  });

  it("counts the whole days a deleted message has left, never below zero", () => {
    const now = Date.parse("2026-11-03T10:00:00.000Z");
    assert.equal(trashDaysLeft("2026-12-03T10:00:00.000Z", now), 30);
    assert.equal(trashDaysLeft("2026-11-04T09:00:00.000Z", now), 0, "under a day: today");
    assert.equal(trashDaysLeft("2026-11-01T10:00:00.000Z", now), 0);
    assert.equal(trashDaysLeft("not a date", now), 0);
  });

  it("never reports an accepted-but-unconfirmed send as a failure", () => {
    assert.equal(classifySendResult(BASE_RESULT), "sent");
    assert.equal(classifySendResult({ ...BASE_RESULT, timedOutWaitingStatus: true, sentPhones: [] }), "unconfirmed");
    assert.equal(classifySendResult({ ...BASE_RESULT, failedPhones: ["+353830000002"] }), "partial");
    assert.equal(classifySendResult({ ...BASE_RESULT, sentPhones: [], failedPhones: ["+353830000002"] }), "failed");
    assert.equal(classifySendResult({ ...BASE_RESULT, ok: false }), "failed");
    assert.equal(classifySendError({ kind: "sms_send_failed" }), "failed");
    assert.equal(classifySendError({ kind: "breaker" }), "not_sent");
    assert.equal(classifySendError({ kind: "yielded" }), "not_sent");
    assert.equal(classifySendError({ kind: "unavailable" }), "not_sent");
    assert.equal(classifySendError({ kind: "network" }), "unknown");
    assert.equal(classifySendError({ kind: "timeout" }), "unknown");
    assert.equal(classifySendError({ kind: "upstream" }), "unknown");
  });
});
