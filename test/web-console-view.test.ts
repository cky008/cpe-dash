import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import { MIN_PASSWORD_LENGTH, TOKEN_LIFETIMES_DAYS, readTokenRequest, validateNewPassword } from "../src/console-policy.ts";
import type { ConnectionTestResult } from "../src/scheduler.ts";
import {
  AGENT_TOKEN_DAYS,
  type ConnectionFailure,
  RECOVERY_COMMANDS,
  agentTokenName,
  auditCaller,
  connectionNotice,
  daysLeft,
  guidanceParams,
  needsLastAttempt,
  passwordProblem,
  tokenState,
} from "../web/src/core/console-view.ts";
import { en } from "../web/src/i18n/en.ts";
import { SETTINGS_TEXT, type SettingsTextKey } from "../web/src/i18n/settings.ts";
import { zhCN } from "../web/src/i18n/zh-CN.ts";

const NOW = Date.parse("2026-11-02T10:00:00.000Z");

function failure(reason: ConnectionFailure["reason"], extra: Partial<ConnectionFailure> = {}): ConnectionFailure {
  return { ok: false, reason, code: null, remainCount: null, waitTimeSec: null, message: reason, ...extra };
}

describe("web core: console settings view", () => {
  it("asks for an explicit confirmation before the router's last login attempt", () => {
    assert.equal(needsLastAttempt(null), false);
    assert.equal(needsLastAttempt({ ok: true, holdMs: 90, model: "H168-383", firmware: "4.4.0.1", loginScheme: "scram", tokenFlow: "webserver-token", ecc: true }), false);
    assert.equal(needsLastAttempt(failure("last_attempt", { remainCount: 1 })), true);
    assert.equal(needsLastAttempt(failure("wrong_password", { remainCount: 1 })), true);
    assert.equal(needsLastAttempt(failure("wrong_password", { remainCount: 2 })), false);
    assert.equal(needsLastAttempt(failure("wrong_password")), false, "an unknown count is not the last attempt");
    assert.equal(needsLastAttempt(failure("unreachable")), false);
  });

  it("explains every failed router test in both languages, with what to do next", () => {
    const reasons: ReadonlyArray<ConnectionFailure["reason"]> = ["invalid_url", "wrong_password", "last_attempt", "locked", "human_logged_in", "unreachable", "standby", "router_error", "password_change_required", "unsupported_login"];
    const tEn = (key: SettingsTextKey): string => SETTINGS_TEXT.en[key];
    for (const reason of reasons) {
      const notice = connectionNotice(failure(reason, { remainCount: 2, waitTimeSec: 90, code: "100003" }), tEn);
      assert.equal(notice.key, `fail_${reason}`);
      assert.equal(notice.tone, reason === "human_logged_in" || reason === "standby" ? "pending" : "danger", reason);
      for (const locale of ["zh-CN", "en"] as const) assert.ok(SETTINGS_TEXT[locale][notice.key].length > 20, `${locale} ${reason}`);
    }
    const ok: ConnectionTestResult = { ok: true, holdMs: 120, model: null, firmware: "4.4.0.1", loginScheme: "scram", tokenFlow: "webserver-token", ecc: true };
    assert.deepEqual(connectionNotice(ok, tEn), {
      key: "ok_result",
      params: { model: "?", firmware: "4.4.0.1", ms: 120, login: "SCRAM", token: "webserver/token", ecc: SETTINGS_TEXT.en.ecc_on },
      tone: "success",
    });
    const legacy = connectionNotice({ ...ok, loginScheme: "sha256", tokenFlow: "sestokinfo", ecc: false }, (key) => SETTINGS_TEXT["zh-CN"][key]);
    assert.deepEqual([legacy.params["login"], legacy.params["token"], legacy.params["ecc"]], ["SHA-256", "webserver/SesTokInfo", "未启用"]);
    assert.deepEqual(guidanceParams(failure("locked", { waitTimeSec: 61, remainCount: 0, code: "108007" })), { remain: 0, minutes: 2, code: "108007" });
    assert.deepEqual(guidanceParams(failure("locked", { waitTimeSec: 5 })), { remain: "?", minutes: 1, code: "?" });
    assert.deepEqual(guidanceParams(failure("unreachable")), { remain: "?", minutes: "?", code: "?" });
  });

  it("checks a new console password with the daemon's own minimum", () => {
    const long = "x".repeat(MIN_PASSWORD_LENGTH);
    assert.equal(passwordProblem(long.slice(1), long.slice(1)), "short");
    assert.equal(passwordProblem(long, `${long}!`), "mismatch");
    assert.equal(passwordProblem(long, long), null);
    assert.equal(validateNewPassword(long), long, "what the console accepts, the daemon accepts");
    assert.throws(() => validateNewPassword(long.slice(1)), /10 to 256 characters/);
    assert.throws(() => validateNewPassword("x".repeat(257)), /10 to 256 characters/);
    for (const text of [zhCN["login.new_password"], en["login.new_password"], SETTINGS_TEXT["zh-CN"].new_password, SETTINGS_TEXT.en.password_short]) {
      assert.ok(text.includes(String(MIN_PASSWORD_LENGTH)), text);
    }
  });

  it("reads a token's state, remaining days and audit caller", () => {
    const day = 86_400_000;
    assert.equal(tokenState({ expiresAtIso: null }, NOW), "active");
    assert.equal(tokenState({ expiresAtIso: new Date(NOW - 1).toISOString() }, NOW), "expired");
    assert.equal(daysLeft({ expiresAtIso: null }, NOW), null);
    assert.equal(daysLeft({ expiresAtIso: new Date(NOW + 1.5 * day).toISOString() }, NOW), 2, "rounded up");
    assert.equal(daysLeft({ expiresAtIso: new Date(NOW - day).toISOString() }, NOW), 0);
    const names = { web: "Console", token: "Token", mcp: "MCP", telegram: "Telegram", "self-heal": "Self-healing", system: "System" } as const;
    assert.equal(auditCaller({ channel: "mcp", label: "Claude Code" }, names), "MCP · Claude Code");
    assert.equal(auditCaller({ channel: "self-heal", label: null }, names), "Self-healing");
  });

  it("mints agent tokens the daemon accepts: a dated name, read-only, an offered lifetime", () => {
    const name = agentTokenName(NOW, "AI agent");
    assert.equal(name, "AI agent 2026-11-02");
    assert.ok((TOKEN_LIFETIMES_DAYS as ReadonlyArray<number>).includes(AGENT_TOKEN_DAYS));
    assert.deepEqual(readTokenRequest({ name, scope: "read", lifetimeDays: AGENT_TOKEN_DAYS }), { name, scope: "read", lifetimeDays: AGENT_TOKEN_DAYS });
    assert.deepEqual(readTokenRequest({ name: "  Grafana ", scope: "full", lifetimeDays: null }), { name: "Grafana", scope: "full", lifetimeDays: null });
    assert.throws(() => readTokenRequest({ name: " ", scope: "read", lifetimeDays: 7 }), /Give the token a name/);
    assert.throws(() => readTokenRequest({ name: "x".repeat(65), scope: "read", lifetimeDays: 7 }), /at most 64/);
    assert.throws(() => readTokenRequest({ name: "x", scope: "admin", lifetimeDays: 7 }), /"scope"/);
    assert.throws(() => readTokenRequest({ name: "x", scope: "read", lifetimeDays: 2 }), /"lifetimeDays" must be one of 1, 7, 30, 90, 365 or null/);
    assert.throws(() => readTokenRequest({ name: "x", scope: "read" }), /"lifetimeDays"/);
  });

  it("ships the settings strings in both languages with the same placeholders and no markup", () => {
    const zh = SETTINGS_TEXT["zh-CN"];
    const english = SETTINGS_TEXT.en;
    assert.deepEqual(Object.keys(english).sort(), Object.keys(zh).sort());
    const placeholders = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? "").sort();
    for (const key of Object.keys(zh) as Array<keyof typeof zh>) {
      assert.ok(zh[key].trim() && english[key].trim(), key);
      assert.deepEqual(placeholders(english[key]), placeholders(zh[key]), key);
      assert.doesNotMatch(zh[key] + english[key], /<\/?[a-z][a-z0-9]*[\s>]/i, key);
    }
    // The recovery commands run the container's own entrypoint and find the line the daemon logs
    assert.match(fs.readFileSync("Dockerfile", "utf8"), /CMD \["node", "dist\/cli\.js", "serve"\]/);
    assert.match(fs.readFileSync("src/cli.ts", "utf8"), /enter the setup code \$\{/);
    assert.ok(RECOVERY_COMMANDS.setup.includes('grep "setup code"'));
    for (const text of [zh.telegram_reset_note, english.telegram_reset_note]) assert.ok(text.includes(RECOVERY_COMMANDS.reset), text);
  });
});
