import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { describe, it } from "node:test";
import type { TelegramChatsResponse } from "../src/api-contract.ts";
import { DaemonAlreadyRunningError, createFengSuiRuntime, startServeDaemon, startupNotices } from "../src/cli.ts";
import { loadConfig } from "../src/config.ts";
import { HuaweiCpeClient } from "../src/cpe-client.ts";
import { StorageCipher, tryAcquireFileLock } from "../src/encrypted-file.ts";
import type { JsonRpcSuccessResponse } from "../src/mcp-server.ts";
import type { PeerTransport } from "../src/peer-guard.ts";
import { redactTelemetry } from "../src/redact.ts";
import { EncryptedStateStore } from "../src/state-store.ts";
import { createMockSmsCpe } from "./helpers/mock-sms-cpe.ts";
import { createStrictCpe } from "./helpers/strict-cpe.ts";
import { removeTempDir, tempDir } from "./helpers/temp-dir.ts";

const BOT_TOKEN = "123456:TEST_TOKEN_abcdefghijklmnopqrstuv";

async function startSleeper(): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await once(child, "spawn");
  return child;
}

async function stopSleeper(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill();
  await exited;
}

async function waitFor(predicate: () => boolean | Promise<boolean>, label: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

function writeEnv(dir: string, values: Record<string, string>): string {
  const envPath = path.join(dir, ".env");
  fs.writeFileSync(envPath, Object.entries(values).map(([k, v]) => `${k}=${v}`).join("\n"));
  return envPath;
}

function baseEnv(dir: string, password: string): Record<string, string> {
  return {
    CPE_URL: "http://192.168.8.1",
    CPE_PASSWORD: password,
    API_TOKEN: "runtime_api_token_v1",
    DATA_ENCRYPTION_KEY: "runtime_data_key_v1",
    WEB_HOST: "127.0.0.1",
    WEB_PORT: "0",
    ALLOWED_HOSTS: "127.0.0.1",
    STATE_FILE: path.join(dir, "data", "state.json"),
    STATIC_DIR: path.join(dir, "no-static"),
    POLL_INTERVAL_MS: "600000",
    NEIGHBOR_SCAN_INTERVAL_MS: "600000",
    TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    TELEGRAM_CHAT_IDS: "1001",
    WEBHOOK_URL: "https://hooks.example.com/fengsui",
    WEBHOOK_SECRET: "runtime_hook_secret",
  };
}

function createNotifyFetch() {
  const calls: Array<{ url: string; body: string }> = [];
  let messageId = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, body: String(init?.body ?? "") });
    if (url.startsWith("https://hooks.example.com/")) return new Response(null, { status: 204 });
    const ok = (result: unknown): Response => new Response(JSON.stringify({ ok: true, result }), { status: 200 });
    const method = url.split("/").pop();
    if (method === "sendMessage") return ok({ message_id: ++messageId });
    if (method === "getUpdates") {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 20);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(init.signal?.reason ?? new DOMException("aborted", "AbortError"));
        });
      });
      return ok([]);
    }
    return ok(true);
  };
  const telegramTexts = () =>
    calls.filter((c) => c.url.endsWith("/sendMessage")).map((c) => String((JSON.parse(c.body) as { text?: string }).text));
  const webhookEvents = () =>
    calls.filter((c) => c.url.startsWith("https://hooks.example.com/")).map((c) => (JSON.parse(c.body) as { event: string }).event);
  return { fetchImpl, calls, telegramTexts, webhookEvents };
}

async function toolNames(stack: ReturnType<typeof createFengSuiRuntime>): Promise<string[]> {
  const res = (await stack.mcpServer.handleRawJsonMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }))) as JsonRpcSuccessResponse;
  return (res.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
}

describe("tryAcquireFileLock", () => {
  it("grants a single owner, respects live foreign owners and takes over stale locks", async () => {
    const dir = tempDir("fengsui-lock-");
    const lockPath = path.join(dir, "nested", "sms.json.lock");
    const sleeper = await startSleeper();
    try {
      const first = tryAcquireFileLock(lockPath);
      assert.equal(first.ok, true);
      assert.equal(fs.readFileSync(lockPath, "utf8"), `${process.pid}\n`);
      assert.equal(fs.statSync(lockPath).mode & 0o777, 0o600);
      // Our own PID in the file means a previous incarnation (e.g. a restarted container)
      assert.equal(tryAcquireFileLock(lockPath).ok, true);

      fs.writeFileSync(lockPath, `${sleeper.pid}\n`);
      assert.deepEqual(tryAcquireFileLock(lockPath), { ok: false, heldByPid: sleeper.pid });
      if (first.ok) first.lock.release();
      assert.equal(fs.readFileSync(lockPath, "utf8"), `${sleeper.pid}\n`, "release() must not delete a foreign lock");

      await stopSleeper(sleeper);
      const takeover = tryAcquireFileLock(lockPath);
      assert.equal(takeover.ok, true);
      fs.writeFileSync(lockPath, "not-a-pid");
      const garbage = tryAcquireFileLock(lockPath);
      assert.equal(garbage.ok, true);
      if (garbage.ok) {
        garbage.lock.release();
        garbage.lock.release();
      }
      assert.equal(fs.existsSync(lockPath), false);
    } finally {
      await stopSleeper(sleeper);
      removeTempDir(dir);
    }
  });
});

describe("tryAcquireFileLock: two processes starting together", () => {
  it("leaves an empty lock that another process has only just created, and takes over an old empty one", () => {
    const dir = tempDir("fengsui-lock-race-");
    const lockPath = path.join(dir, "state.json.lock");
    try {
      // Another process opened the lock a moment ago and has not written its PID yet
      fs.writeFileSync(lockPath, "", { mode: 0o600 });
      assert.deepEqual(tryAcquireFileLock(lockPath), { ok: false, heldByPid: null });
      assert.equal(fs.existsSync(lockPath), true, "the other process keeps its lock");
      // An empty lock nobody finished writing long ago is stale
      const past = new Date(Date.now() - 60_000);
      fs.utimesSync(lockPath, past, past);
      const taken = tryAcquireFileLock(lockPath);
      assert.equal(taken.ok, true);
      assert.equal(fs.readFileSync(lockPath, "utf8"), `${process.pid}\n`);
      if (taken.ok) taken.lock.release();
    } finally {
      removeTempDir(dir);
    }
  });
});

describe("createFengSuiRuntime", () => {
  it("runs SMS, alerts, Telegram and webhooks in serve mode and pushes new SMS and alerts to both channels", async () => {
    const mock = createMockSmsCpe({
      messages: [{ index: 40001, phone: "+353830000001", content: "Already here", date: "2026-10-29 18:00:00", smstat: "0", box: 1 }],
    });
    const dir = tempDir("fengsui-runtime-");
    const envPath = writeEnv(dir, baseEnv(dir, mock.password));
    const config = loadConfig({ envPath, ignoreProcessEnv: true });
    const notify = createNotifyFetch();
    const stack = createFengSuiRuntime({ config, envPath, fetchImpl: mock.fetchImpl, notifyFetchImpl: notify.fetchImpl, log: () => undefined });
    try {
      assert.equal(stack.cpeClient.sessionMaxHoldMs, 90_000, "hold budget outlasts the 45 s send-status poll");
      assert.ok(stack.sms && stack.alertEngine && stack.telegramBot && stack.webhook && stack.notificationHub);
      assert.ok((await toolNames(stack)).includes("list_sms_threads"));
      assert.equal(fs.readFileSync(`${config.stateFile}.lock`, "utf8"), `${process.pid}\n`, "the daemon owns its data dir");

      await stack.start();
      await stack.start();
      const sms = stack.sms;
      await waitFor(() => sms.getStatus().seeded, "initial seeding sync");
      assert.equal(notify.webhookEvents().length, 0, "existing messages are history, not notifications");
      assert.ok(notify.calls.some((c) => c.url.endsWith("/setMyCommands")));

      mock.pushIncoming({ phone: "+353830000002", content: "Runtime hello", date: "2026-10-30 09:00:00" });
      await waitFor(async () => {
        await stack.core.monitor.refreshTelemetry();
        return notify.webhookEvents().includes("sms.received");
      }, "SMS change detected through telemetry counters");
      await waitFor(() => notify.telegramTexts().some((t) => t.includes("Runtime hello")), "Telegram SMS card");
      assert.ok(notify.telegramTexts().every((t) => !t.includes("Already here")));

      stack.scheduler.raiseAlert({ severity: "critical", code: "CPE_UNREACHABLE", messageZh: "离线", messageEn: "offline" });
      await waitFor(() => notify.webhookEvents().includes("alert"), "alert webhook");
      await waitFor(() => notify.telegramTexts().some((t) => t.includes("CPE_UNREACHABLE")), "alert card");
    } finally {
      await stack.close();
      await stack.close();
      removeTempDir(dir);
    }
    assert.equal(fs.existsSync(`${config.stateFile}.lock`), false);
  });

  it("re-encrypts every store when reset-breaker reloads .env, while tokens and linked chats stay the console's", async () => {
    const mock = createMockSmsCpe({ messages: [] });
    const dir = tempDir("fengsui-rotate-");
    // The contact below is saved in its local spelling: the country comes from .env (this mock reports no IMSI)
    const env = { ...baseEnv(dir, mock.password), DEFAULT_COUNTRY_CODE: "+353" };
    const envPath = writeEnv(dir, env);
    const config = loadConfig({ envPath, ignoreProcessEnv: true });
    const notify = createNotifyFetch();
    const originalTz = process.env["TZ"];
    const stack = createFengSuiRuntime({
      config,
      envPath,
      fetchImpl: mock.fetchImpl,
      notifyFetchImpl: notify.fetchImpl,
      log: () => undefined,
      applyTimeZone: true,
    });
    try {
      const bound = await stack.httpServer.listen();
      const bot = stack.telegramBot!;
      stack.sms!.upsertContact({ phone: "0830000009", name: "Rotated Contact" });
      bot.state.authorize("2002");
      await Promise.all([stack.sms!.contacts.flush(), stack.sms!.mirror.flush(), bot.state.flush()]);

      writeEnv(dir, { ...env, DATA_ENCRYPTION_KEY: "runtime_data_key_v2", API_TOKEN: "runtime_api_token_v2", TZ: "asia/tokyo" });
      const res = await fetch(`http://${bound.host}:${bound.port}/api/session/reset-breaker`, {
        method: "POST",
        headers: { Authorization: "Bearer runtime_api_token_v1", "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
        body: "{}",
      });
      assert.equal(res.status, 200);
      assert.equal(process.env["TZ"], "Asia/Tokyo", "reloading .env re-applies TZ to the process");

      const v2 = StorageCipher.fromSecret("runtime_data_key_v2");
      const contacts = v2.readJsonFileOrQuarantine<{ contacts: Array<{ name: string }> }>(config.contactsFile);
      assert.equal(contacts?.contacts[0]?.name, "Rotated Contact");
      assert.ok(v2.readJsonFileOrQuarantine(config.smsFile));
      assert.ok(v2.readJsonFileOrQuarantine(config.stateFile));
      // The console store and the audit log follow the new key too
      assert.ok(v2.readJsonFileOrQuarantine(config.settingsFile));
      assert.ok(v2.readJsonFileOrQuarantine(config.auditFile));
      // API_TOKEN in .env was imported once: changing it there no longer rotates anything
      const tgState = v2.readJsonFileOrQuarantine<{ authorizedChatIds: string[] }>(config.telegramStateFile);
      assert.deepEqual(tgState?.authorizedChatIds, ["2002"]);
      await bot.handleUpdate({ update_id: 1, message: { message_id: 10, chat: { id: 3003, type: "private" }, text: "/auth runtime_api_token_v2" } });
      assert.equal(bot.state.isAuthorized("3003", bot.allowedChatIds), false, "the new .env value is not a token");
      await bot.handleUpdate({ update_id: 2, message: { message_id: 11, chat: { id: 3003, type: "private" }, text: "/auth runtime_api_token_v1" } });
      assert.equal(bot.state.isAuthorized("3003", bot.allowedChatIds), true, "the imported full token still links");
      // A pairing code from the console links once; the console can unlink every /auth chat
      const code = stack.settings.issueCode("pair");
      await bot.handleUpdate({ update_id: 3, message: { message_id: 12, chat: { id: 4004, type: "private" }, text: `/auth ${code}` } });
      assert.equal(bot.state.isAuthorized("4004", bot.allowedChatIds), true);
      await bot.handleUpdate({ update_id: 4, message: { message_id: 13, chat: { id: 5005, type: "private" }, text: `/auth ${code}` } });
      assert.equal(bot.state.isAuthorized("5005", bot.allowedChatIds), false, "spent");
      // Revoking the token in the console unlinks the chat it linked, not the one a code linked
      const base = `http://${bound.host}:${bound.port}`;
      const consoleHeaders = { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest", Origin: base };
      const signIn = await fetch(`${base}/api/auth/login`, { method: "POST", headers: consoleHeaders, body: JSON.stringify({ password: "runtime_api_token_v1" }) });
      const cookie = `fengsui_sid=${/fengsui_sid=([0-9a-f]{64})/.exec(signIn.headers.get("set-cookie") ?? "")?.[1] ?? ""}`;
      // Settings → Telegram lists every chat: how /auth linked it (with the token's name), or .env
      const chats = async (res?: Response): Promise<Array<[string, string | null, string | null, boolean]>> =>
        ((await (res ?? (await fetch(`${base}/api/console/telegram/chats`, { headers: { Cookie: cookie } }))).json()) as TelegramChatsResponse).chats.map((c) => [
          c.chatId,
          c.linkedWith,
          c.tokenName,
          c.fromEnv,
        ]);
      assert.deepEqual(await chats(), [
        ["4004", "code", null, false],
        ["3003", "token", "API_TOKEN (.env)", false],
        ["2002", "code", null, false],
        ["1001", null, null, true],
      ]);
      const imported = stack.settings.listTokens().find((t) => t.name === "API_TOKEN (.env)");
      const revoke = await fetch(`${base}/api/console/tokens/revoke`, { method: "POST", headers: { ...consoleHeaders, Cookie: cookie }, body: JSON.stringify({ id: imported?.id }) });
      assert.equal(revoke.status, 200);
      assert.equal(bot.state.isAuthorized("3003", bot.allowedChatIds), false, "the revoked token's chat");
      assert.equal(bot.state.isAuthorized("4004", bot.allowedChatIds), true, "the pairing code's chat");
      // ... and unlinks one at a time, audited with the chat ID's last digits only
      const unlinkOne = await fetch(`${base}/api/console/telegram/unlink`, { method: "POST", headers: { ...consoleHeaders, Cookie: cookie }, body: JSON.stringify({ chatId: "4004" }) });
      assert.equal(unlinkOne.status, 200);
      assert.deepEqual(await chats(unlinkOne), [
        ["2002", "code", null, false],
        ["1001", null, null, true],
      ]);
      assert.equal(bot.state.isAuthorized("4004", bot.allowedChatIds), false);
      assert.deepEqual(
        stack.audit.list(1).map((e) => [e.action, e.outcome, e.detail, e.channel]),
        [["telegram.unlink", "applied", "private chat …004", "web"]]
      );
      const agent = stack.settings.createToken({ name: "Agent", scope: "full", lifetimeDays: 1 });
      const bearerList = await fetch(`${base}/api/console/telegram/chats`, { headers: { Authorization: `Bearer ${agent.token}` } });
      assert.equal(bearerList.status, 403, "a token, even a full one, never reads the chat list");
      assert.equal(bot.unlinkAllChats(), 1);
      assert.equal(bot.state.isAuthorized("1001", bot.allowedChatIds), true, "TELEGRAM_CHAT_IDS stay authorized");
      // /reset in a linked private chat answers with a one-time console reset code, unless turned off
      await bot.handleUpdate({ update_id: 5, message: { message_id: 14, chat: { id: 1001, type: "private" }, text: "/reset" } });
      const resetText = notify.calls.filter((c) => c.url.endsWith("/sendMessage")).at(-1)?.body ?? "";
      const resetCode = /<code>([A-Z0-9]{4}-[A-Z0-9]{4})<\/code>/.exec(resetText)?.[1] ?? "";
      assert.ok(stack.settings.consumeCode("reset", resetCode), "a working reset code");
      stack.settings.setTelegramReset(false);
      await bot.handleUpdate({ update_id: 6, message: { message_id: 15, chat: { id: 1001, type: "private" }, text: "/reset" } });
      assert.match(notify.calls.filter((c) => c.url.endsWith("/sendMessage")).at(-1)?.body ?? "", /turned off|已在控制台关闭/);
    } finally {
      if (originalTz === undefined) delete process.env["TZ"];
      else process.env["TZ"] = originalTz;
      await stack.close();
      removeTempDir(dir);
    }
  });

  it("shuts down within docker's stop grace while a CPE request hangs and Telegram backs off, logging out first", async () => {
    const cpe = createStrictCpe({ fault: (p) => (p === "/api/device/nbrcellinfo" ? "timeout" : undefined) });
    const dir = tempDir("fengsui-shutdown-");
    const envPath = writeEnv(dir, { ...baseEnv(dir, cpe.password), REQUEST_TIMEOUT_MS: "60000" });
    const config = loadConfig({ envPath, ignoreProcessEnv: true });
    // Telegram is unreachable, so the poll loop sits in its backoff when the shutdown begins
    const unreachableTelegram: typeof fetch = async (input) => {
      if (String(input).endsWith("/getUpdates")) throw new TypeError("fetch failed");
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    };
    const stack = createFengSuiRuntime({ config, envPath, fetchImpl: cpe.fetchImpl, notifyFetchImpl: unreachableTelegram, log: () => undefined });
    try {
      const bound = await stack.httpServer.listen();
      await stack.telegramBot?.start();
      const scan = fetch(`http://${bound.host}:${bound.port}/api/neighbors/scan`, {
        method: "POST",
        headers: { Authorization: "Bearer runtime_api_token_v1", "Content-Type": "application/json" },
        body: "{}",
      });
      await waitFor(() => cpe.count("/api/device/nbrcellinfo") === 1, "the scan hanging inside its CPE session");

      const closingAt = performance.now();
      await stack.close();
      const elapsedMs = performance.now() - closingAt;
      assert.ok(elapsedMs < 5000, `close() took ${Math.round(elapsedMs)} ms; docker stop sends SIGKILL after 10 s`);
      assert.equal(cpe.isSlotTaken(), false, "the router's admin slot is free before the process exits");
      assert.equal(cpe.stats.logins, cpe.stats.logouts);
      const res = await scan;
      assert.equal(res.status, 503, "the cancelled request is answered, not dropped");
      assert.equal(((await res.json()) as { errorCode: string }).errorCode, "QUEUE_FULL");
      assert.ok(StorageCipher.fromSecret(config.dataEncryptionKey).readJsonFileOrQuarantine(config.stateFile), "encrypted state was flushed");
    } finally {
      await stack.close();
      removeTempDir(dir);
    }
  });

  it("closes in order when startup fails (port taken), so no CPE session or poller outlives the process", async () => {
    const cpe = createStrictCpe({ latencyMs: 25 });
    const dir = tempDir("fengsui-startfail-");
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const takenPort = (blocker.address() as net.AddressInfo).port;
    const envPath = writeEnv(dir, { ...baseEnv(dir, cpe.password), WEB_PORT: String(takenPort) });
    const config = loadConfig({ envPath, ignoreProcessEnv: true });
    const notify = createNotifyFetch();
    const stack = createFengSuiRuntime({ config, envPath, fetchImpl: cpe.fetchImpl, notifyFetchImpl: notify.fetchImpl, log: () => undefined });
    try {
      await assert.rejects(() => startServeDaemon(stack), /EADDRINUSE/);
      assert.ok(cpe.stats.logins > 0, "startup had already opened CPE sessions (initial SMS sync, telemetry)");
      assert.equal(cpe.isSlotTaken(), false);
      assert.equal(cpe.stats.logins, cpe.stats.logouts);
      assert.equal(fs.existsSync(`${config.stateFile}.lock`), false, "the data directory is released");
      const polls = notify.calls.filter((c) => c.url.endsWith("/getUpdates")).length;
      await new Promise((r) => setTimeout(r, 60));
      assert.equal(notify.calls.filter((c) => c.url.endsWith("/getUpdates")).length, polls, "Telegram stopped polling");
    } finally {
      await stack.close();
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
      removeTempDir(dir);
    }
  });

  it("takes SMS's default country from the SIM when DEFAULT_COUNTRY_CODE is empty, keeps it across a restart, and lets .env win", async () => {
    const dir = tempDir("fengsui-country-");
    const notify = createNotifyFetch();
    const start = (extra: Record<string, string>) => {
      const cpe = createIdentifiedCpe();
      const envPath = writeEnv(dir, { ...baseEnv(dir, cpe.password), WEB_PORT: "0", SMS_ENABLED: "true", ...extra });
      return createFengSuiRuntime({ config: loadConfig({ envPath, ignoreProcessEnv: true }), envPath, fetchImpl: cpe.fetchImpl, notifyFetchImpl: notify.fetchImpl, log: () => undefined });
    };
    let stack = start({});
    try {
      assert.equal(stack.sms?.defaultCountryCode, "", "nothing in .env and no SIM read yet: no guess");
      await stack.start();
      await waitFor(() => stack.monitor.getCachedTelemetry() !== null, "first poll");
      assert.equal(stack.sms?.defaultCountryCode, "+353", "the SIM's IMSI starts with 272 (Ireland)");
      assert.equal(stack.sms?.contacts.defaultCountryCode, "+353");
      assert.equal(stack.telegramBot?.defaultCountryCode, "+353", "Telegram's /sms reads the same country");
      await stack.close();
      // A restart starts from the telemetry saved in state.json, before the first poll
      stack = start({});
      assert.equal(stack.sms?.defaultCountryCode, "+353");
      await stack.close();
      stack = start({ DEFAULT_COUNTRY_CODE: "+44" });
      await stack.start();
      await waitFor(() => stack.monitor.getCachedTelemetry() !== null, "first poll");
      assert.equal(stack.sms?.defaultCountryCode, "+44", "what .env sets is kept whatever the SIM says");
    } finally {
      await stack.close();
      removeTempDir(dir);
    }
  });

  it("says so (log and alert) when stored data could not be decrypted and was moved aside at startup", async () => {
    const cpe = createStrictCpe({ latencyMs: 5 });
    const dir = tempDir("fengsui-quarantine-");
    const env = { ...baseEnv(dir, cpe.password), WEB_PORT: "0", SMS_ENABLED: "true" };
    // Contacts written under the old key, e.g. CPE_PASSWORD changed while DATA_ENCRYPTION_KEY was unset
    const contactsFile = path.join(dir, "contacts.json");
    fs.writeFileSync(contactsFile, StorageCipher.fromSecret("previous_router_password").serializeJson({ version: 1, contacts: [] }), { mode: 0o600 });
    const envPath = writeEnv(dir, { ...env, CONTACTS_FILE: contactsFile });
    const config = loadConfig({ envPath, ignoreProcessEnv: true });
    const logs: string[] = [];
    const notify = createNotifyFetch();
    const stack = createFengSuiRuntime({ config, envPath, fetchImpl: cpe.fetchImpl, notifyFetchImpl: notify.fetchImpl, log: (line) => logs.push(line) });
    try {
      await stack.start();
      const moved = fs.readdirSync(dir).filter((f) => f.startsWith("contacts.json.unreadable-"));
      assert.equal(moved.length, 1, "the unreadable file was kept aside");
      assert.ok(logs.some((line) => /contacts\.json[\s\S]*could not be decrypted[\s\S]*DATA_ENCRYPTION_KEY/.test(line)), logs.join("\n"));
      const alert = stack.scheduler.getRecentAlerts().find((a) => a.code === "DATA_QUARANTINED");
      assert.ok(alert, "an alert reaches the console and notifications");
      assert.match(alert.messageEn, /contacts\.json/);
      assert.doesNotMatch(alert.messageEn, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "file names only, no host paths");
    } finally {
      await stack.close();
      removeTempDir(dir);
    }
  });

  it("moves a store written without encryption aside at startup instead of trusting it, and says so", async () => {
    const cpe = createStrictCpe({ latencyMs: 5 });
    const dir = tempDir("fengsui-plaintext-");
    const envPath = writeEnv(dir, { ...baseEnv(dir, cpe.password), WEB_PORT: "0" });
    const config = loadConfig({ envPath, ignoreProcessEnv: true });
    // Planted by someone who can write the data directory but lacks the key: a console login of their own
    fs.mkdirSync(path.dirname(config.settingsFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(config.settingsFile, JSON.stringify({ format: 1, cpe: { url: "http://192.168.8.1", username: "admin", password: "planted" } }), { mode: 0o600 });
    const logs: string[] = [];
    const stack = createFengSuiRuntime({ config, envPath, fetchImpl: cpe.fetchImpl, notifyFetchImpl: createNotifyFetch().fetchImpl, log: (line) => logs.push(line) });
    try {
      // Nothing from the plain file is used: the router connection comes from .env's one-time import instead
      assert.equal(stack.settings.cpe?.password, cpe.password);
      await stack.start();
      assert.ok(logs.some((line) => /settings\.json\.unreadable-[\s\S]*stored without encryption/.test(line)), logs.join("\n"));
      assert.ok(stack.scheduler.getRecentAlerts().some((a) => a.code === "DATA_QUARANTINED" && a.messageEn.includes("settings.json")));
    } finally {
      await stack.close();
      removeTempDir(dir);
    }
  });

  it("names the console settings and the audit log too when they were moved aside at startup", async () => {
    const cpe = createStrictCpe({ latencyMs: 5 });
    const dir = tempDir("fengsui-quarantine-console-");
    const envPath = writeEnv(dir, { ...baseEnv(dir, cpe.password), WEB_PORT: "0" });
    const config = loadConfig({ envPath, ignoreProcessEnv: true });
    // Written under another key: a typo in DATA_ENCRYPTION_KEY would otherwise look like a fresh install
    const other = StorageCipher.fromSecret("another_key");
    fs.mkdirSync(path.dirname(config.settingsFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(config.settingsFile, other.serializeJson({ format: 1 }), { mode: 0o600 });
    fs.writeFileSync(config.auditFile, other.serializeJson({ format: 1, entries: [] }), { mode: 0o600 });
    const logs: string[] = [];
    const stack = createFengSuiRuntime({ config, envPath, fetchImpl: cpe.fetchImpl, notifyFetchImpl: createNotifyFetch().fetchImpl, log: (line) => logs.push(line) });
    try {
      await stack.start();
      for (const name of [path.basename(config.settingsFile), path.basename(config.auditFile)]) {
        assert.ok(logs.some((line) => line.includes(`${name}.unreadable-`)), `${name} is reported: ${logs.join("\n")}`);
      }
      const alert = stack.scheduler.getRecentAlerts().find((a) => a.code === "DATA_QUARANTINED");
      assert.ok(alert, "an alert reaches the console and notifications");
      assert.match(alert.messageEn, new RegExp(path.basename(config.settingsFile).replace(".", "\\.")));
      assert.match(alert.messageEn, new RegExp(path.basename(config.auditFile).replace(".", "\\.")));
    } finally {
      await stack.close();
      removeTempDir(dir);
    }
  });

  it("warns at startup only about the router password reuse that is still true", () => {
    const fallback = startupNotices({ cpePassword: "router_pw", dataEncryptionKey: "router_pw" }, { tokenName: "API_TOKEN (.env)", login: true });
    assert.equal(fallback.length, 3);
    assert.match(fallback[0] ?? "", /DATA_ENCRYPTION_KEY is not set/);
    assert.match(fallback[1] ?? "", /also the token "API_TOKEN \(\.env\)"[\s\S]*Settings → Tokens/);
    assert.match(fallback[2] ?? "", /console password is the router's admin password[\s\S]*Settings → Password/);
    assert.deepEqual(startupNotices({ cpePassword: "router_pw", dataEncryptionKey: "random_data_key" }, { tokenName: null, login: false }), []);
    // The README's setup: only DATA_ENCRYPTION_KEY in .env, the router and console passwords set in the console
    const dir = tempDir("fengsui-notices-");
    try {
      fs.writeFileSync(path.join(dir, ".env"), "DATA_ENCRYPTION_KEY=random_data_key\n");
      assert.deepEqual(startupNotices(loadConfig({ envPath: path.join(dir, ".env"), ignoreProcessEnv: true })), []);
    } finally {
      removeTempDir(dir);
    }
  });

  it("stops cleanly when a stop arrives while startup is still running: nothing starts afterwards", async () => {
    const cpe = createStrictCpe({ latencyMs: 5 });
    const dir = tempDir("fengsui-stopstart-");
    const envPath = writeEnv(dir, { ...baseEnv(dir, cpe.password), WEB_PORT: "0", SMS_ENABLED: "false" });
    const config = loadConfig({ envPath, ignoreProcessEnv: true });
    // A peer transport makes start() wait ~1 s for a running daemon's reply: the window a SIGTERM can hit
    const quietLan: PeerTransport = { send: () => undefined, onMessage: () => undefined, close: () => undefined };
    const stack = createFengSuiRuntime({ config, envPath, fetchImpl: cpe.fetchImpl, notifyFetchImpl: createNotifyFetch().fetchImpl, peerTransport: quietLan, log: () => undefined });
    try {
      const starting = startServeDaemon(stack);
      await new Promise((r) => setTimeout(r, 100));
      await stack.close();
      assert.equal(await starting, null, "no HTTP port is bound after the stop");
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(cpe.stats.logins, 0, "no CPE session is opened after the stop");
      assert.equal(stack.scheduler.getStatus().running, false);
      assert.equal(fs.existsSync(`${config.stateFile}.lock`), false);
    } finally {
      await stack.close();
      removeTempDir(dir);
    }
  });

  it("honours a persisted 108006 latch from assembly on, before start()", async () => {
    const cpe = createStrictCpe();
    const dir = tempDir("fengsui-latch-");
    const envPath = writeEnv(dir, baseEnv(dir, cpe.password));
    const config = loadConfig({ envPath, ignoreProcessEnv: true });
    const seed = new EncryptedStateStore({ filePath: config.stateFile, encryptionKey: config.dataEncryptionKey });
    const fingerprint = new HuaweiCpeClient({ cpeUrl: config.cpeUrl, cpePassword: cpe.password }).getPasswordFingerprint();
    seed.update({
      circuitBreaker: {
        tripped: true,
        code: "108006",
        reason: "persisted",
        trippedAtIso: "2026-10-31T00:00:00.000Z",
        remainCount: 2,
        waitTime: null,
        passwordFingerprintHex: fingerprint,
      },
    });
    await seed.flushAsync();
    const stack = createFengSuiRuntime({ config, envPath, fetchImpl: cpe.fetchImpl, log: () => undefined });
    try {
      const bound = await stack.httpServer.listen();
      const res = await fetch(`http://${bound.host}:${bound.port}/api/control/unlock`, {
        method: "POST",
        headers: { Authorization: "Bearer runtime_api_token_v1", "Content-Type": "application/json" },
        body: "{}",
      });
      assert.notEqual(res.status, 200);
      assert.equal(cpe.stats.challengeCalls + cpe.stats.authCalls, 0, "no password attempt against a latched breaker");
      assert.equal(stack.scheduler.getStatus().mode, "circuit_tripped");
    } finally {
      await stack.close();
      removeTempDir(dir);
    }
  });

  it("allows one daemon per data directory and never stores data unencrypted", async () => {
    const mock = createMockSmsCpe({ messages: [] });
    const dir = tempDir("fengsui-daemon-lock-");
    const envPath = writeEnv(dir, baseEnv(dir, mock.password));
    const config = loadConfig({ envPath, ignoreProcessEnv: true });
    const lockPath = `${config.stateFile}.lock`;
    const sleeper = await startSleeper();
    try {
      const first = createFengSuiRuntime({ config, fetchImpl: mock.fetchImpl, log: () => undefined });
      assert.equal(fs.readFileSync(lockPath, "utf8"), `${process.pid}\n`);
      await first.close();
      assert.equal(fs.existsSync(lockPath), false);

      // A live foreign daemon blocks startup; once it is gone its stale lock is taken over
      fs.writeFileSync(lockPath, `${sleeper.pid}\n`);
      assert.throws(
        () => createFengSuiRuntime({ config, fetchImpl: mock.fetchImpl, log: () => undefined }),
        (err: unknown) =>
          err instanceof DaemonAlreadyRunningError &&
          err.heldByPid === sleeper.pid &&
          err.message.includes(`Another FengSui daemon (pid ${sleeper.pid})`)
      );
      assert.equal(fs.readFileSync(lockPath, "utf8"), `${sleeper.pid}\n`, "a foreign lock is never removed");
      await stopSleeper(sleeper);
      const takeover = createFengSuiRuntime({ config, fetchImpl: mock.fetchImpl, log: () => undefined });
      await takeover.close();

      // No key means no daemon (nothing would be encrypted), and a failed assembly releases the lock
      const keyless = loadConfig({
        envPath,
        ignoreProcessEnv: true,
        overrides: { CPE_PASSWORD: " ", DATA_ENCRYPTION_KEY: " " },
      });
      assert.throws(() => createFengSuiRuntime({ config: keyless }), /DATA_ENCRYPTION_KEY must be set in \.env .*never stores its data unencrypted/);
      const badBot = loadConfig({ envPath, ignoreProcessEnv: true, overrides: { TELEGRAM_BOT_TOKEN: "not-a-token" } });
      assert.throws(() => createFengSuiRuntime({ config: badBot, fetchImpl: mock.fetchImpl }), /TELEGRAM_BOT_TOKEN/);
      assert.equal(fs.existsSync(lockPath), false);

      const noSms = createFengSuiRuntime({
        config: loadConfig({ envPath, ignoreProcessEnv: true, overrides: { SMS_ENABLED: "false" } }),
        fetchImpl: mock.fetchImpl,
        log: () => undefined,
      });
      assert.equal(noSms.sms, null);
      assert.ok(!(await toolNames(noSms)).includes("list_sms_threads"));
      noSms.releaseLocks();
      await noSms.close();
    } finally {
      await stopSleeper(sleeper);
      removeTempDir(dir);
    }
  });
});

/** RFC / reserved placeholders only (AGENTS.md 铁律二). */
const IDENTIFIED_DEVICE_INFO =
  "<response><DeviceName>H168-383</DeviceName><Imei>860000000000000</Imei><Imsi>272010000000000</Imsi>" +
  "<Msisdn>+353830000000</Msisdn><WanIPAddress>198.51.100.42</WanIPAddress><uptime>86400</uptime></response>";
const NAMED_HOST_INFO = JSON.stringify([
  { MACAddress: "00:00:5E:00:53:01", HostName: "Demo-Laptop", IPAddress: "192.168.8.10", Active: true, InterfaceType: "Ethernet", EthernetSpeed: 1000 },
]);

function createIdentifiedCpe() {
  return createStrictCpe({
    fault: (p, method) => {
      if (method !== "GET") return undefined;
      if (p === "/api/device/information") return { body: IDENTIFIED_DEVICE_INFO };
      if (p === "/api/system/HostInfo") return { body: NAMED_HOST_INFO };
      return undefined;
    },
  });
}

function privacyEnv(dir: string, password: string, redact: boolean): Record<string, string> {
  return {
    CPE_URL: "http://192.168.8.1",
    CPE_PASSWORD: password,
    API_TOKEN: "runtime_api_token_v1",
    DATA_ENCRYPTION_KEY: "runtime_data_key_v1",
    WEB_HOST: "127.0.0.1",
    WEB_PORT: "0",
    ALLOWED_HOSTS: "127.0.0.1",
    STATE_FILE: path.join(dir, "data", "state.json"),
    STATIC_DIR: path.join(dir, "no-static"),
    POLL_INTERVAL_MS: "600000",
    NEIGHBOR_SCAN_INTERVAL_MS: "600000",
    SSE_HEARTBEAT_MS: "2000",
    SMS_ENABLED: "false",
    REDACT_SENSITIVE_IN_API: String(redact),
  };
}

/** Parsed `/api/events` frames, read on demand. */
function openSse(res: Response): { next: (event: string) => Promise<string>; close: () => Promise<void> } {
  const reader = res.body?.getReader();
  assert.ok(reader, "an event stream body");
  const decoder = new TextDecoder();
  const pending: Array<{ event: string; data: string }> = [];
  let buffer = "";
  return {
    async next(event) {
      for (;;) {
        const index = pending.findIndex((frame) => frame.event === event);
        if (index >= 0) return pending.splice(0, index + 1)[index]?.data ?? "";
        const chunk = await reader.read();
        if (chunk.done) throw new Error(`SSE stream ended before "${event}"`);
        buffer += decoder.decode(chunk.value, { stream: true });
        for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const name = /^event: (.+)$/m.exec(frame)?.[1];
          const data = /^data: (.*)$/m.exec(frame)?.[1];
          if (name && data !== undefined) pending.push({ event: name, data });
        }
      }
    },
    close: () => reader.cancel(),
  };
}

const RAW_IDENTIFIERS = /860000000000000|272010000000000|\+353830000000|198\.51\.100\.42|134217758|Demo-Laptop/;

describe("REDACT_SENSITIVE_IN_API at the output boundary", () => {
  it("serves the logged-in web console plain values and Bearer REST, SSE and MCP clients redacted copies", async () => {
    const cpe = createIdentifiedCpe();
    const dir = tempDir("fengsui-redact-");
    const env = privacyEnv(dir, cpe.password, true);
    const envPath = writeEnv(dir, env);
    const stack = createFengSuiRuntime({ config: loadConfig({ envPath, ignoreProcessEnv: true }), envPath, fetchImpl: cpe.fetchImpl, log: () => undefined });
    const streams: Array<{ close: () => Promise<void> }> = [];
    try {
      const bound = await startServeDaemon(stack);
      assert.ok(bound);
      const base = `http://${bound.host}:${bound.port}`;
      await waitFor(() => stack.monitor.getCachedTelemetry() !== null && stack.monitor.getCachedTopology() !== null, "seed sweep");

      const login = await fetch(`${base}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest", Origin: base },
        body: JSON.stringify({ token: "runtime_api_token_v1" }),
      });
      assert.equal(login.status, 200);
      const cookie = { Cookie: /fengsui_sid=[0-9a-f]{64}/.exec(login.headers.get("set-cookie") ?? "")?.[0] ?? "" };
      const bearer = { Authorization: "Bearer runtime_api_token_v1" };
      const get = async (route: string, headers: Record<string, string>): Promise<string> => {
        const res = await fetch(`${base}${route}`, { headers });
        assert.equal(res.status, 200, route);
        return JSON.stringify(await res.json());
      };
      const mcp = async (method: string, params: Record<string, unknown>): Promise<string> =>
        JSON.stringify(await stack.mcpServer.handleRawJsonMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })));
      const assertPlain = (json: string, label: string): void => {
        assert.match(json, /860000000000000|Demo-Laptop/, `${label} carries plain values`);
      };
      const assertRedacted = (json: string, label: string): void => {
        assert.doesNotMatch(json, RAW_IDENTIFIERS, `${label} leaks a plain identifier`);
        assert.match(json, /<REDACTED>/, `${label} marks what it hid`);
      };

      // REST: the cookie session is the web console; a Bearer token is a script or an agent
      const webTelemetry = await get("/api/telemetry", cookie);
      assertPlain(webTelemetry, "web telemetry");
      assert.match(webTelemetry, /"sensitiveRedacted":false/);
      assertPlain(await get("/api/topology", cookie), "web topology");
      const apiTelemetry = await get("/api/telemetry", bearer);
      assertRedacted(apiTelemetry, "Bearer telemetry");
      assert.match(apiTelemetry, /"imei":"860000\*{9}"/);
      assert.match(apiTelemetry, /"wanIpv4":"198\.51\.\*\.\*"/);
      assert.match(apiTelemetry, /"sensitiveRedacted":true/);
      assertRedacted(await get("/api/topology", bearer), "Bearer topology");

      // MCP tools and resources
      assertRedacted(await mcp("tools/call", { name: "get_cpe_telemetry", arguments: {} }), "MCP telemetry");
      assertRedacted(await mcp("tools/call", { name: "list_terminal_topology", arguments: {} }), "MCP topology");
      assertRedacted(await mcp("resources/read", { uri: "fengsui://telemetry/latest" }), "MCP telemetry resource");

      // SSE: the initial snapshot and every later broadcast follow the subscriber's credentials
      const webSse = openSse(await fetch(`${base}/api/events`, { headers: cookie }));
      const apiSse = openSse(await fetch(`${base}/api/events`, { headers: bearer }));
      streams.push(webSse, apiSse);
      assertPlain(await webSse.next("telemetry"), "web SSE snapshot");
      assertRedacted(await apiSse.next("hello"), "Bearer SSE hello");
      assertRedacted(await apiSse.next("telemetry"), "Bearer SSE snapshot");
      await stack.monitor.refreshTelemetry({ ignoreCooldown: true });
      await stack.monitor.refreshTopology({ ignoreCooldown: true });
      assertPlain(await webSse.next("telemetry"), "web SSE telemetry");
      assertPlain(await webSse.next("topology"), "web SSE topology");
      assertRedacted(await apiSse.next("telemetry"), "Bearer SSE telemetry");
      assertRedacted(await apiSse.next("topology"), "Bearer SSE topology");
      await Promise.all(streams.splice(0).map((s) => s.close()));

      // Turning it off in .env applies through reset-breaker, to REST and MCP alike
      writeEnv(dir, { ...env, REDACT_SENSITIVE_IN_API: "false" });
      const reload = await fetch(`${base}/api/session/reset-breaker`, {
        method: "POST",
        headers: { ...bearer, "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
        body: "{}",
      });
      assert.equal(reload.status, 200);
      assertPlain(await get("/api/telemetry", bearer), "Bearer telemetry after reload");
      assertPlain(await mcp("tools/call", { name: "get_cpe_telemetry", arguments: {} }), "MCP telemetry after reload");
    } finally {
      await Promise.all(streams.map((s) => s.close().catch(() => undefined)));
      await stack.close();
      removeTempDir(dir);
    }
  });

  it("drops telemetry and topology a v1.0.0 daemon cached already masked, instead of showing them as real", async () => {
    const cpe = createIdentifiedCpe();
    const dir = tempDir("fengsui-legacy-cache-");
    const envPath = writeEnv(dir, privacyEnv(dir, cpe.password, true));
    const config = loadConfig({ envPath, ignoreProcessEnv: true });
    const open = () => createFengSuiRuntime({ config, envPath, fetchImpl: cpe.fetchImpl, log: () => undefined });
    try {
      const first = open();
      const telemetry = await first.monitor.refreshTelemetry();
      await first.monitor.refreshTopology();
      await first.close();
      assert.ok(telemetry);

      const restarted = open();
      assert.equal(restarted.monitor.getCachedTelemetry()?.device.imei, "860000000000000", "a plain cache survives a restart");
      assert.equal(restarted.monitor.getCachedTopology()?.hosts[0]?.displayName, "Demo-Laptop");
      await restarted.close();

      const legacy = new EncryptedStateStore({ filePath: config.stateFile, encryptionKey: config.dataEncryptionKey });
      legacy.load();
      legacy.update({ latestTelemetry: redactTelemetry(telemetry) });
      await legacy.flushAsync();

      const upgraded = open();
      assert.equal(upgraded.monitor.getCachedTelemetry(), null);
      assert.equal(upgraded.monitor.getCachedTopology(), null);
      await upgraded.close();
    } finally {
      removeTempDir(dir);
    }
  });
});

describe("Device access control through the daemon (REST, MCP)", () => {
  /** The test client connects from 127.0.0.1, so the "laptop" host carries that address to stand for the requester. */
  const ACCESS_HOSTS = JSON.stringify([
    { MACAddress: "00:00:5E:00:53:01", HostName: "nas", IPAddress: "192.168.8.10", Active: true, InterfaceType: "Ethernet", EthernetSpeed: 1000, IsLocalDevice: true },
    { MACAddress: "00:00:5E:00:53:02", HostName: "laptop", IPAddress: "127.0.0.1", Active: true, InterfaceType: "Wireless", Frequency: "5GHz", rate: 866 },
    { MACAddress: "00:00:5E:00:53:03", HostName: "phone", IPAddress: "192.168.8.30", Active: true, InterfaceType: "Wireless", Frequency: "5GHz", rate: 866 },
  ]);

  async function startAccessStack(extraEnv: Record<string, string> = {}) {
    const cpe = createStrictCpe({ fault: (p, method) => (method === "GET" && p === "/api/system/HostInfo" ? { body: ACCESS_HOSTS } : undefined) });
    const dir = tempDir("fengsui-access-");
    const envPath = writeEnv(dir, { ...privacyEnv(dir, cpe.password, true), ...extraEnv });
    const stack = createFengSuiRuntime({ config: loadConfig({ envPath, ignoreProcessEnv: true }), envPath, fetchImpl: cpe.fetchImpl, log: () => undefined });
    const bound = await startServeDaemon(stack);
    assert.ok(bound);
    const base = `http://${bound.host}:${bound.port}`;
    await waitFor(() => stack.monitor.getCachedTopology() !== null && stack.monitor.getCachedAccessControl() !== null, "seed sweep");
    const mcp = async (method: string, params: Record<string, unknown>): Promise<string> =>
      JSON.stringify(await stack.mcpServer.handleRawJsonMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })));
    const close = async (): Promise<void> => {
      await stack.close();
      removeTempDir(dir);
    };
    return { cpe, stack, base, mcp, close };
  }

  it("blocks, restores and schedules devices over REST with confirmation, never cutting off the daemon's host or the caller", async () => {
    const { cpe, base, mcp, close } = await startAccessStack();
    try {
      const login = await fetch(`${base}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest", Origin: base },
        body: JSON.stringify({ token: "runtime_api_token_v1" }),
      });
      const web = {
        Cookie: /fengsui_sid=[0-9a-f]{64}/.exec(login.headers.get("set-cookie") ?? "")?.[0] ?? "",
        "Content-Type": "application/json",
        "X-Requested-With": "XMLHttpRequest",
        Origin: base,
      };
      const post = (route: string, body: Record<string, unknown>) => fetch(`${base}${route}`, { method: "POST", headers: web, body: JSON.stringify(body) });

      const view = (await (await fetch(`${base}/api/access-control`, { headers: web })).json()) as {
        guard: { daemonHostMac: string | null; requesterMac: string | null };
        accessControl: { wifiMacFilter: { enabled: boolean; maxEntries: number }; timeRules: { maxRules: number } };
      };
      assert.deepEqual(view.guard, { daemonHostMac: "00:00:5E:00:53:01", requesterMac: "00:00:5E:00:53:02" });
      assert.equal(view.accessControl.wifiMacFilter.enabled, false);
      assert.equal(view.accessControl.timeRules.maxRules, 16);

      const unconfirmed = await post("/api/control/wifi-access", { action: "block", macAddress: "00:00:5E:00:53:03", name: "phone" });
      assert.equal(unconfirmed.status, 400);
      for (const mac of ["00:00:5E:00:53:01", "00:00:5E:00:53:02"]) {
        const refused = await post("/api/control/wifi-access", { action: "block", macAddress: mac, name: "x", confirm: true });
        assert.equal(refused.status, 400, mac);
        assert.match(((await refused.json()) as { message: string }).message, /cannot be cut off/);
      }
      assert.equal(cpe.router.macFilter.enable, "0", "refusals never reach the router");

      const blocked = await post("/api/control/wifi-access", { action: "block", macAddress: "00:00:5e:00:53:03", name: "phone", confirm: true });
      assert.equal(blocked.status, 200);
      const blockedBody = (await blocked.json()) as { changed: boolean; accessControl: { wifiMacFilter: { denyList: Array<{ macAddress: string }> } } };
      assert.equal(blockedBody.changed, true);
      assert.deepEqual(blockedBody.accessControl.wifiMacFilter.denyList.map((e) => e.macAddress), ["00:00:5E:00:53:03"]);
      assert.equal(cpe.isWifiBlocked("00:00:5E:00:53:03"), true);

      const whitelist = await post("/api/control/wifi-mac-filter", { mode: "allow", entries: [{ macAddress: "00:00:5E:00:53:03", name: "phone" }], confirm: true });
      assert.equal(whitelist.status, 400, "a whitelist without the caller's own Wi-Fi device is refused");

      const rule = await post("/api/control/time-rule", {
        action: "create",
        rule: { macAddress: "00:00:5E:00:53:03", name: "phone", weekMask: "1111100", startTime: "07:00", endTime: "21:00" },
        confirm: true,
      });
      assert.equal(rule.status, 200);
      assert.equal(cpe.router.timeRules.rules.length, 1);

      const restored = await post("/api/control/wifi-access", { action: "unblock", macAddress: "00:00:5E:00:53:03", confirm: true });
      assert.equal(restored.status, 200);
      assert.equal(cpe.isWifiBlocked("00:00:5E:00:53:03"), false);

      const api = (await (await fetch(`${base}/api/access-control`, { headers: { Authorization: "Bearer runtime_api_token_v1" } })).json()) as {
        guard: { daemonHostMac: string };
        accessControl: { timeRules: { rules: Array<{ devices: Array<{ macAddress: string; name: string }> }> } };
      };
      assert.equal(api.guard.daemonHostMac, "00:00:5E:**:**:**");
      assert.deepEqual(api.accessControl.timeRules.rules[0]?.devices, [{ macAddress: "00:00:5E:**:**:**", name: "<REDACTED>" }]);

      const tools = await mcp("tools/list", {});
      assert.match(tools, /"get_access_control"/);
      assert.doesNotMatch(tools, /set_device_internet_access|manage_internet_time_rule/, "AI cannot cut devices off by default");
      assert.match(await mcp("tools/call", { name: "set_device_internet_access", arguments: { action: "block", macAddress: "00:00:5E:00:53:03", confirm: true } }), /"isError":true|error/i);
      assert.equal(cpe.isWifiBlocked("00:00:5E:00:53:03"), false);
    } finally {
      await close();
    }
  });

  it("lets MCP agents block and restore devices by LAN address once MCP_ALLOW_ACCESS_CONTROL=true, with confirmation", async () => {
    const { cpe, mcp, close } = await startAccessStack({ MCP_ALLOW_MUTATIONS: "true", MCP_ALLOW_ACCESS_CONTROL: "true" });
    try {
      assert.match(await mcp("tools/list", {}), /set_device_internet_access.*set_wifi_mac_filter.*manage_internet_time_rule/s);
      assert.match(await mcp("tools/call", { name: "set_device_internet_access", arguments: { action: "block", ipv4Address: "192.168.8.30" } }), /CONFIRMATION_REQUIRED/);
      await mcp("tools/call", { name: "set_device_internet_access", arguments: { action: "block", ipv4Address: "192.168.8.30", confirm: true } });
      assert.equal(cpe.isWifiBlocked("00:00:5E:00:53:03"), true);
      assert.match(await mcp("tools/call", { name: "set_device_internet_access", arguments: { action: "block", ipv4Address: "192.168.8.10", confirm: true } }), /runs FengSui/);
      await mcp("tools/call", { name: "set_wifi_mac_filter", arguments: { mode: "off", confirm: true } });
      assert.equal(cpe.isWifiBlocked("00:00:5E:00:53:03"), false);
      await mcp("tools/call", {
        name: "manage_internet_time_rule",
        arguments: { action: "create", ipv4Address: "192.168.8.30", weekMask: "0000011", startTime: "09:00", endTime: "23:00", confirm: true },
      });
      assert.equal(cpe.router.timeRules.rules[0]?.WeekEnable, "0000011");
      // The router names rules by TR-069 path (44+ characters); agents must be able to pass it back
      const ruleId = cpe.router.timeRules.rules[0]?.ID ?? "";
      assert.match(ruleId, /^InternetGatewayDevice\.X_FireWall\.TimeRule\.\d+\.$/);
      const updated = await mcp("tools/call", {
        name: "manage_internet_time_rule",
        arguments: { action: "update", id: ruleId, ipv4Address: "192.168.8.30", weekMask: "1111111", startTime: "08:00", endTime: "22:00", confirm: true },
      });
      assert.doesNotMatch(updated, /"isError":\s*true/);
      assert.equal(cpe.router.timeRules.rules[0]?.WeekEnable, "1111111");
      assert.doesNotMatch(await mcp("tools/call", { name: "manage_internet_time_rule", arguments: { action: "delete", id: ruleId, confirm: true } }), /"isError":\s*true/);
      assert.equal(cpe.router.timeRules.rules.length, 0);
    } finally {
      await close();
    }
  });
});

describe("Read-only Bearer token (API_TOKEN_READONLY)", () => {
  it("lets dashboards and agents read and refresh but never write, over REST and MCP", async () => {
    const cpe = createStrictCpe({ latencyMs: 2 });
    const dir = tempDir("fengsui-readonly-");
    const envPath = writeEnv(dir, { ...baseEnv(dir, cpe.password), API_TOKEN_READONLY: "readonly_api_token_v1", SMS_ENABLED: "false", MCP_ALLOW_MUTATIONS: "true" });
    const config = loadConfig({ envPath, ignoreProcessEnv: true });
    const stack = createFengSuiRuntime({ config, envPath, fetchImpl: cpe.fetchImpl, notifyFetchImpl: createNotifyFetch().fetchImpl, log: () => undefined });
    try {
      const bound = await startServeDaemon(stack);
      assert.ok(bound);
      const base = `http://127.0.0.1:${bound.port}`;
      const call = (token: string, method: string, route: string, body?: unknown) =>
        fetch(`${base}${route}`, {
          method,
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      const ro = "readonly_api_token_v1";
      assert.equal((await call(ro, "GET", "/api/telemetry")).status, 200);
      assert.equal((await call(ro, "GET", "/api/session/status")).status, 200);
      assert.equal((await call(ro, "POST", "/api/telemetry/refresh", {})).status, 200, "a read session is allowed");
      for (const [route, body] of [
        ["/api/control/reboot", { confirm: true }],
        ["/api/control/unlock", {}],
        ["/api/control/band-lock", { lteBands: ["B1"] }],
        ["/api/control/security", { upnpEnabled: true }],
        ["/api/control/wifi-access", { action: "block", macAddress: "00:00:5E:00:53:03", confirm: true }],
        ["/api/session/reset-breaker", {}],
        ["/api/sms/send", { phone: "+353830000001", content: "hi" }],
      ] as const) {
        const res = await call(ro, "POST", route, body);
        assert.equal(res.status, 403, route);
        assert.equal(((await res.json()) as { errorCode: string }).errorCode, "READ_ONLY_TOKEN", route);
      }
      assert.equal(cpe.stats.writes.length, 0, "nothing reached the router");

      const mcp = async (token: string, method: string, params: Record<string, unknown>) =>
        (await (await call(token, "POST", "/mcp", { jsonrpc: "2.0", id: 1, method, params })).json()) as {
          result: { tools?: Array<{ name: string }>; isError?: boolean; structuredContent?: { errorCode?: string } };
        };
      const roTools = (await mcp(ro, "tools/list", {})).result.tools?.map((t) => t.name) ?? [];
      assert.ok(roTools.includes("get_cpe_telemetry"));
      assert.ok(!roTools.some((n) => ["lock_band", "lock_cell", "unlock_rf_locks", "set_security_switches", "reboot_cpe"].includes(n)));
      const refused = await mcp(ro, "tools/call", { name: "reboot_cpe", arguments: { confirm: true } });
      assert.equal(refused.result.isError, true);
      assert.equal(refused.result.structuredContent?.errorCode, "READ_ONLY_TOKEN");
      assert.doesNotMatch(JSON.stringify(refused.result.structuredContent), /API_TOKEN/, "tokens come from the console, not .env");
      assert.equal((await mcp(ro, "tools/call", { name: "get_cpe_telemetry", arguments: {} })).result.isError, false);
      assert.equal(cpe.stats.writes.length, 0);

      // The full token keeps full control; the web login does not accept the read-only token
      const fullTools = (await mcp("runtime_api_token_v1", "tools/list", {})).result.tools?.map((t) => t.name) ?? [];
      assert.ok(fullTools.includes("reboot_cpe"));
      const login = await fetch(`${base}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest", Origin: base },
        body: JSON.stringify({ token: ro }),
      });
      assert.equal(login.status, 401);
    } finally {
      await stack.close();
      removeTempDir(dir);
    }
  });

  it("refuses a read-only token that equals the full token or the router password", () => {
    const dir = tempDir("fengsui-readonly-cfg-");
    try {
      for (const value of ["runtime_api_token_v1", "router_password_x"]) {
        const envPath = writeEnv(dir, { ...baseEnv(dir, "router_password_x"), API_TOKEN_READONLY: value });
        assert.throws(() => loadConfig({ envPath, ignoreProcessEnv: true }), /API_TOKEN_READONLY must differ/);
      }
    } finally {
      removeTempDir(dir);
    }
  });
});
