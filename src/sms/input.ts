import { CpeControlValidationError } from "../control-error.ts";
import type { SmsSyncMode } from "./service.ts";
import { MAX_SMS_RECIPIENTS } from "./submission.ts";
import type { SmsThreadFilter } from "./types.ts";

/**
 * The first layer of the check on the SMS REST routes' fields (`/api/sms/*`): types, lengths and list
 * sizes, before anything is queued. Each reader takes a request's JSON body or its query string and
 * throws `CpeControlValidationError` (`400 VALIDATION_ERROR`). No Node built-ins: the static demo
 * checks its requests with the same readers.
 */

type Fields = Readonly<Record<string, unknown>>;

export const MAX_VCF_BODY_BYTES = 4 * 1024 * 1024;
export const MAX_CONTENT_CHARS = 2000;

function optionalString(body: Fields, key: string, maxLength: number): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new CpeControlValidationError(`Field "${key}" must be a string`);
  if (value.length > maxLength) throw new CpeControlValidationError(`Field "${key}" exceeds ${maxLength} characters`);
  return value;
}

function requiredString(body: Fields, key: string, maxLength: number): string {
  const value = optionalString(body, key, maxLength);
  if (value === undefined || !value.trim()) throw new CpeControlValidationError(`Field "${key}" is required`);
  return value;
}

function stringArray(body: Fields, key: string, maxItems: number): string[] | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || v.length > 128)) {
    throw new CpeControlValidationError(`Field "${key}" must be an array of strings`);
  }
  if (value.length > maxItems) throw new CpeControlValidationError(`Field "${key}" accepts at most ${maxItems} items`);
  return value as string[];
}

/** A query string's value (`undefined` when absent). */
function queryValue(query: Fields, key: string): string | undefined {
  const value = query[key];
  return typeof value === "string" ? value : undefined;
}

function parseLimit(raw: string | undefined, fallback: number, max: number): number {
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d{1,4}$/.test(raw)) throw new CpeControlValidationError(`Invalid limit "${raw}"`);
  return Math.min(max, Math.max(1, Number(raw)));
}

/** `GET /api/sms/threads?filter=&search=&limit=`. */
export function readThreadsQuery(query: Fields): { filter: SmsThreadFilter; search: string; limit: number } {
  const filter = queryValue(query, "filter") ?? "all";
  if (filter !== "all" && filter !== "unread" && filter !== "otp") {
    throw new CpeControlValidationError(`Unsupported filter "${filter}" (all | unread | otp)`);
  }
  return { filter, search: (queryValue(query, "search") ?? "").slice(0, 100), limit: parseLimit(queryValue(query, "limit"), 500, 500) };
}

/** `GET /api/sms/thread?key=` (or `?phone=`): a thread key or any spelling of the number. */
export function readThreadKeyQuery(query: Fields): string {
  const key = (queryValue(query, "key") ?? queryValue(query, "phone") ?? "").trim();
  if (!key || key.length > 64) throw new CpeControlValidationError('Query "key" (thread key or phone number) is required');
  return key;
}

/** `GET /api/sms/contacts?search=&limit=`. */
export function readContactsQuery(query: Fields): { search: string; limit: number } {
  return { search: (queryValue(query, "search") ?? "").slice(0, 100), limit: parseLimit(queryValue(query, "limit"), 500, 5000) };
}

/** `POST /api/sms/preview`: nothing is required, a preview of nothing is a preview. */
export function readPreview(body: Fields): { phone: string | undefined; content: string; countryCode: string | undefined } {
  return {
    phone: optionalString(body, "phone", 64),
    content: optionalString(body, "content", MAX_CONTENT_CHARS) ?? "",
    countryCode: optionalString(body, "countryCode", 5),
  };
}

/** `POST /api/sms/send`: `phone`, or `phones` (at most five), and the text. */
export function readSend(body: Fields): { phones: string[]; content: string; countryCode: string | undefined } {
  const phones = stringArray(body, "phones", MAX_SMS_RECIPIENTS) ?? [requiredString(body, "phone", 64)];
  return { phones, content: requiredString(body, "content", MAX_CONTENT_CHARS), countryCode: optionalString(body, "countryCode", 5) };
}

/** `POST /api/sms/read`: messages by `uids`, or a whole thread by `threadKey`. */
export function readMarkRead(body: Fields): { uids: string[] | undefined; threadKey: string | undefined } {
  return { uids: stringArray(body, "uids", 200), threadKey: optionalString(body, "threadKey", 64) };
}

/** `POST /api/sms/delete` and `POST /api/sms/trash/restore`: the messages' `uids`. */
export function readUids(body: Fields): { uids: string[] } {
  return { uids: stringArray(body, "uids", 200) ?? [] };
}

/** `POST /api/sms/trash/purge`: `{ all: true }`, or the `uids` to delete for good. */
export function readPurge(body: Fields): { all: true } | { uids: string[] } {
  if (body["all"] !== undefined && body["all"] !== true) throw new CpeControlValidationError('Field "all" must be true when given');
  return body["all"] === true ? { all: true } : { uids: stringArray(body, "uids", 200) ?? [] };
}

/** `POST /api/sms/sync`: `full` (default) or `incremental`. */
export function readSyncMode(body: Fields): SmsSyncMode {
  const mode = optionalString(body, "mode", 16) ?? "full";
  if (mode !== "full" && mode !== "incremental") {
    throw new CpeControlValidationError('Field "mode" must be "full" or "incremental"');
  }
  return mode;
}

/** `POST /api/sms/contacts/upsert`. */
export function readContact(body: Fields): { phone: string; name: string; note: string | undefined } {
  return { phone: requiredString(body, "phone", 64), name: requiredString(body, "name", 256), note: optionalString(body, "note", 1024) };
}

/** `POST /api/sms/contacts/delete`: the contact's `id`. */
export function readContactId(body: Fields): string {
  return requiredString(body, "id", 64);
}

/** `POST /api/sms/contacts/import-vcf`: the text of a `.vcf` file. */
export function readVcard(body: Fields): string {
  return requiredString(body, "vcf", MAX_VCF_BODY_BYTES);
}
