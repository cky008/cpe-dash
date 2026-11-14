import path from "node:path";
import { AgentTestService } from "./agent-test-service.ts";
import { AlertEngine } from "./alert-engine.ts";
import { AuditLog } from "./audit-log.ts";
import { type BehaviourValues, behaviourFromConfig, resolveBehaviour } from "./behaviour-settings.ts";
import { ConsoleSettings, type ScryptCost } from "./console-settings.ts";
import { type FengSuiCore, createFengSuiCore, stopFengSuiCore } from "./core.ts";
import type { CpeControlService } from "./cpe-controls.ts";
import type { CpeMonitor } from "./cpe-monitor.ts";
import { StorageCipher, onStorageWriteFailure, quarantinedSince } from "./encrypted-file.ts";
import { FengSuiApi } from "./http-api.ts";
import { t } from "./i18n.ts";
import { type NotificationChannel, NotificationHub } from "./notify/hub.ts";
import { TelegramApi } from "./notify/telegram-api.ts";
import { TelegramBot, TelegramStateStore } from "./notify/telegram-bot.ts";
import { WebhookNotifier } from "./notify/webhook.ts";
import type { ControlAuditEvent, MutexSessionScheduler } from "./scheduler.ts";
import { DEFAULT_SESSION_MAX_HOLD_MS } from "./session-errors.ts";
import { WanSelfHeal } from "./self-heal.ts";
import { SELF_HEAL_OFF, type SelfHealStatus } from "./self-heal-status.ts";
import { ContactBook } from "./sms/contacts.ts";
import { SmsMirrorStore } from "./sms/mirror.ts";
import { dialCodeFromImsi } from "./sms/phone.ts";
import { SmsService, type SmsUpdatedEvent } from "./sms/service.ts";
import { SseEventBus } from "./sse-bus.ts";
import { EncryptedStateStore } from "./state-store.ts";
import { TimeSeriesRingBuffer } from "./timeseries.ts";
import type { AppConfig } from "./types.ts";

/**
 * FengSui's services and how they are wired to each other, apart from the process that runs them:
 * the console settings, the audit log, the core (scheduler, monitor, controls), SMS, alerts, self-
 * healing, the AI agent test, Telegram, the notification hub, the event bus and the REST API behind
 * the sign-in, with the audit of every write, the default country code, the behaviour settings and
 * self-healing's watch on risky writes. The serve daemon (src/cli.ts) adds the process around them
 * (the data directory's lock, the duplicate-daemon guard, MCP, the HTTP server, process figures); the
 * live demo assembles the same services in a page (web/src/demo/runtime.ts), so neither wires its own.
 */

/** How long one router session may hold the admin slot: an SMS send polls send-status inside its session, so the budget must outlast that poll. */
export function sessionHoldBudgetMs(config: Pick<AppConfig, "smsSendStatusTimeoutMs">): number {
  return Math.max(DEFAULT_SESSION_MAX_HOLD_MS, config.smsSendStatusTimeoutMs + 30_000);
}

/** Every store of the data directory (encrypted under DATA_ENCRYPTION_KEY). */
export function storeFiles(config: AppConfig): string[] {
  return [config.stateFile, config.smsFile, config.contactsFile, config.telegramStateFile, config.settingsFile, config.auditFile];
}

export interface ServicesOptions {
  /** The stores are encrypted under its DATA_ENCRYPTION_KEY; without one they are plain JSON (tests, the live demo). */
  config: AppConfig;
  /** CPE transport (tests and the demo inject their mock router here). */
  fetchImpl?: typeof fetch;
  /** Transport for Telegram and webhooks (defaults to global `fetch`). */
  notifyFetchImpl?: typeof fetch;
  log?: (line: string) => void;
  /**
   * `/api/session/reset-breaker` first re-reads the process's configuration (the daemon's `.env`, which
   * then calls `applyConfig`). Absent: there is none to re-read.
   */
  reloadConfig?: (() => Promise<void>) | null;
  /** The console password's scrypt cost (the console store's default when absent). */
  scryptCost?: ScryptCost;
}

export interface FengSuiServices {
  readonly config: AppConfig;
  readonly stateStore: EncryptedStateStore;
  readonly timeseries: TimeSeriesRingBuffer;
  readonly core: FengSuiCore;
  readonly scheduler: MutexSessionScheduler;
  readonly monitor: CpeMonitor;
  readonly controls: CpeControlService;
  readonly sseBus: SseEventBus;
  /** `null` when SMS_ENABLED=false. */
  readonly sms: SmsService | null;
  readonly alertEngine: AlertEngine;
  readonly selfHeal: WanSelfHeal;
  readonly agentTest: AgentTestService;
  /** Router connection, console login and tokens (`settings.json`). */
  readonly settings: ConsoleSettings;
  readonly audit: AuditLog;
  readonly notificationHub: NotificationHub | null;
  readonly telegramBot: TelegramBot | null;
  readonly telegramState: TelegramStateStore | null;
  readonly webhook: WebhookNotifier | null;
  /** The REST API behind the sign-in. */
  readonly api: FengSuiApi;
  /** Stores that could not be decrypted when they were loaded, moved aside (file names). */
  readonly quarantined: ReadonlyArray<string>;
  /** The behaviour settings in force: the console's choice, else `.env`. */
  behaviour(): BehaviourValues;
  /** What WAN self-healing will do next. */
  selfHealStatus(): SelfHealStatus;
  /** No router connection yet: the background work waits for the console's setup. */
  awaitingSetup(): boolean;
  /** A configuration reloaded from `.env`: the behaviour it names, and every store re-encrypted under its key. */
  applyConfig(reloaded: AppConfig): Promise<void>;
  /** The services that need no router: the event bus, alerts, self-healing, the agent test's reminders, notifications. */
  start(): void;
  /** Polling, SMS and Telegram; `identify` reads who the router is once. Nothing starts once `close` began. */
  startBackground(identify: boolean): Promise<void>;
  /**
   * Stop in dependency order and flush the stores. `closeTransport` (the HTTP server) starts closing once
   * the event bus is stopped and is awaited before the stores are flushed.
   */
  close(closeTransport?: () => Promise<void>): Promise<void>;
}

export function assembleServices(options: ServicesOptions): FengSuiServices {
  const { config, fetchImpl } = options;
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

  const cipher = StorageCipher.fromSecret(config.dataEncryptionKey);
  // First start with this store: carry the .env setup over once; the console is authoritative after
  const settings = new ConsoleSettings({ filePath: config.settingsFile, cipher, ...(options.scryptCost ? { scryptCost: options.scryptCost } : {}) });
  if (!settings.load()) {
    settings.importFromEnv(config);
    void settings.flush().catch(() => undefined);
  }
  const audit = new AuditLog({ filePath: config.auditFile, cipher });
  audit.load();
  const connection = settings.cpe;

  // Two processes long-polling one Telegram bot token fight over getUpdates (HTTP 409); the daemon
  // lock guarantees this is the only poller on this data directory.
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
    // No connection saved yet: the address of .env and no password, so nothing logs in until the console's setup
    connection: {
      cpeUrl: connection?.url ?? config.cpeUrl,
      cpeUsername: connection?.username ?? config.cpeUsername,
      cpePassword: connection?.password ?? "",
      requestTimeoutMs: config.requestTimeoutMs,
      respectBrowserSession: config.respectBrowserSession,
      requireEccSignature: config.cpeRequireEccSignature,
      ...(fetchImpl !== undefined ? { fetchImpl } : {}),
      sessionMaxHoldMs: sessionHoldBudgetMs(config),
    },
    stateStore,
    timeseries,
    // The router's family as the console saved it (absent: Huawei): the brand whose driver reads and writes it
    family: connection?.family,
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
  const ownStores = new Set(storeFiles(config).map((file) => path.resolve(file)));
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

  // AI master switches, self-healing, alerts and SMS behaviour: the console's choice, else `.env`. Every part
  // reads them per use, so a change in Settings applies at once (see applyBehaviour below)
  let envBehaviour: BehaviourValues = behaviourFromConfig(config);
  let behaviour: BehaviourValues = resolveBehaviour(envBehaviour, settings.behaviourOverrides);

  // SMS's default country: the console's or DEFAULT_COUNTRY_CODE, else the SIM's (from the telemetry saved
  // last time, then live), else none, and a number typed without + is refused rather than sent to a guessed country
  const simCountry = (): string => dialCodeFromImsi(monitor.getCachedTelemetry()?.device.imsi ?? "") ?? "";
  let countryCode = behaviour.defaultCountryCode || simCountry();
  let sms: SmsService | null = null;
  if (config.smsEnabled) {
    const contacts = new ContactBook({
      filePath: config.contactsFile,
      cipher,
      defaultCountryCode: countryCode,
    });
    const mirror = new SmsMirrorStore({
      filePath: config.smsFile,
      cipher,
      defaultCountryCode: countryCode,
      contacts,
    });
    contacts.load();
    mirror.load();
    sms = new SmsService({
      scheduler,
      monitor,
      mirror,
      contacts,
      defaultCountryCode: countryCode,
      fullSyncIntervalMs: config.smsFullSyncIntervalMs,
      seedExistingOnStart: config.smsSeedExistingOnStart,
      autoMarkRead: () => behaviour.smsAutoMarkRead,
      trashDays: () => behaviour.smsTrashDays,
      sendStatusTimeoutMs: config.smsSendStatusTimeoutMs,
    });
    // Restoring from Recently deleted and deleting for good touch no router, so they are audited here (counts only)
    sms.on("sms:updated", (event: SmsUpdatedEvent) => {
      const count = `${event.uids.length} message${event.uids.length === 1 ? "" : "s"}`;
      if (event.action === "restored") audit.record({ action: "sms.restore", outcome: "applied", detail: count });
      else if (event.action === "purged") audit.record({ action: "sms.purge", outcome: "applied", detail: event.expired ? `${count}, kept the set number of days` : count, ...(event.expired ? { actor: { channel: "system" } } : {}) });
    });
  }
  // While no country is set: the first read of the SIM (or a SIM from another country) sets it; a missing
  // or masked IMSI keeps the last one
  monitor.on("telemetry", () => {
    if (behaviour.defaultCountryCode) return;
    const fromSim = simCountry();
    if (!fromSim || fromSim === countryCode) return;
    countryCode = fromSim;
    sms?.setDefaultCountryCode(fromSim);
  });

  const alertEngine = new AlertEngine({
    scheduler,
    monitor,
    controls,
    enabled: () => behaviour.alertsEnabled,
    rsrpThresholdDbm: () => behaviour.alertRsrpThresholdDbm,
    sinrThresholdDb: () => behaviour.alertSinrThresholdDb,
    batteryLowPercent: config.alertBatteryLowPercent,
  });

  // Opt-in automatic router writes (lock rollback, WAN redial); off unless turned on
  const selfHeal = new WanSelfHeal({
    scheduler,
    monitor,
    controls,
    lockRollbackAfterMs: () => behaviour.lockRollbackAfterMin * 60_000,
    reconnectAfterMs: () => behaviour.wanReconnectAfterMin * 60_000,
    log,
  });
  const selfHealStatus = (): SelfHealStatus => (selfHeal.enabled ? selfHeal.status() : SELF_HEAL_OFF);

  // A band or cell lock on a router nobody verified is watched whoever asked for it, and undone if the WAN stays down
  controls.onExperimentalLock = (change) => selfHeal.guardExperimentalLock(change);
  // A changed SIM slot, network mode, operator or access point is watched the same way, on any router
  controls.onLinkChange = (notice) => selfHeal.guardLinkChange(notice);

  /** Settings changed in the console (or `.env` reloaded): what reads them per use needs nothing; these act now. */
  const applyBehaviour = (next: BehaviourValues): void => {
    behaviour = next;
    selfHeal.reconfigure();
    // A shorter time in Recently deleted applies to what is already there
    sms?.purgeExpiredTrash();
    const code = behaviour.defaultCountryCode || simCountry();
    if (code && code !== countryCode) {
      countryCode = code;
      sms?.setDefaultCountryCode(code);
    }
  };

  const sseBus = new SseEventBus({
    heartbeatMs: config.sseHeartbeatMs,
    maxClients: config.sseMaxClients,
  });

  // The AI agent test at one click (Settings → Device): it turns on what the test needs, puts it back at
  // the end, and reminds the owner while something it turned on stays on
  const agentTest = new AgentTestService({
    settings,
    scheduler,
    audit,
    behaviourFromEnv: () => envBehaviour,
    smsEnabled: sms !== null,
    smsAbilities: () => sms?.abilities ?? null,
    onBehaviourChanged: applyBehaviour,
    // A token allowed (or no longer allowed) to change the router reconnects its event streams
    onTokenChanged: (tokenId) => sseBus.disconnectByTokenId(tokenId),
  });

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
      acknowledgeAgentTest: () => agentTest.acknowledge(),
      allowedChatIds: config.telegramChatIds,
      locale: config.defaultLocale,
      defaultCountryCode: () => countryCode,
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
          alertMinSeverity: () => behaviour.alertNotifyMinSeverity,
          log,
        })
      : null;

  // The writes the owner turned off on a router nobody verified. Each entry names its model and the
  // gate counts only those of the router in use, so a router of another model starts with every
  // implemented write on, and one put back later is as its owner left it
  scheduler.device.setDisabledWrites(settings.disabledWrites);

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

  // The REST API behind the sign-in; the daemon's HTTP server (or the demo's page) hands it each request
  const api = new FengSuiApi({
    core,
    settings,
    sseBus,
    sms,
    audit,
    notificationHub,
    selfHealStatus,
    agentTest,
    metricsFromEnv: config.metricsEnabled,
    behaviourFromEnv: () => envBehaviour,
    onBehaviourChanged: applyBehaviour,
    onConnectionReady: () => {
      if (!awaitingSetup) return;
      awaitingSetup = false;
      log("[fengsui] Router connection saved in the console: starting telemetry, SMS and Telegram");
      if (started && !closed) void startBackground(false);
    },
    unlinkTelegram: telegramBot ? () => telegramBot?.unlinkAllChats() ?? 0 : null,
    unlinkTelegramToken: telegramBot ? (tokenId: string) => telegramBot?.unlinkChatsLinkedBy(tokenId) ?? 0 : null,
    telegramChats: telegramBot ? () => telegramBot?.chatRecords((tokenId) => settings.listTokens().find((token) => token.id === tokenId)?.name ?? null) ?? [] : null,
    unlinkTelegramChat: telegramBot ? (chatId: string) => telegramBot?.unlinkChat(chatId) ?? false : null,
    telegramUsername: () => telegramBot?.username ?? null,
    reloadConfig: options.reloadConfig ?? null,
  });

  // A store that could not decrypt its file starts empty: say so instead of losing contacts quietly (or the
  // console's settings, which would otherwise look like a fresh install)
  const quarantined = storeFiles(config).flatMap((file) => quarantinedSince(file, assemblyStartedMs));
  for (const name of quarantined) {
    log(
      `[fengsui] Warning: ${name} could not be decrypted with the current DATA_ENCRYPTION_KEY (written under another key, damaged, or stored without encryption) and was moved aside; its store starts empty. cpe-dash doctor says which; cpe-dash rekey brings it back (the backup page of the guide shows how).`
    );
  }

  return {
    config,
    stateStore,
    timeseries,
    core,
    scheduler,
    monitor,
    controls,
    sseBus,
    sms,
    alertEngine,
    selfHeal,
    agentTest,
    settings,
    audit,
    notificationHub,
    telegramBot,
    telegramState,
    webhook,
    api,
    quarantined,
    behaviour: () => behaviour,
    selfHealStatus,
    awaitingSetup: () => awaitingSetup,
    async applyConfig(reloaded: AppConfig): Promise<void> {
      stateStore.rotateEncryptionKey(reloaded.dataEncryptionKey);
      // Re-encrypt now rather than at the next periodic flush (up to 30 min away), so a crash in
      // between cannot leave state.json under a key the reloaded .env no longer provides.
      await stateStore.flushAsync().catch(() => undefined);
      envBehaviour = behaviourFromConfig(reloaded);
      applyBehaviour(resolveBehaviour(envBehaviour, settings.behaviourOverrides));
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
    start(): void {
      if (started) return;
      started = true;
      stopWriteFailureReports ??= onStorageWriteFailure(reportWriteFailure);
      monitor.init();
      sseBus.attachCore(core);
      if (sms) sseBus.attachSms(sms);
      sseBus.start();
      notificationHub?.start();
      alertEngine.start();
      selfHeal.start();
      agentTest.start();
      if (quarantined.length > 0) {
        const files = quarantined.join(", ");
        scheduler.raiseAlert({
          severity: "critical",
          code: "DATA_QUARANTINED",
          messageZh: t("zh-CN", "alerts.data_quarantined", { files }),
          messageEn: t("en", "alerts.data_quarantined", { files }),
        });
      }
    },
    startBackground,
    async close(closeTransport?: () => Promise<void>): Promise<void> {
      if (closed) return;
      closed = true;
      // Every step is bounded so the whole shutdown fits docker stop's 10 s grace before SIGKILL:
      // nothing may wait for a CPE session before the scheduler has cancelled it.
      sseBus.stop();
      const transportClosed = closeTransport?.();
      await telegramBot?.stop();
      notificationHub?.stop();
      alertEngine.stop();
      agentTest.stop();
      // No new automatic write starts; one in flight ends with the scheduler below
      const selfHealStopped = selfHeal.stop();
      // Queued requests answer 503 now; the in-flight session gets its grace, is cancelled and logs out
      await stopFengSuiCore(core);
      await selfHealStopped;
      await telegramBot?.drain();
      await sms?.stop();
      await transportClosed;
      await telegramState?.flush().catch(() => undefined);
      await settings.flush().catch(() => undefined);
      await audit.flush().catch(() => undefined);
      stopWriteFailureReports?.();
      stopWriteFailureReports = null;
    },
  };
}
