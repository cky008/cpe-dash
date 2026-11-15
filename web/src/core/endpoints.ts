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
import type { RestOperation } from "../../../src/operations/registry.ts";
import { REST_ROUTES } from "../../../src/operations/routes.ts";
import type { ApiClient, RequestOptions } from "./api.ts";

/**
 * Typed wrappers for every REST route of the contract: the operation registry's routes by operation
 * name (their paths and methods come from `src/operations/routes.ts`), the console's own by path. Writes wait out the daemon's queue and the
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
  /** Trust the certificate with this SHA-256 fingerprint for the router (an HTTPS page with a certificate of its own). */
  certFingerprint?: string;
}

export function createEndpoints(api: ApiClient) {
  const control = { timeoutMs: CONTROL_TIMEOUT_MS };
  const slow = { timeoutMs: SLOW_CONTROL_TIMEOUT_MS };
  /**
   * A route of the operation registry: its method and path are the registry's, and a write carries
   * `confirm: true` (every write of the console follows its own confirmation or an explicit action of
   * yours). The console's own routes are written below.
   */
  const call = <T>(op: RestOperation, request: { body?: object; query?: string; options?: RequestOptions } = {}): Promise<T> => {
    const { method, path, write } = REST_ROUTES[op];
    const url = request.query === undefined ? path : `${path}?${request.query}`;
    if (method === "GET") return api.get<T>(url, request.options);
    return api.post<T>(url, write ? { ...request.body, confirm: true } : (request.body ?? {}), request.options);
  };
  return {
    health: () => call<HealthResponse>("health"),
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
    audit: (limit = 200) => call<AuditResponse>("audit", { query: `limit=${limit}` }),
    deviceProfile: () => call<DeviceProfileResponse>("deviceProfile"),
    deviceReport: () => api.get<DeviceReportResponse>("/api/console/device-report"),
    experimental: () => api.get<ExperimentalWritesResponse>("/api/console/experimental"),
    setExperimental: (body: ExperimentalWriteRequest) => api.post<ExperimentalWritesResponse>("/api/console/experimental", body),
    agentTest: (body: AgentTestRequest) => api.post<AgentTestResponse>("/api/console/agent-test", body),
    logout: () => api.post<AuthLogoutResponse>("/api/auth/logout"),

    telemetry: () => call<TelemetryEndpointResponse>("telemetry"),
    refreshTelemetry: () => call<TelemetryRefreshResponse>("telemetryRefresh", { body: {}, options: control }),
    sessionStatus: () => call<SessionStatusResponse>("sessionStatus"),
    timeseries: (query: string) => call<TimeSeriesEndpointResponse>("timeseries", { query }),
    neighbors: () => call<NeighborsEndpointResponse>("neighbors"),
    scanNeighbors: () => call<NeighborsEndpointResponse>("neighborsScan", { body: {}, options: control }),
    topology: () => call<TopologyEndpointResponse>("topology"),
    refreshTopology: () => call<TopologyEndpointResponse>("topologyRefresh", { body: {}, options: control }),
    settings: () => call<SettingsEndpointResponse>("settings"),
    refreshSettings: () => call<SettingsRefreshResponse>("settingsRefresh", { body: {}, options: control }),
    alerts: () => call<AlertsResponse>("alerts"),

    bandLock: (body: BandLockRequest) => call<LockStateResponse>("bandLock", { body, options: control }),
    cellLock: (body: CellLockRequest) => call<LockStateResponse>("cellLock", { body, options: control }),
    unlock: () => call<LockStateResponse>("unlock", { options: control }),
    reboot: () => call<RebootResponse>("reboot", { options: control }),
    reconnect: () => call<ReconnectResponse>("reconnect", { options: control }),
    security: (body: SecurityControlRequest) => call<SecurityControlResponse>("securitySwitches", { body, options: control }),
    wifi7: (body: Wifi7ControlRequest) => call<Wifi7ControlResponse>("wifi7", { body, options: control }),
    antenna: (mode: AntennaModeName) => call<AntennaControlResponse>("antenna", { body: { mode }, options: control }),
    mobileData: (enabled: boolean) => call<MobileDataControlResponse>("mobileData", { body: { enabled }, options: control }),
    resetBreaker: () => call<ResetBreakerResponse>("resetBreaker", { options: control }),

    // Cellular settings. A search for networks and a registration take the router minutes
    cellular: () => call<CellularEndpointResponse>("cellular"),
    refreshCellular: () => call<CellularEndpointResponse>("cellularRefresh", { body: {}, options: control }),
    networkMode: (mode: NetworkMode) => call<NetworkModeControlResponse>("networkMode", { body: { mode }, options: control }),
    operatorScan: () => call<OperatorScanResponse>("operatorScan", { options: slow }),
    operator: (body: Omit<Extract<OperatorRequest, { mode: "auto" }>, "confirm"> | Omit<Extract<OperatorRequest, { mode: "manual" }>, "confirm">) => call<OperatorControlResponse>("operatorSelect", { body, options: slow }),
    simSlot: (slot: SimSlotRef) => call<SimSlotControlResponse>("simSlot", { body: { kind: slot.kind, index: slot.index }, options: control }),
    simPin: (action: NonNullable<SimPinRequest["action"]>, pin: string) => call<SimPinControlResponse>("simPin", { body: { action, pin }, options: control }),
    airplaneMode: (enabled: boolean) => call<AirplaneModeControlResponse>("airplaneSwitch", { body: { enabled }, options: control }),
    roaming: (enabled: boolean) => call<RoamingControlResponse>("roaming", { body: { enabled }, options: control }),
    apn: (body: Omit<Extract<ApnRequest, { mode: "auto" }>, "confirm"> | Omit<Extract<ApnRequest, { mode: "manual" }>, "confirm">) => call<ApnControlResponse>("apn", { body, options: control }),
    dataLimit: (body: Omit<DataLimitRequest, "confirm">) => call<DataLimitControlResponse>("dataLimit", { body, options: control }),
    trafficReset: () => call<TrafficResetResponse>("trafficReset", { options: control }),
    ussd: (body: Omit<Extract<UssdSendRequest, { code: string }>, "confirm"> | { action: "cancel" }) => call<UssdResponse>("ussd", { body, options: control }),

    accessControl: () => call<AccessControlEndpointResponse>("accessControlView"),
    refreshAccessControl: () => call<AccessControlEndpointResponse>("accessControlRefresh", { body: {}, options: control }),
    wifiAccess: (body: WifiDeviceAccessRequest) => call<AccessControlChangeResponse>("wifiAccess", { body, options: control }),
    wifiMacFilter: (body: WifiMacFilterRequest) => call<AccessControlChangeResponse>("wifiMacFilter", { body, options: control }),
    timeRule: (body: TimeRuleRequest) => call<AccessControlChangeResponse>("timeRule", { body, options: control }),

    smsStatus: () => call<SmsStatusResponse>("smsStatus"),
    smsCountries: () => call<SmsCountriesResponse>("smsCountries"),
    smsThreads: (filter: ThreadFilter, search: string, limit = 500) =>
      call<SmsThreadsResponse>("smsThreads", { query: new URLSearchParams({ filter, search: search.slice(0, 100), limit: String(limit) }).toString() }),
    smsThread: (key: string) => call<SmsThreadResponse>("smsThread", { query: new URLSearchParams({ key }).toString() }),
    smsContacts: (search = "", limit = 5000) =>
      call<SmsContactsResponse>("contacts", { query: new URLSearchParams({ search: search.slice(0, 100), limit: String(limit) }).toString() }),
    smsPreview: (body: SmsPreviewRequest) => call<SmsPreviewResponse>("smsPreview", { body }),
    smsSend: (body: SmsSendRequest) => call<SmsSendResponse>("smsSend", { body, options: { timeoutMs: SMS_SEND_TIMEOUT_MS } }),
    smsRead: (body: SmsReadRequest) => call<SmsReadResponse>("smsMarkRead", { body, options: control }),
    smsDelete: (uids: string[]) => call<SmsDeleteResponse>("smsDelete", { body: { uids }, options: control }),
    smsTrash: () => call<SmsTrashResponse>("smsTrash"),
    smsRestore: (uids: string[]) => call<SmsRestoreResponse>("smsRestore", { body: { uids } }),
    smsPurge: (body: { uids: string[] } | { all: true }) => call<SmsPurgeResponse>("smsPurge", { body }),
    smsSync: (mode: "full" | "incremental" = "full") => call<SmsSyncResponse>("smsSync", { body: { mode }, options: control }),
    contactUpsert: (body: ContactUpsertRequest) => call<ContactUpsertResponse>("contactUpsert", { body }),
    contactDelete: (id: string) => call<ContactDeleteResponse>("contactDelete", { body: { id } }),
    importVcf: (vcf: string) => call<VcardImportResponse>("contactImport", { body: { vcf }, options: { timeoutMs: 60_000 } }),
  };
}

export type Endpoints = ReturnType<typeof createEndpoints>;
