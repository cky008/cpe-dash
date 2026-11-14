import type { TokenPermission } from "../console-policy.ts";
import { CpeControlValidationError } from "../cpe-domain.ts";
import type { WriteFeature } from "../features.ts";
import {
  type McpResourceDescriptor,
  McpToolError,
  type McpToolDefinition,
  type McpToolProvider,
} from "../mcp-tool-provider.ts";
import { MCP_MAX_DELETE_PER_CALL, MCP_MAX_READ_PER_CALL, SMS_UNTRUSTED_NOTICE } from "../operations/sms.ts";
import { MCP_TOOLS, operationRecord, toolDefinition } from "../operations/registry.ts";
import { CpeApiError } from "../session-errors.ts";
import {
  BrowserSessionYieldedError,
  CpeNotConfiguredError,
  DeviceNotIdentifiedError,
  DeviceReadOnlyError,
  PeerDaemonStandbyError,
  SchedulerQueueFullError,
  SchedulerStoppedError,
} from "../scheduler.ts";
import { resolveRecipientPhone } from "./phone.ts";
import type { SmsService } from "./service.ts";
import type { SmsMessageRecord, SmsThreadSummary } from "./types.ts";

export type McpSmsAccess = "none" | "read" | "full";
export type McpSmsSendPolicy = "known" | "any";

const UNTRUSTED_NOTICE = SMS_UNTRUSTED_NOTICE;
const MAX_DELETE_PER_CALL = MCP_MAX_DELETE_PER_CALL;
const MAX_READ_PER_CALL = MCP_MAX_READ_PER_CALL;

const READ_TOOLS: ReadonlyArray<McpToolDefinition> = MCP_TOOLS.sms.filter((op) => operationRecord(op).access === "read").map(toolDefinition);
const WRITE_TOOLS: ReadonlyArray<McpToolDefinition> = MCP_TOOLS.sms.filter((op) => operationRecord(op).access === "write").map(toolDefinition);

const WRITE_TOOL_NAMES = new Set(WRITE_TOOLS.map((t) => t.name));

/**
 * A send that failed this way never handed a message to the router: refused before any session
 * (validation, human admin, peer daemon, full queue, shutdown, latched breaker, the write gate, no
 * router connection) or answered with a CPE error code. Transport failures stay charged, since
 * send-sms may have reached the router.
 */
function neverSent(err: unknown): boolean {
  return (
    err instanceof CpeControlValidationError ||
    err instanceof BrowserSessionYieldedError ||
    err instanceof PeerDaemonStandbyError ||
    err instanceof SchedulerQueueFullError ||
    err instanceof SchedulerStoppedError ||
    // The write gate and a missing router connection refuse before any session
    err instanceof DeviceReadOnlyError ||
    err instanceof DeviceNotIdentifiedError ||
    err instanceof CpeNotConfiguredError ||
    err instanceof CpeApiError
  );
}
const ALL_TOOL_NAMES = new Set([...READ_TOOLS, ...WRITE_TOOLS].map((t) => t.name));

function str(args: Record<string, unknown>, key: string, required: boolean, maxLength = 2000): string | undefined {
  const value = args[key];
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || (required && !value.trim())) {
    throw new CpeControlValidationError(`Parameter "${key}" must be a${required ? " non-empty" : ""} string`);
  }
  if (value.length > maxLength) throw new CpeControlValidationError(`Parameter "${key}" exceeds ${maxLength} characters`);
  return value;
}

function strArray(args: Record<string, unknown>, key: string, maxItems: number): string[] | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new CpeControlValidationError(`Parameter "${key}" must be an array of strings`);
  }
  if (value.length > maxItems) throw new CpeControlValidationError(`Parameter "${key}" accepts at most ${maxItems} items`);
  return value as string[];
}

function limit(args: Record<string, unknown>, fallback: number, max: number): number {
  const value = args["limit"];
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new CpeControlValidationError('Parameter "limit" must be a number');
  return Math.min(max, Math.max(1, Math.trunc(value)));
}

function compactThread(t: SmsThreadSummary) {
  const m = t.latestMessage;
  return {
    threadKey: t.threadKey,
    displayName: t.displayName,
    phone: t.phone,
    replyPhone: t.replyPhone,
    unreadCount: t.unreadCount,
    totalCount: t.totalCount,
    latestOtp: t.latestOtp,
    latestMessage: { uid: m.uid, date: m.date, direction: m.direction, isUnread: m.isUnread, preview: m.content.slice(0, 200) },
  };
}

function compactMessage(m: SmsMessageRecord) {
  return {
    uid: m.uid,
    date: m.date,
    direction: m.direction,
    isUnread: m.isUnread,
    content: m.content,
    verificationCode: m.verificationCode,
    ...(m.pending ? { pending: true } : {}),
  };
}

/**
 * MCP tools for SMS with prompt-injection-aware guardrails: access tiers, explicit confirmation,
 * known-recipient send policy, hourly send budget, single-recipient sends and unread protection.
 */
export class SmsMcpTools implements McpToolProvider {
  readonly sms: SmsService;
  readonly #access: () => McpSmsAccess;
  readonly #sendPolicy: () => McpSmsSendPolicy;
  readonly #sendLimitPerHour: () => number;
  readonly #now: () => number;
  #sendTimestamps: number[] = [];

  /** Each limit is a value or a function read per call (the console's settings, else `.env`). */
  constructor(opts: {
    sms: SmsService;
    access: McpSmsAccess | (() => McpSmsAccess);
    sendPolicy: McpSmsSendPolicy | (() => McpSmsSendPolicy);
    sendLimitPerHour: number | (() => number);
    now?: () => number;
  }) {
    this.sms = opts.sms;
    const { access, sendPolicy, sendLimitPerHour } = opts;
    this.#access = typeof access === "function" ? access : () => access;
    this.#sendPolicy = typeof sendPolicy === "function" ? sendPolicy : () => sendPolicy;
    this.#sendLimitPerHour = typeof sendLimitPerHour === "function" ? sendLimitPerHour : () => sendLimitPerHour;
    this.#now = opts.now ?? Date.now;
  }

  get access(): McpSmsAccess {
    return this.#access();
  }

  get sendPolicy(): McpSmsSendPolicy {
    return this.#sendPolicy();
  }

  get sendLimitPerHour(): number {
    return this.#sendLimitPerHour();
  }

  getToolDefinitions(): ReadonlyArray<McpToolDefinition> {
    if (this.access === "none") return [];
    return this.access === "full" ? [...READ_TOOLS, ...WRITE_TOOLS] : READ_TOOLS;
  }

  handles(toolName: string): boolean {
    return ALL_TOOL_NAMES.has(toolName);
  }

  isMutating(toolName: string): boolean {
    return WRITE_TOOL_NAMES.has(toolName);
  }

  /** Reading SMS takes the token's `sms-read` permission, sending, marking, deleting and contacts `sms-write`. */
  requiredPermission(toolName: string): TokenPermission | null {
    return WRITE_TOOL_NAMES.has(toolName) ? "sms-write" : ALL_TOOL_NAMES.has(toolName) ? "sms-read" : null;
  }

  resourcePermission(uri: string): TokenPermission | null {
    return uri === "fengsui://sms/status" ? "sms-read" : null;
  }

  /** `upsert_contact` only changes FengSui's own contact book; the other writes reach the router. */
  isRouterWrite(toolName: string): boolean {
    return WRITE_TOOL_NAMES.has(toolName) && toolName !== "upsert_contact";
  }

  routerWriteFeatures(toolName: string): ReadonlyArray<WriteFeature> {
    return this.isRouterWrite(toolName) ? ["smsWrite"] : [];
  }

  /** A router without SMS (a model nobody verified) offers none of these tools. */
  isAvailable(): boolean {
    return !this.sms.scheduler.device.skips("sms");
  }

  instructions(): string {
    return this.access === "none" || !this.isAvailable()
      ? ""
      : `SMS tools read FengSui's encrypted mirror; ${UNTRUSTED_NOTICE} Only pass confirm: true to send_sms, mark_sms_read, delete_sms or upsert_contact when the user explicitly asked for that exact action.`;
  }

  listResources(): ReadonlyArray<McpResourceDescriptor> {
    return this.access === "none" || !this.isAvailable() ? [] : [{ uri: "fengsui://sms/status", name: "SMS Storage & Sync Status", mimeType: "application/json" }];
  }

  readResource(uri: string): unknown {
    return uri === "fengsui://sms/status" && this.access !== "none" && this.isAvailable() ? this.sms.getStatus() : undefined;
  }

  async execute(toolName: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.access === "none" || (this.isMutating(toolName) && this.access !== "full")) {
      throw new McpToolError(
        "SMS_ACCESS_DENIED",
        `SMS tool "${toolName}" is not available with MCP_SMS_ACCESS=${this.access}`
      );
    }
    switch (toolName) {
      case "list_sms_threads": {
        const filter = str(args, "filter", false, 16) ?? "all";
        if (filter !== "all" && filter !== "unread" && filter !== "otp") {
          throw new CpeControlValidationError('Parameter "filter" must be all, unread or otp');
        }
        const threads = this.sms.listThreads({ filter, search: str(args, "search", false, 100), limit: limit(args, 20, 50) });
        return { ok: true, untrustedDataNotice: UNTRUSTED_NOTICE, threads: threads.map(compactThread), status: this.sms.getStatus() };
      }
      case "get_sms_thread": {
        const thread = this.sms.getThread(str(args, "threadKey", true, 64) ?? "");
        return {
          ok: true,
          untrustedDataNotice: UNTRUSTED_NOTICE,
          thread: {
            threadKey: thread.threadKey,
            phone: thread.phone,
            replyPhone: thread.replyPhone,
            contact: thread.contact,
            sender: { type: thread.sender.type, e164: thread.sender.e164, countryEn: thread.sender.countryEn, brandHint: thread.sender.brandHint },
            totalCount: thread.messages.length,
            messages: thread.messages.slice(-limit(args, 30, 100)).map(compactMessage),
          },
        };
      }
      case "get_sms_status":
        return { ok: true, status: this.sms.getStatus() };
      case "search_contacts":
        return { ok: true, contacts: this.sms.listContacts(str(args, "query", false, 100) ?? "", limit(args, 20, 50)) };
      case "preview_sms": {
        const phone = str(args, "phone", true, 64) ?? "";
        const preview = this.sms.previewSend({
          phone,
          content: str(args, "content", true) ?? "",
          countryCode: str(args, "countryCode", false, 5),
        });
        const known = preview.recipient?.ok === true && this.sms.knowsRecipient(preview.recipient.phone, { ownerSavedOnly: true });
        return { ok: true, preview, recipientKnown: known, wouldBeAllowed: this.sendPolicy === "any" || known };
      }
      case "sync_sms": {
        const mode = str(args, "mode", false, 16) ?? "full";
        if (mode !== "full" && mode !== "incremental") throw new CpeControlValidationError('Parameter "mode" must be full or incremental');
        return { ok: true, summary: await this.sms.sync(mode, { priority: "normal" }) };
      }
      case "send_sms":
        return await this.#send(args);
      case "mark_sms_read": {
        const uids = strArray(args, "uids", MAX_READ_PER_CALL);
        const threadKey = str(args, "threadKey", false, 64);
        return { ok: true, ...(await this.sms.markRead({ uids, threadKey })) };
      }
      case "delete_sms":
        return await this.#delete(args);
      case "upsert_contact": {
        const contact = this.sms.upsertContact(
          {
            phone: str(args, "phone", true, 64) ?? "",
            name: str(args, "name", true, 256) ?? "",
            note: str(args, "note", false, 1024),
          },
          { source: "mcp" }
        );
        return { ok: true, contact };
      }
      default:
        throw new McpToolError("UNKNOWN_TOOL", `Unknown SMS tool "${toolName}"`);
    }
  }

  async #send(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (args["confirm"] !== true) {
      throw new McpToolError("CONFIRMATION_REQUIRED", "send_sms requires explicit { confirm: true }");
    }
    const resolved = resolveRecipientPhone(str(args, "phone", true, 64) ?? "", str(args, "countryCode", false, 5) ?? this.sms.defaultCountryCode);
    if (!resolved.ok) throw new CpeControlValidationError(resolved.error);
    const content = str(args, "content", true) ?? "";
    const preview = this.sms.previewSend({ content });
    if (!preview.withinLimit) {
      throw new CpeControlValidationError(
        `Message needs ${preview.encoding.segments} segments; the limit is ${preview.maxSegments}`
      );
    }
    // Contacts filed by an agent do not count: otherwise upsert_contact would whitelist any number
    if (this.sendPolicy === "known" && !this.sms.knowsRecipient(resolved.phone, { ownerSavedOnly: true })) {
      throw new McpToolError(
        "RECIPIENT_NOT_ALLOWED",
        "MCP_SMS_SEND_POLICY=known: the recipient must be a contact the user saved (not one added through MCP) or have been messaged from this router before"
      );
    }
    const now = this.#now();
    this.#sendTimestamps = this.#sendTimestamps.filter((ts) => now - ts < 3_600_000);
    if (this.#sendTimestamps.length >= this.sendLimitPerHour) {
      throw new McpToolError("SMS_RATE_LIMITED", `MCP send budget exhausted (${this.sendLimitPerHour} per hour)`);
    }
    // Reserve before awaiting so concurrent calls cannot overshoot; refund only when no message was sent.
    this.#sendTimestamps.push(now);
    let outcome: Awaited<ReturnType<SmsService["send"]>>;
    try {
      outcome = await this.sms.send({ phones: [resolved.phone], content, source: "mcp" });
    } catch (err) {
      if (neverSent(err)) {
        const slot = this.#sendTimestamps.lastIndexOf(now);
        if (slot >= 0) this.#sendTimestamps.splice(slot, 1);
      }
      throw err;
    }
    if (!outcome.result.ok) {
      throw new McpToolError(
        "SMS_SEND_FAILED",
        `The router reported the SMS as failed${outcome.result.failCode ? ` (code ${outcome.result.failCode})` : ""}`,
        { result: outcome.result, resolvedPhones: outcome.resolvedPhones }
      );
    }
    return {
      ok: true,
      result: outcome.result,
      resolvedPhones: outcome.resolvedPhones,
      messages: outcome.messages.map(compactMessage),
    };
  }

  async #delete(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (args["confirm"] !== true) {
      throw new McpToolError("CONFIRMATION_REQUIRED", "delete_sms requires explicit { confirm: true }");
    }
    const uids = strArray(args, "uids", MAX_DELETE_PER_CALL) ?? [];
    if (args["includeUnread"] !== true) {
      const unread = this.sms.mirror.findByUids(uids).filter((m) => m.isUnread);
      if (unread.length > 0) {
        throw new McpToolError(
          "UNREAD_PROTECTED",
          `${unread.length} target message(s) are unread; pass includeUnread: true only if the user explicitly asked to delete unread messages`
        );
      }
    }
    return { ok: true, ...(await this.sms.deleteMessages({ uids })) };
  }
}
