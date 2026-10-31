import type {
  AccessControlChangeResponse,
  AccessControlEndpointResponse,
  AlertsResponse,
  AntennaControlResponse,
  AntennaModeName,
  AuthLoginResponse,
  AuthLogoutResponse,
  AuthStatusResponse,
  BandLockRequest,
  CellLockRequest,
  ContactDeleteResponse,
  ContactUpsertRequest,
  ContactUpsertResponse,
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
import type { ApiClient } from "./api.ts";

/**
 * Typed wrappers for every REST route of the contract. Writes wait out the daemon's queue and the
 * 90 s session hold budget; an SMS send also polls `send-status` (45 s by default) inside its session.
 */

const CONTROL_TIMEOUT_MS = 120_000;
const SMS_SEND_TIMEOUT_MS = 180_000;

export type ThreadFilter = "all" | "unread" | "otp";

export function createEndpoints(api: ApiClient) {
  const control = { timeoutMs: CONTROL_TIMEOUT_MS };
  return {
    health: () => api.get<HealthResponse>("/api/health"),
    authStatus: () => api.get<AuthStatusResponse>("/api/auth/status"),
    login: (token: string) => api.post<AuthLoginResponse>("/api/auth/login", { token }),
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
    smsSync: (mode: "full" | "incremental" = "full") => api.post<SmsSyncResponse>("/api/sms/sync", { mode }, control),
    contactUpsert: (body: ContactUpsertRequest) => api.post<ContactUpsertResponse>("/api/sms/contacts/upsert", body),
    contactDelete: (id: string) => api.post<ContactDeleteResponse>("/api/sms/contacts/delete", { id }),
    importVcf: (vcf: string) => api.post<VcardImportResponse>("/api/sms/contacts/import-vcf", { vcf }, { timeoutMs: 60_000 }),
  };
}

export type Endpoints = ReturnType<typeof createEndpoints>;
