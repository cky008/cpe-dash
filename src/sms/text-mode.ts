import { CpeControlValidationError } from "../control-error.ts";
import { stripInvalidControlChars } from "../text-sanitize.ts";
import type { SmsTextModeCode, SmsTextModeInfo } from "./types.ts";

/*
 * GSM-7 / UCS-2 segment counting, dependency-free so the web composer counts exactly what the
 * daemon will submit.
 */

/** Huawei `<Reserved>` text modes (`smsSendPage.vue`). */
export const SMS_TEXT_MODE_UCS2: SmsTextModeCode = 0;
export const SMS_TEXT_MODE_7BIT: SmsTextModeCode = 1;

/** H168-383 concatenates at most 4 segments per `send-sms` submission. */
export const MAX_SMS_SEGMENTS = 4;

/**
 * The GSM 7-bit default alphabet (3GPP TS 23.038 §6.2.1) as UTF-16 code units, in septet order:
 * entry `n` is the character septet `n` stands for. The PDU codec packs and unpacks with it.
 */
export const GSM_7BIT_ALPHABET: ReadonlyArray<number> = [
  64, 163, 36, 165, 232, 233, 249, 236, 242, 199, 10, 216, 248, 13, 197, 229,
  916, 95, 934, 915, 923, 937, 928, 936, 931, 920, 926, 27, 198, 230, 223, 201,
  32, 33, 34, 35, 164, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50,
  51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 161, 65, 66, 67, 68, 69,
  70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83, 84, 85, 86, 87, 88,
  89, 90, 196, 214, 209, 220, 167, 191, 97, 98, 99, 100, 101, 102, 103, 104,
  105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119,
  120, 121, 122, 228, 246, 241, 252, 224,
];

const GSM_7BIT_DEFAULT_TABLE = new Set<number>(GSM_7BIT_ALPHABET);

/** Characters that need the GSM-7 escape (`ESC + char`) and therefore cost two septets. */
const GSM_7BIT_EXT_TABLE = new Set<number>([10, 94, 32, 123, 125, 92, 91, 126, 93, 124, 8364]);

/**
 * Determine the Huawei `<Reserved>` text mode and segment count for an outgoing message
 * (GSM-7: 160 / 153 septets per segment; UCS-2: 70 / 67 code units per segment).
 */
export function detectSmsTextMode(content: string): SmsTextModeInfo {
  const clean = stripInvalidControlChars(content);
  let septets = 0;
  for (let i = 0; i < clean.length; i++) {
    const code = clean.charCodeAt(i);
    if (GSM_7BIT_DEFAULT_TABLE.has(code)) {
      septets += 1;
    } else if (GSM_7BIT_EXT_TABLE.has(code)) {
      septets += 2;
    } else {
      const units = clean.length;
      return {
        textMode: SMS_TEXT_MODE_UCS2,
        encoding: "UCS2",
        segments: units <= 70 ? 1 : Math.ceil(units / 67),
        charUnits: units,
      };
    }
  }
  return {
    textMode: SMS_TEXT_MODE_7BIT,
    encoding: "7BIT",
    segments: septets <= 160 ? 1 : Math.ceil(septets / 153),
    charUnits: septets,
  };
}

/**
 * Text outside the basic multilingual plane (emoji and the like): the reference project sends the
 * request body as CESU-8, FengSui sends UTF-8, and the two differ only there, so the generic send
 * refuses it instead of guessing how the router decodes it (docs/dev/protocol.md A.11).
 */
export function validateGenericSmsContent(content: string): void {
  if (/[\u{10000}-\u{10FFFF}]/u.test(content)) {
    throw new CpeControlValidationError("This router is a model FengSui was not verified on: its experimental SMS send takes no emoji or other characters outside the basic plane");
  }
}
