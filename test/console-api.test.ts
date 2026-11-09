import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import type { AuditResponse, ConsoleSettingsResponse, CreateTokenResponse, TokensResponse } from "../src/api-contract.ts";
import { type FengSuiRuntimeStack, createFengSuiRuntime, runCli, runResetLogin } from "../src/cli.ts";
import { loadConfig } from "../src/config.ts";
import { ConsoleSettings, resetLoginProof } from "../src/console-settings.ts";
import { StorageCipher } from "../src/encrypted-file.ts";
import { createStrictCpe } from "./helpers/strict-cpe.ts";
import { removeTempDir, tempDir } from "./helpers/temp-dir.ts";

const PASSPHRASE = "a long console passphrase";

async function startRuntime(extraEnv: Record<string, string>) {
  const cpe = createStrictCpe();
  const dir = tempDir("fengsui-console-");
  const env: Record<string, string> = {
    CPE_URL: "http://192.168.8.1",
    DATA_ENCRYPTION_KEY: "console_data_key",
    WEB_HOST: "127.0.0.1",
    WEB_PORT: "0",
    ALLOWED_HOSTS: "127.0.0.1",
    STATE_FILE: path.join(dir, "data", "state.json"),
    POLL_INTERVAL_MS: "600000",
    NEIGHBOR_SCAN_INTERVAL_MS: "600000",
    SMS_ENABLED: "false",
    ...Object.fromEntries(Object.entries(extraEnv).map(([k, v]) => [k, v.replace("{ROUTER}", cpe.password)])),
  };
  const envPath = path.join(dir, ".env");
  fs.writeFileSync(envPath, Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n"));
  const logs: string[] = [];
  const stack: FengSuiRuntimeStack = createFengSuiRuntime({ config: loadConfig({ envPath, ignoreProcessEnv: true }), envPath, fetchImpl: cpe.fetchImpl, log: (line) => logs.push(line) });
  const bound = await stack.httpServer.listen();
  const base = `http://${bound.host}:${bound.port}`;
  const headers = (cookie = ""): Record<string, string> => ({ "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest", Origin: base, ...(cookie ? { Cookie: cookie } : {}) });
  const post = (p: string, body: unknown, cookie = "") => fetch(`${base}${p}`, { method: "POST", headers: headers(cookie), body: JSON.stringify(body) });
  const get = (p: string, auth: { cookie?: string; token?: string } = {}) =>
    fetch(`${base}${p}`, { headers: auth.token ? { Authorization: `Bearer ${auth.token}` } : auth.cookie ? { Cookie: auth.cookie } : {} });
  const cookieOf = (res: Response): string => `fengsui_sid=${/fengsui_sid=([0-9a-f]{64})/.exec(res.headers.get("set-cookie") ?? "")?.[1] ?? ""}`;
  return {
    cpe,
    stack,
    logs,
    envPath,
    base,
    post,
    get,
    cookieOf,
    cleanup: async () => {
      await stack.close();
      removeTempDir(dir);
    },
  };
}

describe("console setup on a fresh install", () => {
  it("sets the password with the logged setup code, then proves and saves the router before anything logs in", async () => {
    const fx = await startRuntime({});
    try {
      await fx.stack.start();
      assert.equal(fx.stack.awaitingSetup(), true);
      assert.deepEqual(fx.cpe.stats.requests, [], "no router contact before the setup");
      const status = (await (await fx.get("/api/auth/status")).json()) as { authenticated: boolean; setupRequired: boolean };
      assert.deepEqual([status.authenticated, status.setupRequired], [false, true]);
      const code = /setup code ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(fx.logs.join("\n"))?.[1] ?? "";
      assert.ok(code, "the setup code is in the daemon log");

      assert.equal((await fx.post("/api/setup/login", { code: "AAAA-AAAA", password: PASSPHRASE })).status, 401);
      const short = await fx.post("/api/setup/login", { code, password: "short" });
      assert.equal(short.status, 400);
      const setup = await fx.post("/api/setup/login", { code, password: PASSPHRASE });
      assert.equal(setup.status, 200);
      const cookie = fx.cookieOf(setup);
      assert.equal((await fx.post("/api/setup/login", { code, password: PASSPHRASE })).status, 409, "only once");

      const summary = (await (await fx.get("/api/console", { cookie })).json()) as ConsoleSettingsResponse;
      assert.deepEqual([summary.cpe, summary.reviewPending, summary.login.fromEnv], [null, false, false]);
      const early = await fx.post("/api/control/unlock", {}, cookie);
      assert.equal(early.status, 409);
      assert.equal(((await early.json()) as { errorCode: string }).errorCode, "CPE_NOT_CONFIGURED");

      const wrong = await fx.post("/api/console/cpe", { url: "http://192.168.8.1", password: "not it" }, cookie);
      assert.equal(wrong.status, 400);
      const wrongBody = (await wrong.json()) as { errorCode: string; connectionTest: { reason: string; remainCount: number } };
      assert.deepEqual([wrongBody.errorCode, wrongBody.connectionTest.reason, wrongBody.connectionTest.remainCount], ["CPE_TEST_FAILED", "wrong_password", 2]);
      assert.equal(fx.stack.settings.cpe, null, "nothing saved");
      const publicHost = (await (await fx.post("/api/console/cpe/test", { url: "http://203.0.113.10", password: "x" }, cookie)).json()) as { result: { reason: string } };
      assert.equal(publicHost.result.reason, "invalid_url");

      const saved = await fx.post("/api/console/cpe", { url: "http://192.168.8.1", username: "admin", password: fx.cpe.password }, cookie);
      assert.equal(saved.status, 200);
      assert.equal(((await saved.json()) as { result: { ok: boolean; model: string } }).result.model, "H168-383");
      assert.equal(fx.stack.awaitingSetup(), false);
      for (let i = 0; i < 100 && fx.cpe.stats.logins < 2; i++) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.ok(fx.cpe.stats.logins >= 2, "polling started once the connection was saved");

      const audit = (await (await fx.get("/api/audit", { cookie })).json()) as AuditResponse;
      assert.deepEqual(
        audit.entries.slice(0, 4).map((e) => [e.action, e.outcome]).reverse(),
        [
          ["setup", "applied"],
          ["unlock_rf_locks", "refused"],
          ["settings.cpe", "refused"],
          ["settings.cpe", "applied"],
        ]
      );
    } finally {
      await fx.cleanup();
    }
  });
});

describe("console settings after an upgrade (.env imported)", () => {
  it("keeps the old token working, then manages tokens, switches, metrics and the password from the console", async () => {
    const fx = await startRuntime({ CPE_PASSWORD: "{ROUTER}", API_TOKEN: "legacy_full_token" });
    try {
      const login = await fx.post("/api/auth/login", { password: "legacy_full_token" });
      assert.equal(login.status, 200, "the imported API_TOKEN is the console password");
      const cookie = fx.cookieOf(login);
      let summary = (await (await fx.get("/api/console", { cookie })).json()) as ConsoleSettingsResponse;
      assert.deepEqual([summary.reviewPending, summary.login.fromEnv, summary.cpe?.passwordSet], [true, true, true]);
      assert.equal(JSON.stringify(summary).includes(fx.cpe.password), false, "the router password never comes back");
      assert.equal(((await (await fx.post("/api/console/cpe/test", {}, cookie)).json()) as { result: { ok: boolean } }).result.ok, true, "tests the stored connection");
      summary = (await (await fx.post("/api/console/review", {}, cookie)).json()) as ConsoleSettingsResponse;
      assert.equal(summary.reviewPending, false);

      // Tokens
      assert.equal((await fx.post("/api/console/tokens", { name: "", scope: "read", lifetimeDays: 7 }, cookie)).status, 400);
      assert.equal((await fx.post("/api/console/tokens", { name: "x", scope: "admin", lifetimeDays: 7 }, cookie)).status, 400);
      assert.equal((await fx.post("/api/console/tokens", { name: "x", scope: "read", lifetimeDays: 2 }, cookie)).status, 400);
      const minted = (await (await fx.post("/api/console/tokens", { name: "Grafana", scope: "read", lifetimeDays: 90 }, cookie)).json()) as CreateTokenResponse;
      const list = (await (await fx.get("/api/console/tokens", { cookie })).json()) as TokensResponse;
      assert.deepEqual(list.tokens.map((t) => t.name), ["API_TOKEN (.env)", "Grafana"]);
      assert.equal((await fx.get("/api/telemetry", { token: minted.token })).status, 200);
      const denied = await fetch(`${new URL((await fx.get("/api/health")).url).origin}/api/control/unlock`, { method: "POST", headers: { Authorization: `Bearer ${minted.token}`, "Content-Type": "application/json" }, body: "{}" });
      assert.equal(denied.status, 403);
      assert.equal((await fx.get("/api/console", { token: "legacy_full_token" })).status, 403, "tokens never reach the console settings");

      // A write through the imported full token is audited under its name
      const unlock = await fetch(denied.url, { method: "POST", headers: { Authorization: "Bearer legacy_full_token", "Content-Type": "application/json" }, body: "{}" });
      assert.equal(unlock.status, 200);

      // Metrics: off by default, on from the console, any token, no identifiers
      assert.equal((await fx.get("/metrics", { token: minted.token })).status, 404);
      summary = (await (await fx.post("/api/console/switches", { metricsEnabled: true }, cookie)).json()) as ConsoleSettingsResponse;
      assert.deepEqual(summary.metrics, { enabled: true, source: "console", envEnabled: false });
      assert.equal((await fx.get("/metrics")).status, 401);
      const scraped = await fx.get("/metrics", { token: minted.token });
      assert.equal(scraped.status, 200);
      assert.match(scraped.headers.get("content-type") ?? "", /text\/plain; version=0\.0\.4/);
      const text = await scraped.text();
      assert.match(text, /^fengsui_info\{version="\d+\.\d+\.\d+"\} 1$/m);
      assert.match(text, /^fengsui_scheduler_mode\{mode="idle"\} [01]$/m);
      assert.match(text, /^process_resident_memory_bytes \d+$/m, "the daemon's own memory, to watch it over weeks");
      assert.match(text, /^fengsui_sse_clients \d+$/m);
      for (const identifier of ["860000000000000", "272010000000000", "198.51.100.42", "134217758"]) assert.equal(text.includes(identifier), false, identifier);
      summary = (await (await fx.post("/api/console/switches", { metricsEnabled: null, telegramReset: false }, cookie)).json()) as ConsoleSettingsResponse;
      assert.deepEqual([summary.metrics, summary.telegram.resetEnabled], [{ enabled: false, source: "env", envEnabled: false }, false]);
      assert.equal((await fx.post("/api/console/switches", {}, cookie)).status, 400);
      assert.equal((await fx.post("/api/console/switches", { telegramReset: "yes" }, cookie)).status, 400);
      assert.equal((await fx.post("/api/console/telegram/pairing-code", {}, cookie)).status, 409, "no bot configured");
      assert.equal(((await (await fx.post("/api/console/telegram/unlink-all", {}, cookie)).json()) as { unlinked: number }).unlinked, 0);

      assert.equal((await fx.post("/api/console/tokens/revoke", { id: minted.record.id }, cookie)).status, 200);
      assert.equal((await fx.post("/api/console/tokens/revoke", { id: minted.record.id }, cookie)).status, 404);
      assert.equal((await fx.get("/api/telemetry", { token: minted.token })).status, 401);

      // Password: the current one is required, then the old login stops working
      assert.equal((await fx.post("/api/console/password", { current: "nope", next: PASSPHRASE }, cookie)).status, 403);
      assert.equal((await fx.post("/api/console/password", { current: "legacy_full_token", next: "short" }, cookie)).status, 400);
      assert.equal((await fx.post("/api/console/password", { current: "legacy_full_token", next: PASSPHRASE }, cookie)).status, 200);
      assert.equal((await fx.post("/api/auth/login", { password: "legacy_full_token" })).status, 401);
      assert.equal((await fx.post("/api/auth/login", { password: PASSPHRASE })).status, 200);

      // Reset with a one-time code (CLI or Telegram hand these out): signs every session out
      assert.equal((await fx.post("/api/auth/reset", { code: "WRNG-CODE", password: "yet another passphrase" })).status, 401);
      const resetCode = fx.stack.settings.issueCode("reset");
      const reset = await fx.post("/api/auth/reset", { code: resetCode, password: "yet another passphrase" });
      assert.equal(reset.status, 200);
      assert.equal((await fx.get("/api/console", { cookie })).status, 401, "the old session is gone");
      const fresh = fx.cookieOf(reset);
      assert.equal((await fx.get("/api/console", { cookie: fresh })).status, 200, "the reset signs this browser in");

      // cpe-dash reset-login on the daemon's host: a key-proven request from loopback gets a code
      const port = Number(new URL((await fx.get("/api/health")).url).port);
      const lines: string[] = [];
      assert.equal(await runResetLogin({ ...fx.stack.config, webPort: port }, { write: (l) => lines.push(l) }), 0);
      const cliCode = /Reset code: ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(lines.join("\n"))?.[1] ?? "";
      assert.equal((await fx.post("/api/auth/reset", { code: cliCode, password: "the cli reset passphrase" })).status, 200);
      assert.equal(await runResetLogin({ ...fx.stack.config, webPort: port, dataEncryptionKey: "not the key" }, { write: (l) => lines.push(l) }), 1);
      assert.match(lines.at(-1) ?? "", /the daemon refused \(HTTP 401\)/);
      assert.equal(await runResetLogin({ ...fx.stack.config, webPort: 1, dataEncryptionKey: "k" }, { write: (l) => lines.push(l) }), 1);
      assert.match(lines.at(-1) ?? "", /no daemon answered/);
      assert.equal(await runResetLogin({ ...fx.stack.config, dataEncryptionKey: "" }, { write: (l) => lines.push(l) }), 1);
      // The same through the real entry point, as `docker exec … cpe-dash reset-login` runs it
      const cliEnv = `${fx.envPath}.cli`;
      fs.writeFileSync(cliEnv, `${fs.readFileSync(fx.envPath, "utf8").replace("WEB_PORT=0", `WEB_PORT=${port}`)}\n`);
      const printed: string[] = [];
      const realWrite = process.stdout.write.bind(process.stdout);
      const savedExit = process.exitCode;
      process.stdout.write = ((chunk: string | Uint8Array) => {
        printed.push(String(chunk));
        return true;
      }) as typeof process.stdout.write;
      try {
        await runCli(["node", "cli", "reset-login", "--env", cliEnv]);
      } finally {
        process.stdout.write = realWrite;
      }
      assert.equal(process.exitCode, 0);
      process.exitCode = savedExit;
      assert.match(printed.join(""), /^Reset code: [A-Z0-9]{4}-[A-Z0-9]{4} \(valid 15 minutes, once\)/);
      const after = await fx.post("/api/auth/login", { password: "the cli reset passphrase" });
      const audit = (await (await fx.get("/api/audit?limit=50", { cookie: fx.cookieOf(after) })).json()) as AuditResponse;
      const actions = audit.entries.map((e) => `${e.channel}:${e.label ?? ""}:${e.action}:${e.outcome}`);
      for (const expected of [
        "token:API_TOKEN (.env):unlock_rf_locks:applied",
        "web::token.create:applied",
        "web::token.revoke:applied",
        "web::settings.switches:applied",
        "web::settings.password:refused",
        "web::settings.password:applied",
        "web::login.reset:refused",
        "web::login.reset:applied",
        "web::login:refused",
        "system::login.reset-code:applied",
      ]) {
        assert.ok(actions.includes(expected), expected);
      }
      assert.equal(JSON.stringify(audit).includes(minted.token), false, "no secret in the audit");
    } finally {
      await fx.cleanup();
    }
  });

  it("hands a reset code to the daemon's own host only, not to a client behind a proxy on it", async () => {
    // The NAS runs an HTTPS proxy on 127.0.0.1: every request it forwards reaches the daemon from loopback
    const fx = await startRuntime({ TRUSTED_PROXIES: "127.0.0.1" });
    try {
      const base = new URL((await fx.get("/api/health")).url).origin;
      const ask = (headers: Record<string, string>) =>
        fetch(`${base}/api/setup/reset-code`, { method: "POST", headers: { "X-FengSui-Proof": resetLoginProof(fx.stack.config.dataEncryptionKey, Date.now()), ...headers } });
      assert.equal((await ask({ "X-Forwarded-For": "192.168.8.50" })).status, 401, "a LAN client forwarded by the proxy");
      const direct = await ask({});
      assert.equal(direct.status, 200, "cpe-dash reset-login on the host itself");
      assert.match(String(((await direct.json()) as { code: string }).code), /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    } finally {
      await fx.cleanup();
    }
  });
});

describe("one-time codes and the sign-in limit", () => {
  it("counts wrong current passwords in a password change against the sign-in limit", async () => {
    const fx = await startRuntime({ CPE_PASSWORD: "{ROUTER}", API_TOKEN: "legacy_full_token", RATE_LIMIT_MAX_AUTH_FAILURES: "3" });
    try {
      const cookie = fx.cookieOf(await fx.post("/api/auth/login", { password: "legacy_full_token" }));
      for (const guess of ["guess one", "guess two", "guess three"]) {
        assert.equal((await fx.post("/api/console/password", { current: guess, next: PASSPHRASE }, cookie)).status, 403);
      }
      // Locked out like a sign-in: even the right password waits for the window, and nothing changed
      const locked = await fx.post("/api/console/password", { current: "legacy_full_token", next: PASSPHRASE }, cookie);
      assert.equal(locked.status, 429);
      assert.equal(((await locked.json()) as { errorCode: string }).errorCode, "RATE_LIMITED");
      assert.equal(await fx.stack.settings.verifyLogin("legacy_full_token"), true, "the password is unchanged");
    } finally {
      await fx.cleanup();
    }
  });

  it("shares that limit with sign-in across an IPv6 /64, and says when to retry", async () => {
    const fx = await startRuntime({ CPE_PASSWORD: "{ROUTER}", API_TOKEN: "legacy_full_token", RATE_LIMIT_MAX_AUTH_FAILURES: "3", TRUSTED_PROXIES: "127.0.0.1" });
    try {
      const base = new URL((await fx.get("/api/health")).url).origin;
      const from = (address: string, p: string, body: unknown, cookie = ""): Promise<Response> =>
        fetch(`${base}${p}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest", Origin: base, "X-Forwarded-For": address, ...(cookie ? { Cookie: cookie } : {}) },
          body: JSON.stringify(body),
        });
      const cookie = fx.cookieOf(await from("2001:db8:1:2::10", "/api/auth/login", { password: "legacy_full_token" }));
      // Privacy addresses rotate inside the /64 the session is bound to: they share one count
      for (const address of ["2001:db8:1:2::10", "2001:db8:1:2::11", "2001:db8:1:2::12"]) {
        assert.equal((await from(address, "/api/console/password", { current: "a wrong guess", next: PASSPHRASE }, cookie)).status, 403);
      }
      const locked = await from("2001:db8:1:2::13", "/api/console/password", { current: "legacy_full_token", next: PASSPHRASE }, cookie);
      assert.equal(locked.status, 429);
      assert.match(locked.headers.get("retry-after") ?? "", /^\d+$/);
      assert.equal((await from("2001:db8:1:2::14", "/api/auth/login", { password: "legacy_full_token" })).status, 429, "sign-in from that /64 waits too");
    } finally {
      await fx.cleanup();
    }
  });

  it("tells a malformed body (BAD_PAYLOAD) from a password the rules refuse (VALIDATION_ERROR) on a code sign-in", async () => {
    const fx = await startRuntime({ CPE_PASSWORD: "{ROUTER}", API_TOKEN: "legacy_full_token" });
    try {
      const base = new URL((await fx.get("/api/health")).url).origin;
      const raw = (body: string): Promise<Response> =>
        fetch(`${base}/api/auth/reset`, { method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest", Origin: base }, body });
      const malformed = await raw("{ not json");
      assert.equal(malformed.status, 400);
      assert.equal(((await malformed.json()) as { errorCode: string }).errorCode, "BAD_PAYLOAD");
      const weak = await raw(JSON.stringify({ code: "WRNG-0001", password: "short" }));
      assert.equal(weak.status, 400);
      assert.equal(((await weak.json()) as { errorCode: string }).errorCode, "VALIDATION_ERROR");
    } finally {
      await fx.cleanup();
    }
  });

  it("keeps a valid one-time code that the sign-in limit refused, so it still works", async () => {
    const fx = await startRuntime({ CPE_PASSWORD: "{ROUTER}", API_TOKEN: "legacy_full_token", RATE_LIMIT_MAX_AUTH_FAILURES: "3", TRUSTED_PROXIES: "127.0.0.1" });
    try {
      const base = new URL((await fx.get("/api/health")).url).origin;
      const reset = (address: string, code: string): Promise<Response> =>
        fetch(`${base}/api/auth/reset`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest", Origin: base, "X-Forwarded-For": address },
          body: JSON.stringify({ code, password: "a reset passphrase to keep" }),
        });
      // Typos lock this address out for the window
      for (const typo of ["WRNG-0001", "WRNG-0002", "WRNG-0003"]) assert.equal((await reset("192.168.8.60", typo)).status, 401);
      const code = fx.stack.settings.issueCode("reset");
      assert.equal((await reset("192.168.8.60", code)).status, 429, "refused while locked out");
      // The refusal spent nothing: the same code works (here from an address that is not locked out)
      assert.equal((await reset("192.168.8.61", code)).status, 200);
    } finally {
      await fx.cleanup();
    }
  });
});

describe("behaviour settings from the console", () => {
  it("sets AI switches, self-healing, alerts and SMS behaviour over .env from a console session only, and keeps them", async () => {
    const fx = await startRuntime({ CPE_PASSWORD: "{ROUTER}", API_TOKEN: "legacy_full_token", MCP_ALLOW_MUTATIONS: "true", LOCK_ROLLBACK_AFTER_MIN: "10" });
    try {
      const cookie = fx.cookieOf(await fx.post("/api/auth/login", { password: "legacy_full_token" }));
      let summary = (await (await fx.get("/api/console", { cookie })).json()) as ConsoleSettingsResponse;
      assert.deepEqual(summary.behaviour.agentWrites, { value: true, source: "env", envValue: true });
      assert.deepEqual(summary.behaviour.lockRollbackAfterMin, { value: 10, source: "env", envValue: 10 });
      assert.deepEqual(summary.behaviour.agentSms, { value: "read", source: "env", envValue: "read" });

      const changed = await fx.post("/api/console/behaviour", { agentWrites: false, lockRollbackAfterMin: 0, agentSms: "full", defaultCountryCode: "353" }, cookie);
      assert.equal(changed.status, 200);
      summary = (await changed.json()) as ConsoleSettingsResponse;
      assert.deepEqual(summary.behaviour.agentWrites, { value: false, source: "console", envValue: true });
      assert.deepEqual(summary.behaviour.lockRollbackAfterMin, { value: 0, source: "console", envValue: 10 });
      assert.deepEqual(summary.behaviour.agentSms, { value: "full", source: "console", envValue: "read" });
      assert.equal(summary.behaviour.defaultCountryCode.value, "+353");

      // A token, even a full one, cannot change them; a refused value changes nothing
      const byToken = await fetch(`${fx.base}/api/console/behaviour`, {
        method: "POST",
        headers: { Authorization: "Bearer legacy_full_token", "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
        body: JSON.stringify({ agentWrites: true }),
      });
      assert.deepEqual([byToken.status, ((await byToken.json()) as { errorCode: string }).errorCode], [403, "CONSOLE_ONLY"]);
      assert.equal((await fx.post("/api/console/behaviour", { lockRollbackAfterMin: 2 }, cookie)).status, 400);
      assert.equal((await fx.post("/api/console/behaviour", { pollIntervalMs: 1000 }, cookie)).status, 400);
      assert.equal((await fx.post("/api/console/behaviour", {}, cookie)).status, 400);

      // null goes back to .env
      summary = (await (await fx.post("/api/console/behaviour", { agentWrites: null }, cookie)).json()) as ConsoleSettingsResponse;
      assert.deepEqual(summary.behaviour.agentWrites, { value: true, source: "env", envValue: true });

      const audit = (await (await fx.get("/api/audit", { cookie })).json()) as AuditResponse;
      const changes = audit.entries.filter((e) => e.action === "settings.behaviour").map((e) => e.detail);
      assert.deepEqual(changes.reverse(), ["MCP_ALLOW_MUTATIONS false, LOCK_ROLLBACK_AFTER_MIN 0, MCP_SMS_ACCESS full, DEFAULT_COUNTRY_CODE +353", "MCP_ALLOW_MUTATIONS from .env"]);

      // Kept encrypted in settings.json, read back as set
      await fx.stack.settings.flush();
      const reloaded = new ConsoleSettings({ filePath: fx.stack.settings.filePath, cipher: StorageCipher.fromSecret("console_data_key") });
      assert.equal(reloaded.load(), true);
      assert.deepEqual(reloaded.behaviourOverrides, { lockRollbackAfterMin: 0, agentSms: "full", defaultCountryCode: "+353" });
    } finally {
      await fx.cleanup();
    }
  });

  it("applies a change at once: agents' tools, self-healing, alerts and masking follow without a restart", async () => {
    const fx = await startRuntime({ CPE_PASSWORD: "{ROUTER}", API_TOKEN: "legacy_full_token" });
    try {
      await fx.stack.start();
      const cookie = fx.cookieOf(await fx.post("/api/auth/login", { password: "legacy_full_token" }));
      const toolNames = async (): Promise<string[]> => {
        const outcome = await fx.stack.mcpServer.handleHttpMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }), {}, { readOnly: false });
        return ((outcome.body as { result: { tools: Array<{ name: string }> } }).result.tools).map((t) => t.name);
      };
      const status = async () => ((await (await fx.get("/api/session/status", { cookie })).json()) as { selfHeal: { lockRollback: { afterMin: number | null }; reconnect: { afterMin: number | null } } }).selfHeal;
      assert.equal((await toolNames()).includes("lock_band"), false, ".env leaves agent writes off");
      assert.deepEqual([(await status()).lockRollback.afterMin, fx.stack.alertEngine?.enabled, fx.stack.httpServer.redactApi], [null, true, true]);

      await fx.post("/api/console/behaviour", { agentWrites: true, agentAccessControl: true, lockRollbackAfterMin: 10, wanReconnectAfterMin: 3, alertsEnabled: false, redactApi: false }, cookie);
      const tools = await toolNames();
      assert.ok(tools.includes("lock_band") && tools.includes("set_wifi_mac_filter"), "the master switch opens the write tools at once");
      const heal = await status();
      assert.deepEqual([heal.lockRollback.afterMin, heal.reconnect.afterMin], [10, 3]);
      assert.deepEqual([fx.stack.alertEngine?.enabled, fx.stack.httpServer.redactApi], [false, false]);

      await fx.post("/api/console/behaviour", { agentWrites: null, lockRollbackAfterMin: null, wanReconnectAfterMin: null, alertsEnabled: null, redactApi: null }, cookie);
      assert.equal((await toolNames()).includes("lock_band"), false, "back to .env: off");
      assert.deepEqual([(await status()).lockRollback.afterMin, fx.stack.alertEngine?.enabled, fx.stack.httpServer.redactApi], [null, true, true]);
    } finally {
      await fx.cleanup();
    }
  });
});

describe("token permissions", () => {
  it("lets each token do what its permissions allow over REST and MCP, and an edit applies at once", async () => {
    const fx = await startRuntime({ CPE_PASSWORD: "{ROUTER}", API_TOKEN: "legacy_full_token", MCP_ALLOW_MUTATIONS: "true", MCP_ALLOW_ACCESS_CONTROL: "true" });
    try {
      await fx.stack.start();
      const cookie = fx.cookieOf(await fx.post("/api/auth/login", { password: "legacy_full_token" }));
      const mint = async (name: string, permissions: string[]): Promise<CreateTokenResponse> =>
        (await (await fx.post("/api/console/tokens", { name, permissions, lifetimeDays: 7 }, cookie)).json()) as CreateTokenResponse;
      const dashboard = await mint("Dashboard", []);
      const locker = await mint("Locker", ["control"]);
      assert.deepEqual([dashboard.record.permissions, dashboard.record.scope, locker.record.permissions], [[], "read", ["control"]]);
      const tokenPost = (token: string, p: string, body: unknown) =>
        fetch(`${fx.base}${p}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" }, body: JSON.stringify(body) });
      const refusal = async (res: Response) => {
        const body = (await res.json()) as { errorCode?: string; permission?: string };
        return [res.status, body.errorCode, body.permission];
      };

      // Every token reads the router; SMS only with sms-read
      assert.equal((await fx.get("/api/telemetry", { token: dashboard.token })).status, 200);
      assert.deepEqual(await refusal(await fx.get("/api/sms/threads", { token: dashboard.token })), [403, "TOKEN_NOT_PERMITTED", "sms-read"]);
      // A token that may change nothing keeps the read-only answer; another one is told what it lacks
      assert.deepEqual(await refusal(await tokenPost(dashboard.token, "/api/control/unlock", {})), [403, "READ_ONLY_TOKEN", undefined]);
      assert.deepEqual(await refusal(await tokenPost(locker.token, "/api/control/wifi-mac-filter", { mode: "off", confirm: true })), [403, "TOKEN_NOT_PERMITTED", "access"]);
      assert.notEqual((await tokenPost(locker.token, "/api/control/unlock", {})).status, 403, "control lets it unlock");

      // MCP: it sees and calls the router's writes, not device access
      const mcp = async (method: string, params: Record<string, unknown>, permissions: ReadonlyArray<string>) =>
        ((await fx.stack.mcpServer.handleHttpMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), {}, { permissions: permissions as never })).body as { result: Record<string, unknown> }).result;
      const tools = ((await mcp("tools/list", {}, locker.record.permissions))["tools"] as Array<{ name: string }>).map((t) => t.name);
      assert.ok(tools.includes("lock_band") && tools.includes("get_access_control"));
      assert.equal(tools.includes("set_wifi_mac_filter"), false);
      const call = await mcp("tools/call", { name: "set_wifi_mac_filter", arguments: { mode: "off", confirm: true } }, locker.record.permissions);
      assert.deepEqual([(call["structuredContent"] as { errorCode: string }).errorCode, (call["structuredContent"] as { permission: string }).permission], ["TOKEN_NOT_PERMITTED", "access"]);

      // An edit in the console applies at once to the same token; a token cannot edit permissions itself
      const edited = await fx.post("/api/console/tokens/permissions", { id: locker.record.id, permissions: ["control", "access"] }, cookie);
      assert.equal(edited.status, 200);
      assert.notEqual((await tokenPost(locker.token, "/api/control/wifi-mac-filter", { mode: "off", confirm: true })).status, 403);
      assert.equal((await tokenPost(locker.token, "/api/console/tokens/permissions", { id: locker.record.id, permissions: [...["sms-read", "control", "access", "sms-write"]] })).status, 403);
      assert.equal((await fx.post("/api/console/tokens/permissions", { id: locker.record.id, permissions: ["root"] }, cookie)).status, 400);
      assert.equal((await fx.post("/api/console/tokens/permissions", { id: "nope", permissions: [] }, cookie)).status, 404);
      const audit = (await (await fx.get("/api/audit", { cookie })).json()) as AuditResponse;
      assert.ok(audit.entries.some((e) => e.action === "token.permissions" && e.detail === "Locker: read + control + access"));
      assert.ok(audit.entries.some((e) => e.action === "token.create" && e.detail === "Dashboard (read, no SMS, 7 d)"));
    } finally {
      await fx.cleanup();
    }
  });
});
