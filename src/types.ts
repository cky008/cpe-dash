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
}

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
