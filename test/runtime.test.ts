import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createFengSuiRuntime } from "../src/cli.ts";
import { loadConfig } from "../src/config.ts";
import { StorageCipher, tryAcquireFileLock } from "../src/encrypted-file.ts";
import type { JsonRpcSuccessResponse } from "../src/mcp-server.ts";
import { createMockSmsCpe } from "./helpers/mock-sms-cpe.ts";

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
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fengsui-lock-"));
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
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("createFengSuiRuntime", () => {
  it("runs SMS, alerts, Telegram and webhooks in serve mode and pushes new SMS and alerts to both channels", async () => {
    const mock = createMockSmsCpe({
      messages: [{ index: 40001, phone: "+353830000001", content: "Already here", date: "2026-10-29 18:00:00", smstat: "0", box: 1 }],
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fengsui-runtime-"));
    const envPath = writeEnv(dir, baseEnv(dir, mock.password));
    const config = loadConfig({ envPath, ignoreProcessEnv: true });
    const notify = createNotifyFetch();
    const stack = createFengSuiRuntime({ config, envPath, fetchImpl: mock.fetchImpl, notifyFetchImpl: notify.fetchImpl, log: () => undefined });
    try {
      assert.equal(stack.mode, "serve");
      assert.ok(stack.sms && stack.alertEngine && stack.telegramBot && stack.webhook && stack.notificationHub);
      assert.equal(stack.smsUnavailableReason, null);
      assert.ok((await toolNames(stack)).includes("list_sms_threads"));
      assert.equal(fs.readFileSync(`${config.smsFile}.lock`, "utf8"), `${process.pid}\n`);

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
      fs.rmSync(dir, { recursive: true, force: true });
    }
    assert.equal(fs.existsSync(`${config.smsFile}.lock`), false);
  });

  it("re-encrypts SMS, contacts and Telegram state and revokes /auth-linked chats when reset-breaker reloads .env", async () => {
    const mock = createMockSmsCpe({ messages: [] });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fengsui-rotate-"));
    const env = baseEnv(dir, mock.password);
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
      const tgState = v2.readJsonFileOrQuarantine<{ authorizedChatIds: string[] }>(config.telegramStateFile);
      assert.deepEqual(tgState?.authorizedChatIds, []);
      assert.equal(bot.state.isAuthorized("2002", bot.allowedChatIds), false);
      assert.equal(bot.state.isAuthorized("1001", bot.allowedChatIds), true);

      await bot.handleUpdate({ update_id: 1, message: { message_id: 10, chat: { id: 3003 }, text: "/auth runtime_api_token_v1" } });
      assert.equal(bot.state.isAuthorized("3003", bot.allowedChatIds), false);
      await bot.handleUpdate({ update_id: 2, message: { message_id: 11, chat: { id: 3003 }, text: "/auth runtime_api_token_v2" } });
      assert.equal(bot.state.isAuthorized("3003", bot.allowedChatIds), true);
      assert.equal(bot.rotateAuthToken("runtime_api_token_v2"), 0, "unchanged token keeps linked chats");
    } finally {
      if (originalTz === undefined) delete process.env["TZ"];
      else process.env["TZ"] = originalTz;
      await stack.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the stdio MCP runtime free of push channels and without SMS while another process owns the store", async () => {
    const mock = createMockSmsCpe({ messages: [] });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fengsui-mcp-runtime-"));
    const envPath = writeEnv(dir, baseEnv(dir, mock.password));
    const config = loadConfig({ envPath, ignoreProcessEnv: true });
    const sleeper = await startSleeper();
    try {
      const idle = createFengSuiRuntime({ config, mode: "mcp", fetchImpl: mock.fetchImpl });
      assert.equal(idle.telegramBot, null);
      assert.equal(idle.webhook, null);
      assert.equal(idle.alertEngine, null);
      assert.equal(idle.notificationHub, null);
      assert.ok(idle.sms);
      const idleTools = await toolNames(idle);
      assert.ok(idleTools.includes("list_sms_threads"));
      assert.ok(!idleTools.includes("send_sms"), "MCP_SMS_ACCESS defaults to read");
      await idle.start();
      assert.equal(mock.getLoginCount(), 0, "stdio mode without --poll stays passive");
      await idle.close();

      const polling = createFengSuiRuntime({ config, mode: "mcp", backgroundPoll: true, fetchImpl: mock.fetchImpl });
      await polling.start();
      await waitFor(() => polling.sms?.getStatus().seeded === true, "background seeding in --poll mode");
      await polling.close();

      fs.writeFileSync(`${config.smsFile}.lock`, `${sleeper.pid}\n`);
      const contended = createFengSuiRuntime({ config, mode: "mcp", fetchImpl: mock.fetchImpl });
      assert.equal(contended.sms, null);
      assert.match(contended.smsUnavailableReason ?? "", new RegExp(`owned by another FengSui process \\(pid ${sleeper.pid}\\)`));
      assert.ok(!(await toolNames(contended)).includes("list_sms_threads"));
      await contended.close();
      assert.equal(fs.readFileSync(`${config.smsFile}.lock`, "utf8"), `${sleeper.pid}\n`);

      const disabled = createFengSuiRuntime({
        config: loadConfig({ envPath, ignoreProcessEnv: true, overrides: { SMS_ENABLED: "false", SMS_FILE: path.join(dir, "other", "sms.json") } }),
        mode: "mcp",
        fetchImpl: mock.fetchImpl,
      });
      assert.equal(disabled.sms, null);
      assert.equal(disabled.smsUnavailableReason, "SMS_ENABLED=false");
      assert.equal(fs.existsSync(path.join(dir, "other", "sms.json.lock")), false);
      disabled.releaseLocks();
      await disabled.close();
    } finally {
      await stopSleeper(sleeper);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
