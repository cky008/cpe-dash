import { after, before } from "node:test";
import { withDeadline } from "../../scripts/cdp.ts";

/**
 * `node --test --test-timeout` bounds tests, not hooks: a hook that hangs (such as a Chrome that
 * never opens its DevTools socket) hung the whole gate once. Every browser-test hook goes through
 * `setup` / `teardown` with a hook timeout, and each awaited step inside wraps itself in `step` so a
 * failure names the exact step where it stopped.
 */
/** The most a whole hook may take: the demo's build (its own limit is 180 s) and a Chrome launch fit inside. */
export const HOOK_TIMEOUT_MS = 300_000;
/** The most one step inside a hook may take, unless it names its own. */
export const STEP_TIMEOUT_MS = 120_000;

/** `before`, bounded. */
export function setup(fn: () => Promise<void>): void {
  before(fn, { timeout: HOOK_TIMEOUT_MS });
}

/** `after`, bounded. */
export function teardown(fn: () => Promise<void>): void {
  after(fn, { timeout: HOOK_TIMEOUT_MS });
}

/** One awaited step of a hook: a step that does not finish fails as `timed out after N s: <what>`. */
export function step<T>(what: string, work: () => Promise<T>, timeoutMs = STEP_TIMEOUT_MS): Promise<T> {
  return withDeadline(what, timeoutMs, work());
}
