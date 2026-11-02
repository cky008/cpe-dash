import type { ApiErrorEnvelope, ConsoleSettingsResponse } from "./api-contract.ts";
import type { AuditLog } from "./audit-log.ts";
import { normalizeCpeUrl } from "./config.ts";
import { readTokenRequest, validateNewPassword } from "./console-policy.ts";
import type { ConsoleSettings } from "./console-settings.ts";
import { CpeControlValidationError } from "./control-error.ts";
import type { ConnectionCandidate, MutexSessionScheduler } from "./scheduler.ts";
import type { ApiRouteContext } from "./sms/http-routes.ts";

export interface SettingsRoutesOptions {
  settings: ConsoleSettings;
  scheduler: MutexSessionScheduler;
  audit: AuditLog | null;
  /** METRICS_ENABLED from `.env`, used while the console has not set its own choice. */
  metricsFromEnv: boolean;
  /** The bot is configured (TELEGRAM_BOT_TOKEN). */
  telegramConfigured: boolean;
  /** The first router connection was saved: start polling, SMS and Telegram. */
  onConnectionReady: () => void;
  /** End every console session except `keepSessionId` (after a password change). */
  revokeSessions: (keepSessionId: string | null) => void;
  /** Close the SSE streams of a revoked token. */
  disconnectToken: (tokenId: string) => void;
  /** Unlink every chat linked with /auth; resolves how many. */
  unlinkTelegram: () => number;
}

function text(body: Record<string, unknown>, key: string, max: number): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length > max) throw new CpeControlValidationError(`"${key}" must be text of at most ${max} characters`);
  return value;
}

/**
 * `/api/console/*`: what the console manages instead of `.env` (router connection, console password,
 * tokens, Telegram linking, switches). Only a console session reaches these routes: a Bearer token,
 * even a full one, cannot change the credentials it was issued under.
 */
export class SettingsHttpRoutes {
  readonly #opts: SettingsRoutesOptions;

  constructor(opts: SettingsRoutesOptions) {
    this.#opts = opts;
  }

  summary(): ConsoleSettingsResponse {
    const { settings, metricsFromEnv, telegramConfigured } = this.#opts;
    const cpe = settings.cpe;
    return {
      ok: true,
      cpe: cpe ? { url: cpe.url, username: cpe.username, passwordSet: cpe.password !== "" } : null,
      login: { changedAtIso: settings.loginChangedAtIso, fromEnv: settings.loginFromEnv },
      reviewPending: settings.reviewPending,
      telegram: { configured: telegramConfigured, resetEnabled: settings.telegramReset },
      metrics: { enabled: settings.metricsEnabled ?? metricsFromEnv, source: settings.metricsEnabled === null ? "env" : "console", envEnabled: metricsFromEnv },
    };
  }

  /** `true` when the route was handled. `sessionId` is the console session making the request. */
  async handle(ctx: ApiRouteContext, sessionId: string): Promise<boolean> {
    const { settings, audit } = this.#opts;
    if (ctx.method === "GET") {
      if (ctx.pathname === "/api/console") {
        ctx.sendJson(200, this.summary());
        return true;
      }
      if (ctx.pathname === "/api/console/tokens") {
        ctx.sendJson(200, { ok: true, tokens: settings.listTokens() });
        return true;
      }
      return false;
    }
    if (ctx.method !== "POST") return false;

    switch (ctx.pathname) {
      case "/api/console/cpe/test": {
        const body = await ctx.readJsonBody();
        ctx.sendJson(200, { ok: true, result: await this.#opts.scheduler.testConnection(this.#candidate(body), { lastAttempt: body["lastAttempt"] === true }) });
        return true;
      }
      case "/api/console/cpe": {
        const body = await ctx.readJsonBody();
        const candidate = this.#candidate(body);
        const result = await this.#opts.scheduler.testConnection(candidate, { lastAttempt: body["lastAttempt"] === true });
        if (!result.ok) {
          audit?.record({ action: "settings.cpe", outcome: "refused", detail: `test failed: ${result.reason}` });
          ctx.sendJson(400, { ok: false, errorCode: "CPE_TEST_FAILED", message: result.message, connectionTest: result } satisfies ApiErrorEnvelope);
          return true;
        }
        const first = settings.cpe === null;
        // Stored as the client uses it ("192.168.8.1/" becomes "http://192.168.8.1"); the test proved it parses
        const saved = { ...candidate, url: normalizeCpeUrl(candidate.url) };
        settings.setCpe(saved);
        settings.markReviewed();
        await this.#opts.scheduler.applyConnection(saved);
        audit?.record({ action: "settings.cpe", outcome: "applied", detail: `router ${new URL(saved.url).host} as ${saved.username}` });
        if (first) this.#opts.onConnectionReady();
        ctx.sendJson(200, { ok: true, result, settings: this.summary() });
        return true;
      }
      case "/api/console/review": {
        settings.markReviewed();
        audit?.record({ action: "settings.review", outcome: "applied" });
        ctx.sendJson(200, this.summary());
        return true;
      }
      case "/api/console/password": {
        const body = await ctx.readJsonBody();
        const next = validateNewPassword(body["next"]);
        if (!(await settings.verifyLogin(typeof body["current"] === "string" ? body["current"] : ""))) {
          audit?.record({ action: "settings.password", outcome: "refused", detail: "wrong current password" });
          ctx.sendJson(403, { ok: false, errorCode: "WRONG_PASSWORD", message: "The current console password is wrong" });
          return true;
        }
        await settings.setLogin(next);
        this.#opts.revokeSessions(sessionId);
        audit?.record({ action: "settings.password", outcome: "applied", detail: "other console sessions signed out" });
        ctx.sendJson(200, this.summary());
        return true;
      }
      case "/api/console/tokens": {
        const request = readTokenRequest(await ctx.readJsonBody());
        const { name, scope, lifetimeDays } = request;
        let minted;
        try {
          minted = settings.createToken(request);
        } catch (err) {
          throw new CpeControlValidationError(err instanceof Error ? err.message : String(err));
        }
        audit?.record({ action: "token.create", outcome: "applied", detail: `${name} (${scope}, ${lifetimeDays === null ? "never expires" : `${lifetimeDays} d`})` });
        ctx.sendJson(200, { ok: true, token: minted.token, record: minted.record });
        return true;
      }
      case "/api/console/tokens/revoke": {
        const id = text(await ctx.readJsonBody(), "id", 64) ?? "";
        const revoked = settings.revokeToken(id);
        if (!revoked) {
          ctx.sendJson(404, { ok: false, errorCode: "NOT_FOUND", message: "No such token" });
          return true;
        }
        this.#opts.disconnectToken(revoked.id);
        audit?.record({ action: "token.revoke", outcome: "applied", detail: revoked.name });
        ctx.sendJson(200, { ok: true, record: revoked });
        return true;
      }
      case "/api/console/telegram/pairing-code": {
        if (!this.#opts.telegramConfigured) {
          ctx.sendJson(409, { ok: false, errorCode: "TELEGRAM_DISABLED", message: "Set TELEGRAM_BOT_TOKEN first" });
          return true;
        }
        const code = settings.issueCode("pair");
        audit?.record({ action: "telegram.pairing-code", outcome: "applied" });
        ctx.sendJson(200, { ok: true, code, expiresInSec: 600 });
        return true;
      }
      case "/api/console/telegram/unlink-all": {
        const unlinked = this.#opts.unlinkTelegram();
        audit?.record({ action: "telegram.unlink-all", outcome: "applied", detail: `${unlinked} chat(s)` });
        ctx.sendJson(200, { ok: true, unlinked });
        return true;
      }
      case "/api/console/switches": {
        const body = await ctx.readJsonBody();
        const changes: string[] = [];
        if (body["telegramReset"] !== undefined) {
          if (typeof body["telegramReset"] !== "boolean") throw new CpeControlValidationError('"telegramReset" must be true or false');
          settings.setTelegramReset(body["telegramReset"]);
          changes.push(`telegram reset ${body["telegramReset"] ? "on" : "off"}`);
        }
        if (body["metricsEnabled"] !== undefined) {
          const value = body["metricsEnabled"];
          if (value !== null && typeof value !== "boolean") throw new CpeControlValidationError('"metricsEnabled" must be true, false or null (follow .env)');
          settings.setMetricsEnabled(value);
          changes.push(`metrics ${value === null ? "from .env" : value ? "on" : "off"}`);
        }
        if (changes.length === 0) throw new CpeControlValidationError("Nothing to change");
        audit?.record({ action: "settings.switches", outcome: "applied", detail: changes.join(", ") });
        ctx.sendJson(200, this.summary());
        return true;
      }
      default:
        return false;
    }
  }

  /** The connection to try: given fields, the stored ones for anything left out (the password is never sent back). */
  #candidate(body: Record<string, unknown>): ConnectionCandidate {
    const stored = this.#opts.settings.cpe;
    const url = (text(body, "url", 256) ?? stored?.url ?? "").trim();
    const username = (text(body, "username", 64) ?? stored?.username ?? "admin").trim() || "admin";
    const password = text(body, "password", 256) || stored?.password || "";
    if (!url) throw new CpeControlValidationError('"url" is required, e.g. http://192.168.8.1');
    if (!password) throw new CpeControlValidationError('"password" is required');
    return { url, username, password };
  }
}
