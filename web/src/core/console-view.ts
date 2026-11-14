import type { TelegramChatRecord } from "../../../src/api-contract.ts";
import type { AuditEntry } from "../../../src/audit-log.ts";
import { MIN_PASSWORD_LENGTH } from "../../../src/console-policy.ts";
import type { PublicTokenRecord } from "../../../src/console-settings.ts";
import type { ConnectionTestResult } from "../../../src/scheduler.ts";
import type { LoginScheme, TokenFlow } from "../../../src/device-profile.ts";
import { type RouterFamily, isDriverFamily } from "../../../src/router-family.ts";
import type { MessageParams } from "./i18n.ts";
import { usualAddress } from "./router-brand.ts";
import type { SettingsTextKey } from "../i18n/settings.ts";

/**
 * What the console's settings dialog decides without the DOM: which guidance a failed router test
 * gets, when the last login attempt must be confirmed, how a token's state and an audit caller read.
 */

export type ConnectionFailure = Extract<ConnectionTestResult, { ok: false }>;

/** The router has (at most) one login attempt left: another try needs an explicit confirmation. */
export function needsLastAttempt(result: ConnectionTestResult | null): boolean {
  if (!result || result.ok) return false;
  return result.reason === "last_attempt" || (result.reason === "wrong_password" && result.remainCount !== null && result.remainCount <= 1);
}

export type NoticeTone = "info" | "pending" | "success" | "danger";

const LOGIN_KEYS: Readonly<Record<LoginScheme, SettingsTextKey>> = {
  scram: "login_scram",
  sha256: "login_sha256",
  base64: "login_base64",
  unknown: "login_unknown",
};

const TOKEN_FLOW_KEYS: Readonly<Record<TokenFlow, SettingsTextKey>> = {
  "webserver-token": "token_flow_webserver",
  sestokinfo: "token_flow_sestokinfo",
  unknown: "token_flow_unknown",
};

/** A login scheme's name (SCRAM, SHA-256, Base64, unknown). */
export function schemeText(scheme: LoginScheme, t: (key: SettingsTextKey) => string): string {
  return t(LOGIN_KEYS[scheme]);
}

/** Where a session's CSRF tokens came from. */
export function tokenFlowText(flow: TokenFlow, t: (key: SettingsTextKey) => string): string {
  return t(TOKEN_FLOW_KEYS[flow]);
}

/** The connection a test ran against: its brand (the detected one when FengSui told it) and the address typed. */
export interface TestedConnection {
  family: RouterFamily;
  address: string;
}

/**
 * The text, its parameters and the tone the settings dialog shows for a router test; a working one
 * also names how it logged in (`t` translates those names). `tested` is the connection the test ran
 * against (default: the verified router's brand and usual address): a brand FengSui was never run on
 * says so instead of naming HiLink's login details, and the guidance names the address typed.
 */
export function connectionNotice(
  result: ConnectionTestResult,
  t: (key: SettingsTextKey) => string,
  tested: TestedConnection = { family: "huawei", address: usualAddress("huawei") }
): { key: SettingsTextKey; params: Record<string, string | number>; tone: NoticeTone } {
  const otherBrand = isDriverFamily(tested.family);
  if (result.ok) {
    if (otherBrand) return { key: "ok_result_brand", params: { model: result.model ?? "?", firmware: result.firmware ?? "?", ms: result.holdMs }, tone: "success" };
    return {
      key: "ok_result",
      params: {
        model: result.model ?? "?",
        firmware: result.firmware ?? "?",
        ms: result.holdMs,
        login: schemeText(result.loginScheme, t),
        token: tokenFlowText(result.tokenFlow, t),
        ecc: t(result.ecc ? "ecc_on" : "ecc_off"),
      },
      tone: "success",
    };
  }
  // Every failure reason has its own guidance text (checked by the type)
  let key: SettingsTextKey = `fail_${result.reason}` satisfies `fail_${ConnectionFailure["reason"]}`;
  // No count of attempts left: none is made up; an answer or a login that does not fit another brand's interface points at the brand
  if (result.reason === "wrong_password" && result.remainCount === null) key = "fail_wrong_password_nocount";
  else if (result.reason === "router_error" && otherBrand) key = "fail_router_error_brand";
  else if (result.reason === "unsupported_login" && otherBrand) key = "fail_unsupported_login_brand";
  const params = { ...guidanceParams(result), address: tested.address.trim() || usualAddress(tested.family), usual: usualAddress(tested.family) };
  return { key, params, tone: result.reason === "human_logged_in" || result.reason === "standby" ? "pending" : "danger" };
}

/** Why a new console password cannot be used: too short, or the repeat differs. */
export function passwordProblem(next: string, repeat: string): "short" | "mismatch" | null {
  if (next.length < MIN_PASSWORD_LENGTH) return "short";
  return next === repeat ? null : "mismatch";
}

/** Parameters for the guidance text of a failed test (`remain`, `minutes`, `code`). */
export function guidanceParams(result: ConnectionFailure): Record<string, string | number> {
  return {
    remain: result.remainCount ?? "?",
    minutes: result.waitTimeSec === null ? "?" : Math.max(1, Math.ceil(result.waitTimeSec / 60)),
    code: result.code ?? "?",
  };
}

export type TokenState = "active" | "expired";

export function tokenState(token: Pick<PublicTokenRecord, "expiresAtIso">, nowMs: number): TokenState {
  return token.expiresAtIso !== null && Date.parse(token.expiresAtIso) <= nowMs ? "expired" : "active";
}

/** `days` until a token expires (rounded up), `null` when it never does. */
export function daysLeft(token: Pick<PublicTokenRecord, "expiresAtIso">, nowMs: number): number | null {
  if (token.expiresAtIso === null) return null;
  return Math.max(0, Math.ceil((Date.parse(token.expiresAtIso) - nowMs) / 86_400_000));
}

/** The caller of an audit entry, for the given channel names (web, token, MCP, …). */
export function auditCaller(entry: Pick<AuditEntry, "channel" | "label">, channelNames: Readonly<Record<AuditEntry["channel"], string>>): string {
  const channel = channelNames[entry.channel];
  return entry.label ? `${channel} · ${entry.label}` : channel;
}

/** A Telegram chat or user ID as Settings shows it: its last three digits only in privacy mode (like the audit log). */
export function chatIdText(id: string, masked: boolean): string {
  return masked && id.length > 4 ? `…${id.slice(-3)}` : id;
}

/** How a Telegram chat reaches the bot: the way `/auth` linked it, a linked group's topic and member, `.env`. */
export function telegramChatDetails(chat: TelegramChatRecord, masked: boolean, t: (key: SettingsTextKey, params?: MessageParams) => string): string[] {
  const details: string[] = [];
  if (chat.linkedWith === "token") details.push(chat.tokenName ? t("chat_via_token", { name: chat.tokenName }) : t("chat_via_token_gone"));
  else if (chat.linkedWith === "code") details.push(t("chat_via_code"));
  else if (chat.linkedWith === "group-code") details.push(t("chat_via_group_code"));
  if (chat.topic !== null) details.push(t("chat_topic", { topic: chat.topic }));
  if (chat.linkedBy !== null) details.push(t("chat_member", { id: chatIdText(chat.linkedBy, masked) }));
  if (chat.fromEnv) details.push(t(chat.linkedWith === null ? "chat_env_only" : "chat_also_env"));
  return details;
}

/** What to run on the NAS for the one-time setup code, and for a console reset code. */
export const RECOVERY_COMMANDS = {
  setup: 'sudo docker logs cpe-dash 2>&1 | grep "setup code"',
  reset: "sudo docker exec cpe-dash node dist/cli.js reset-login",
} as const;

/** Lifetime of a read-only token minted from the agent guide (one of TOKEN_LIFETIMES_DAYS). */
export const AGENT_TOKEN_DAYS = 90;

/** A default name for a token minted from the agent guide. */
export function agentTokenName(nowMs: number, prefix: string): string {
  return `${prefix} ${new Date(nowMs).toISOString().slice(0, 10)}`;
}
