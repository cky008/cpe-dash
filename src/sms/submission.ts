import { CpeControlValidationError } from "../control-error.ts";
import { stripInvalidControlChars } from "../text-sanitize.ts";
import { MAX_SMS_SEGMENTS, detectSmsTextMode } from "./text-mode.ts";
import type { SmsSendResult, SmsTextModeInfo } from "./types.ts";

/**
 * What a send is checked against before it is queued, on every brand: its recipients, its text and
 * how many segments it takes. The brand's session then sends what this prepared.
 */

export const MAX_SMS_RECIPIENTS = 5;

export interface PreparedSmsSubmission {
  phones: string[];
  content: string;
  mode: SmsTextModeInfo;
}

/**
 * Validate recipients and body before any CPE session is queued (throws `CpeControlValidationError`).
 */
export function prepareSmsSubmission(phones: ReadonlyArray<string>, content: string): PreparedSmsSubmission {
  const normalized = [...new Set(phones.map((p) => p.trim().replace(/[\s-]/g, "")).filter(Boolean))];
  if (normalized.length === 0) {
    throw new CpeControlValidationError("Provide at least one recipient number");
  }
  if (normalized.length > MAX_SMS_RECIPIENTS) {
    throw new CpeControlValidationError(`Send to at most ${MAX_SMS_RECIPIENTS} recipients at once`);
  }
  for (const phone of normalized) {
    if (!/^\+?[0-9]{3,20}$/.test(phone)) {
      throw new CpeControlValidationError(`Recipient "${phone}" is not a dialable number`);
    }
  }
  const clean = stripInvalidControlChars(content).trim();
  if (!clean) {
    throw new CpeControlValidationError("Message content is empty");
  }
  const mode = detectSmsTextMode(clean);
  if (mode.segments > MAX_SMS_SEGMENTS) {
    throw new CpeControlValidationError(
      `Message needs ${mode.segments} segments; the CPE accepts at most ${MAX_SMS_SEGMENTS} segments per send`
    );
  }
  return { phones: normalized, content: clean, mode };
}

export interface SubmitSmsOptions {
  /** Upper bound for polling `send-status` inside the session (default 45 s, as verified on H168-383). */
  statusTimeoutMs?: number;
  statusIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Monotonic clock in ms for the polling bound (default `performance.now`). */
  now?: () => number;
  /** Called once the router accepted `send-sms`: from then on the message is on its way. */
  onAccepted?: () => void;
}

/** The outcome of an accepted submission whose delivery the router has not confirmed (yet). */
export function unconfirmedSendResult(prepared: PreparedSmsSubmission): SmsSendResult {
  return {
    submitted: true,
    encoding: prepared.mode.encoding,
    segments: prepared.mode.segments,
    ok: true,
    timedOutWaitingStatus: true,
    sentPhones: [...prepared.phones],
    failedPhones: [],
    failCode: null,
  };
}
