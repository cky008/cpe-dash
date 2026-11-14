import type {
  ApiErrorEnvelope,
  ContactDeleteResponse,
  ContactUpsertResponse,
  SmsContactsResponse,
  SmsCountriesResponse,
  SmsDeleteResponse,
  SmsPreviewResponse,
  SmsPurgeResponse,
  SmsReadResponse,
  SmsRestoreResponse,
  SmsSendResponse,
  SmsStatusResponse,
  SmsSyncResponse,
  SmsThreadResponse,
  SmsThreadsResponse,
  SmsTrashResponse,
  VcardImportResponse,
} from "../api-contract.ts";
import {
  MAX_VCF_BODY_BYTES,
  readContact,
  readContactId,
  readContactsQuery,
  readMarkRead,
  readPreview,
  readPurge,
  readSend,
  readSyncMode,
  readThreadKeyQuery,
  readThreadsQuery,
  readUids,
  readVcard,
} from "./input.ts";
import type { SmsService } from "./service.ts";

/** Minimal request surface the HTTP server hands to domain route modules. */
export interface ApiRouteContext {
  method: string;
  pathname: string;
  query: Readonly<Record<string, string>>;
  readJsonBody(maxBytes?: number): Promise<Record<string, unknown>>;
  sendJson(statusCode: number, body: unknown, headers?: Record<string, string>): void;
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
        const threads = this.sms.listThreads(readThreadsQuery(query));
        ctx.sendJson(200, { ok: true, threads, status: this.sms.getStatus() } satisfies SmsThreadsResponse);
        return true;
      }
      case "/api/sms/thread": {
        ctx.sendJson(200, { ok: true, thread: this.sms.getThread(readThreadKeyQuery(query)) } satisfies SmsThreadResponse);
        return true;
      }
      case "/api/sms/contacts": {
        const { search, limit } = readContactsQuery(query);
        const contacts = this.sms.listContacts(search, limit);
        ctx.sendJson(200, { ok: true, total: this.sms.contacts.size, contacts } satisfies SmsContactsResponse);
        return true;
      }
      case "/api/sms/trash":
        ctx.sendJson(200, { ok: true, messages: this.sms.listTrash(), trashDays: this.sms.trashDays } satisfies SmsTrashResponse);
        return true;
      default:
        return false;
    }
  }

  async #handlePost(ctx: ApiRouteContext): Promise<boolean> {
    switch (ctx.pathname) {
      case "/api/sms/preview": {
        const body = await ctx.readJsonBody();
        const preview = this.sms.previewSend(readPreview(body));
        ctx.sendJson(200, { ok: true, preview } satisfies SmsPreviewResponse);
        return true;
      }
      case "/api/sms/send": {
        const body = await ctx.readJsonBody();
        const outcome = await this.sms.send({ ...readSend(body), source: "web" });
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
        const result = await this.sms.markRead(readMarkRead(body));
        ctx.sendJson(200, { ok: true, ...result } satisfies SmsReadResponse);
        return true;
      }
      case "/api/sms/delete": {
        const body = await ctx.readJsonBody();
        const result = await this.sms.deleteMessages(readUids(body));
        ctx.sendJson(200, { ok: true, ...result } satisfies SmsDeleteResponse);
        return true;
      }
      case "/api/sms/trash/restore": {
        const body = await ctx.readJsonBody();
        const result = await this.sms.restoreMessages(readUids(body));
        ctx.sendJson(200, { ok: true, ...result } satisfies SmsRestoreResponse);
        return true;
      }
      case "/api/sms/trash/purge": {
        // A console session only (the server refuses tokens before this)
        const body = await ctx.readJsonBody();
        const result = this.sms.purgeTrash(readPurge(body));
        ctx.sendJson(200, { ok: true, ...result } satisfies SmsPurgeResponse);
        return true;
      }
      case "/api/sms/sync": {
        const body = await ctx.readJsonBody();
        const summary = await this.sms.sync(readSyncMode(body), { priority: "normal" });
        ctx.sendJson(200, { ok: true, summary, status: this.sms.getStatus() } satisfies SmsSyncResponse);
        return true;
      }
      case "/api/sms/contacts/upsert": {
        const body = await ctx.readJsonBody();
        const contact = this.sms.upsertContact(readContact(body));
        ctx.sendJson(200, { ok: true, contact } satisfies ContactUpsertResponse);
        return true;
      }
      case "/api/sms/contacts/delete": {
        const body = await ctx.readJsonBody();
        ctx.sendJson(200, { ok: true, deleted: this.sms.removeContact(readContactId(body)) } satisfies ContactDeleteResponse);
        return true;
      }
      case "/api/sms/contacts/import-vcf": {
        const body = await ctx.readJsonBody(MAX_VCF_BODY_BYTES);
        const summary = this.sms.importVcard(readVcard(body));
        ctx.sendJson(200, { ok: true, summary } satisfies VcardImportResponse);
        return true;
      }
      default:
        return false;
    }
  }
}
