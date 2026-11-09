import type {
  ApiErrorEnvelope,
  ContactDeleteResponse,
  ContactUpsertResponse,
  SmsContactsResponse,
  SmsCountriesResponse,
  SmsDeleteResponse,
  SmsPreviewResponse,
  SmsReadResponse,
  SmsSendResponse,
  SmsStatusResponse,
  SmsSyncResponse,
  SmsThreadResponse,
  SmsThreadsResponse,
  VcardImportResponse,
} from "../api-contract.ts";
import { CpeControlValidationError } from "../cpe-domain.ts";
import { MAX_SMS_RECIPIENTS } from "./protocol.ts";
import type { SmsService, SmsSyncMode } from "./service.ts";
import type { SmsThreadFilter } from "./types.ts";

/** Minimal request surface the HTTP server hands to domain route modules. */
export interface ApiRouteContext {
  method: string;
  pathname: string;
  query: Readonly<Record<string, string>>;
  readJsonBody(maxBytes?: number): Promise<Record<string, unknown>>;
  sendJson(statusCode: number, body: unknown, headers?: Record<string, string>): void;
}

export const MAX_VCF_BODY_BYTES = 4 * 1024 * 1024;
const MAX_CONTENT_CHARS = 2000;

function optionalString(body: Record<string, unknown>, key: string, maxLength: number): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new CpeControlValidationError(`Field "${key}" must be a string`);
  if (value.length > maxLength) throw new CpeControlValidationError(`Field "${key}" exceeds ${maxLength} characters`);
  return value;
}

function requiredString(body: Record<string, unknown>, key: string, maxLength: number): string {
  const value = optionalString(body, key, maxLength);
  if (value === undefined || !value.trim()) throw new CpeControlValidationError(`Field "${key}" is required`);
  return value;
}

function stringArray(body: Record<string, unknown>, key: string, maxItems: number): string[] | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || v.length > 128)) {
    throw new CpeControlValidationError(`Field "${key}" must be an array of strings`);
  }
  if (value.length > maxItems) throw new CpeControlValidationError(`Field "${key}" accepts at most ${maxItems} items`);
  return value as string[];
}

function parseLimit(raw: string | undefined, fallback: number, max: number): number {
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d{1,4}$/.test(raw)) throw new CpeControlValidationError(`Invalid limit "${raw}"`);
  return Math.min(max, Math.max(1, Number(raw)));
}

/**
 * `/api/sms/*` REST routes. GET routes read the encrypted mirror and contact book (no CPE session);
 * POST routes are mutations or explicit syncs and inherit the server's CSRF / Bearer guards.
 */
export class SmsHttpRoutes {
  readonly sms: SmsService;

  constructor(sms: SmsService) {
    this.sms = sms;
  }

  /** Returns `false` for unknown routes so the server can answer `404 NOT_FOUND`. */
  async handle(ctx: ApiRouteContext): Promise<boolean> {
    if (ctx.method === "GET") return this.#handleGet(ctx);
    if (ctx.method === "POST") return await this.#handlePost(ctx);
    return false;
  }

  #handleGet(ctx: ApiRouteContext): boolean {
    const { query } = ctx;
    switch (ctx.pathname) {
      case "/api/sms/status":
        ctx.sendJson(200, { ok: true, status: this.sms.getStatus() } satisfies SmsStatusResponse);
        return true;
      case "/api/sms/countries":
        ctx.sendJson(200, { ok: true, defaultCountryCode: this.sms.defaultCountryCode, countries: this.sms.countries() } satisfies SmsCountriesResponse);
        return true;
      case "/api/sms/threads": {
        const filter = query["filter"] ?? "all";
        if (filter !== "all" && filter !== "unread" && filter !== "otp") {
          throw new CpeControlValidationError(`Unsupported filter "${filter}" (all | unread | otp)`);
        }
        const threads = this.sms.listThreads({
          filter: filter satisfies SmsThreadFilter,
          search: (query["search"] ?? "").slice(0, 100),
          limit: parseLimit(query["limit"], 500, 500),
        });
        ctx.sendJson(200, { ok: true, threads, status: this.sms.getStatus() } satisfies SmsThreadsResponse);
        return true;
      }
      case "/api/sms/thread": {
        const key = (query["key"] ?? query["phone"] ?? "").trim();
        if (!key || key.length > 64) throw new CpeControlValidationError('Query "key" (thread key or phone number) is required');
        ctx.sendJson(200, { ok: true, thread: this.sms.getThread(key) } satisfies SmsThreadResponse);
        return true;
      }
      case "/api/sms/contacts": {
        const contacts = this.sms.listContacts((query["search"] ?? "").slice(0, 100), parseLimit(query["limit"], 500, 5000));
        ctx.sendJson(200, { ok: true, total: this.sms.contacts.size, contacts } satisfies SmsContactsResponse);
        return true;
      }
      default:
        return false;
    }
  }

  async #handlePost(ctx: ApiRouteContext): Promise<boolean> {
    switch (ctx.pathname) {
      case "/api/sms/preview": {
        const body = await ctx.readJsonBody();
        const preview = this.sms.previewSend({
          phone: optionalString(body, "phone", 64),
          content: optionalString(body, "content", MAX_CONTENT_CHARS) ?? "",
          countryCode: optionalString(body, "countryCode", 5),
        });
        ctx.sendJson(200, { ok: true, preview } satisfies SmsPreviewResponse);
        return true;
      }
      case "/api/sms/send": {
        const body = await ctx.readJsonBody();
        const phones = stringArray(body, "phones", MAX_SMS_RECIPIENTS) ?? [requiredString(body, "phone", 64)];
        const outcome = await this.sms.send({
          phones,
          content: requiredString(body, "content", MAX_CONTENT_CHARS),
          countryCode: optionalString(body, "countryCode", 5),
          source: "web",
        });
        if (!outcome.result.ok) {
          ctx.sendJson(502, {
            ok: false,
            errorCode: "SMS_SEND_FAILED",
            message: `The CPE reported a send failure (code ${outcome.result.failCode ?? "unknown"})`,
            result: outcome.result,
            resolvedPhones: outcome.resolvedPhones,
          } satisfies ApiErrorEnvelope);
          return true;
        }
        ctx.sendJson(200, { ok: true, ...outcome } satisfies SmsSendResponse);
        return true;
      }
      case "/api/sms/read": {
        const body = await ctx.readJsonBody();
        const result = await this.sms.markRead({
          uids: stringArray(body, "uids", 200),
          threadKey: optionalString(body, "threadKey", 64),
        });
        ctx.sendJson(200, { ok: true, ...result } satisfies SmsReadResponse);
        return true;
      }
      case "/api/sms/delete": {
        const body = await ctx.readJsonBody();
        const result = await this.sms.deleteMessages({ uids: stringArray(body, "uids", 200) ?? [] });
        ctx.sendJson(200, { ok: true, ...result } satisfies SmsDeleteResponse);
        return true;
      }
      case "/api/sms/sync": {
        const body = await ctx.readJsonBody();
        const mode = optionalString(body, "mode", 16) ?? "full";
        if (mode !== "full" && mode !== "incremental") {
          throw new CpeControlValidationError('Field "mode" must be "full" or "incremental"');
        }
        const summary = await this.sms.sync(mode satisfies SmsSyncMode, { priority: "normal" });
        ctx.sendJson(200, { ok: true, summary, status: this.sms.getStatus() } satisfies SmsSyncResponse);
        return true;
      }
      case "/api/sms/contacts/upsert": {
        const body = await ctx.readJsonBody();
        const contact = this.sms.upsertContact({
          phone: requiredString(body, "phone", 64),
          name: requiredString(body, "name", 256),
          note: optionalString(body, "note", 1024),
        });
        ctx.sendJson(200, { ok: true, contact } satisfies ContactUpsertResponse);
        return true;
      }
      case "/api/sms/contacts/delete": {
        const body = await ctx.readJsonBody();
        ctx.sendJson(200, { ok: true, deleted: this.sms.removeContact(requiredString(body, "id", 64)) } satisfies ContactDeleteResponse);
        return true;
      }
      case "/api/sms/contacts/import-vcf": {
        const body = await ctx.readJsonBody(MAX_VCF_BODY_BYTES);
        const summary = this.sms.importVcard(requiredString(body, "vcf", MAX_VCF_BODY_BYTES));
        ctx.sendJson(200, { ok: true, summary } satisfies VcardImportResponse);
        return true;
      }
      default:
        return false;
    }
  }
}
