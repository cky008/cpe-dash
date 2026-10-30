#!/usr/bin/env node
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { AlertEngine } from "./alert-engine.ts";
import { loadConfig } from "./config.ts";
import { type FengSuiCore, createFengSuiCore, stopFengSuiCore } from "./core.ts";
import { HuaweiCpeClient } from "./cpe-client.ts";
import type { CpeControlService } from "./cpe-controls.ts";
import type { CpeMonitor } from "./cpe-monitor.ts";
import { type FileLockHandle, StorageCipher, tryAcquireFileLock } from "./encrypted-file.ts";
import { FengSuiHttpServer } from "./http-server.ts";
import { FengSuiMcpServer } from "./mcp-server.ts";
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
  mcpBackgroundPoll: boolean;
}

export function parseCliCommand(argv: ReadonlyArray<string>): ParsedCliCommand {
  const args = argv.slice(2);
  let mode: CliMode = "serve";
  let envPath: string | undefined;
  let mcpBackgroundPoll = process.env["MCP_STDIO_BACKGROUND_POLL"] === "true";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--help" || arg === "-h" || arg === "help") {
      return { mode: "help", envPath, mcpBackgroundPoll };
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
      mcpBackgroundPoll = true;
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

  return { mode, envPath, mcpBackgroundPoll };
}

export interface FengSuiRuntimeStack {
  config: AppConfig;
  mode: "serve" | "mcp";
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
  /** `null` when SMS_ENABLED=false or another FengSui process owns the SMS store. */
  sms: SmsService | null;
  smsUnavailableReason: string | null;
  alertEngine: AlertEngine | null;
  notificationHub: NotificationHub | null;
  telegramBot: TelegramBot | null;
  webhook: WebhookNotifier | null;
  /** Initialize the scheduler and start background work (polling, SMS sync, alerts, notifications). */
  start(): Promise<void>;
  /** Stop every subsystem in dependency order, flush encrypted stores and release the SMS store lock. */
  close(): Promise<void>;
  /** Synchronously release the SMS store lock (for `process.on("exit")`). */
  releaseLocks(): void;
}

export interface FengSuiRuntimeOptions {
  config: AppConfig;
  envPath?: string;
  /** CPE transport (tests inject the mock router here). */
  fetchImpl?: typeof fetch;
  /** Transport for Telegram and webhooks (defaults to global `fetch`). */
  notifyFetchImpl?: typeof fetch;
  /** `serve` runs the daemon (SSE, alerts, Telegram, webhooks); `mcp` is the stdio MCP server. */
  mode?: "serve" | "mcp";
  /** `mcp` mode only: poll telemetry and keep SMS in sync in the background (`--poll`). */
  backgroundPoll?: boolean;
  /** Re-apply `TZ` to `process.env` when `/api/session/reset-breaker` reloads `.env` (CLI only). */
  applyTimeZone?: boolean;
  log?: (line: string) => void;
}

export function createFengSuiRuntime(options: FengSuiRuntimeOptions): FengSuiRuntimeStack {
  const { config, envPath, fetchImpl } = options;
  const mode = options.mode ?? "serve";
  const background = mode === "serve" || options.backgroundPoll === true;
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
  });

  // Alerts and push channels belong to the daemon only: two processes long-polling one Telegram
  // bot token would fight over getUpdates (HTTP 409). Their constructors validate the token and
  // URL, so they run before the SMS store lock is taken.
  const telegramApi =
    mode === "serve" && config.telegramBotToken
      ? new TelegramApi({
          token: config.telegramBotToken,
          apiBase: config.telegramApiBase,
          fetchImpl: options.notifyFetchImpl,
        })
      : null;
  const webhook =
    mode === "serve" && config.webhookUrl
      ? new WebhookNotifier({
          url: config.webhookUrl,
          secret: config.webhookSecret || undefined,
          fetchImpl: options.notifyFetchImpl,
        })
      : null;

  // The SMS store has exactly one owner process; a second process (e.g. stdio MCP next to the
  // daemon) runs without SMS instead of overwriting the daemon's encrypted mirror.
  let smsLock: FileLockHandle | null = null;
  let smsUnavailableReason: string | null = config.smsEnabled ? null : "SMS_ENABLED=false";
  if (config.smsEnabled) {
    const acquired = tryAcquireFileLock(`${config.smsFile}.lock`);
    if (acquired.ok) {
      smsLock = acquired.lock;
    } else {
      smsUnavailableReason = `the SMS store is owned by another FengSui process (pid ${acquired.heldByPid ?? "unknown"}); use that process's MCP endpoint for SMS`;
    }
  }
  const needsCipher = smsLock !== null || telegramApi !== null;
  const cipher = needsCipher ? StorageCipher.fromSecret(config.dataEncryptionKey) : null;

  const core = createFengSuiCore({
    client: cpeClient,
    stateStore,
    timeseries,
    pollIntervalMs: config.pollIntervalMs,
    neighborScanIntervalMs: config.neighborScanIntervalMs,
    stateFlushIntervalMs: config.stateFlushIntervalMs,
    redactSensitive: config.redactSensitiveInApi,
    smsCountersEnabled: smsLock !== null,
  });
  const { scheduler, monitor, controls } = core;

  let sms: SmsService | null = null;
  if (smsLock && cipher) {
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
    mode === "serve" && config.alertsEnabled
      ? new AlertEngine({
          scheduler,
          monitor,
          rsrpThresholdDbm: config.alertRsrpThresholdDbm,
          sinrThresholdDb: config.alertSinrThresholdDb,
        })
      : null;

  let telegramState: TelegramStateStore | null = null;
  let telegramBot: TelegramBot | null = null;
  if (telegramApi && cipher) {
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
        rekeyed.push(telegramState.flush());
      }
      telegramBot?.rotateAuthToken(reloaded.apiToken);
      await Promise.allSettled(rekeyed);
    },
  });

  let started = false;
  let closed = false;

  return {
    config,
    mode,
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
    smsUnavailableReason,
    alertEngine,
    notificationHub,
    telegramBot,
    webhook,
    async start(): Promise<void> {
      if (started) return;
      started = true;
      monitor.init();
      if (mode === "serve") {
        sseBus.attachCore(core);
        if (sms) sseBus.attachSms(sms);
        sseBus.start();
      }
      if (!background) return;
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
      smsLock?.release();
    },
    releaseLocks(): void {
      smsLock?.release();
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
    "  cpe-dash [serve] [--env <path>]        Start Web Dashboard, REST API, SSE & Streamable HTTP MCP daemon",
    "  cpe-dash mcp [--poll] [--env <path>]   Start NDJSON stdio MCP Server for local AI agents",
    "  cpe-dash --help                        Show this help message",
    "",
    "The serve daemon owns the SMS mirror, alerts, Telegram bot and webhooks; agents should use its",
    "/api/mcp endpoint for SMS. A stdio MCP process started next to it runs without SMS tools.",
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

  if (cmd.mode === "mcp") {
    redirectConsoleToStderrForStdioMcp();
  }

  const config = loadConfig({ envPath: cmd.envPath });
  applyProcessTimeZone(config);
  const stack = createFengSuiRuntime({
    config,
    envPath: cmd.envPath,
    mode: cmd.mode,
    backgroundPoll: cmd.mcpBackgroundPoll,
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
  const smsSummary = stack.sms
    ? `sms=on (mirror ${stack.sms.mirror.size} messages)`
    : `sms=off (${stack.smsUnavailableReason ?? "disabled"})`;

  if (cmd.mode === "mcp") {
    const detachStdio = stack.mcpServer.attachStdio(process.stdin, process.stdout);
    process.stderr.write(
      `[fengsui-mcp] stdio NDJSON server ready (cpe=${config.cpeUrl}, mutations=${config.mcpAllowMutations}, mcpSms=${stack.sms ? config.mcpSmsAccess : "off"}, ${smsSummary})\n`
    );

    let shuttingDown = false;
    const shutdown = async (): Promise<void> => {
      if (shuttingDown) return;
      shuttingDown = true;
      detachStdio();
      await stack.close();
    };

    process.once("SIGINT", () => {
      void shutdown().finally(() => process.exit(0));
    });
    process.once("SIGTERM", () => {
      void shutdown().finally(() => process.exit(0));
    });
    process.stdin.once("end", () => {
      void shutdown();
    });
    return;
  }

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
