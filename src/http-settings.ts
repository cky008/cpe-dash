import { AGENT_TEST_UNAVAILABLE_MESSAGE, noAgentTestPlan } from "./agent-test.ts";
import { type AgentTestService, AgentTestUnavailableError } from "./agent-test-service.ts";
import type {
  AgentTestResponse,
  ApiErrorEnvelope,
  ConnectionTestResponse,
  ConsoleSettingsResponse,
  DeviceReportResponse,
  ExperimentalWritesResponse,
  PairingCodeResponse,
  TelegramChatRecord,
  TelegramChatsResponse,
} from "./api-contract.ts";
import type { AuditLog } from "./audit-log.ts";
import { BEHAVIOUR_ENV, type BehaviourValues, DEFAULT_BEHAVIOUR, describeBehaviour, readBehaviourPatch, resolveBehaviour } from "./behaviour-settings.ts";
import type { CredentialVerdict } from "./http-auth.ts";
import { normalizeCpeUrl } from "./config.ts";
import { describePermissions, readTokenPermissions, readTokenRequest, validateNewPassword } from "./console-policy.ts";
import { type ConsoleSettings, PAIRING_CODE_TTL_MS } from "./console-settings.ts";
import { CpeControlValidationError } from "./control-error.ts";
import { changeExperimentalConsent } from "./experimental-consent.ts";
import type { DeviceProbeResult, DeviceReport } from "./device-profile.ts";
import { FAMILY_AUTO, ROUTER_FAMILIES, ROUTER_FAMILY_FACTS, type RouterFamily, isRouterFamily, routerFamilyOf } from "./router-family.ts";
import type { ConnectionCandidate, ConnectionTestResult, MutexSessionScheduler } from "./scheduler.ts";
import type { ApiRouteContext } from "./sms/http-routes.ts";

export interface SettingsRoutesOptions {
  settings: ConsoleSettings;
  scheduler: MutexSessionScheduler;
  audit: AuditLog | null;
  /** METRICS_ENABLED from `.env`, used while the console has not set its own choice. */
  metricsFromEnv: boolean;
  /** What `.env` says for the behaviour settings (it can be reloaded, hence a function). */
  behaviourFromEnv?: () => BehaviourValues;
  /** The behaviour settings in force changed: hand them to the running parts. */
  onBehaviourChanged?: (values: BehaviourValues) => void;
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
  /** A token was revoked: unlink the Telegram chats it linked with /auth; resolves how many. */
  unlinkTelegramToken?: (tokenId: string) => number;
  /** Every chat the bot reaches (none without a bot). */
  telegramChats?: () => TelegramChatRecord[];
  /** Unlink one chat linked with /auth; `false` when it was not linked that way. */
  unlinkTelegramChat?: (chatId: string) => boolean;
  /** The bot's @username once known (`/auth@bot CODE` reaches it in a group with other bots). */
  telegramUsername?: () => string | null;
  /** Keep a device probe a connection test made of the router in use (or of the one just saved). */
  onDeviceProbe?: (probe: DeviceProbeResult) => void;
  /** Build the desensitized device report (structure only, second pass through src/sanitize.ts). */
  deviceReport?: () => DeviceReport;
  /** The AI agent test at one click (absent: never offered). */
  agentTest?: Pick<AgentTestService, "status" | "begin" | "end" | "acknowledge"> | null;
}

/** What to send the bot: a group code names the bot, so a group with other bots routes it here (privacy mode delivers it). */
export function pairingCommand(code: string, botUsername: string | null): string {
  return botUsername ? `/auth@${botUsername} ${code}` : `/auth ${code}`;
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
      cpe: cpe ? { url: cpe.url, username: cpe.username, passwordSet: cpe.password !== "", ...(cpe.family && cpe.family !== "huawei" ? { family: cpe.family } : {}) } : null,
      login: { changedAtIso: settings.loginChangedAtIso, fromEnv: settings.loginFromEnv },
      reviewPending: settings.reviewPending,
      telegram: { configured: telegramConfigured, resetEnabled: settings.telegramReset },
      metrics: { enabled: settings.metricsEnabled ?? metricsFromEnv, source: settings.metricsEnabled === null ? "env" : "console", envEnabled: metricsFromEnv },
      behaviour: describeBehaviour(this.#behaviourFromEnv(), settings.behaviourOverrides),
    };
  }

  #behaviourFromEnv(): BehaviourValues {
    return this.#opts.behaviourFromEnv?.() ?? DEFAULT_BEHAVIOUR;
  }

  /**
   * `true` when the route was handled. `sessionId` is the console session making the request;
   * `checkPassword` verifies a console password through the sign-in limiter of the caller's address.
   */
  async handle(ctx: ApiRouteContext, sessionId: string, checkPassword: (candidate: string) => Promise<CredentialVerdict>): Promise<boolean> {
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
      if (ctx.pathname === "/api/console/telegram/chats") {
        ctx.sendJson(200, { ok: true, chats: this.#opts.telegramChats?.() ?? [] } satisfies TelegramChatsResponse);
        return true;
      }
      if (ctx.pathname === "/api/console/device-report" && this.#opts.deviceReport) {
        ctx.sendJson(200, { ok: true, report: this.#opts.deviceReport() } satisfies DeviceReportResponse);
        return true;
      }
      if (ctx.pathname === "/api/console/experimental") {
        ctx.sendJson(200, this.#experimental());
        return true;
      }
      return false;
    }
    if (ctx.method !== "POST") return false;

    switch (ctx.pathname) {
      case "/api/console/cpe/test": {
        const body = await ctx.readJsonBody();
        const candidate = await this.#candidate(body);
        // No brand could be told: nothing but login-free requests went out
        if ("ok" in candidate) {
          ctx.sendJson(200, { ok: true, result: candidate } satisfies ConnectionTestResponse);
          return true;
        }
        const { result, probe } = await this.#opts.scheduler.testConnectionDetailed(candidate, { lastAttempt: body["lastAttempt"] === true });
        // Testing the router in use identifies it again; a test of another address changes nothing
        if (probe && this.#isCurrentRouter(candidate.url)) this.#opts.onDeviceProbe?.(probe);
        ctx.sendJson(200, { ok: true, result, family: candidate.family } satisfies ConnectionTestResponse);
        return true;
      }
      case "/api/console/cpe": {
        const body = await ctx.readJsonBody();
        const candidate = await this.#candidate(body);
        if ("ok" in candidate) {
          audit?.record({ action: "settings.cpe", outcome: "refused", detail: `test failed: ${candidate.reason}` });
          ctx.sendJson(400, { ok: false, errorCode: "CPE_TEST_FAILED", message: candidate.message, connectionTest: candidate } satisfies ApiErrorEnvelope);
          return true;
        }
        const { result, probe } = await this.#opts.scheduler.testConnectionDetailed(candidate, { lastAttempt: body["lastAttempt"] === true });
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
        // The scheme the test logged in with: a SCRAM router never gets a legacy password afterwards
        await this.#opts.scheduler.applyConnection(saved, { loginScheme: probe?.identity.loginScheme ?? null });
        if (probe) this.#opts.onDeviceProbe?.(probe);
        // The brand is part of the record: a change of it is a change of everything FengSui sends
        audit?.record({ action: "settings.cpe", outcome: "applied", detail: `router ${new URL(saved.url).host}${saved.username ? ` as ${saved.username}` : ""} (${saved.family})` });
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
        // Through the sign-in limiter: a session cannot try current passwords without limit (nor tie up scrypt)
        const verdict = await checkPassword(typeof body["current"] === "string" ? body["current"] : "");
        if (!verdict.ok && verdict.statusCode === 429) {
          const retryAfterSec = verdict.retrySec ?? 60;
          audit?.record({ action: "settings.password", outcome: "refused", detail: "too many wrong passwords" });
          ctx.sendJson(429, { ok: false, errorCode: "RATE_LIMITED", retryAfterSec, message: `Too many wrong passwords: try again in ${retryAfterSec} s` } satisfies ApiErrorEnvelope, { "Retry-After": String(retryAfterSec) });
          return true;
        }
        if (!verdict.ok) {
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
        const { name, permissions, lifetimeDays } = request;
        let minted;
        try {
          minted = settings.createToken(request);
        } catch (err) {
          throw new CpeControlValidationError(err instanceof Error ? err.message : String(err));
        }
        audit?.record({ action: "token.create", outcome: "applied", detail: `${name} (${describePermissions(permissions)}, ${lifetimeDays === null ? "never expires" : `${lifetimeDays} d`})` });
        ctx.sendJson(200, { ok: true, token: minted.token, record: minted.record });
        return true;
      }
      case "/api/console/tokens/permissions": {
        const body = await ctx.readJsonBody();
        const id = text(body, "id", 64) ?? "";
        const permissions = readTokenPermissions(body["permissions"]);
        const updated = settings.setTokenPermissions(id, permissions);
        if (!updated) {
          ctx.sendJson(404, { ok: false, errorCode: "NOT_FOUND", message: "No such token" });
          return true;
        }
        // Its event streams reconnect under the new permissions (SMS events follow sms-read)
        this.#opts.disconnectToken(updated.id);
        audit?.record({ action: "token.permissions", outcome: "applied", detail: `${updated.name}: ${describePermissions(permissions)}` });
        ctx.sendJson(200, { ok: true, record: updated });
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
        // A chat it linked with /auth would otherwise keep the SMS and the router's controls
        const unlinked = this.#opts.unlinkTelegramToken?.(revoked.id) ?? 0;
        audit?.record({ action: "token.revoke", outcome: "applied", detail: unlinked > 0 ? `${revoked.name}; ${unlinked} Telegram chat(s) it linked unlinked` : revoked.name });
        ctx.sendJson(200, { ok: true, record: revoked });
        return true;
      }
      case "/api/console/telegram/pairing-code": {
        if (!this.#opts.telegramConfigured) {
          ctx.sendJson(409, { ok: false, errorCode: "TELEGRAM_DISABLED", message: "Set TELEGRAM_BOT_TOKEN first" });
          return true;
        }
        const body = await ctx.readJsonBody();
        const group = body["group"] ?? false;
        if (typeof group !== "boolean") throw new CpeControlValidationError('"group" must be true or false');
        const code = settings.issueCode(group ? "pair-group" : "pair");
        audit?.record({ action: "telegram.pairing-code", outcome: "applied", detail: group ? "group" : null });
        ctx.sendJson(200, { ok: true, code, expiresInSec: PAIRING_CODE_TTL_MS / 1000, group, command: pairingCommand(code, group ? (this.#opts.telegramUsername?.() ?? null) : null) } satisfies PairingCodeResponse);
        return true;
      }
      case "/api/console/telegram/unlink": {
        const chatId = (text(await ctx.readJsonBody(), "chatId", 24) ?? "").trim();
        if (!/^-?\d{1,20}$/.test(chatId)) throw new CpeControlValidationError('"chatId" must be a Telegram chat ID, e.g. 1001 or -1001');
        if (!this.#opts.unlinkTelegramChat?.(chatId)) {
          // A chat .env authorizes is not linked: say where it can be removed
          const fromEnv = this.#opts.telegramChats?.().some((chat) => chat.chatId === chatId && chat.fromEnv) === true;
          ctx.sendJson(404, {
            ok: false,
            errorCode: "NOT_FOUND",
            message: fromEnv ? "TELEGRAM_CHAT_IDS in .env authorizes this chat: remove it there" : "No chat linked with /auth has this ID",
          } satisfies ApiErrorEnvelope);
          return true;
        }
        audit?.record({ action: "telegram.unlink", outcome: "applied", detail: `${chatId.startsWith("-") ? "group" : "private"} chat …${chatId.slice(-3)}` });
        ctx.sendJson(200, { ok: true, chats: this.#opts.telegramChats?.() ?? [] } satisfies TelegramChatsResponse);
        return true;
      }
      case "/api/console/telegram/unlink-all": {
        const unlinked = this.#opts.unlinkTelegram();
        audit?.record({ action: "telegram.unlink-all", outcome: "applied", detail: `${unlinked} chat(s)` });
        ctx.sendJson(200, { ok: true, unlinked });
        return true;
      }
      case "/api/console/experimental": {
        await this.#setExperimental(ctx, await ctx.readJsonBody());
        return true;
      }
      case "/api/console/agent-test": {
        this.#agentTest(ctx, await ctx.readJsonBody());
        return true;
      }
      case "/api/console/behaviour": {
        const patch = readBehaviourPatch(await ctx.readJsonBody());
        settings.setBehaviour(patch);
        this.#opts.onBehaviourChanged?.(resolveBehaviour(this.#behaviourFromEnv(), settings.behaviourOverrides));
        const detail = Object.entries(patch)
          .map(([key, value]) => `${BEHAVIOUR_ENV[key as keyof typeof BEHAVIOUR_ENV]} ${value === null ? "from .env" : String(value)}`)
          .join(", ");
        audit?.record({ action: "settings.behaviour", outcome: "applied", detail });
        ctx.sendJson(200, this.summary());
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

  /** What each write is on this router, the experimental writes its owner turned on, the recent results and the agent test. */
  #experimental(): ExperimentalWritesResponse {
    const agentTest = this.#opts.agentTest?.status() ?? { current: null, plan: noAgentTestPlan() };
    return { ok: true, device: this.#opts.scheduler.device.snapshot(), consents: this.#opts.settings.experimentalConsents, writes: this.#opts.scheduler.genericWrites, agentTest };
  }

  /**
   * The AI agent test at one click: `start` (what the plan lists, for the model the console showed and
   * the token it chose), `end` (put back what it turned on) and `ack` (its reminder was read). The
   * service audits each change; the answer carries the switches too, which the test may have changed.
   */
  #agentTest(ctx: ApiRouteContext, body: Record<string, unknown>): void {
    const service = this.#opts.agentTest;
    const action = body["action"];
    if (action !== "start" && action !== "end" && action !== "ack") throw new CpeControlValidationError('"action" must be "start", "end" or "ack"');
    if (!service) {
      ctx.sendJson(409, { ok: false, errorCode: "AGENT_TEST_UNAVAILABLE", message: AGENT_TEST_UNAVAILABLE_MESSAGE } satisfies ApiErrorEnvelope);
      return;
    }
    if (action === "start") {
      try {
        service.begin({ model: body["model"], tokenId: body["tokenId"], sms: body["sms"] });
      } catch (err) {
        if (!(err instanceof AgentTestUnavailableError)) throw err;
        ctx.sendJson(409, { ok: false, errorCode: "AGENT_TEST_UNAVAILABLE", message: err.message } satisfies ApiErrorEnvelope);
        return;
      }
    } else if (action === "end") {
      service.end();
    } else {
      const alertId = body["alertId"];
      if (alertId !== undefined && (typeof alertId !== "string" || alertId.length > 64)) throw new CpeControlValidationError('"alertId" must be the reminder\'s alert ID');
      service.acknowledge(alertId ?? null);
    }
    ctx.sendJson(200, { ...this.#experimental(), settings: this.summary() } satisfies AgentTestResponse);
  }

  /**
   * Turn one experimental write on or off (multi-model phase 3). On needs the feature to be offered on
   * this router (a generic implementation and the probe's evidence) and the router's model typed back,
   * so a consent always names the model the owner saw; off always works. The gate sees the change at
   * once; both directions are audited, refusals too.
   */
  async #setExperimental(ctx: ApiRouteContext, body: Record<string, unknown>): Promise<void> {
    const { settings, audit, scheduler } = this.#opts;
    const result = changeExperimentalConsent(settings, scheduler.device, { feature: body["feature"], enabled: body["enabled"], model: body["model"] });
    if (result.ok) {
      audit?.record({ action: "settings.experimental", outcome: "applied", detail: result.detail });
      ctx.sendJson(200, this.#experimental());
      return;
    }
    if (result.detail) audit?.record({ action: "settings.experimental", outcome: "refused", detail: result.detail });
    if (result.errorCode === "EXPERIMENTAL_UNAVAILABLE") {
      ctx.sendJson(409, { ok: false, errorCode: "EXPERIMENTAL_UNAVAILABLE", message: result.message, state: result.state } satisfies ApiErrorEnvelope);
      return;
    }
    throw new CpeControlValidationError(result.message);
  }

  /** `url` is the address of the stored router connection (both compared as the client uses them). */
  #isCurrentRouter(url: string): boolean {
    const stored = this.#opts.settings.cpe;
    if (!stored) return false;
    try {
      return normalizeCpeUrl(url) === normalizeCpeUrl(stored.url);
    } catch {
      return false;
    }
  }

  /**
   * The connection to try: given fields, the stored ones for anything left out (the password is never
   * sent back). The stored password goes only to the stored address: another host would receive it
   * with a legacy login, or a SCRAM proof it could crack offline, so a new address needs it typed.
   * `family: "auto"` has FengSui tell the brand from the router's login-free answers before anything
   * else is sent; a router it cannot place comes back as a failed test instead of a candidate. A user
   * name left out is the stored one for the stored brand, else the brand's usual one.
   */
  async #candidate(body: Record<string, unknown>): Promise<(ConnectionCandidate & { family: RouterFamily }) | Extract<ConnectionTestResult, { ok: false }>> {
    const stored = this.#opts.settings.cpe;
    const url = (text(body, "url", 256) ?? stored?.url ?? "").trim();
    const asked = body["family"];
    if (asked !== undefined && asked !== null && asked !== FAMILY_AUTO && !isRouterFamily(asked)) {
      throw new CpeControlValidationError(`"family" must be "${FAMILY_AUTO}" or one of ${ROUTER_FAMILIES.join(", ")}`);
    }
    if (!url) throw new CpeControlValidationError('"url" is required, e.g. http://192.168.8.1');
    const typedUser = text(body, "username", 64);
    const typed = text(body, "password", 256);
    let password: string;
    if (typed) password = typed;
    else if (stored?.password && this.#isCurrentRouter(url)) password = stored.password;
    else throw new CpeControlValidationError(stored?.password ? '"password" is required to try another router address' : '"password" is required');

    const storedFamily = routerFamilyOf(stored?.family);
    let family: RouterFamily;
    if (asked === FAMILY_AUTO) {
      const detected = await this.#opts.scheduler.detectFamily(url);
      if (typeof detected !== "string") return detected;
      family = detected;
    } else {
      family = isRouterFamily(asked) ? asked : storedFamily;
    }
    const username = (typedUser ?? (stored && family === storedFamily ? stored.username : ROUTER_FAMILY_FACTS[family].defaultUsername)).trim();
    return { url, username, password, family };
  }
}
