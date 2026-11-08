#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AlertEngine } from "./alert-engine.ts";
import { AuditLog } from "./audit-log.ts";
import { ConsoleSettings, type RouterPasswordReuse, resetLoginProof } from "./console-settings.ts";
import { loadConfig } from "./config.ts";
import { type FengSuiCore, createFengSuiCore, stopFengSuiCore } from "./core.ts";
import { DEFAULT_SESSION_MAX_HOLD_MS, HuaweiCpeClient } from "./cpe-client.ts";
import type { CpeControlService } from "./cpe-controls.ts";
import type { CpeMonitor } from "./cpe-monitor.ts";
import { type FileLockHandle, StorageCipher, onStorageWriteFailure, quarantinedSince, tryAcquireFileLock } from "./encrypted-file.ts";
import { FengSuiHttpServer } from "./http-server.ts";
import { backupDataDir, formatDoctorReport, rekeyDataDir, restoreDataDir, runDoctor } from "./maintenance.ts";
import { AccessControlMcpTools } from "./mcp-access-tools.ts";
import { FengSuiMcpServer } from "./mcp-server.ts";
import { RuntimeSampler } from "./metrics.ts";
import { McpStdioBridge } from "./mcp-stdio-bridge.ts";
import { PeerDaemonGuard, type PeerTransport, createUdpPeerTransport } from "./peer-guard.ts";
import { t } from "./i18n.ts";
import { type NotificationChannel, NotificationHub } from "./notify/hub.ts";
import { TelegramApi } from "./notify/telegram-api.ts";
import { TelegramBot, TelegramStateStore } from "./notify/telegram-bot.ts";
import { WebhookNotifier } from "./notify/webhook.ts";
import type { ControlAuditEvent, MutexSessionScheduler } from "./scheduler.ts";
import { SELF_HEAL_OFF, WanSelfHeal } from "./self-heal.ts";
import { ContactBook } from "./sms/contacts.ts";
import { SmsMcpTools } from "./sms/mcp-tools.ts";
import { SmsMirrorStore } from "./sms/mirror.ts";
import { SmsService } from "./sms/service.ts";
import { SseEventBus } from "./sse-bus.ts";
import { EncryptedStateStore } from "./state-store.ts";
import { TimeSeriesRingBuffer } from "./timeseries.ts";
import type { AppConfig } from "./types.ts";

export type CliMode = "serve" | "mcp" | "doctor" | "backup" | "restore" | "rekey" | "reset-login" | "help";

export interface ParsedCliCommand {
  mode: CliMode;
  envPath?: string;
  /** `backup --out <dir>` */
  outDir?: string;
  /** `restore <backup dir>` */
  target?: string;
  /** `rekey --old-key-stdin`: read the previous DATA_ENCRYPTION_KEY from stdin instead of FENGSUI_OLD_DATA_KEY. */
  oldKeyStdin?: boolean;
  /** Notices for the user (e.g. deprecated flags), printed to stderr. */
  warnings: string[];
}

export function parseCliCommand(argv: ReadonlyArray<string>): ParsedCliCommand {
  const args = argv.slice(2);
  let mode: CliMode = "serve";
  let envPath: string | undefined;
  let outDir: string | undefined;
  let target: string | undefined;
  let oldKeyStdin = false;
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
    if (arg === "mcp" || arg === "doctor" || arg === "backup" || arg === "restore" || arg === "rekey" || arg === "reset-login") {
      mode = arg;
      continue;
    }
    if (arg === "--out" && mode === "backup" && typeof args[i + 1] === "string") {
      outDir = args[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--old-key-stdin" && mode === "rekey") {
      oldKeyStdin = true;
      continue;
    }
    if (mode === "restore" && target === undefined && !arg.startsWith("-")) {
      target = arg;
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
  if (mode === "restore" && target === undefined) throw new Error('"restore" needs the backup directory: cpe-dash restore <dir>');

  return { mode, envPath, warnings, ...(outDir ? { outDir } : {}), ...(target ? { target } : {}), ...(oldKeyStdin ? { oldKeyStdin } : {}) };
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
  /** `null` without a `peerTransport` (tests) or with PEER_DISCOVERY_ENABLED=false. */
  peerGuard: PeerDaemonGuard | null;
  alertEngine: AlertEngine | null;
  /** `null` unless LOCK_ROLLBACK_AFTER_MIN or WAN_AUTO_RECONNECT_AFTER_MIN is set. */
  selfHeal: WanSelfHeal | null;
  /** Router connection, console login and tokens (encrypted `settings.json`). */
  settings: ConsoleSettings;
  audit: AuditLog;
  /** No router connection yet: the background work waits for the console's setup. */
  awaitingSetup(): boolean;
  notificationHub: NotificationHub | null;
  telegramBot: TelegramBot | null;
  webhook: WebhookNotifier | null;
  /** Initialize the scheduler and start background work (polling, SMS sync, alerts, notifications). */
  start(): Promise<void>;
  /** Stop every subsystem in dependency order, flush encrypted stores and release the daemon lock. */
  close(): Promise<void>;
  /** `true` once `close()` began (a stop can arrive while `start()` is still running). */
  isClosed(): boolean;
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
  /** LAN beacon transport for the cross-host duplicate-daemon guard (the CLI passes UDP; omit to disable). */
  peerTransport?: PeerTransport;
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
      "DATA_ENCRYPTION_KEY must be set in .env (a long random string; setups from before v1.5.0 may key on CPE_PASSWORD instead): FengSui never stores its data unencrypted"
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
  // Stores loaded below move undecryptable files aside; anything moved from now on is reported
  const assemblyStartedMs = Date.now();

  const stateStore = new EncryptedStateStore({
    filePath: config.stateFile,
    encryptionKey: config.dataEncryptionKey,
  });

  const timeseries = new TimeSeriesRingBuffer({
    retentionHours: config.historyRetentionHours,
  });

  const cipher = new StorageCipher(config.dataEncryptionKey);
  // First start with this store: carry the .env setup over once; the console is authoritative after
  const settings = new ConsoleSettings({ filePath: config.settingsFile, cipher });
  if (!settings.load()) {
    settings.importFromEnv(config);
    void settings.flush().catch(() => undefined);
  }
  const audit = new AuditLog({ filePath: config.auditFile, cipher });
  audit.load();
  const connection = settings.cpe;

  const cpeClient = new HuaweiCpeClient({
    cpeUrl: connection?.url ?? config.cpeUrl,
    cpeUsername: connection?.username ?? config.cpeUsername,
    cpePassword: connection?.password ?? "",
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

  const core = createFengSuiCore({
    client: cpeClient,
    stateStore,
    timeseries,
    pollIntervalMs: config.pollIntervalMs,
    neighborScanIntervalMs: config.neighborScanIntervalMs,
    stateFlushIntervalMs: config.stateFlushIntervalMs,
    smsCountersEnabled: config.smsEnabled,
    allowLegacyLoginAfterScram: config.cpeAllowLegacyLoginAfterScram,
  });
  const { scheduler, monitor, controls } = core;
  // Restore the persisted breaker latch (and the time series) now: from here on any adapter can
  // queue a session, and none may spend a password attempt the latch already ruled out.
  monitor.init();

  // A save that fails (a full or read-only data volume, a UID change) keeps the change in memory only,
  // lost on restart unless a later save works: said once per file and cause an hour, in the log and
  // as a critical alert (whose own state.json save may fail too, which the same limit keeps quiet)
  const ownStores = new Set(
    [config.stateFile, config.smsFile, config.contactsFile, config.telegramStateFile, config.settingsFile, config.auditFile].map((file) => path.resolve(file))
  );
  const writeFailuresSaid = new Map<string, number>();
  let stopWriteFailureReports: (() => void) | null = null;
  const reportWriteFailure = (filePath: string, err: unknown): void => {
    if (!ownStores.has(path.resolve(filePath))) return;
    const file = path.basename(filePath);
    const reason = err && typeof err === "object" && "code" in err && typeof err.code === "string" ? err.code : "unknown error";
    const key = `${file}:${reason}`;
    const nowMs = Date.now();
    if (nowMs - (writeFailuresSaid.get(key) ?? Number.NEGATIVE_INFINITY) < 60 * 60_000) return;
    writeFailuresSaid.set(key, nowMs);
    log(`[fengsui] could not save ${file} (${reason}): the change stays in memory and is lost on restart unless a save works again; check the data volume's free space and permissions`);
    scheduler.raiseAlert({
      severity: "critical",
      code: "STORAGE_WRITE_FAILED",
      messageZh: t("zh-CN", "alerts.storage_write_failed", { file, reason }),
      messageEn: t("en", "alerts.storage_write_failed", { file, reason }),
    });
  };

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

  // Opt-in automatic router writes (lock rollback, WAN redial); off unless configured
  const selfHeal =
    config.lockRollbackAfterMs > 0 || config.wanReconnectAfterMs > 0
      ? new WanSelfHeal({
          scheduler,
          monitor,
          controls,
          lockRollbackAfterMs: config.lockRollbackAfterMs,
          reconnectAfterMs: config.wanReconnectAfterMs,
          log,
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
      authToken: "",
      linkSecret: (secret, where) => settings.decideTelegramLink(secret, where),
      issueResetCode: () => (settings.telegramReset ? settings.issueCode("reset") : null),
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

  // REST and SSE read it from the HTTP server's config, which reset-breaker reloads; MCP follows here
  let redactApiOutput = config.redactSensitiveInApi;
  const accessTools = new AccessControlMcpTools({
    core,
    allowWrites: config.mcpAllowAccessControl,
    redactSensitive: () => redactApiOutput,
  });
  const mcpServer = new FengSuiMcpServer({
    core,
    allowMutations: config.mcpAllowMutations,
    redactSensitive: () => redactApiOutput,
    selfHealStatus: () => selfHeal?.status() ?? SELF_HEAL_OFF,
    toolProviders: sms
      ? [
          accessTools,
          new SmsMcpTools({
            sms,
            access: config.mcpSmsAccess,
            sendPolicy: config.mcpSmsSendPolicy,
            sendLimitPerHour: config.mcpSmsSendLimitPerHour,
          }),
        ]
      : [accessTools],
  });

  // The owner's experimental writes (phase 3): only the current model's count, a router of another
  // model ends them for good (a router put back later needs a new consent), and so does a start with
  // no identification to match them against (state.json gone while settings.json stayed)
  const keepConsentsFor = (model: string | null): void => {
    if (settings.retainExperimentalFor(model ?? "") > 0) {
      const why = model === null ? "no router identified to match them against" : `the router is now ${model}`;
      audit.record({ action: "settings.experimental", outcome: "applied", detail: `all off: ${why}`, actor: { channel: "system" } });
    }
    scheduler.device.setConsents(settings.experimentalConsents);
  };
  keepConsentsFor(scheduler.device.current?.model ?? null);
  scheduler.on("device:model", keepConsentsFor);

  // Every write that reached the router queue, with the caller captured where it was requested
  scheduler.on("control:audit", (event: ControlAuditEvent) => {
    audit.record({ action: event.action, outcome: event.outcome, detail: event.detail, actor: event.actor });
  });

  let awaitingSetup = connection === null;
  let started = false;
  let closed = false;
  /**
   * Polling, SMS and Telegram: only once the router connection exists. `identify` reads who the router
   * is once (a low-priority session after the first polls, or right after the first read that gets in
   * when the start cannot); the setup's save already did, in its test.
   */
  const startBackground = async (identify: boolean): Promise<void> => {
    await telegramBot?.start();
    if (closed) return;
    sms?.start();
    monitor.start();
    if (identify) void monitor.identifyDevice().catch(() => undefined);
  };

  // The process's own memory, CPU and event-loop delay, for /metrics (watching it over weeks on a NAS)
  const runtime = new RuntimeSampler();
  const httpServer = new FengSuiHttpServer({
    config,
    core,
    sseBus,
    mcpServer,
    envPath,
    sms,
    notificationHub,
    settings,
    audit,
    unlinkTelegram: telegramBot ? () => telegramBot?.unlinkAllChats() ?? 0 : null,
    unlinkTelegramToken: telegramBot ? (tokenId: string) => telegramBot?.unlinkChatsLinkedBy(tokenId) ?? 0 : null,
    telegramChats: telegramBot ? () => telegramBot?.chatRecords((tokenId) => settings.listTokens().find((token) => token.id === tokenId)?.name ?? null) ?? [] : null,
    unlinkTelegramChat: telegramBot ? (chatId: string) => telegramBot?.unlinkChat(chatId) ?? false : null,
    telegramUsername: () => telegramBot?.username ?? null,
    runtimeSample: () => runtime.sample({ sseClients: sseBus.getClientCount(), telegramPending: telegramBot?.pendingNotifications ?? null }),
    selfHealStatus: () => selfHeal?.status() ?? SELF_HEAL_OFF,
    onConnectionReady: () => {
      if (!awaitingSetup) return;
      awaitingSetup = false;
      log("[fengsui] Router connection saved in the console: starting telemetry, SMS and Telegram");
      if (started && !closed) void startBackground(false);
    },
    onConfigReloaded: async (reloaded) => {
      if (options.applyTimeZone) applyProcessTimeZone(reloaded);
      redactApiOutput = reloaded.redactSensitiveInApi;
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
      const nextCipher = new StorageCipher(reloaded.dataEncryptionKey);
      settings.rotateEncryptionKey(nextCipher);
      audit.rotateEncryptionKey(nextCipher);
      rekeyed.push(settings.flush(), audit.flush());
      await Promise.allSettled(rekeyed);
    },
  });

  const peerGuard = options.peerTransport
    ? new PeerDaemonGuard({ secret: config.cpePassword, cpeHost: new URL(config.cpeUrl).hostname, transport: options.peerTransport })
    : null;
  if (peerGuard) {
    const raiseDuplicate = (key: "alerts.duplicate_daemon_standby" | "alerts.duplicate_daemon_leader", address: string): void => {
      scheduler.raiseAlert({
        severity: "critical",
        code: "DUPLICATE_DAEMON",
        messageZh: t("zh-CN", key, { address }),
        messageEn: t("en", key, { address }),
      });
    };
    peerGuard.on("standby", (leader: { address: string }) => {
      scheduler.setPeerStandby(leader.address);
      telegramBot?.setStandby(true);
      raiseDuplicate("alerts.duplicate_daemon_standby", leader.address);
    });
    peerGuard.on("peer", (event: { peer?: { address: string }; standby: boolean }) => {
      if (!event.standby && event.peer) raiseDuplicate("alerts.duplicate_daemon_leader", event.peer.address);
    });
    peerGuard.on("resume", () => {
      scheduler.setPeerStandby(null);
      telegramBot?.setStandby(false);
      scheduler.raiseAlert({
        severity: "info",
        code: "DUPLICATE_DAEMON_CLEARED",
        messageZh: t("zh-CN", "alerts.duplicate_daemon_cleared"),
        messageEn: t("en", "alerts.duplicate_daemon_cleared"),
      });
    });
  }

  // A store that could not decrypt its file starts empty: say so instead of losing contacts quietly
  const quarantined = [config.stateFile, config.smsFile, config.contactsFile, config.telegramStateFile].flatMap((file) =>
    quarantinedSince(file, assemblyStartedMs)
  );
  for (const name of quarantined) {
    log(
      `[fengsui] Warning: ${name} could not be decrypted with the current DATA_ENCRYPTION_KEY and was moved aside; its store starts empty. If CPE_PASSWORD changed while DATA_ENCRYPTION_KEY was unset, set DATA_ENCRYPTION_KEY to the previous password, rename the file back and restart.`
    );
  }

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
    peerGuard,
    alertEngine,
    selfHeal,
    settings,
    audit,
    awaitingSetup: () => awaitingSetup,
    notificationHub,
    telegramBot,
    webhook,
    async start(): Promise<void> {
      if (started) return;
      started = true;
      stopWriteFailureReports ??= onStorageWriteFailure(reportWriteFailure);
      monitor.init();
      sseBus.attachCore(core);
      if (sms) sseBus.attachSms(sms);
      sseBus.start();
      runtime.start();
      notificationHub?.start();
      alertEngine?.start();
      selfHeal?.start();
      if (quarantined.length > 0) {
        const files = quarantined.join(", ");
        scheduler.raiseAlert({
          severity: "critical",
          code: "DATA_QUARANTINED",
          messageZh: t("zh-CN", "alerts.data_quarantined", { files }),
          messageEn: t("en", "alerts.data_quarantined", { files }),
        });
      }
      if (peerGuard) {
        // Hear a running daemon's reply before the first CPE session, so a newcomer starts on standby
        peerGuard.start();
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      // A stop that arrived meanwhile wins: nothing may start polling or open a CPE session after it
      if (closed) return;
      if (!settings.loginConfigured) {
        log(`[fengsui] First start: open the web console and enter the setup code ${settings.issueCode("setup")} to choose the console password`);
      }
      if (awaitingSetup) {
        log("[fengsui] No router connection yet: the web console's setup asks for it (nothing logs in to the router until then)");
        return;
      }
      await startBackground(true);
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      // Every step is bounded so the whole shutdown fits docker stop's 10 s grace before SIGKILL:
      // nothing may wait for a CPE session before the scheduler has cancelled it.
      peerGuard?.stop();
      sseBus.stop();
      runtime.stop();
      const httpClosed = httpServer.close();
      await telegramBot?.stop();
      notificationHub?.stop();
      alertEngine?.stop();
      // No new automatic write starts; one in flight ends with the scheduler below
      const selfHealStopped = selfHeal?.stop();
      // Queued requests answer 503 now; the in-flight session gets its grace, is cancelled and logs out
      await stopFengSuiCore(core);
      await selfHealStopped;
      await telegramBot?.drain();
      await sms?.stop();
      await httpClosed;
      await telegramState?.flush().catch(() => undefined);
      await settings.flush().catch(() => undefined);
      await audit.flush().catch(() => undefined);
      stopWriteFailureReports?.();
      stopWriteFailureReports = null;
      daemonLock.release();
    },
    releaseLocks(): void {
      daemonLock.release();
    },
    isClosed(): boolean {
      return closed;
    },
  };
}

/**
 * Start the background work, then bind the HTTP port. Any failure (e.g. `EADDRINUSE`) closes the
 * stack in order before it propagates, so the process never exits with a CPE session open or the
 * Telegram poller running. Resolves the bound address, or `null` with `WEB_ENABLED=false`.
 */
export async function startServeDaemon(stack: FengSuiRuntimeStack): Promise<{ host: string; port: number } | null> {
  try {
    await stack.start();
    if (stack.isClosed() || !stack.config.webEnabled) return null;
    const bound = await stack.httpServer.listen();
    if (!stack.isClosed()) return bound;
    // Stopped while the port was being bound: close() found no server yet, so release it here
    await stack.httpServer.close(0);
    return null;
  } catch (err) {
    await stack.close().catch(() => undefined);
    throw err;
  }
}

/**
 * Notices for configuration that works but leaks or risks something, printed to stderr at startup:
 * a data key that falls back to CPE_PASSWORD, the saved router password still opening the console
 * (`reuse`, from the console store), and a switch meant to be on only for a while.
 */
export function startupNotices(
  config: Pick<AppConfig, "cpePassword" | "dataEncryptionKey"> & Partial<Pick<AppConfig, "cpeAllowLegacyLoginAfterScram">>,
  reuse: RouterPasswordReuse = { tokenName: null, login: false }
): string[] {
  const notices: string[] = [];
  if (config.cpePassword !== "" && config.dataEncryptionKey === config.cpePassword) {
    notices.push(
      "DATA_ENCRYPTION_KEY is not set, so the encrypted data is keyed to CPE_PASSWORD in .env: keep that value even though the router password is now managed in the console. Move to a dedicated key with `cpe-dash rekey`; restarting with a different key instead leaves the files unreadable (quarantined as *.unreadable-<timestamp>)."
    );
  }
  if (reuse.tokenName !== null) {
    notices.push(
      `The router's admin password is also the token "${reuse.tokenName}" (imported from .env), so it sits in the config of every REST and MCP client that uses it and links Telegram chats with /auth. Create a token for those clients in Settings → Tokens, then revoke "${reuse.tokenName}" there.`
    );
  }
  if (reuse.login) {
    notices.push("The console password is the router's admin password: whoever knows one knows the other. Choose another one in Settings → Password.");
  }
  if (config.cpeAllowLegacyLoginAfterScram === true) {
    notices.push(
      "CPE_ALLOW_LEGACY_LOGIN_AFTER_SCRAM=true: a connection test in the console may send the password the legacy way to a router that has logged in with SCRAM, which costs one of its login attempts if it is still that router. Use it only to set up a router that replaced it at the same address, and set it back to false once the new one is saved."
    );
  }
  return notices;
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
    "  cpe-dash doctor [--env <path>]    Offline self-check: config, data directory, stores, running daemon",
    "  cpe-dash backup [--out <dir>]     Copy the encrypted stores with a checksum manifest (daemon may run)",
    "  cpe-dash restore <dir>            Put a backup back (daemon stopped; replaced files are kept)",
    "  cpe-dash rekey [--old-key-stdin]  Re-encrypt under the current DATA_ENCRYPTION_KEY and recover copies",
    "                                    moved aside after a key change (old key: FENGSUI_OLD_DATA_KEY or stdin)",
    "  cpe-dash reset-login              Forgot the console password: get a one-time reset code from the",
    "                                    daemon running on this host (proves access to its .env)",
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

/**
 * `cpe-dash reset-login`: ask the daemon on this host for a one-time console reset code. The request
 * goes to loopback and carries an HMAC of the data key, so only someone who can read this `.env`
 * (a shell on the NAS or in the container) gets a code.
 */
export async function runResetLogin(
  config: AppConfig,
  opts: { fetchImpl?: typeof fetch; write?: (line: string) => void; now?: () => number } = {}
): Promise<number> {
  const write = opts.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  if (!config.dataEncryptionKey) {
    write("✗ DATA_ENCRYPTION_KEY (or CPE_PASSWORD) is empty in .env: there is nothing to prove access with");
    return 1;
  }
  try {
    const res = await (opts.fetchImpl ?? fetch)(`http://127.0.0.1:${config.webPort}/api/setup/reset-code`, {
      method: "POST",
      headers: { "X-FengSui-Proof": resetLoginProof(config.dataEncryptionKey, (opts.now ?? Date.now)()) },
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
    const body = (await res.json()) as { code?: unknown };
    if (!res.ok || typeof body.code !== "string") {
      write(`✗ the daemon refused (HTTP ${res.status}); run this on the daemon's host with its .env`);
      return 1;
    }
    write(`Reset code: ${body.code} (valid 15 minutes, once). On the console's sign-in page choose "Forgot password", enter it and set a new password.`);
    return 0;
  } catch (err) {
    write(`✗ no daemon answered on 127.0.0.1:${config.webPort}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

/** First line of a stream (the old key piped into `rekey --old-key-stdin`). */
async function readFirstLine(input: AsyncIterable<Buffer | string>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of input) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8").split(/\r?\n/)[0]?.trim() ?? "";
}

/** `doctor` / `backup` / `restore` / `rekey`; resolves the exit code. None of them talks to the CPE. */
export async function runMaintenance(
  cmd: ParsedCliCommand,
  write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  stdin: AsyncIterable<Buffer | string> = process.stdin
): Promise<number> {
  let config: AppConfig;
  try {
    config = loadConfig({ envPath: cmd.envPath });
  } catch (err) {
    write(`✗ configuration: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  try {
    if (cmd.mode === "doctor") {
      const checks = await runDoctor(config, { notices: startupNotices(config) });
      write(formatDoctorReport(checks));
      return checks.some((c) => c.level === "error") ? 1 : 0;
    }
    if (cmd.mode === "backup") {
      const { dir, manifest } = backupDataDir(config, { outDir: cmd.outDir });
      write(`Backed up ${manifest.files.map((f) => f.name).join(", ") || "nothing (no data yet)"} to ${dir}`);
      return 0;
    }
    if (cmd.mode === "restore") {
      const { restored, movedAside } = restoreDataDir(config, cmd.target ?? "");
      write(`Restored ${restored.join(", ")}${movedAside.length > 0 ? `; previous files kept as ${movedAside.join(", ")}` : ""}`);
      return 0;
    }
    const oldKey = cmd.oldKeyStdin ? await readFirstLine(stdin) : (process.env["FENGSUI_OLD_DATA_KEY"] ?? "");
    if (!oldKey) {
      write("✗ rekey needs the previous DATA_ENCRYPTION_KEY (or the old CPE_PASSWORD if it was unset): set FENGSUI_OLD_DATA_KEY or pipe it with --old-key-stdin");
      return 1;
    }
    const results = rekeyDataDir(config, oldKey);
    for (const r of results) write(`${r.action === "not-decryptable" ? "✗" : "✓"} ${r.name}: ${r.action}${r.source ? ` (from ${r.source})` : ""}`);
    return results.some((r) => r.action === "not-decryptable") ? 1 : 0;
  } catch (err) {
    write(`✗ ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
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

  if (cmd.mode === "reset-login") {
    process.exitCode = await runResetLogin(loadConfig({ envPath: cmd.envPath }));
    return;
  }

  if (cmd.mode === "doctor" || cmd.mode === "backup" || cmd.mode === "restore" || cmd.mode === "rekey") {
    process.exitCode = await runMaintenance(cmd);
    return;
  }

  const config = loadConfig({ envPath: cmd.envPath });
  applyProcessTimeZone(config);
  const stack = createFengSuiRuntime({
    config,
    envPath: cmd.envPath,
    applyTimeZone: true,
    peerTransport: config.peerDiscoveryEnabled ? createUdpPeerTransport({ port: config.peerDiscoveryPort }) : undefined,
  });
  // `exit` listeners run synchronously (also after uncaught errors); graceful paths use close()
  process.once("exit", () => stack.releaseLocks());

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write(`[fengsui] Received ${signal}, flushing encrypted state and closing server...\n`);
    await stack.close();
    process.exit(0);
  };
  // Registered before startup: a docker stop during startup must still log out of the CPE and flush
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  const boundAddress = await startServeDaemon(stack);
  if (shuttingDown) return;
  for (const notice of startupNotices(config, await stack.settings.routerPasswordReuse())) process.stderr.write(`[fengsui] Notice: ${notice}\n`);
  const smsSummary = stack.sms ? `sms=on (mirror ${stack.sms.mirror.size} messages)` : "sms=off (SMS_ENABLED=false)";

  // `serve` daemon mode
  if (boundAddress) {
    process.stdout.write(
      `[fengsui] HTTP + SSE + MCP server listening on http://${boundAddress.host}:${boundAddress.port} (cpe=${config.cpeUrl}, poll=${config.pollIntervalMs}ms, mcpHttp=${config.mcpHttpEnabled})\n`
    );
  } else {
    process.stdout.write(
      `[fengsui] Background telemetry daemon started with WEB_ENABLED=false (cpe=${config.cpeUrl}, poll=${config.pollIntervalMs}ms)\n`
    );
  }
  process.stdout.write(
    `[fengsui] ${smsSummary}, alerts=${stack.alertEngine ? "on" : "off"}, telegram=${stack.telegramBot ? "on" : "off"}, webhook=${stack.webhook ? "on" : "off"}, lockRollback=${config.lockRollbackAfterMs > 0 ? `${config.lockRollbackAfterMs / 60_000}min` : "off"}, wanReconnect=${config.wanReconnectAfterMs > 0 ? `${config.wanReconnectAfterMs / 60_000}min` : "off"}\n`
  );
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
