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
import { type OperationHandlers, type SmsRestOperation, restBinding, runOperation, smsOperation } from "../operations/registry.ts";
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
 * POST routes are mutations or explicit syncs and inherit the server's CSRF / Bearer guards. The
 * routes and their input checks are the operation registry's; this module writes their handlers.
 */
export class SmsHttpRoutes {
  readonly sms: SmsService;
  readonly #handlers: OperationHandlers<SmsRestOperation, ApiRouteContext, void>;

  constructor(sms: SmsService) {
    this.sms = sms;
    this.#handlers = this.#buildHandlers();
  }

  /** Returns `false` for unknown routes so the server can answer `404 NOT_FOUND` (an unknown POST's body is never read). */
  async handle(ctx: ApiRouteContext): Promise<boolean> {
    const op = smsOperation(ctx.method, ctx.pathname);
    if (op === null) return false;
    const rest = restBinding(op);
    const fields = rest.method === "GET" ? ctx.query : await ctx.readJsonBody(rest.maxBodyBytes);
    await runOperation(this.#handlers, op, fields, ctx);
    return true;
  }

  #buildHandlers(): OperationHandlers<SmsRestOperation, ApiRouteContext, void> {
    const { sms } = this;
    return {
      smsStatus: (_input, ctx) => ctx.sendJson(200, { ok: true, status: sms.getStatus() } satisfies SmsStatusResponse),
      smsCountries: (_input, ctx) => ctx.sendJson(200, { ok: true, defaultCountryCode: sms.defaultCountryCode, countries: sms.countries() } satisfies SmsCountriesResponse),
      smsThreads: (query, ctx) => {
        const threads = sms.listThreads(query);
        ctx.sendJson(200, { ok: true, threads, status: sms.getStatus() } satisfies SmsThreadsResponse);
      },
      smsThread: (key, ctx) => ctx.sendJson(200, { ok: true, thread: sms.getThread(key) } satisfies SmsThreadResponse),
      contacts: ({ search, limit }, ctx) => {
        const contacts = sms.listContacts(search, limit);
        ctx.sendJson(200, { ok: true, total: sms.contacts.size, contacts } satisfies SmsContactsResponse);
      },
      smsTrash: (_input, ctx) => ctx.sendJson(200, { ok: true, messages: sms.listTrash(), trashDays: sms.trashDays } satisfies SmsTrashResponse),
      smsPreview: (request, ctx) => ctx.sendJson(200, { ok: true, preview: sms.previewSend(request) } satisfies SmsPreviewResponse),
      smsSync: async (mode, ctx) => {
        const summary = await sms.sync(mode, { priority: "normal" });
        ctx.sendJson(200, { ok: true, summary, status: sms.getStatus() } satisfies SmsSyncResponse);
      },
      smsSend: async (request, ctx) => {
        const outcome = await sms.send({ ...request, source: "web" });
        if (!outcome.result.ok) {
          ctx.sendJson(502, {
            ok: false,
            errorCode: "SMS_SEND_FAILED",
            message: `The CPE reported a send failure (code ${outcome.result.failCode ?? "unknown"})`,
            result: outcome.result,
            resolvedPhones: outcome.resolvedPhones,
          } satisfies ApiErrorEnvelope);
          return;
        }
        ctx.sendJson(200, { ok: true, ...outcome } satisfies SmsSendResponse);
      },
      smsMarkRead: async (request, ctx) => ctx.sendJson(200, { ok: true, ...(await sms.markRead(request)) } satisfies SmsReadResponse),
      smsDelete: async (request, ctx) => ctx.sendJson(200, { ok: true, ...(await sms.deleteMessages(request)) } satisfies SmsDeleteResponse),
      smsRestore: async (request, ctx) => ctx.sendJson(200, { ok: true, ...(await sms.restoreMessages(request)) } satisfies SmsRestoreResponse),
      // A console session only (the server refuses tokens before this)
      smsPurge: (request, ctx) => ctx.sendJson(200, { ok: true, ...sms.purgeTrash(request) } satisfies SmsPurgeResponse),
      contactUpsert: (contact, ctx) => ctx.sendJson(200, { ok: true, contact: sms.upsertContact(contact) } satisfies ContactUpsertResponse),
      contactDelete: (id, ctx) => ctx.sendJson(200, { ok: true, deleted: sms.removeContact(id) } satisfies ContactDeleteResponse),
      contactImport: (vcf, ctx) => ctx.sendJson(200, { ok: true, summary: sms.importVcard(vcf) } satisfies VcardImportResponse),
    };
  }
}
