export type EncryptionType = 1 | 2 | 3;

export type SupportedLocale = "zh-CN" | "en";

export interface AppConfig {
  cpeUrl: string;
  cpeUsername: string;
  cpePassword: string;
  dataEncryptionKey: string;
  apiToken: string;
  trustedProxies: string[];
  allowedHosts: string[];
  webEnabled: boolean;
  webPort: number;
  webHost: string;
  defaultLocale: SupportedLocale;
  mcpHttpEnabled: boolean;
  mcpAllowMutations: boolean;
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
  passwordType: string;
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
