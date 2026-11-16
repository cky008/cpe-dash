import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ConnectionPauseStatus } from "../src/connection-pause.ts";
import { pauseView } from "../web/src/core/pause-view.ts";

const statusOf = (overrides: Partial<ConnectionPauseStatus> = {}): ConnectionPauseStatus => ({
  active: false,
  sinceIso: null,
  untilIso: null,
  blocked: null,
  ...overrides,
});

describe("pauseView", () => {
  it("shows a running pause with its end and the minutes left, never fewer than one", () => {
    const nowMs = Date.parse("2026-11-16T12:00:00.000Z");
    const untilIso = "2026-11-16T12:14:30.000Z";
    const untilMs = Date.parse(untilIso);
    assert.deepEqual(pauseView(statusOf({ active: true, sinceIso: "2026-11-16T11:59:30.000Z", untilIso }), nowMs), {
      state: "paused",
      untilMs,
      minutesLeft: 15,
    });

    assert.deepEqual(pauseView(statusOf({ active: true, untilIso }), Date.parse("2026-11-16T12:15:00.000Z")), {
      state: "paused",
      untilMs,
      minutesLeft: 1,
    });
  });

  it("shows why a pause cannot begin while a change is still watched", () => {
    const nowMs = Date.parse("2026-11-16T12:00:00.000Z");
    const untilIso = "2026-11-16T12:05:00.000Z";
    assert.deepEqual(pauseView(statusOf({ blocked: { reason: "watch", untilIso } }), nowMs), {
      state: "blocked",
      untilMs: Date.parse(untilIso),
    });
    assert.deepEqual(pauseView(statusOf({ blocked: { reason: "watch", untilIso: null } }), nowMs), {
      state: "blocked",
      untilMs: null,
    });
    assert.deepEqual(pauseView(statusOf({ blocked: { reason: "watch", untilIso: "not-a-timestamp" } }), nowMs), {
      state: "blocked",
      untilMs: null,
    });
  });

  it("is ready otherwise, also before the first status arrived", () => {
    const nowMs = Date.parse("2026-11-16T12:00:00.000Z");
    assert.deepEqual(pauseView(null, nowMs), { state: "ready" });
    assert.deepEqual(pauseView(undefined, nowMs), { state: "ready" });
    assert.deepEqual(pauseView(statusOf(), nowMs), { state: "ready" });
    assert.deepEqual(
      pauseView(statusOf({ active: true, untilIso: "not-a-timestamp", blocked: { reason: "watch", untilIso: "2026-11-16T12:05:00.000Z" } }), nowMs),
      { state: "ready" }
    );
  });
});
