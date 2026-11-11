/**
 * SMS domain types shared by the protocol layer, encrypted mirror, application service,
 * REST routes, MCP tools and Telegram bot.
 */

export type SmsDirection = "in" | "out";
export type SmsEncodingName = "7BIT" | "UCS2";
/** Huawei `<Reserved>` text mode: `1` = GSM 7-bit, `0` = UCS-2. */
export type SmsTextModeCode = 0 | 1;

export interface SmsTextModeInfo {
  textMode: SmsTextModeCode;
  encoding: SmsEncodingName;
  segments: number;
  /** GSM-7 septets (extension characters count twice) or UCS-2 code units. */
  charUnits: number;
}

/** Message exactly as parsed from a CPE `<Message>` / `<message>` block. */
export interface SmsWireMessage {
  /** CPE storage index (unique among messages currently stored on the router). */
  index: number;
  phone: string;
  content: string;
  /** `yyyy-MM-dd HH:mm:ss` in the router's local time. */
  date: string;
  /** Raw Huawei status (`0` unread, `1` read, `3`/`4` outgoing). */
  smstat: string;
  isUnread: boolean;
  direction: SmsDirection;
}

export interface SmsMessageRecord extends SmsWireMessage {
  /** Opaque stable id derived from `(index, date, phone)`; never contains the phone number. */
  uid: string;
  verificationCode: string | null;
  /** Provisional outgoing record kept only until the router copy is read back. */
  pending?: true;
  /**
   * Only FengSui keeps it, so a full sync leaves it: restored from Recently deleted (its router copy
   * was deleted), or sent through a router that keeps no copy of what it sends.
   */
  localOnly?: true;
}

/** A message in Recently deleted: kept encrypted in FengSui after its router copy was deleted. */
export interface SmsTrashRecord extends SmsMessageRecord {
  deletedAtIso: string;
}

/** `GET /api/sms/sms-count` counters (piggybacked on the telemetry session). */
export interface SmsCounters {
  localUnread: number;
  localInbox: number;
  localOutbox: number;
  localDraft: number;
  /** How many messages fit (`0`: the router does not say). */
  localMax: number;
  /**
   * The handle of the newest message, on a router whose counts alone would miss a new one (it can
   * only count the page it lists): a sync starts when this moves, as when a count does.
   */
  newest?: number;
}

/**
 * How the messages of a sync were listed: HiLink's plain `sms-list`, its encrypted per-contact
 * fallback, or (`driver`) another brand's own listing.
 */
export type SmsListingPath = "sms-list" | "contact-list" | "driver";

/**
 * What the router's SMS interface can do, beside reading: send, and delete one message at a time,
 * a whole conversation at a time, or not at all. Marking read is always possible (where the router
 * cannot be told, FengSui keeps the state itself).
 */
export interface SmsAbilities {
  send: boolean;
  delete: "message" | "conversation" | "none";
}

/** One listing of the router's messages, with the counts read in the same session. */
export interface SmsFetchResult {
  counters: SmsCounters;
  messages: SmsWireMessage[];
  via: SmsListingPath;
}

export interface CountryDialInfo {
  code: string;
  iso: string;
  flag: string;
  nameZh: string;
  nameEn: string;
  dropTrunkZero: boolean;
}

export type SenderCategory =
  | "unknown"
  | "alphanumeric"
  | "gateway"
  | "shortcode"
  | "international"
  | "national"
  | "other";

export interface SenderInfo {
  type: SenderCategory;
  raw: string;
  e164: string | null;
  dialable: boolean;
  flag: string;
  countryCode: string | null;
  countryZh: string;
  countryEn: string;
  countryIso: string | null;
  brandHint: string | null;
  displayNumber: string;
}

export type ResolvedRecipient =
  | {
      ok: true;
      phone: string;
      flag: string;
      countryCode: string | null;
      countryZh: string;
      countryEn: string;
      isShortCode: boolean;
    }
  | {
      ok: false;
      error: string;
    };

export interface ContactRecord {
  id: string;
  name: string;
  phones: string[];
  note?: string;
  /**
   * `manual` / `vcard`: saved by the owner (web console, Telegram, vCard import). `mcp`: filed by an
   * MCP agent, which does not make the number a known recipient for MCP sends until the owner saves it.
   */
  source: "manual" | "vcard" | "mcp";
  updatedAt: string;
}

export interface ContactBrief {
  id: string;
  name: string;
  note?: string;
}

export interface EnrichedSmsMessage extends SmsMessageRecord {
  threadKey: string;
  sender: SenderInfo;
  contact: ContactBrief | null;
}

/** A message in Recently deleted as the console lists it. */
export interface DeletedSmsMessage extends EnrichedSmsMessage {
  deletedAtIso: string;
  /** When it is deleted for good, at the retention now in force. */
  purgeAtIso: string;
}

export interface SmsThreadSummary {
  threadKey: string;
  phone: string;
  replyPhone: string | null;
  dialable: boolean;
  sender: SenderInfo;
  contact: ContactBrief | null;
  displayName: string;
  unreadCount: number;
  totalCount: number;
  hasOtp: boolean;
  latestOtp: string | null;
  latestMessage: SmsMessageRecord;
  matchedPreview?: string;
}

export interface SmsThreadDetail {
  threadKey: string;
  phone: string;
  replyPhone: string | null;
  dialable: boolean;
  sender: SenderInfo;
  contact: ContactBrief | null;
  messages: EnrichedSmsMessage[];
}

export type SmsThreadFilter = "all" | "unread" | "otp";

export interface SmsSendResult {
  ok: boolean;
  submitted: boolean;
  timedOutWaitingStatus: boolean;
  sentPhones: string[];
  failedPhones: string[];
  failCode: string | null;
  encoding: SmsEncodingName;
  segments: number;
}
