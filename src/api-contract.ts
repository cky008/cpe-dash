/**
 * REST and SSE payload types of `docs/PHASE2_BACKEND_CONTRACT.md`, composed from the domain types the
 * daemon already produces. The HTTP routes check their response bodies against these types
 * (`satisfies`), and the web dashboard imports the same declarations, so a field renamed on one side
 * fails to compile on the other. Type-only module: it emits nothing at runtime.
 */
import type { AccessControlSnapshot, TimeRulesState } from "./access-control.ts";
import type { MacFilterEntry, TimeRule, TimeRuleInput, WifiFilterMode, WifiFilterPolicy, WifiMacFilterState } from "./access-plan.ts";
import type { AlertEventRecord } from "./state-store.ts";
import type { BehaviourReport } from "./behaviour-settings.ts";
import type { TokenPermission } from "./console-policy.ts";
import type {
  AntennaModeName,
  FirewallSwitchState,
  GlobalTelemetrySnapshot,
  LockVerification,
  NeighborScanSnapshot,
  PersistedLockState,
  RouterSettingsSnapshot,
  TerminalTopologySnapshot,
} from "./cpe-domain.ts";
import type { SpeedTickPayload } from "./cpe-monitor.ts";
import type { ChannelDeliveryStats } from "./notify/hub.ts";
import type { AuditEntry } from "./audit-log.ts";
import type {
  ApiErrorSnapshot,
  ApiErrorStat,
  DeviceCapabilities,
  DeviceFeature,
  DeviceIdentity,
  DeviceProbePath,
  DeviceProfile,
  DeviceReport,
  DeviceReportEndpoint,
  DeviceReportWrite,
  EndpointProbe,
  EndpointState,
  FeatureCapability,
  FieldShape,
  LoginScheme,
  ProbeOrigin,
  StructureKind,
  TokenFlow,
} from "./device-profile.ts";
import type { DeviceVerification } from "./firmware.ts";
import type {
  DeviceAccessSnapshot,
  FeatureWriteAccess,
  ReadCapability,
  ReadSection,
  ReadState,
  ReadbackOutcome,
  ReadbackReason,
  WriteAccess,
  WriteCheck,
  WriteFeature,
  WriteFeatureState,
  WriteResultRecord,
} from "./device-access.ts";
import type { ExperimentalConsent, PublicTokenRecord } from "./console-settings.ts";
import type { AgentTestFeature, AgentTestPlan, AgentTestSetting, AgentTestStatus, AgentTestTokenChoice, AgentTestView } from "./agent-test.ts";
import type { AvoidanceBroadcastPayload, ConnectionTestResult, ControlAppliedEvent, SchedulerStatusSnapshot } from "./scheduler.ts";
import type { SelfHealStatus } from "./self-heal-status.ts";
import type { VcardImportSummary } from "./sms/contacts.ts";
import type {
  SmsSendPreview,
  SmsSentEvent,
  SmsStatusSnapshot,
  SmsSyncSummary,
  SmsUpdatedEvent,
} from "./sms/service.ts";
import type {
  ContactRecord,
  CountryDialInfo,
  DeletedSmsMessage,
  EnrichedSmsMessage,
  SenderInfo,
  SmsSendResult,
  SmsThreadDetail,
  SmsThreadSummary,
} from "./sms/types.ts";
import type { TimeSeriesQueryResult } from "./timeseries.ts";
import type { CircuitBreakerState, SupportedLocale } from "./types.ts";

export type {
  AccessControlSnapshot,
  AlertEventRecord,
  AntennaModeName,
  FirewallSwitchState,
  AvoidanceBroadcastPayload,
  ChannelDeliveryStats,
  CircuitBreakerState,
  ContactRecord,
  ControlAppliedEvent,
  CountryDialInfo,
  DeletedSmsMessage,
  EnrichedSmsMessage,
  GlobalTelemetrySnapshot,
  LockVerification,
  MacFilterEntry,
  NeighborScanSnapshot,
  PersistedLockState,
  RouterSettingsSnapshot,
  SchedulerStatusSnapshot,
  SenderInfo,
  SmsSendPreview,
  SmsSendResult,
  SmsSentEvent,
  SmsStatusSnapshot,
  SmsSyncSummary,
  SmsThreadDetail,
  SmsThreadSummary,
  SmsUpdatedEvent,
  SpeedTickPayload,
  SupportedLocale,
  TerminalTopologySnapshot,
  TimeRule,
  TimeRuleInput,
  TimeRulesState,
  VcardImportSummary,
  WifiFilterMode,
  WifiFilterPolicy,
  WifiMacFilterState,
};
export type { AgentTestFeature, AgentTestPlan, AgentTestSetting, AgentTestStatus, AgentTestTokenChoice, AgentTestView };
export type {
  ApiErrorSnapshot,
  ApiErrorStat,
  DeviceAccessSnapshot,
  ExperimentalConsent,
  FeatureWriteAccess,
  ReadCapability,
  ReadSection,
  ReadState,
  ReadbackOutcome,
  ReadbackReason,
  WriteAccess,
  WriteCheck,
  WriteFeature,
  WriteFeatureState,
  WriteResultRecord,
  DeviceCapabilities,
  DeviceFeature,
  DeviceIdentity,
  DeviceProbePath,
  DeviceProfile,
  DeviceReport,
  DeviceReportEndpoint,
  DeviceReportWrite,
  DeviceVerification,
  EndpointProbe,
  EndpointState,
  FeatureCapability,
  FieldShape,
  LoginScheme,
  ProbeOrigin,
  StructureKind,
  TokenFlow,
};
export type { NeighborCellEntry, TerminalAccessMedium, TerminalHostEntry } from "./parsers.ts";
export type { SchedulerMode } from "./scheduler.ts";
export type { TimeSeriesBucketPoint, TimeSeriesPreset } from "./timeseries.ts";

// ── Errors (§1.4) ────────────────────────────────────────────────────────────

export type ApiErrorCode =
  | "MISDIRECTED_HOST"
  | "BAD_URL"
  | "METHOD_NOT_ALLOWED"
  | "CSRF_REJECTED"
  | "UNAUTHORIZED"
  | "RATE_LIMITED"
  | "NOT_FOUND"
  | "SMS_DISABLED"
  | "LOCALE_NOT_FOUND"
  | "INTERNAL_ERROR"
  | "BAD_PAYLOAD"
  | "VALIDATION_ERROR"
  | "BROWSER_SESSION_YIELDED"
  | "PEER_DAEMON_ACTIVE"
  | "QUEUE_FULL"
  | "CIRCUIT_BREAKER_OPEN"
  | "CPE_UPSTREAM_ERROR"
  | "SMS_SEND_FAILED"
  | "SSE_LIMIT_REACHED"
  | "READ_ONLY_TOKEN"
  | "TOKEN_NOT_PERMITTED"         // 403: the token lacks the permission this request needs (`permission`; v1.8.0)
  | "CONSOLE_ONLY"                // 403: /api/console/* with a Bearer token (credentials change only from a console session)
  | "CPE_NOT_CONFIGURED"          // 409: no router connection yet (finish the setup in the console)
  | "DEVICE_UNVERIFIED_READ_ONLY" // 409: the router is a model FengSui was not verified on and this write is not open there (nothing was sent)
  | "DEVICE_NOT_IDENTIFIED"       // 409: the write's own session could not read the router's model; nothing was written
  | "EXPERIMENTAL_UNAVAILABLE"    // 409: an experimental write that cannot be turned on for this router (see `state`)
  | "AGENT_TEST_UNAVAILABLE"      // 409: the router has no experimental write for an AI agent's test (a verified model, or none identified)
  | "ALREADY_SET_UP"              // 409: /api/setup/login after the console password was set
  | "WRONG_PASSWORD"              // 403: the current console password did not match
  | "CPE_TEST_FAILED"             // 400: the new router connection did not log in; nothing was saved
  | "TELEGRAM_DISABLED"           // 409: a pairing code without TELEGRAM_BOT_TOKEN
  | "MCP_DISABLED"
  | "FORBIDDEN_ORIGIN"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "STATIC_ROOT_NOT_FOUND"
  | "ASSET_NOT_FOUND"
  | "BAD_PATH"
  | "PATH_TRAVERSAL_BLOCKED"
  | "SYMLINK_ESCAPE_BLOCKED";

/** Every non-2xx body outside `/mcp`'s JSON-RPC errors. */
export interface ApiErrorEnvelope {
  ok: false;
  errorCode: ApiErrorCode;
  message: string;
  /** Only `409 BROWSER_SESSION_YIELDED`. */
  messageEn?: string;
  /** Only `409 DEVICE_UNVERIFIED_READ_ONLY` and `409 DEVICE_NOT_IDENTIFIED` (`message` is English there). */
  messageZh?: string;
  /** Only `409 DEVICE_UNVERIFIED_READ_ONLY`: the router's model (`?` when it is not plain text). */
  model?: string;
  /** Only `409 DEVICE_UNVERIFIED_READ_ONLY`: the feature the refused write belongs to. */
  feature?: DeviceFeature;
  /** Only `429 RATE_LIMITED`. */
  retryAfterSec?: number;
  /** Only `403 TOKEN_NOT_PERMITTED`: the permission the token lacks (`all`: a change that needs every permission). */
  permission?: TokenPermission | "all";
  /** Only `409 BROWSER_SESSION_YIELDED`. */
  avoidance?: AvoidanceBroadcastPayload;
  /** Only `409 PEER_DAEMON_ACTIVE`. */
  peerAddress?: string | null;
  /** Only `423 CIRCUIT_BREAKER_OPEN`. */
  circuitBreaker?: CircuitBreakerState;
  /** Only `502 SMS_SEND_FAILED`. */
  result?: SmsSendResult;
  /** Only `502 SMS_SEND_FAILED`. */
  resolvedPhones?: string[];
  /** Only `400 CPE_TEST_FAILED`: why the router connection did not log in. */
  connectionTest?: ConnectionTestResult;
  /** Only `409 EXPERIMENTAL_UNAVAILABLE`: what the feature is on this router (verified, not implemented, unsupported, unknown). */
  state?: WriteFeatureState;
}

// ── Public, auth and i18n (§2.1) ─────────────────────────────────────────────

export interface HealthResponse {
  ok: true;
  service: "cpe-dash";
  codename: "FengSui";
  version: string;
  uptimeSec: number;
}

export interface LocaleCatalogResponse {
  ok: true;
  locale: SupportedLocale;
  catalog: Record<string, unknown>;
}

export interface AuthStatusResponse {
  ok: true;
  authenticated: boolean;
  locale: SupportedLocale;
  /** No console password yet (a fresh install): the login page shows the first-time setup. */
  setupRequired: boolean;
}

/** `GET /api/console` (console session only): what the console manages instead of `.env`. */
export interface ConsoleSettingsResponse {
  ok: true;
  /** The router connection; the password itself is never sent back. */
  cpe: { url: string; username: string; passwordSet: boolean } | null;
  login: { changedAtIso: string | null; fromEnv: boolean };
  /** Imported from `.env` on upgrade and not yet confirmed in the guided check. */
  reviewPending: boolean;
  telegram: { configured: boolean; resetEnabled: boolean };
  /** `/metrics`: the effective switch, who set it, and what `.env` (METRICS_ENABLED) says. */
  metrics: { enabled: boolean; source: "console" | "env"; envEnabled: boolean };
  /** AI master switches, self-healing, alerts and SMS behaviour: each value in force, who set it, and `.env`'s. */
  behaviour: BehaviourReport;
}

/** `POST /api/console/cpe/test` (and the `result` of a refused `POST /api/console/cpe`). */
export interface ConnectionTestResponse {
  ok: true;
  result: ConnectionTestResult;
}

export interface SaveConnectionResponse {
  ok: true;
  result: ConnectionTestResult;
  settings: ConsoleSettingsResponse;
}

export interface TokensResponse {
  ok: true;
  tokens: PublicTokenRecord[];
}

/** `POST /api/console/tokens`: the token is shown this once; only its hash is kept. */
export interface CreateTokenResponse {
  ok: true;
  token: string;
  record: PublicTokenRecord;
}

export interface RevokeTokenResponse {
  ok: true;
  record: PublicTokenRecord;
}

/** `POST /api/console/tokens/permissions`: the token with its new permissions (its value is unchanged). */
export interface TokenPermissionsResponse {
  ok: true;
  record: PublicTokenRecord;
}

export interface PairingCodeResponse {
  ok: true;
  code: string;
  expiresInSec: number;
  /** A group pairing code (it also links a group; the request said `{ group: true }`). */
  group: boolean;
  /** The exact message to send: `/auth CODE`, or `/auth@bot CODE` for a group once the bot's name is known. */
  command: string;
}

/** A Telegram chat that gets the bot's notifications and may use its commands (Settings → Telegram). */
export interface TelegramChatRecord {
  chatId: string;
  /** Telegram gives private chats positive IDs and groups negative ones. */
  kind: "private" | "group";
  /** Listed in TELEGRAM_CHAT_IDS: authorized by `.env`, so only editing `.env` removes it. */
  fromEnv: boolean;
  /** How `/auth` linked it: a full-access token, a pairing code in a private chat, a group pairing code; `null` when only `.env` authorizes it. */
  linkedWith: "token" | "code" | "group-code" | null;
  /** The token that linked it (revoking that token unlinks the chat). */
  tokenName: string | null;
  /** A group linked with a group code: the member who linked it, the only one who may act there. */
  linkedBy: string | null;
  /** A group linked with a group code: the forum topic it posts to (`null`: the group itself, or General). */
  topic: number | null;
  /** When `/auth` linked it (`null` for a chat only `.env` authorizes). */
  linkedAtIso: string | null;
}

/** `GET /api/console/telegram/chats`, and `POST /api/console/telegram/unlink` with the list that is left. */
export interface TelegramChatsResponse {
  ok: true;
  /** Chats linked with `/auth`, newest first, then those only TELEGRAM_CHAT_IDS authorizes, in its order. */
  chats: TelegramChatRecord[];
}

export interface AuditResponse {
  ok: true;
  entries: AuditEntry[];
}

export interface AuthLoginResponse {
  ok: true;
  authenticated: true;
  expiresAtIso: string;
}

export interface AuthLogoutResponse {
  ok: true;
  authenticated: false;
}

// ── Device identity and capabilities (§2.9) ──────────────────────────────────

/**
 * `GET /api/device/profile` (any signed-in caller): the router's identity, verification and
 * capabilities from the last probe (daemon start or a console test of the router in use), `null`
 * before the first one, and the builds FengSui was verified on.
 */
export interface DeviceProfileResponse {
  ok: true;
  profile: DeviceProfile | null;
  verifiedFirmware: Array<{ model: string; softwareVersion: string }>;
}

/**
 * `GET` / `POST /api/console/experimental` (console session only; multi-model phase 3): what each write
 * is on this router (`device.features`) and the experimental writes its owner turned on for this model.
 */
export interface ExperimentalWritesResponse {
  ok: true;
  device: DeviceAccessSnapshot;
  consents: ExperimentalConsent[];
  /** The last generic writes (oldest first): endpoints, router code and read-back, never a value written. */
  writes: WriteResultRecord[];
  /** The AI agent test at one click: the one in progress, and what starting it would turn on now. */
  agentTest: AgentTestStatus;
}

/**
 * `POST /api/console/agent-test` (console session only): `start` turns on what `agentTest.plan` lists for
 * the router's `model` as the console showed it, SMS too with `sms: true`, and gives `tokenId` (one of
 * the plan's tokens; `null`: none) what the test needs; `end` puts back what the test turned on; `ack`
 * reads its reminder (`alertId`: the reminder alert the console showed).
 */
export type AgentTestRequest =
  | { action: "start"; model: string; tokenId?: string | null; sms?: boolean }
  | { action: "end" }
  | { action: "ack"; alertId?: string };

/** `POST /api/console/agent-test`: the experimental writes and the test after the change, and the settings (the switches may have changed). */
export interface AgentTestResponse extends ExperimentalWritesResponse {
  settings: ConsoleSettingsResponse;
}

/** `POST /api/console/experimental`: turn one experimental write on (typing the router's model) or off. */
export interface ExperimentalWriteRequest {
  feature: WriteFeature;
  enabled: boolean;
  /** Required to turn one on: the router's model as the console shows it (case and surrounding spaces aside). */
  model?: string;
}

/**
 * `GET /api/console/device-report` (console session only): the desensitized device report. Structure
 * only, values just for the allowlist; the user decides whether to share it. Nothing is uploaded.
 */
export interface DeviceReportResponse {
  ok: true;
  report: DeviceReport;
}

// ── Telemetry, history, neighbors, topology, settings (§2.2–2.3) ─────────────

export interface TelemetryEndpointResponse {
  ok: true;
  schedulerStatus: SchedulerStatusSnapshot;
  lockState: PersistedLockState;
  lockVerification: LockVerification;
  telemetry: GlobalTelemetrySnapshot | null;
  recentAlerts: ReadonlyArray<AlertEventRecord>;
}

export interface TelemetryRefreshResponse {
  ok: true;
  schedulerStatus: SchedulerStatusSnapshot;
  telemetry: GlobalTelemetrySnapshot | null;
}

export interface SessionStatusResponse {
  ok: true;
  status: SchedulerStatusSnapshot;
  /** What WAN self-healing will do next (both parts off: `afterMin` is `null`). */
  selfHeal: SelfHealStatus;
}

export type TimeSeriesEndpointResponse = { ok: true } & TimeSeriesQueryResult;

export interface NeighborsEndpointResponse {
  ok: true;
  schedulerStatus: SchedulerStatusSnapshot;
  neighbors: NeighborScanSnapshot | null;
}

export interface TopologyEndpointResponse {
  ok: true;
  schedulerStatus: SchedulerStatusSnapshot;
  topology: TerminalTopologySnapshot | null;
}

export interface SettingsEndpointResponse {
  ok: true;
  schedulerStatus: SchedulerStatusSnapshot;
  lockState: PersistedLockState;
  lockVerification: LockVerification;
  settings: RouterSettingsSnapshot | null;
}

export interface SettingsRefreshResponse {
  ok: true;
  schedulerStatus: SchedulerStatusSnapshot;
  settings: RouterSettingsSnapshot | null;
}

export interface AlertsResponse {
  ok: true;
  alerts: ReadonlyArray<AlertEventRecord>;
  notifications: Record<string, ChannelDeliveryStats> | null;
}

// ── Controls (§2.4) ──────────────────────────────────────────────────────────

/** `band-lock`, `cell-lock` and `unlock`. */
export interface LockStateResponse {
  ok: true;
  lockState: PersistedLockState;
}

export interface RebootResponse {
  ok: true;
  rebooting: true;
  requestedAtIso: string;
}

export interface ReconnectResponse {
  ok: true;
  reconnecting: true;
  requestedAtIso: string;
}

export interface SecurityControlResponse {
  ok: true;
  settings: RouterSettingsSnapshot | null;
}

export interface Wifi7ControlResponse {
  ok: true;
  wifi7: { mloEnable: boolean; dbhoEnable: boolean };
}

export interface AntennaControlResponse {
  ok: true;
  antenna: { mode: AntennaModeName; rawCode: number };
}

export interface MobileDataControlResponse {
  ok: true;
  mobileDataEnabled: boolean;
}

/** Devices the access-control writes refuse to cut off, as seen for this caller. */
export interface AccessGuardInfo {
  /** The machine running FengSui (`IsLocalDevice` in HostInfo); `null` before the first topology read. */
  daemonHostMac: string | null;
  /** The caller's own device when its address is a LAN host; `null` behind a proxy or Tailscale. */
  requesterMac: string | null;
}

export interface AccessControlEndpointResponse {
  ok: true;
  schedulerStatus: SchedulerStatusSnapshot;
  accessControl: AccessControlSnapshot | null;
  guard: AccessGuardInfo;
}

export interface AccessControlChangeResponse {
  ok: true;
  accessControl: AccessControlSnapshot | null;
  /** `false` when the router already was in the requested state (nothing written). */
  changed: boolean;
  /** Other devices the change cut off (stored blacklist entries, Wi-Fi devices left off a whitelist). */
  alsoBlocked: string[];
}

export interface ResetBreakerResponse {
  ok: true;
  circuitBreaker: CircuitBreakerState;
  status: SchedulerStatusSnapshot;
}

// ── SMS and contacts (§2.5) ──────────────────────────────────────────────────

export interface SmsStatusResponse {
  ok: true;
  status: SmsStatusSnapshot;
}

export interface SmsCountriesResponse {
  ok: true;
  /** `DEFAULT_COUNTRY_CODE`, else the SIM's country; `""` while neither is known (a number without `+` is refused). */
  defaultCountryCode: string;
  countries: ReadonlyArray<CountryDialInfo>;
}

export interface SmsThreadsResponse {
  ok: true;
  threads: SmsThreadSummary[];
  status: SmsStatusSnapshot;
}

export interface SmsThreadResponse {
  ok: true;
  thread: SmsThreadDetail;
}

export interface SmsContactsResponse {
  ok: true;
  total: number;
  contacts: ContactRecord[];
}

export interface SmsPreviewResponse {
  ok: true;
  preview: SmsSendPreview;
}

export interface SmsSendResponse {
  ok: true;
  result: SmsSendResult;
  resolvedPhones: string[];
  messages: EnrichedSmsMessage[];
}

export interface SmsReadResponse {
  ok: true;
  count: number;
  uids: string[];
}

export interface SmsDeleteResponse {
  ok: true;
  deleted: number;
  uids: string[];
  /** Days FengSui keeps them in Recently deleted (`0`: deleted for good). */
  trashDays: number;
}

/** `GET /api/sms/trash`: Recently deleted, the newest deletion first. */
export interface SmsTrashResponse {
  ok: true;
  messages: DeletedSmsMessage[];
  trashDays: number;
}

export interface SmsRestoreResponse {
  ok: true;
  restored: number;
  uids: string[];
}

export interface SmsPurgeResponse {
  ok: true;
  purged: number;
  uids: string[];
}

export interface SmsSyncResponse {
  ok: true;
  summary: SmsSyncSummary | null;
  status: SmsStatusSnapshot;
}

export interface ContactUpsertResponse {
  ok: true;
  contact: ContactRecord;
}

export interface ContactDeleteResponse {
  ok: true;
  deleted: boolean;
}

export interface VcardImportResponse {
  ok: true;
  summary: VcardImportSummary;
}

// ── Request bodies (§2.4–2.5; the daemon re-validates every field) ──────────

export interface BandLockRequest {
  lteBands?: Array<string | number> | "all";
  nrBands?: Array<string | number> | "all";
}

export interface CellLockRequest {
  rat: "LTE" | "NR";
  band: string | number;
  arfcn: number;
  /** Omitted or `null`: lock the frequency (`lock_mode=1`). */
  pci?: number | null;
}

export interface SecurityControlRequest {
  upnpEnabled?: boolean;
  dmz?: { enabled: boolean; ipAddress?: string };
  firewall?: Partial<FirewallSwitchState>;
}

export interface Wifi7ControlRequest {
  mloEnable?: boolean;
  dbhoEnable?: boolean;
}

export interface WifiDeviceAccessRequest {
  action: "block" | "unblock";
  macAddress: string;
  name?: string;
  confirm: true;
}

/** `mode` (with optional `entries`) switches the filter; otherwise `add` / `remove` edit the active list. */
export interface WifiMacFilterRequest {
  mode?: WifiFilterMode;
  entries?: MacFilterEntry[];
  add?: MacFilterEntry[];
  remove?: string[];
  confirm: true;
}

export interface TimeRuleRequest {
  action: "create" | "update" | "delete";
  id?: string;
  rule?: TimeRuleInput;
  confirm: true;
}

export interface SmsPreviewRequest {
  phone?: string;
  content: string;
  countryCode?: string;
}

export interface SmsSendRequest {
  phone?: string;
  phones?: string[];
  content: string;
  countryCode?: string;
}

export interface SmsReadRequest {
  uids?: string[];
  threadKey?: string;
}

export interface ContactUpsertRequest {
  phone: string;
  name: string;
  note?: string;
}

// ── `/api/events` (§3) ───────────────────────────────────────────────────────

export interface SseHelloPayload {
  clientId: string;
  connectedAtIso: string;
  heartbeatMs: number;
  schedulerStatus: SchedulerStatusSnapshot;
  avoidance: AvoidanceBroadcastPayload;
  telemetry: GlobalTelemetrySnapshot | null;
  lockState: PersistedLockState;
  lockVerification: LockVerification;
  sms: SmsStatusSnapshot | null;
}

/** The first frame of every `/api/events` stream, minus the per-connection fields the bus adds. */
export type SseInitialSnapshot = Omit<SseHelloPayload, "clientId" | "connectedAtIso" | "heartbeatMs">;

/** `event:` name → `data:` payload of every named `/api/events` frame. */
export interface SseEventPayloads {
  hello: SseHelloPayload;
  speed: SpeedTickPayload;
  telemetry: GlobalTelemetrySnapshot;
  neighbors: NeighborScanSnapshot;
  topology: TerminalTopologySnapshot;
  settings: RouterSettingsSnapshot;
  "access-control": AccessControlSnapshot;
  "session:avoidance": AvoidanceBroadcastPayload;
  "control:applied": ControlAppliedEvent;
  alert: AlertEventRecord;
  "sms:new": EnrichedSmsMessage;
  "sms:sent": SmsSentEvent;
  "sms:updated": SmsUpdatedEvent;
  "sms:sync": SmsSyncSummary;
  "sms:status": SmsStatusSnapshot;
  "contacts:updated": { total: number };
}
