/**
 * The capability registry: every feature FengSui has, one record each. A feature's name is the one
 * `VERIFIED_FEATURES`, the device report's `checks` and the console's switches use; every list of
 * features (the write gate's, the Supported devices table's columns, the report's, the console's, the
 * agent test's) is worked out from here, and a brand's facts (`src/router-family.ts`) name only
 * features recorded here. What a brand implements, and who verified what on which model, are not
 * part of a feature: they stay with the brand's facts and with the reports (`src/firmware.ts`).
 *
 * The records follow the table's columns: a column's features stand together, the columns in the
 * table's order, and every list of features keeps that order.
 *
 * Zero dependencies: the daemon, the web console and the static demo share it.
 */

/** The parts of a router FengSui reads, each in a session of its own (the poll, the sweeps, settings, SMS). */
export const READ_SECTIONS = ["telemetry", "neighbors", "topology", "settings", "accessControl", "sms"] as const;
export type ReadSection = (typeof READ_SECTIONS)[number];

/** The columns of the Supported devices table, in its order, as the table and Settings → Device name them. */
const COLUMNS = [
  { id: "signal", zh: "信号与流量", en: "Signal & traffic" },
  { id: "neighbors", zh: "附近的基站", en: "Nearby cells" },
  { id: "devices", zh: "已连接设备", en: "Connected devices" },
  { id: "sms", zh: "短信", en: "SMS" },
  { id: "bandLock", zh: "锁频段", en: "Band lock" },
  { id: "cellLock", zh: "锁小区", en: "Cell lock" },
  { id: "restart", zh: "重启与重拨", en: "Reboot & redial" },
  { id: "mobileData", zh: "移动数据", en: "Mobile data" },
  { id: "switches", zh: "路由器开关", en: "Router switches" },
  { id: "access", zh: "访问控制", en: "Access control" },
  { id: "battery", zh: "电池", en: "Battery" },
  { id: "sim", zh: "SIM 卡", en: "SIM card" },
  { id: "airplane", zh: "飞行模式", en: "Airplane mode" },
  { id: "network", zh: "网络制式与选网", en: "Network mode & operator" },
  { id: "data", zh: "数据设置", en: "Data settings" },
  { id: "ussd", zh: "USSD", en: "USSD" },
] as const;

export type FeatureColumnId = (typeof COLUMNS)[number]["id"];

interface FeatureRecordBase {
  /** The Supported devices table's column it is marked in. */
  column: FeatureColumnId;
  /** How the notes under the table name it, in a column of several features. */
  part?: { zh: string; en: string };
}

export interface ReadFeatureRecord extends FeatureRecordBase {
  access: "read";
  /**
   * Where it is read: in the session of one read section, or `status`, the router's status the 5 s poll
   * reads besides the signal. The status reads came after the H168-383 was verified, and some routers
   * lack the hardware (a CPE has no battery): each is verified only by a report of its own.
   */
  read: ReadSection | "status";
}

export interface WriteFeatureRecord extends FeatureRecordBase {
  access: "write";
  /**
   * The router writes the scheduler runs that are filed under it, FengSui's own included (an unlock or
   * redial it does on its own, putting a setting back after the WAN stayed down): turning the feature
   * off turns them off.
   */
  actions: readonly [string, ...string[]];
  /**
   * A cellular setting (`src/cellular.ts`). They came after the H168-383 was verified, so its
   * verification does not cover them: it gets the ones checked on it in person (`VERIFIED_FEATURES`).
   */
  cellular?: true;
  /** One of the writes the one-click AI agent test covers (what an agent's tools can write). */
  agentTest?: true;
}

export type FeatureRecord = ReadFeatureRecord | WriteFeatureRecord;

/** Every feature, in the order of the table's columns. */
export const FEATURES = {
  telemetry: { access: "read", column: "signal", read: "telemetry" },
  neighbors: { access: "read", column: "neighbors", read: "neighbors" },
  topology: { access: "read", column: "devices", read: "topology" },
  smsRead: { access: "read", column: "sms", part: { zh: "读取", en: "reading" }, read: "sms" },
  smsWrite: { access: "write", column: "sms", part: { zh: "发送与管理", en: "sending and managing" }, actions: ["sms_send", "sms_mark_read", "sms_delete"], agentTest: true },
  bandLock: { access: "write", column: "bandLock", actions: ["lock_band", "unlock_rf_locks", "auto_unlock_rf_locks"], agentTest: true },
  cellLock: { access: "write", column: "cellLock", actions: ["lock_cell"] },
  reboot: { access: "write", column: "restart", part: { zh: "重启", en: "reboot" }, actions: ["reboot_cpe"], agentTest: true },
  reconnect: { access: "write", column: "restart", part: { zh: "重拨", en: "redial" }, actions: ["reconnect_cellular", "auto_reconnect_cellular"], agentTest: true },
  mobileData: { access: "write", column: "mobileData", actions: ["set_mobile_data"] },
  securitySwitches: { access: "write", column: "switches", part: { zh: "安全开关", en: "the security switches" }, actions: ["set_security_switches"] },
  wifi: { access: "write", column: "switches", part: { zh: "Wi-Fi 7", en: "Wi-Fi 7" }, actions: ["set_wifi7_mlo"] },
  antenna: { access: "write", column: "switches", part: { zh: "天线", en: "the antenna" }, actions: ["set_antenna_mode"] },
  accessControl: { access: "write", column: "access", actions: ["set_wifi_access", "manage_time_rule"] },
  battery: { access: "read", column: "battery", read: "status" },
  simCard: { access: "read", column: "sim", part: { zh: "状态", en: "its status" }, read: "status" },
  simSlot: { access: "write", column: "sim", part: { zh: "切换卡槽", en: "switching slots" }, actions: ["set_sim_slot", "auto_restore_sim_slot"], cellular: true },
  simPin: { access: "write", column: "sim", part: { zh: "PIN", en: "the PIN" }, actions: ["enter_sim_pin", "set_sim_pin_lock"], cellular: true },
  airplaneMode: { access: "read", column: "airplane", part: { zh: "状态", en: "its state" }, read: "status" },
  airplaneSwitch: { access: "write", column: "airplane", part: { zh: "开关", en: "the switch" }, actions: ["set_airplane_mode"], cellular: true },
  networkMode: { access: "write", column: "network", part: { zh: "网络制式", en: "the network mode" }, actions: ["set_network_mode", "auto_restore_network_mode"], cellular: true },
  operatorSelect: { access: "write", column: "network", part: { zh: "手动选网", en: "choosing the operator" }, actions: ["scan_operators", "select_operator", "auto_restore_operator"], cellular: true },
  roaming: { access: "write", column: "data", part: { zh: "数据漫游", en: "data roaming" }, actions: ["set_roaming"], cellular: true },
  apn: { access: "write", column: "data", part: { zh: "接入点（APN）", en: "the access point (APN)" }, actions: ["set_apn", "auto_restore_apn"], cellular: true },
  dataLimit: { access: "write", column: "data", part: { zh: "流量上限", en: "the data limit" }, actions: ["set_data_limit"], cellular: true },
  trafficReset: { access: "write", column: "data", part: { zh: "清零流量统计", en: "clearing the traffic counters" }, actions: ["reset_traffic"], cellular: true },
  ussd: { access: "write", column: "ussd", actions: ["send_ussd"], cellular: true },
} as const satisfies Readonly<Record<string, FeatureRecord>>;

type Registry = typeof FEATURES;

export type DeviceFeature = keyof Registry;

/** The features whose record has this shape. */
type FeaturesWith<Shape> = { [K in DeviceFeature]: Registry[K] extends Shape ? K : never }[DeviceFeature];

export type ReadFeature = FeaturesWith<{ access: "read" }>;
export type WriteFeature = FeaturesWith<{ access: "write" }>;
export type StatusReadFeature = FeaturesWith<{ read: "status" }>;
export type CellularWriteFeature = FeaturesWith<{ cellular: true }>;
export type AgentTestFeature = FeaturesWith<{ agentTest: true }>;

/** Every router write the scheduler runs (a write is turned off by its feature). */
export type ControlAction = { [K in WriteFeature]: Registry[K] extends { actions: ReadonlyArray<infer A> } ? A : never }[WriteFeature];

/** The record of a feature. */
export function featureRecord(feature: DeviceFeature): FeatureRecord {
  return FEATURES[feature];
}

/** Every feature, in the table's column order. */
export const DEVICE_FEATURES = Object.keys(FEATURES) as ReadonlyArray<DeviceFeature>;

function featuresWhere<F extends DeviceFeature>(test: (record: FeatureRecord) => boolean): ReadonlyArray<F> {
  return DEVICE_FEATURES.filter((feature) => test(FEATURES[feature])) as F[];
}

/** The features read rather than written. */
export const READ_FEATURES = featuresWhere<ReadFeature>((record) => record.access === "read");
/** The features a router write belongs to, in the order the console lists them. */
export const WRITE_FEATURES = featuresWhere<WriteFeature>((record) => record.access === "write");
/** The status the 5 s poll reads besides the signal (`GlobalTelemetrySnapshot.status`). */
export const STATUS_READ_FEATURES = featuresWhere<StatusReadFeature>((record) => record.access === "read" && record.read === "status");
/** The cellular settings FengSui writes besides the locks, each its own feature. */
export const CELLULAR_WRITE_FEATURES = featuresWhere<CellularWriteFeature>((record) => record.access === "write" && record.cellular === true);
/** The writes the one-click AI agent test covers. */
export const AGENT_TEST_FEATURES = featuresWhere<AgentTestFeature>((record) => record.access === "write" && record.agentTest === true);

/** Every router write the scheduler runs, and the feature it is filed under. */
export const CONTROL_FEATURES = Object.fromEntries(
  WRITE_FEATURES.flatMap((feature) => (FEATURES[feature] as WriteFeatureRecord).actions.map((action) => [action, feature]))
) as Readonly<Record<ControlAction, WriteFeature>>;

const NAMES: ReadonlySet<string> = new Set(DEVICE_FEATURES);

export function isDeviceFeature(value: unknown): value is DeviceFeature {
  return typeof value === "string" && NAMES.has(value);
}

export function isWriteFeature(value: unknown): value is WriteFeature {
  return isDeviceFeature(value) && FEATURES[value].access === "write";
}

export function isStatusReadFeature(feature: string): feature is StatusReadFeature {
  return (STATUS_READ_FEATURES as ReadonlyArray<string>).includes(feature);
}

export function isCellularWriteFeature(feature: string): feature is CellularWriteFeature {
  return (CELLULAR_WRITE_FEATURES as ReadonlyArray<string>).includes(feature);
}

/** Whether the feature is read or written. */
export function featureAccess(feature: DeviceFeature): "read" | "write" {
  return FEATURES[feature].access;
}

/** Where a read feature is read: its read section, or `status` (the 5 s poll). */
export function featureRead(feature: ReadFeature): ReadSection | "status" {
  return (FEATURES[feature] as ReadFeatureRecord).read;
}

/** The read feature read in this section (`null`: the section is read for writes only: settings, access control). */
export function sectionFeature(section: ReadSection): ReadFeature | null {
  return READ_FEATURES.find((feature) => featureRead(feature) === section) ?? null;
}

/** A column of the table, with its features in order and, in a column of several, how the notes name each. */
export interface FeatureColumn {
  id: FeatureColumnId;
  zh: string;
  en: string;
  features: ReadonlyArray<DeviceFeature>;
  parts?: { zh: ReadonlyArray<string>; en: ReadonlyArray<string> };
}

/** The Supported devices table's columns, each with the features marked in it. */
export const FEATURE_COLUMNS: ReadonlyArray<FeatureColumn> = COLUMNS.map(({ id, zh, en }) => {
  const features = DEVICE_FEATURES.filter((feature) => FEATURES[feature].column === id);
  const records: ReadonlyArray<FeatureRecord> = features.map((feature) => FEATURES[feature]);
  if (features.length < 2) return { id, zh, en, features };
  return { id, zh, en, features, parts: { zh: records.map((record) => record.part?.zh ?? ""), en: records.map((record) => record.part?.en ?? "") } };
});
