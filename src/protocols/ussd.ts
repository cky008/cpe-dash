import { USSD_MAX_TEXT, type UssdAnswer } from "../cellular.ts";

/**
 * USSD on any interface: an operator's answer as it may be shown, how long one is waited for, and an
 * answer with nothing in it. How a code is sent and its answer fetched is each interface's own.
 */

/**
 * An operator's USSD text as it may be shown: control characters out (a menu's line breaks stay),
 * cut at `USSD_MAX_TEXT`. `null`: nothing readable.
 */
export function ussdText(raw: string | null): string | null {
  if (raw === null) return null;
  // Line breaks survive as "\n"; every other control character goes
  const text = raw
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, "")
    .trim()
    .slice(0, USSD_MAX_TEXT);
  return text === "" ? null : text;
}

/** How long a USSD answer is waited for, and how often the router is asked. */
export const USSD_POLLS = 30;
export const USSD_POLL_MS = 1000;

/** An answer with nothing in it (the network said nothing in time, or the session was ended). */
export function emptyUssd(state: UssdAnswer["state"]): UssdAnswer {
  return { state, text: null, awaitsReply: false };
}
