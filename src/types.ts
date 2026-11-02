export type EncryptionType = 1 | 2 | 3;

export type SupportedLocale = "zh-CN" | "en";

export interface AppConfig {
  cpeUrl: string;
  cpeUsername: string;
  cpePassword: string;
  /**
   * Canonical IANA zone from `TZ` (e.g. `Europe/Dublin`), or `null` when unset. `.env` values never
   * reach `process.env` on their own, so the CLI applies it (it stamps the `<Date>` of sent SMS).
   */
  timeZone: string | null;
  dataEncryptionKey: string;
  apiToken: string;
  /** Optional Bearer token for reads only (REST GETs, read refreshes, SSE, read-only MCP tools); `""` = off. */
  apiTokenReadonly: string;
  trustedProxies: string[];
  allowedHosts: string[];
  webEnabled: boolean;
  webPort: number;
  webHost: string;
  defaultLocale: SupportedLocale;
  mcpHttpEnabled: boolean;
  mcpAllowMutations: boolean;
  /**
   * `MCP_ALLOW_ACCESS_CONTROL` (default `false`): expose the MCP tools that cut devices off (Wi-Fi
   * block / unblock, MAC filter changes, internet time rules). Reading the state is always available.
   */
  mcpAllowAccessControl: boolean;
  /**
   * The serve daemon's Streamable HTTP endpoint that `cpe-dash mcp` (the stdio bridge) forwards to:
   * `MCP_DAEMON_URL`, or `http://127.0.0.1:<WEB_PORT>/mcp` (the bound `WEB_HOST` when it is specific).
   */
  mcpDaemonUrl: string;
  /** Broadcast signed LAN beacons so a second daemon for the same CPE (another host) goes on standby. */
  peerDiscoveryEnabled: boolean;
  peerDiscoveryPort: number;
  sseHeartbeatMs: number;
  sseMaxClients: number;
  historyRetentionHours: number;
  stateFlushIntervalMs: number;
  rateLimitWindowMs: number;
  rateLimitMaxAuthFailures: number;
  sessionTtlMs: number;
  staticDir: string;
  redactSensitiveInApi: boolean;
  pollIntervalMs: number;
  neighborScanIntervalMs: number;
  requestTimeoutMs: number;
  respectBrowserSession: boolean;
  stateFile: string;
  cpeHarPath: string;
  smsEnabled: boolean;
  defaultCountryCode: string;
  smsFile: string;
  contactsFile: string;
  smsFullSyncIntervalMs: number;
  smsSeedExistingOnStart: boolean;
  smsAutoMarkRead: boolean;
  smsSendStatusTimeoutMs: number;
  telegramBotToken: string;
  telegramChatIds: string[];
  telegramApiBase: string;
  telegramStateFile: string;
  webhookUrl: string;
  webhookSecret: string;
  alertsEnabled: boolean;
  alertNotifyMinSeverity: "info" | "warning" | "critical";
  alertRsrpThresholdDbm: number;
  alertSinrThresholdDb: number;
  /**
   * `LOCK_ROLLBACK_AFTER_MIN` in ms (`0` = off, the default): clear every lock when the WAN is still
   * down this long after a band or cell lock (an automatic router write, so opt-in).
   */
  lockRollbackAfterMs: number;
  /**
   * `WAN_AUTO_RECONNECT_AFTER_MIN` in ms (`0` = off, the default): redial a WAN down this long, then
   * after 10 / 30 / 60 min, at most 4 times in 24 h; never a reboot.
   */
  wanReconnectAfterMs: number;
  /** `METRICS_ENABLED` (default `false`): serve `GET /metrics`; the console's switch overrides it. */
  metricsEnabled: boolean;
  /** Encrypted console settings (router connection, login, tokens), next to STATE_FILE. */
  settingsFile: string;
  /** Encrypted audit log, next to STATE_FILE. */
  auditFile: string;
  /** `none` hides SMS tools, `read` exposes read-only tools, `full` adds send / read / delete / contacts. */
  mcpSmsAccess: "none" | "read" | "full";
  /** `known`: MCP may only text contacts or numbers previously messaged; `any`: no recipient restriction. */
  mcpSmsSendPolicy: "known" | "any";
  mcpSmsSendLimitPerHour: number;
}

export interface EccSessionKeys {
  clientPubHex: string;
  shareKeyHex: string;
  privateHex: string;
}

export interface ScramProof {
  clientProofHex: string;
  expectedServerSig: string;
  serverKey: Buffer;
}

export interface ParsedXmlError {
  code: string;
  message: string;
  remainCount: number | null;
  waitTime: number | null;
}

export interface CpeLoginState {
  state: string;
  isLoggedInElsewhere: boolean;
  isLocked: boolean;
  remainWaitTime: number;
  /** `null` when the router names none. */
  passwordType: string | null;
  firstLogin: string;
}

export interface CircuitBreakerState {
  tripped: boolean;
  code: string | null;
  reason: string | null;
  trippedAtIso: string | null;
  remainCount?: number | null;
  waitTime?: number | null;
  passwordFingerprintHex?: string | null;
}

export type SessionExecutionOutcome<T> =
  | {
      status: "ok";
      value: T;
      holdMs: number;
    }
  | {
      status: "yielded";
      layer: 1 | 2;
      stateCode: string;
      messageZh: string;
      messageEn: string;
    };

export interface SessionTelemetry {
  lastSessionHoldMs: number | null;
  totalSessionsCompleted: number;
  browserYieldCount: number;
  circuitBreaker: CircuitBreakerState;
}

export interface FieldFormatObservation {
  tag: string;
  present: boolean;
  byteLength: number;
  encodingHint: "empty" | "decimal" | "hex" | "prefixed-hex" | "band-label" | "unit-value" | "text";
}
