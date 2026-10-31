#!/usr/bin/env node
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { AlertEngine } from "./alert-engine.ts";
import { loadConfig } from "./config.ts";
import { type FengSuiCore, createFengSuiCore, stopFengSuiCore } from "./core.ts";
import { DEFAULT_SESSION_MAX_HOLD_MS, HuaweiCpeClient } from "./cpe-client.ts";
import type { CpeControlService } from "./cpe-controls.ts";
import type { CpeMonitor } from "./cpe-monitor.ts";
import { type FileLockHandle, StorageCipher, tryAcquireFileLock } from "./encrypted-file.ts";
import { FengSuiHttpServer } from "./http-server.ts";
import { FengSuiMcpServer } from "./mcp-server.ts";
import { McpStdioBridge } from "./mcp-stdio-bridge.ts";
import { type NotificationChannel, NotificationHub } from "./notify/hub.ts";
import { TelegramApi } from "./notify/telegram-api.ts";
import { TelegramBot, TelegramStateStore } from "./notify/telegram-bot.ts";
import { WebhookNotifier } from "./notify/webhook.ts";
import type { MutexSessionScheduler } from "./scheduler.ts";
import { ContactBook } from "./sms/contacts.ts";
import { SmsMcpTools } from "./sms/mcp-tools.ts";
import { SmsMirrorStore } from "./sms/mirror.ts";
import { SmsService } from "./sms/service.ts";
import { SseEventBus } from "./sse-bus.ts";
import { EncryptedStateStore } from "./state-store.ts";
import { TimeSeriesRingBuffer } from "./timeseries.ts";
import type { AppConfig } from "./types.ts";

export type CliMode = "serve" | "mcp" | "help";

export interface ParsedCliCommand {
  mode: CliMode;
  envPath?: string;
  /** Notices for the user (e.g. deprecated flags), printed to stderr. */
  warnings: string[];
}

export function parseCliCommand(argv: ReadonlyArray<string>): ParsedCliCommand {
  const args = argv.slice(2);
  let mode: CliMode = "serve";
  let envPath: string | undefined;
  const warnings: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--help" || arg === "-h" || arg === "help") {
      return { mode: "help", envPath, warnings };
    }
    if (arg === "serve") {
      mode = "serve";
      continue;
    }
    if (arg === "mcp") {
      mode = "mcp";
      continue;
    }
    if (arg === "--poll") {
      warnings.push(
        '"--poll" is ignored: "cpe-dash mcp" is a stateless bridge to the serve daemon, which does the polling'
      );
      continue;
    }
    if (arg === "--env" && typeof args[i + 1] === "string") {
      envPath = args[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith("--env=")) {
      envPath = arg.slice("--env=".length);
      continue;
    }
    throw new Error(`Unknown CLI argument "${arg}". Run with --help for usage.`);
  }

  return { mode, envPath, warnings };
}

/** A second daemon on the same data directory would run its own CPE scheduler next to ours. */
export class DaemonAlreadyRunningError extends Error {
  readonly heldByPid: number | null;

  constructor(lockPath: string, heldByPid: number | null) {
    super(
      `Another FengSui daemon (pid ${heldByPid ?? "unknown"}) already owns ${lockPath}: only one daemon may talk to the CPE. Point MCP agents at it with "cpe-dash mcp" (stdio bridge) or its /mcp endpoint.`
    );
    this.name = "DaemonAlreadyRunningError";
    this.heldByPid = heldByPid;
  }
}

export interface FengSuiRuntimeStack {
  config: AppConfig;
  stateStore: EncryptedStateStore;
  timeseries: TimeSeriesRingBuffer;
  cpeClient: HuaweiCpeClient;
  core: FengSuiCore;
  scheduler: MutexSessionScheduler;
  monitor: CpeMonitor;
  controls: CpeControlService;
  sseBus: SseEventBus;
  mcpServer: FengSuiMcpServer;
  httpServer: FengSuiHttpServer;
  /** `null` when SMS_ENABLED=false. */
  sms: SmsService | null;
  alertEngine: AlertEngine | null;
  notificationHub: NotificationHub | null;
  telegramBot: TelegramBot | null;
  webhook: WebhookNotifier | null;
  /** Initialize the scheduler and start background work (polling, SMS sync, alerts, notifications). */
  start(): Promise<void>;
  /** Stop every subsystem in dependency order, flush encrypted stores and release the daemon lock. */
  close(): Promise<void>;
  /** Synchronously release the daemon lock (for `process.on("exit")`). */
  releaseLocks(): void;
}

export interface FengSuiRuntimeOptions {
  config: AppConfig;
  envPath?: string;
  /** CPE transport (tests inject the mock router here). */
  fetchImpl?: typeof fetch;
  /** Transport for Telegram and webhooks (defaults to global `fetch`). */
  notifyFetchImpl?: typeof fetch;
  /** Re-apply `TZ` to `process.env` when `/api/session/reset-breaker` reloads `.env` (CLI only). */
  applyTimeZone?: boolean;
  log?: (line: string) => void;
}

/**
 * Assemble the serve daemon: the only FengSui process that talks to the CPE. It takes an exclusive
 * lock on the data directory (`<STATE_FILE>.lock`) first, so a second daemon fails fast instead of
 * running a second scheduler, breaker and state writer, and refuses to store anything unencrypted.
 */
export function createFengSuiRuntime(options: FengSuiRuntimeOptions): FengSuiRuntimeStack {
  const { config } = options;
  if (!config.dataEncryptionKey.trim()) {
    throw new Error(
      "CPE_PASSWORD (or DATA_ENCRYPTION_KEY) must be set: FengSui never stores state, SMS, contacts or Telegram links unencrypted"
    );
  }
  const lockPath = `${config.stateFile}.lock`;
  const acquired = tryAcquireFileLock(lockPath);
  if (!acquired.ok) {
    throw new DaemonAlreadyRunningError(lockPath, acquired.heldByPid);
  }
  try {
    return assembleRuntime(options, acquired.lock);
  } catch (err) {
    acquired.lock.release();
    throw err;
  }
}

function assembleRuntime(options: FengSuiRuntimeOptions, daemonLock: FileLockHandle): FengSuiRuntimeStack {
  const { config, envPath, fetchImpl } = options;
  const log = options.log ?? ((line: string) => console.warn(line));

  const stateStore = new EncryptedStateStore({
    filePath: config.stateFile,
    encryptionKey: config.dataEncryptionKey,
  });

  const timeseries = new TimeSeriesRingBuffer({
    retentionHours: config.historyRetentionHours,
  });

  const cpeClient = new HuaweiCpeClient({
    cpeUrl: config.cpeUrl,
    cpeUsername: config.cpeUsername,
    cpePassword: config.cpePassword,
    requestTimeoutMs: config.requestTimeoutMs,
    respectBrowserSession: config.respectBrowserSession,
    fetchImpl,
    // An SMS send polls send-status inside its session, so the hold budget must outlast that poll
    sessionMaxHoldMs: Math.max(DEFAULT_SESSION_MAX_HOLD_MS, config.smsSendStatusTimeoutMs + 30_000),
  });

  // Two processes long-polling one Telegram bot token fight over getUpdates (HTTP 409); the daemon
  // lock above guarantees this is the only poller on this data directory.
  const telegramApi =
    config.telegramBotToken
      ? new TelegramApi({
          token: config.telegramBotToken,
          apiBase: config.telegramApiBase,
          fetchImpl: options.notifyFetchImpl,
        })
      : null;
  const webhook =
    config.webhookUrl
      ? new WebhookNotifier({
          url: config.webhookUrl,
          secret: config.webhookSecret || undefined,
          fetchImpl: options.notifyFetchImpl,
        })
      : null;

  const cipher = new StorageCipher(config.dataEncryptionKey);

  const core = createFengSuiCore({
    client: cpeClient,
    stateStore,
    timeseries,
    pollIntervalMs: config.pollIntervalMs,
    neighborScanIntervalMs: config.neighborScanIntervalMs,
    stateFlushIntervalMs: config.stateFlushIntervalMs,
    redactSensitive: config.redactSensitiveInApi,
    smsCountersEnabled: config.smsEnabled,
  });
  const { scheduler, monitor, controls } = core;

  let sms: SmsService | null = null;
  if (config.smsEnabled) {
    const contacts = new ContactBook({
      filePath: config.contactsFile,
      cipher,
      defaultCountryCode: config.defaultCountryCode,
    });
    const mirror = new SmsMirrorStore({
      filePath: config.smsFile,
      cipher,
      defaultCountryCode: config.defaultCountryCode,
      contacts,
    });
    contacts.load();
    mirror.load();
    sms = new SmsService({
      scheduler,
      monitor,
      mirror,
      contacts,
      defaultCountryCode: config.defaultCountryCode,
      fullSyncIntervalMs: config.smsFullSyncIntervalMs,
      seedExistingOnStart: config.smsSeedExistingOnStart,
      autoMarkRead: config.smsAutoMarkRead,
      sendStatusTimeoutMs: config.smsSendStatusTimeoutMs,
    });
  }

  const alertEngine =
    config.alertsEnabled
      ? new AlertEngine({
          scheduler,
          monitor,
          controls,
          rsrpThresholdDbm: config.alertRsrpThresholdDbm,
          sinrThresholdDb: config.alertSinrThresholdDb,
        })
      : null;

  let telegramState: TelegramStateStore | null = null;
  let telegramBot: TelegramBot | null = null;
  if (telegramApi) {
    telegramState = new TelegramStateStore({ filePath: config.telegramStateFile, cipher });
    telegramState.load();
    telegramBot = new TelegramBot({
      api: telegramApi,
      core,
      state: telegramState,
      sms,
      authToken: config.apiToken,
      allowedChatIds: config.telegramChatIds,
      locale: config.defaultLocale,
      defaultCountryCode: config.defaultCountryCode,
      log,
    });
  }

  const channels: NotificationChannel[] = [telegramBot, webhook].filter(
    (channel): channel is TelegramBot | WebhookNotifier => channel !== null
  );
  const notificationHub =
    channels.length > 0
      ? new NotificationHub({
          scheduler,
          sms,
          channels,
          alertMinSeverity: config.alertNotifyMinSeverity,
          log,
        })
      : null;

  const sseBus = new SseEventBus({
    heartbeatMs: config.sseHeartbeatMs,
    maxClients: config.sseMaxClients,
  });

  const mcpServer = new FengSuiMcpServer({
    core,
    allowMutations: config.mcpAllowMutations,
    toolProviders: sms
      ? [
          new SmsMcpTools({
            sms,
            access: config.mcpSmsAccess,
            sendPolicy: config.mcpSmsSendPolicy,
            sendLimitPerHour: config.mcpSmsSendLimitPerHour,
          }),
        ]
      : [],
  });

  const httpServer = new FengSuiHttpServer({
    config,
    core,
    sseBus,
    mcpServer,
    envPath,
    sms,
    notificationHub,
    onConfigReloaded: async (reloaded) => {
      if (options.applyTimeZone) applyProcessTimeZone(reloaded);
      // Re-encrypt immediately: DATA_ENCRYPTION_KEY defaults to CPE_PASSWORD, so fixing the password
      // changes the key, and files left under the old key would be unreadable after a restart.
      const rekeyed: Array<Promise<void>> = [];
      if (sms) {
        sms.rotateEncryptionKey(reloaded.dataEncryptionKey);
        rekeyed.push(sms.mirror.flush(), sms.contacts.flush());
      }
      if (telegramState) {
        telegramState.rotateEncryptionKey(reloaded.dataEncryptionKey);
        // Revoke /auth-linked chats before the awaited flush (writes are chained), so the response
        // never precedes a durable revocation of a rotated, possibly leaked API_TOKEN
        telegramBot?.rotateAuthToken(reloaded.apiToken);
        rekeyed.push(telegramState.flush());
      }
      await Promise.allSettled(rekeyed);
    },
  });

  let started = false;
  let closed = false;

  return {
    config,
    stateStore,
    timeseries,
    cpeClient,
    core,
    scheduler,
    monitor,
    controls,
    sseBus,
    mcpServer,
    httpServer,
    sms,
    alertEngine,
    notificationHub,
    telegramBot,
    webhook,
    async start(): Promise<void> {
      if (started) return;
      started = true;
      monitor.init();
      sseBus.attachCore(core);
      if (sms) sseBus.attachSms(sms);
      sseBus.start();
      notificationHub?.start();
      alertEngine?.start();
      await telegramBot?.start();
      sms?.start();
      monitor.start();
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      sseBus.stop();
      await httpServer.close();
      await telegramBot?.stop();
      notificationHub?.stop();
      alertEngine?.stop();
      await stopFengSuiCore(core);
      await sms?.stop();
      await telegramState?.flush().catch(() => undefined);
      daemonLock.release();
    },
    releaseLocks(): void {
      daemonLock.release();
    },
  };
}

/**
 * Apply `TZ` from `.env` to this process (Node re-reads `process.env.TZ` on assignment), so local
 * timestamps such as the `<Date>` of sent SMS match the router's clock. Returns `true` on change.
 */
export function applyProcessTimeZone(
  config: Pick<AppConfig, "timeZone">,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (!config.timeZone || env["TZ"] === config.timeZone) return false;
  env["TZ"] = config.timeZone;
  return true;
}

export function formatCliHelp(): string {
  return [
    "FengSui (烽燧 / cpe-dash) — Huawei 5G CPE Ultra 6 (H168-383) Telemetry, Control & MCP Platform",
    "",
    "Usage:",
    "  cpe-dash [serve] [--env <path>]   Start the daemon: Web dashboard, REST API, SSE and HTTP MCP (/mcp)",
    "  cpe-dash mcp [--env <path>]       Stdio MCP bridge for local agents, forwarding to the daemon's /mcp",
    "  cpe-dash --help                   Show this help message",
    "",
    "Only the serve daemon talks to the CPE (one admin session, one breaker). The stdio bridge keeps no",
    "state: it reads MCP_DAEMON_URL (default http://127.0.0.1:<WEB_PORT>/mcp) and API_TOKEN from .env.",
  ].join("\n");
}

function redirectConsoleToStderrForStdioMcp(): void {
  const writeStderr = (...items: unknown[]): void => {
    const line = items
      .map((item) => (typeof item === "string" ? item : JSON.stringify(item)))
      .join(" ");
    process.stderr.write(`${line}\n`);
  };
  console.log = writeStderr;
  console.info = writeStderr;
  console.warn = writeStderr;
}

export async function runCli(argv: ReadonlyArray<string> = process.argv): Promise<void> {
  const cmd = parseCliCommand(argv);

  if (cmd.mode === "help") {
    process.stdout.write(`${formatCliHelp()}\n`);
    return;
  }

  for (const warning of cmd.warnings) process.stderr.write(`[fengsui] Warning: ${warning}\n`);

  if (cmd.mode === "mcp") {
    redirectConsoleToStderrForStdioMcp();
    await runStdioBridge(loadConfig({ envPath: cmd.envPath }));
    return;
  }

  const config = loadConfig({ envPath: cmd.envPath });
  applyProcessTimeZone(config);
  const stack = createFengSuiRuntime({
    config,
    envPath: cmd.envPath,
    applyTimeZone: true,
  });
  // `exit` listeners run synchronously (also after uncaught errors); graceful paths use close()
  process.once("exit", () => stack.releaseLocks());
  await stack.start();
  if (config.dataEncryptionKey === config.cpePassword) {
    process.stderr.write(
      "[fengsui] Notice: DATA_ENCRYPTION_KEY is not set, so encrypted data (state, SMS mirror, contacts, Telegram state) is keyed to CPE_PASSWORD. Set a dedicated key and apply it with POST /api/session/reset-breaker; restarting with a changed password instead leaves these files unreadable (quarantined as *.unreadable-<timestamp>).\n"
    );
  }
  const smsSummary = stack.sms ? `sms=on (mirror ${stack.sms.mirror.size} messages)` : "sms=off (SMS_ENABLED=false)";

  // `serve` daemon mode
  if (config.webEnabled) {
    const boundAddress = await stack.httpServer.listen();
    process.stdout.write(
      `[fengsui] HTTP + SSE + MCP server listening on http://${boundAddress.host}:${boundAddress.port} (cpe=${config.cpeUrl}, poll=${config.pollIntervalMs}ms, mcpHttp=${config.mcpHttpEnabled})\n`
    );
  } else {
    process.stdout.write(
      `[fengsui] Background telemetry daemon started with WEB_ENABLED=false (cpe=${config.cpeUrl}, poll=${config.pollIntervalMs}ms)\n`
    );
  }
  process.stdout.write(
    `[fengsui] ${smsSummary}, alerts=${stack.alertEngine ? "on" : "off"}, telegram=${stack.telegramBot ? "on" : "off"}, webhook=${stack.webhook ? "on" : "off"}\n`
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write(`[fengsui] Received ${signal}, flushing encrypted state and closing server...\n`);
    await stack.close();
    process.exit(0);
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

/**
 * `cpe-dash mcp`: forward stdio NDJSON to the daemon until stdin ends, then exit once every
 * forwarded request has been answered. Never opens a CPE session itself.
 */
async function runStdioBridge(config: AppConfig): Promise<void> {
  const bridge = new McpStdioBridge({
    daemonUrl: config.mcpDaemonUrl,
    apiToken: config.apiToken,
    log: (line) => process.stderr.write(`${line}\n`),
  });
  const session = bridge.attach(process.stdin, process.stdout);
  process.stderr.write(`[fengsui-mcp] stdio bridge ready -> ${bridge.daemonUrl} (no CPE session in this process)\n`);
  const finish = (): void => {
    session.detach();
    void session.drained().finally(() => process.exit(0));
  };
  process.stdin.once("end", finish);
  process.once("SIGINT", finish);
  process.once("SIGTERM", finish);
}

/**
 * Detect whether `moduleUrl` is the process entry script. Both sides are resolved with `realpath`
 * because npm links the `cpe-dash` bin as a symlink, so `process.argv[1]` is the link path while
 * `import.meta.url` is the real module path.
 */
export function isCliEntryPoint(argv1: string | undefined, moduleUrl: string): boolean {
  if (!argv1) return false;
  try {
    return fs.realpathSync(argv1) === fs.realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isCliEntryPoint(process.argv[1], import.meta.url)) {
  runCli(process.argv).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[fengsui] Fatal startup error: ${msg}\n`);
    process.exit(1);
  });
}
