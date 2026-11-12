import type {
  AirplaneModeControlResponse,
  ApnControlResponse,
  ApnRequest,
  CellularEndpointResponse,
  DataLimitControlResponse,
  DataLimitRequest,
  NetworkMode,
  NetworkModeControlResponse,
  OperatorControlResponse,
  OperatorRequest,
  OperatorScanResponse,
  RoamingControlResponse,
  SimPinControlResponse,
  SimPinRequest,
  SimSlotControlResponse,
  SimSlotRef,
  TrafficResetResponse,
  UssdResponse,
  UssdSendRequest,
  AgentTestRequest,
  AgentTestResponse,
  AccessControlChangeResponse,
  AccessControlEndpointResponse,
  AlertsResponse,
  AntennaControlResponse,
  AntennaModeName,
  AuthLoginResponse,
  AuthLogoutResponse,
  AuditResponse,
  AuthStatusResponse,
  ConnectionTestResponse,
  ConsoleSettingsResponse,
  CreateTokenResponse,
  PairingCodeResponse,
  RevokeTokenResponse,
  SaveConnectionResponse,
  TelegramChatsResponse,
  TokenPermissionsResponse,
  TokensResponse,
  BandLockRequest,
  CellLockRequest,
  ContactDeleteResponse,
  ContactUpsertRequest,
  ContactUpsertResponse,
  DeviceProfileResponse,
  DeviceReportResponse,
  ExperimentalWriteRequest,
  ExperimentalWritesResponse,
  HealthResponse,
  LockStateResponse,
  MobileDataControlResponse,
  NeighborsEndpointResponse,
  RebootResponse,
  ReconnectResponse,
  ResetBreakerResponse,
  SecurityControlRequest,
  SecurityControlResponse,
  SessionStatusResponse,
  SettingsEndpointResponse,
  SettingsRefreshResponse,
  SmsContactsResponse,
  SmsCountriesResponse,
  SmsDeleteResponse,
  SmsPurgeResponse,
  SmsRestoreResponse,
  SmsTrashResponse,
  SmsPreviewRequest,
  SmsPreviewResponse,
  SmsReadRequest,
  SmsReadResponse,
  SmsSendRequest,
  SmsSendResponse,
  SmsStatusResponse,
  SmsSyncResponse,
  SmsThreadResponse,
  SmsThreadsResponse,
  TelemetryEndpointResponse,
  TelemetryRefreshResponse,
  TimeRuleRequest,
  TimeSeriesEndpointResponse,
  TopologyEndpointResponse,
  VcardImportResponse,
  Wifi7ControlRequest,
  Wifi7ControlResponse,
  WifiDeviceAccessRequest,
  WifiMacFilterRequest,
} from "../../../src/api-contract.ts";
import type { RouterFamilyChoice } from "../../../src/router-family.ts";
import type { BehaviourOverrides } from "../../../src/behaviour-settings.ts";
import type { TokenPermission } from "../../../src/console-policy.ts";
import type { ApiClient } from "./api.ts";

/**
 * Typed wrappers for every REST route of the contract. Writes wait out the daemon's queue and the
 * 90 s session hold budget; an SMS send also polls `send-status` (45 s by default) inside its session.
 */

const CONTROL_TIMEOUT_MS = 120_000;
/** A search for networks, or registering on one: the router itself may take three minutes, and the session waits its turn first. */
const SLOW_CONTROL_TIMEOUT_MS = 240_000;
const SMS_SEND_TIMEOUT_MS = 180_000;

export type ThreadFilter = "all" | "unread" | "otp";

/** A router connection to test or save; fields left out keep the stored values. */
export interface ConnectionInput {
  url?: string;
  /** The router's brand, or `"auto"` to have FengSui tell it before anything else is sent. */
  family?: RouterFamilyChoice;
  username?: string;
  password?: string;
  /** Spend the router's last login attempt deliberately. */
  lastAttempt?: boolean;
}

export function createEndpoints(api: ApiClient) {
  const control = { timeoutMs: CONTROL_TIMEOUT_MS };
  const slow = { timeoutMs: SLOW_CONTROL_TIMEOUT_MS };
  return {
    health: () => api.get<HealthResponse>("/api/health"),
    authStatus: () => api.get<AuthStatusResponse>("/api/auth/status"),
    login: (password: string) => api.post<AuthLoginResponse>("/api/auth/login", { password }),
    setupLogin: (code: string, password: string) => api.post<AuthLoginResponse>("/api/setup/login", { code, password }),
    resetLogin: (code: string, password: string) => api.post<AuthLoginResponse>("/api/auth/reset", { code, password }),
    consoleSettings: () => api.get<ConsoleSettingsResponse>("/api/console"),
    testConnection: (body: ConnectionInput) => api.post<ConnectionTestResponse>("/api/console/cpe/test", body, control),
    saveConnection: (body: ConnectionInput) => api.post<SaveConnectionResponse>("/api/console/cpe", body, control),
    confirmReview: () => api.post<ConsoleSettingsResponse>("/api/console/review"),
    changePassword: (current: string, next: string) => api.post<ConsoleSettingsResponse>("/api/console/password", { current, next }),
    tokens: () => api.get<TokensResponse>("/api/console/tokens"),
    createToken: (body: { name: string; permissions: TokenPermission[]; lifetimeDays: number | null }) => api.post<CreateTokenResponse>("/api/console/tokens", body),
    setTokenPermissions: (id: string, permissions: TokenPermission[]) => api.post<TokenPermissionsResponse>("/api/console/tokens/permissions", { id, permissions }),
    revokeToken: (id: string) => api.post<RevokeTokenResponse>("/api/console/tokens/revoke", { id }),
    pairingCode: (group: boolean) => api.post<PairingCodeResponse>("/api/console/telegram/pairing-code", { group }),
    unlinkTelegram: () => api.post<{ ok: true; unlinked: number }>("/api/console/telegram/unlink-all"),
    telegramChats: () => api.get<TelegramChatsResponse>("/api/console/telegram/chats"),
    unlinkTelegramChat: (chatId: string) => api.post<TelegramChatsResponse>("/api/console/telegram/unlink", { chatId }),
    consoleSwitches: (body: { telegramReset?: boolean; metricsEnabled?: boolean | null }) => api.post<ConsoleSettingsResponse>("/api/console/switches", body),
    consoleBehaviour: (body: BehaviourOverrides) => api.post<ConsoleSettingsResponse>("/api/console/behaviour", body),
    audit: (limit = 200) => api.get<AuditResponse>(`/api/audit?limit=${limit}`),
    deviceProfile: () => api.get<DeviceProfileResponse>("/api/device/profile"),
    deviceReport: () => api.get<DeviceReportResponse>("/api/console/device-report"),
    experimental: () => api.get<ExperimentalWritesResponse>("/api/console/experimental"),
    setExperimental: (body: ExperimentalWriteRequest) => api.post<ExperimentalWritesResponse>("/api/console/experimental", body),
    agentTest: (body: AgentTestRequest) => api.post<AgentTestResponse>("/api/console/agent-test", body),
    logout: () => api.post<AuthLogoutResponse>("/api/auth/logout"),

    telemetry: () => api.get<TelemetryEndpointResponse>("/api/telemetry"),
    refreshTelemetry: () => api.post<TelemetryRefreshResponse>("/api/telemetry/refresh", {}, control),
    sessionStatus: () => api.get<SessionStatusResponse>("/api/session/status"),
    timeseries: (query: string) => api.get<TimeSeriesEndpointResponse>(`/api/timeseries?${query}`),
    neighbors: () => api.get<NeighborsEndpointResponse>("/api/neighbors"),
    scanNeighbors: () => api.post<NeighborsEndpointResponse>("/api/neighbors/scan", {}, control),
    topology: () => api.get<TopologyEndpointResponse>("/api/topology"),
    refreshTopology: () => api.post<TopologyEndpointResponse>("/api/topology/refresh", {}, control),
    settings: () => api.get<SettingsEndpointResponse>("/api/settings"),
    refreshSettings: () => api.post<SettingsRefreshResponse>("/api/settings/refresh", {}, control),
    alerts: () => api.get<AlertsResponse>("/api/alerts"),

    bandLock: (body: BandLockRequest) => api.post<LockStateResponse>("/api/control/band-lock", body, control),
    cellLock: (body: CellLockRequest) => api.post<LockStateResponse>("/api/control/cell-lock", body, control),
    unlock: () => api.post<LockStateResponse>("/api/control/unlock", {}, control),
    reboot: () => api.post<RebootResponse>("/api/control/reboot", { confirm: true }, control),
    reconnect: () => api.post<ReconnectResponse>("/api/control/reconnect", { confirm: true }, control),
    security: (body: SecurityControlRequest) => api.post<SecurityControlResponse>("/api/control/security", body, control),
    wifi7: (body: Wifi7ControlRequest) => api.post<Wifi7ControlResponse>("/api/control/wifi7", body, control),
    antenna: (mode: AntennaModeName) => api.post<AntennaControlResponse>("/api/control/antenna", { mode }, control),
    mobileData: (enabled: boolean) => api.post<MobileDataControlResponse>("/api/control/mobile-data", { enabled }, control),
    resetBreaker: () => api.post<ResetBreakerResponse>("/api/session/reset-breaker", {}, control),

    // Cellular settings. A search for networks and a registration take the router minutes
    cellular: () => api.get<CellularEndpointResponse>("/api/cellular"),
    refreshCellular: () => api.post<CellularEndpointResponse>("/api/cellular/refresh", {}, control),
    networkMode: (mode: NetworkMode) => api.post<NetworkModeControlResponse>("/api/control/network-mode", { mode, confirm: true }, control),
    operatorScan: () => api.post<OperatorScanResponse>("/api/control/operator-scan", { confirm: true }, slow),
    operator: (body: Omit<Extract<OperatorRequest, { mode: "auto" }>, "confirm"> | Omit<Extract<OperatorRequest, { mode: "manual" }>, "confirm">) => api.post<OperatorControlResponse>("/api/control/operator", { ...body, confirm: true }, slow),
    simSlot: (slot: SimSlotRef) => api.post<SimSlotControlResponse>("/api/control/sim-slot", { kind: slot.kind, index: slot.index, confirm: true }, control),
    simPin: (action: NonNullable<SimPinRequest["action"]>, pin: string) => api.post<SimPinControlResponse>("/api/control/sim-pin", { action, pin, confirm: true }, control),
    airplaneMode: (enabled: boolean) => api.post<AirplaneModeControlResponse>("/api/control/airplane-mode", { enabled, confirm: true }, control),
    roaming: (enabled: boolean) => api.post<RoamingControlResponse>("/api/control/roaming", { enabled, confirm: true }, control),
    apn: (body: Omit<Extract<ApnRequest, { mode: "auto" }>, "confirm"> | Omit<Extract<ApnRequest, { mode: "manual" }>, "confirm">) => api.post<ApnControlResponse>("/api/control/apn", { ...body, confirm: true }, control),
    dataLimit: (body: Omit<DataLimitRequest, "confirm">) => api.post<DataLimitControlResponse>("/api/control/data-limit", { ...body, confirm: true }, control),
    trafficReset: () => api.post<TrafficResetResponse>("/api/control/traffic-reset", { confirm: true }, control),
    ussd: (body: Omit<Extract<UssdSendRequest, { code: string }>, "confirm"> | { action: "cancel" }) => api.post<UssdResponse>("/api/control/ussd", { ...body, confirm: true }, control),

    accessControl: () => api.get<AccessControlEndpointResponse>("/api/access-control"),
    refreshAccessControl: () => api.post<AccessControlEndpointResponse>("/api/access-control/refresh", {}, control),
    wifiAccess: (body: WifiDeviceAccessRequest) => api.post<AccessControlChangeResponse>("/api/control/wifi-access", body, control),
    wifiMacFilter: (body: WifiMacFilterRequest) => api.post<AccessControlChangeResponse>("/api/control/wifi-mac-filter", body, control),
    timeRule: (body: TimeRuleRequest) => api.post<AccessControlChangeResponse>("/api/control/time-rule", body, control),

    smsStatus: () => api.get<SmsStatusResponse>("/api/sms/status"),
    smsCountries: () => api.get<SmsCountriesResponse>("/api/sms/countries"),
    smsThreads: (filter: ThreadFilter, search: string, limit = 500) =>
      api.get<SmsThreadsResponse>(
        `/api/sms/threads?${new URLSearchParams({ filter, search: search.slice(0, 100), limit: String(limit) }).toString()}`
      ),
    smsThread: (key: string) => api.get<SmsThreadResponse>(`/api/sms/thread?${new URLSearchParams({ key }).toString()}`),
    smsContacts: (search = "", limit = 5000) =>
      api.get<SmsContactsResponse>(`/api/sms/contacts?${new URLSearchParams({ search: search.slice(0, 100), limit: String(limit) }).toString()}`),
    smsPreview: (body: SmsPreviewRequest) => api.post<SmsPreviewResponse>("/api/sms/preview", body),
    smsSend: (body: SmsSendRequest) => api.post<SmsSendResponse>("/api/sms/send", body, { timeoutMs: SMS_SEND_TIMEOUT_MS }),
    smsRead: (body: SmsReadRequest) => api.post<SmsReadResponse>("/api/sms/read", body, control),
    smsDelete: (uids: string[]) => api.post<SmsDeleteResponse>("/api/sms/delete", { uids }, control),
    smsTrash: () => api.get<SmsTrashResponse>("/api/sms/trash"),
    smsRestore: (uids: string[]) => api.post<SmsRestoreResponse>("/api/sms/trash/restore", { uids }),
    smsPurge: (body: { uids: string[] } | { all: true }) => api.post<SmsPurgeResponse>("/api/sms/trash/purge", body),
    smsSync: (mode: "full" | "incremental" = "full") => api.post<SmsSyncResponse>("/api/sms/sync", { mode }, control),
    contactUpsert: (body: ContactUpsertRequest) => api.post<ContactUpsertResponse>("/api/sms/contacts/upsert", body),
    contactDelete: (id: string) => api.post<ContactDeleteResponse>("/api/sms/contacts/delete", { id }),
    importVcf: (vcf: string) => api.post<VcardImportResponse>("/api/sms/contacts/import-vcf", { vcf }, { timeoutMs: 60_000 }),
  };
}

export type Endpoints = ReturnType<typeof createEndpoints>;
