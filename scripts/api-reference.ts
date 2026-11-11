import { permissionForRoute } from "../src/http-server.ts";
import type { ApiErrorCode, SseEventPayloads } from "../src/api-contract.ts";

/**
 * The generated parts of the guide's API reference (docs/guide/{zh,en}/api.md): the routes, the SSE
 * events and the error codes. What each one is comes from the code (paths, methods, the permission a
 * token needs: `permissionForRoute`); the one-line descriptions are written here, next to the facts
 * they describe. test/api-reference.test.ts keeps the three lists equal to the code (a route, event or
 * error code the code has and this file lacks fails it, and so does one this file names and the code
 * no longer has), asks the daemon each route with its method and example body, and checks that the
 * pages hold exactly what these functions write. `npm run docs:sync` rewrites the pages.
 */

export type DocLocale = "zh-CN" | "en";
type Text = Readonly<Record<DocLocale, string>>;

export type RouteGroup = "read" | "refresh" | "control" | "access" | "sms" | "other";

export interface ApiRouteDoc {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly group: RouteGroup;
  readonly summary: Text;
  /** A request body for a POST that takes parameters; the test sends it to a mock router. */
  readonly body?: string;
  /** The body names something that must exist first (a message, a contact): the test accepts a validation error. */
  readonly needsState?: true;
  /** No token needed. */
  readonly open?: true;
  /** A console session only: tokens get `403 CONSOLE_ONLY`. */
  readonly consoleOnly?: true;
}

/** Routes the web console uses for itself; tokens cannot call them, so the reference leaves them out. */
export const CONSOLE_ROUTE_PREFIXES = ["/api/auth", "/api/setup", "/api/console", "/api/i18n"] as const;

export const API_ROUTES: ReadonlyArray<ApiRouteDoc> = [
  // Reading: the daemon's latest data, no router session
  { method: "GET", path: "/api/telemetry", group: "read", summary: { "zh-CN": "最新的信号、载波、速率、流量和 WAN 状态，以及锁定状态和最近的告警", en: "The latest signal, carriers, rates, traffic and WAN state, with the lock state and recent alerts" } },
  { method: "GET", path: "/api/timeseries", group: "read", summary: { "zh-CN": "历史：速率、RSRP、SINR。`?preset=1h`（或 `6h`、`12h`、`24h`），或 `?preset=custom&fromMs=…&toMs=…`", en: "History: rates, RSRP and SINR. `?preset=1h` (or `6h`, `12h`, `24h`), or `?preset=custom&fromMs=…&toMs=…`" } },
  { method: "GET", path: "/api/neighbors", group: "read", summary: { "zh-CN": "附近的基站（上一次扫描的结果）", en: "Nearby cells, from the last scan" } },
  { method: "GET", path: "/api/topology", group: "read", summary: { "zh-CN": "已连接设备", en: "Connected devices" } },
  { method: "GET", path: "/api/settings", group: "read", summary: { "zh-CN": "路由器设置：UPnP、DMZ、防火墙、Wi-Fi 7、天线、移动数据", en: "Router settings: UPnP, DMZ, firewall, Wi-Fi 7, antenna, mobile data" } },
  { method: "GET", path: "/api/access-control", group: "read", summary: { "zh-CN": "Wi-Fi 黑白名单和上网时段", en: "The Wi-Fi MAC filter and internet schedules" } },
  { method: "GET", path: "/api/session/status", group: "read", summary: { "zh-CN": "烽燧和路由器之间的状态：是否在让位、是否熔断、自愈在做什么", en: "How FengSui stands with the router: yielding, breaker, what self-healing is doing" } },
  { method: "GET", path: "/api/device/profile", group: "read", summary: { "zh-CN": "识别到的型号、固件和能力，以及它在「支持的设备」表里的那一行（不含设备标识）", en: "The identified model, firmware and capabilities, and its row of Supported devices (no identifiers)" } },
  { method: "GET", path: "/api/alerts", group: "read", summary: { "zh-CN": "最近 100 条告警，以及每个通知渠道的发送统计", en: "The last 100 alerts, and delivery counts per notification channel" } },
  { method: "GET", path: "/api/audit", group: "read", summary: { "zh-CN": "审计日志：谁在什么时候改了什么（`?limit=`，最多 500 条）", en: "The audit log: who changed what, and when (`?limit=`, up to 500)" } },
  // Refreshing: one read session now
  { method: "POST", path: "/api/telemetry/refresh", group: "refresh", summary: { "zh-CN": "马上读一次信号", en: "Read the signal now" } },
  { method: "POST", path: "/api/neighbors/scan", group: "refresh", summary: { "zh-CN": "马上扫描附近的基站", en: "Scan for nearby cells now" } },
  { method: "POST", path: "/api/topology/refresh", group: "refresh", summary: { "zh-CN": "马上读一次已连接设备", en: "Read the connected devices now" } },
  { method: "POST", path: "/api/settings/refresh", group: "refresh", summary: { "zh-CN": "马上读一次路由器设置", en: "Read the router settings now" } },
  { method: "POST", path: "/api/access-control/refresh", group: "refresh", summary: { "zh-CN": "马上读一次黑白名单和上网时段", en: "Read the MAC filter and schedules now" } },
  // The router's controls
  { method: "POST", path: "/api/control/band-lock", group: "control", body: '{"lteBands":["B1","B3"]}', summary: { "zh-CN": "锁频段（`lteBands`、`nrBands`，`\"all\"` 为全部频段；只给一种制式时另一种不变）", en: "Lock bands (`lteBands`, `nrBands`, `\"all\"` for every band; the type you leave out stays as it is)" } },
  { method: "POST", path: "/api/control/cell-lock", group: "control", body: '{"rat":"NR","band":"N78","arfcn":650000,"pci":211}', summary: { "zh-CN": "锁小区；不给 `pci` 时只锁频点", en: "Lock a cell; without `pci`, lock the channel only" } },
  { method: "POST", path: "/api/control/unlock", group: "control", summary: { "zh-CN": "解除锁频段和锁小区", en: "Clear band and cell locks" } },
  { method: "POST", path: "/api/control/reboot", group: "control", body: '{"confirm":true}', summary: { "zh-CN": "重启路由器", en: "Restart the router" } },
  { method: "POST", path: "/api/control/reconnect", group: "control", body: '{"confirm":true}', summary: { "zh-CN": "重拨移动网络（不重启路由器）", en: "Redial the mobile connection (no restart)" } },
  { method: "POST", path: "/api/control/security", group: "control", body: '{"upnpEnabled":false}', summary: { "zh-CN": "UPnP、DMZ、防火墙（`upnpEnabled`、`dmz`、`firewall`，只给要改的）", en: "UPnP, DMZ and firewall (`upnpEnabled`, `dmz`, `firewall`; send only what changes)" } },
  { method: "POST", path: "/api/control/wifi7", group: "control", body: '{"mloEnable":true}', summary: { "zh-CN": "Wi-Fi 7 多链路（`mloEnable`）和双频优选（`dbhoEnable`）", en: "Wi-Fi 7 multi-link (`mloEnable`) and dual-band steering (`dbhoEnable`)" } },
  { method: "POST", path: "/api/control/antenna", group: "control", body: '{"mode":"auto"}', summary: { "zh-CN": "天线：`auto`、`internal`、`external`", en: "Antenna: `auto`, `internal`, `external`" } },
  { method: "POST", path: "/api/control/mobile-data", group: "control", body: '{"enabled":true}', summary: { "zh-CN": "打开或关闭移动数据", en: "Turn mobile data on or off" } },
  { method: "POST", path: "/api/session/reset-breaker", group: "control", summary: { "zh-CN": "解除路由器账户被锁（错误码 108007）引起的熔断，并重新读取 `.env`；密码错误引起的熔断请在「设置 → 路由器」改正密码", en: "Reset a breaker the router's account lock (108007) tripped, and reload `.env`; for a wrong password, correct it under Settings → Router" } },
  // Devices' internet access
  { method: "POST", path: "/api/control/wifi-access", group: "access", body: '{"action":"unblock","macAddress":"02:00:5E:10:00:01","confirm":true}', summary: { "zh-CN": "断开或恢复一台设备的 Wi-Fi（`block`、`unblock`）", en: "Block or unblock one device's Wi-Fi (`block`, `unblock`)" } },
  { method: "POST", path: "/api/control/wifi-mac-filter", group: "access", body: '{"mode":"off","confirm":true}', summary: { "zh-CN": "Wi-Fi 黑白名单：`off`、`deny`、`allow`，或增删名单里的设备", en: "The Wi-Fi MAC filter: `off`, `deny`, `allow`, or add and remove entries" } },
  { method: "POST", path: "/api/control/time-rule", group: "access", body: '{"action":"delete","id":"1","confirm":true}', needsState: true, summary: { "zh-CN": "上网时段：新建、修改、删除（`create`、`update`、`delete`）", en: "Internet schedules: create, update, delete" } },
  // SMS
  { method: "GET", path: "/api/sms/status", group: "sms", summary: { "zh-CN": "短信数量和同步状态", en: "Message counts and sync state" } },
  { method: "GET", path: "/api/sms/countries", group: "sms", summary: { "zh-CN": "国家和地区的电话区号", en: "Country and region calling codes" } },
  { method: "GET", path: "/api/sms/threads", group: "sms", summary: { "zh-CN": "会话列表（`?filter=all`、`unread`、`otp`，`&search=`）", en: "Threads (`?filter=all`, `unread`, `otp`, and `&search=`)" } },
  { method: "GET", path: "/api/sms/thread", group: "sms", summary: { "zh-CN": "一个会话的全部短信（`?key=` 号码或会话标识）", en: "Every message of a thread (`?key=` a number or thread key)" } },
  { method: "GET", path: "/api/sms/contacts", group: "sms", summary: { "zh-CN": "通讯录（`?search=`）", en: "Contacts (`?search=`)" } },
  { method: "GET", path: "/api/sms/trash", group: "sms", summary: { "zh-CN": "「最近删除」里的短信", en: "Messages in Recently deleted" } },
  { method: "POST", path: "/api/sms/preview", group: "sms", body: '{"phone":"+353830000001","content":"Hello"}', summary: { "zh-CN": "预览一条短信：分几段、用什么编码，不发送", en: "Preview a message: segments and encoding; nothing is sent" } },
  { method: "POST", path: "/api/sms/sync", group: "sms", body: '{"mode":"incremental"}', summary: { "zh-CN": "马上同步短信（`full` 或 `incremental`）", en: "Sync messages now (`full` or `incremental`)" } },
  { method: "POST", path: "/api/sms/send", group: "sms", body: '{"phone":"+353830000001","content":"Hello"}', summary: { "zh-CN": "发短信（`phone`，或 `phones` 最多 5 个）；只发一次，失败不重发", en: "Send a message (`phone`, or up to 5 `phones`); sent once, never retried" } },
  { method: "POST", path: "/api/sms/read", group: "sms", body: '{"threadKey":"+353830000001"}', summary: { "zh-CN": "标为已读（`uids` 或 `threadKey`）", en: "Mark read (`uids` or `threadKey`)" } },
  { method: "POST", path: "/api/sms/delete", group: "sms", body: '{"uids":["<uid>"]}', needsState: true, summary: { "zh-CN": "删除短信，放进「最近删除」", en: "Delete messages into Recently deleted" } },
  { method: "POST", path: "/api/sms/trash/restore", group: "sms", body: '{"uids":["<uid>"]}', needsState: true, summary: { "zh-CN": "从「最近删除」放回原来的会话", en: "Put messages back from Recently deleted" } },
  { method: "POST", path: "/api/sms/trash/purge", group: "sms", consoleOnly: true, summary: { "zh-CN": "彻底删除「最近删除」里的短信", en: "Delete messages in Recently deleted for good" } },
  { method: "POST", path: "/api/sms/contacts/upsert", group: "sms", body: '{"phone":"+353830000001","name":"Example"}', summary: { "zh-CN": "新建或修改联系人", en: "Add or edit a contact" } },
  { method: "POST", path: "/api/sms/contacts/delete", group: "sms", body: '{"id":"<id>"}', summary: { "zh-CN": "删除联系人", en: "Delete a contact" } },
  { method: "POST", path: "/api/sms/contacts/import-vcf", group: "sms", body: '{"vcf":"BEGIN:VCARD…"}', summary: { "zh-CN": "导入 vCard（`.vcf` 文件的内容）", en: "Import vCards (the text of a `.vcf` file)" } },
  // Other
  { method: "GET", path: "/api/health", group: "other", open: true, summary: { "zh-CN": "存活检查：版本和运行时长", en: "Liveness check: version and uptime" } },
  { method: "GET", path: "/api/events", group: "other", summary: { "zh-CN": "实时事件流（见[实时事件](#events)）", en: "The live event stream (see [Live events](#events))" } },
  { method: "GET", path: "/metrics", group: "other", summary: { "zh-CN": "Prometheus 指标（打开后才有，见 [Prometheus 指标](#metrics)）", en: "Prometheus metrics (when turned on, see [Prometheus metrics](#metrics))" } },
];

export type SseEventName = keyof SseEventPayloads;

/** Every SSE event, in the order the reference lists them; `sms` marks the ones a token without "read SMS" never gets. */
export const API_EVENTS: ReadonlyArray<{ readonly name: SseEventName; readonly sms?: true; readonly summary: Text }> = [
  { name: "hello", summary: { "zh-CN": "连上时先发一次：当前的状态、信号、锁定和短信计数", en: "First, on connecting: the current state, signal, locks and SMS counts" } },
  { name: "speed", summary: { "zh-CN": "每次读到信号（默认每 5 秒）：上下行速率", en: "Each signal read (every 5 seconds by default): download and upload rates" } },
  { name: "telemetry", summary: { "zh-CN": "紧跟 `speed`：完整的信号和状态，与 `GET /api/telemetry` 的 `telemetry` 相同", en: "Right after `speed`: the full signal and state, as `telemetry` in `GET /api/telemetry`" } },
  { name: "neighbors", summary: { "zh-CN": "附近的基站扫描完成（默认每 60 秒）", en: "A scan for nearby cells finished (every 60 seconds by default)" } },
  { name: "topology", summary: { "zh-CN": "已连接设备读完（默认每 60 秒）", en: "The connected devices were read (every 60 seconds by default)" } },
  { name: "settings", summary: { "zh-CN": "路由器设置读完或改动之后（没有定时推送）", en: "The router settings were read or changed (never on a timer)" } },
  { name: "access-control", summary: { "zh-CN": "黑白名单和上网时段读完或改动之后", en: "The MAC filter and schedules were read or changed" } },
  { name: "session:avoidance", summary: { "zh-CN": "有人登录或退出路由器自己的管理页，烽燧开始或结束让位", en: "Someone signed in to or out of the router's own page, so FengSui starts or stops stepping aside" } },
  { name: "control:applied", summary: { "zh-CN": "一项写操作完成（任何入口：控制台、令牌、智能体、自愈）", en: "A write finished (from anywhere: the console, a token, an agent, self-healing)" } },
  { name: "alert", summary: { "zh-CN": "一条新告警", en: "A new alert" } },
  { name: "sms:new", sms: true, summary: { "zh-CN": "收到一条新短信（每条一次）", en: "A new message arrived (one event each)" } },
  { name: "sms:sent", sms: true, summary: { "zh-CN": "一条短信发完（任何入口）", en: "A message was sent (from anywhere)" } },
  { name: "sms:updated", sms: true, summary: { "zh-CN": "短信被标为已读、删除、恢复或彻底删除", en: "Messages were marked read, deleted, restored or deleted for good" } },
  { name: "sms:sync", sms: true, summary: { "zh-CN": "一次短信同步完成", en: "An SMS sync finished" } },
  { name: "sms:status", sms: true, summary: { "zh-CN": "短信计数或同步状态变了", en: "The SMS counts or sync state changed" } },
  { name: "contacts:updated", sms: true, summary: { "zh-CN": "通讯录变了", en: "The contacts changed" } },
];

/** The error codes a script calling the API can meet, with the HTTP status they come with. */
export const API_ERRORS: ReadonlyArray<{ readonly code: ApiErrorCode; readonly status: string; readonly summary: Text }> = [
  { code: "BAD_PAYLOAD", status: "400 / 413 / 415", summary: { "zh-CN": "请求体不是 JSON 对象、超过上限，或没有 `Content-Type: application/json`", en: "The body is not a JSON object, is too large, or lacks `Content-Type: application/json`" } },
  { code: "VALIDATION_ERROR", status: "400", summary: { "zh-CN": "参数不对：比如频段不在路由器支持的列表里、缺少 `confirm: true`", en: "A parameter is wrong: a band the router does not support, a missing `confirm: true`" } },
  { code: "UNAUTHORIZED", status: "401", summary: { "zh-CN": "没带令牌，或令牌错误、已过期、已撤销", en: "No token, or a wrong, expired or revoked one" } },
  { code: "READ_ONLY_TOKEN", status: "403", summary: { "zh-CN": "这个令牌不能做任何改动", en: "This token may change nothing" } },
  { code: "TOKEN_NOT_PERMITTED", status: "403", summary: { "zh-CN": "令牌缺少这项权限，`permission` 字段写着缺哪一项", en: "The token lacks the permission; `permission` names it" } },
  { code: "CONSOLE_ONLY", status: "403", summary: { "zh-CN": "只能在登录的控制台里做", en: "Only a signed-in console may do this" } },
  { code: "NOT_FOUND", status: "404", summary: { "zh-CN": "没有这个接口（`/metrics` 没打开时也是这个）", en: "No such endpoint (also `/metrics` while it is off)" } },
  { code: "SMS_DISABLED", status: "404", summary: { "zh-CN": "短信功能关着（`SMS_ENABLED=false`）", en: "SMS is turned off (`SMS_ENABLED=false`)" } },
  { code: "METHOD_NOT_ALLOWED", status: "405", summary: { "zh-CN": "方法不对，比如该用 `POST` 的用了 `GET`", en: "Wrong method, such as `GET` where `POST` is needed" } },
  { code: "BROWSER_SESSION_YIELDED", status: "409", summary: { "zh-CN": "有人正登录路由器自己的管理页，烽燧让位，什么都没做", en: "Someone is signed in to the router's own page; FengSui stepped aside and did nothing" } },
  { code: "PEER_DAEMON_ACTIVE", status: "409", summary: { "zh-CN": "另一台机器上的烽燧在管理这台路由器，这一个在待机", en: "FengSui on another machine manages this router; this one stands by" } },
  { code: "CPE_NOT_CONFIGURED", status: "409", summary: { "zh-CN": "还没在控制台连上路由器", en: "No router connection yet: finish the setup in the console" } },
  { code: "DEVICE_UNVERIFIED_READ_ONLY", status: "409", summary: { "zh-CN": "烽燧在这台路由器上没有实现这项写入，什么都没发", en: "FengSui does not implement this write on this router; nothing was sent" } },
  { code: "DEVICE_WRITE_DISABLED", status: "409", summary: { "zh-CN": "这项写入在「设置 → 设备」里关掉了，什么都没发", en: "This write is turned off under Settings → Device; nothing was sent" } },
  { code: "DEVICE_NOT_IDENTIFIED", status: "409", summary: { "zh-CN": "还没认出路由器的型号，写入没有执行", en: "The router's model is not known yet; nothing was written" } },
  { code: "MISDIRECTED_HOST", status: "421", summary: { "zh-CN": "访问用的主机名不在允许范围内，把它加进 `ALLOWED_HOSTS`", en: "The host name you used is not allowed; add it to `ALLOWED_HOSTS`" } },
  { code: "CIRCUIT_BREAKER_OPEN", status: "423", summary: { "zh-CN": "路由器密码错误或账户被锁，烽燧停止登录；到「设置 → 路由器」改正", en: "The router password is wrong or its account is locked, so FengSui stopped signing in; fix it under Settings → Router" } },
  { code: "RATE_LIMITED", status: "429", summary: { "zh-CN": "认证失败太多次，`retryAfterSec` 秒后再试", en: "Too many failed sign-ins; try again after `retryAfterSec` seconds" } },
  { code: "SSE_LIMIT_REACHED", status: "429", summary: { "zh-CN": "实时事件的连接太多", en: "Too many live event connections" } },
  { code: "INTERNAL_ERROR", status: "500", summary: { "zh-CN": "烽燧内部出错", en: "Something went wrong inside FengSui" } },
  { code: "CPE_UPSTREAM_ERROR", status: "502", summary: { "zh-CN": "路由器没有应答，或返回了错误", en: "The router did not answer, or answered with an error" } },
  { code: "SMS_SEND_FAILED", status: "502", summary: { "zh-CN": "路由器收下了短信，但报告发送失败", en: "The router took the message but reports that sending failed" } },
  { code: "QUEUE_FULL", status: "503", summary: { "zh-CN": "排队的请求太多，或烽燧正在停止", en: "Too many requests queued, or FengSui is stopping" } },
];

/**
 * Error codes a token's request never meets: the console's own requests (sign-in, setup, settings,
 * the browser's CSRF check), `/mcp` (JSON-RPC errors, on the AI agents page) and static files.
 */
export const ERRORS_NOT_LISTED: ReadonlyArray<ApiErrorCode> = [
  "BAD_URL",
  "CSRF_REJECTED",
  "LOCALE_NOT_FOUND",
  "EXPERIMENTAL_UNAVAILABLE",
  "AGENT_TEST_UNAVAILABLE",
  "ALREADY_SET_UP",
  "WRONG_PASSWORD",
  "CPE_TEST_FAILED",
  "TELEGRAM_DISABLED",
  "MCP_DISABLED",
  "FORBIDDEN_ORIGIN",
  "UNSUPPORTED_MEDIA_TYPE",
  "STATIC_ROOT_NOT_FOUND",
  "ASSET_NOT_FOUND",
  "BAD_PATH",
  "PATH_TRAVERSAL_BLOCKED",
  "SYMLINK_ESCAPE_BLOCKED",
];

const GROUPS: ReadonlyArray<{ readonly id: RouteGroup; readonly title: Text }> = [
  { id: "read", title: { "zh-CN": "读取", en: "Reading" } },
  { id: "refresh", title: { "zh-CN": "刷新", en: "Refreshing" } },
  { id: "control", title: { "zh-CN": "路由器控制", en: "Router controls" } },
  { id: "access", title: { "zh-CN": "设备上网管理", en: "Devices' internet access" } },
  { id: "sms", title: { "zh-CN": "短信", en: "SMS" } },
  { id: "other", title: { "zh-CN": "其他", en: "Other" } },
];

const PERMISSION_LABEL: Readonly<Record<string, Text>> = {
  any: { "zh-CN": "任何令牌", en: "Any token" },
  open: { "zh-CN": "不需要令牌", en: "No token" },
  console: { "zh-CN": "只能在控制台", en: "Console only" },
  "sms-read": { "zh-CN": "读短信和验证码", en: "Read SMS and codes" },
  control: { "zh-CN": "改动路由器", en: "Change the router" },
  access: { "zh-CN": "管理设备上网", en: "Manage devices' internet access" },
  "sms-write": { "zh-CN": "发短信、删短信、改通讯录", en: "Send and delete SMS, edit contacts" },
  all: { "zh-CN": "全部四项权限", en: "All four permissions" },
};

/** What a token needs for a route, as the daemon decides it (`permissionForRoute`). */
export function routePermission(route: ApiRouteDoc): string {
  if (route.open) return "open";
  if (route.consoleOnly) return "console";
  return permissionForRoute(route.method, route.path) ?? "any";
}

const HEADINGS = {
  "zh-CN": { method: "方法", path: "路径", permission: "需要的权限", summary: "说明", body: "请求体示例", event: "事件", when: "什么时候发", status: "状态码", code: "`errorCode`", meaning: "意思", smsNote: "（要「读短信和验证码」）" },
  en: { method: "Method", path: "Path", permission: "Permission", summary: "What it does", body: "Example body", event: "Event", when: "When it is sent", status: "Status", code: "`errorCode`", meaning: "Meaning", smsNote: " (needs \"Read SMS and codes\")" },
} as const;

/** The routes, one table per group (between `<!-- api-routes:begin -->` and `<!-- api-routes:end -->`). */
export function apiRoutesSection(locale: DocLocale): string {
  const h = HEADINGS[locale];
  return GROUPS.map((group) => {
    const routes = API_ROUTES.filter((route) => route.group === group.id);
    // A group whose routes take no parameters gets no column for them
    const withBody = routes.some((route) => route.body !== undefined);
    const rows = routes.map((route) => {
      const permission = PERMISSION_LABEL[routePermission(route)]?.[locale] ?? routePermission(route);
      const cells = [`\`${route.method}\``, `\`${route.path}\``, permission, route.summary[locale], ...(withBody ? [route.body ? `\`${route.body}\`` : ""] : [])];
      return `| ${cells.join(" | ")} |`;
    });
    const head = [h.method, h.path, h.permission, h.summary, ...(withBody ? [h.body] : [])];
    return [`### ${group.title[locale]}`, "", `| ${head.join(" | ")} |`, `|${head.map(() => " :--- |").join("")}`, ...rows].join("\n");
  }).join("\n\n");
}

/** The SSE events (between `<!-- api-events:begin -->` and `<!-- api-events:end -->`). */
export function apiEventsSection(locale: DocLocale): string {
  const h = HEADINGS[locale];
  const rows = API_EVENTS.map((event) => `| \`${event.name}\` | ${event.summary[locale]}${event.sms ? h.smsNote : ""} |`);
  return [`| ${h.event} | ${h.when} |`, "| :--- | :--- |", ...rows].join("\n");
}

/** The error codes (between `<!-- api-errors:begin -->` and `<!-- api-errors:end -->`). */
export function apiErrorsSection(locale: DocLocale): string {
  const h = HEADINGS[locale];
  const rows = API_ERRORS.map((error) => `| ${error.status} | \`${error.code}\` | ${error.summary[locale]} |`);
  return [`| ${h.status} | ${h.code} | ${h.meaning} |`, "| :--- | :--- | :--- |", ...rows].join("\n");
}

/** The generated blocks of the API reference, by marker name. */
export function apiReferenceBlocks(locale: DocLocale): Readonly<Record<string, string>> {
  return { "api-routes": apiRoutesSection(locale), "api-events": apiEventsSection(locale), "api-errors": apiErrorsSection(locale) };
}

/** `text` with the block between `<!-- name:begin -->` and `<!-- name:end -->` replaced by `content`. */
export function replaceBlock(text: string, name: string, content: string): string {
  const begin = `<!-- ${name}:begin -->\n`;
  const end = `\n<!-- ${name}:end -->`;
  const from = text.indexOf(begin);
  const to = text.indexOf(end, from);
  if (from < 0 || to < 0) throw new Error(`no <!-- ${name}:begin --> … <!-- ${name}:end --> block`);
  return `${text.slice(0, from + begin.length)}${content}${text.slice(to)}`;
}

/** The block between `<!-- name:begin -->` and `<!-- name:end -->`, or null. */
export function readBlock(text: string, name: string): string | null {
  return new RegExp(`<!-- ${name}:begin -->\\n([\\s\\S]*?)\\n<!-- ${name}:end -->`).exec(text)?.[1] ?? null;
}
