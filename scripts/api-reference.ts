import type { ApiErrorCode, SseEventPayloads } from "../src/api-contract.ts";
import type { DocLocale, ReferenceGroup, RestBinding, Text } from "../src/operations/record.ts";
import { REST_OPERATIONS, permissionForRoute, restBinding } from "../src/operations/registry.ts";

/**
 * The generated parts of the guide's API reference (docs/guide/{zh,en}/api.md): the routes, the SSE
 * events and the error codes. The routes come from the operation registry (`src/operations/`: path,
 * method, the permission a token needs, the one-line descriptions and the example bodies are each
 * operation's record); the events' and error codes' descriptions are written here, next to the facts
 * they describe. test/api-reference.test.ts keeps the events and codes equal to the code, asks the
 * daemon each route with its method and example body, and checks that the pages hold exactly what
 * these functions write. `npm run docs:sync` rewrites the pages.
 */

/** Routes the web console uses for itself; tokens cannot call them, so the reference leaves them out (and the registry holds none). */
export const CONSOLE_ROUTE_PREFIXES = ["/api/auth", "/api/setup", "/api/console", "/api/i18n"] as const;

/** Every route of the registry, in the reference's order. */
export const API_ROUTES: ReadonlyArray<RestBinding> = REST_OPERATIONS.map(restBinding);

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

const GROUPS: ReadonlyArray<{ readonly id: ReferenceGroup; readonly title: Text }> = [
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
export function routePermission(route: RestBinding): string {
  if (route.served === "open") return "open";
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
    const withBody = routes.some((route) => route.example !== undefined);
    const rows = routes.map((route) => {
      const permission = PERMISSION_LABEL[routePermission(route)]?.[locale] ?? routePermission(route);
      const cells = [`\`${route.method}\``, `\`${route.path}\``, permission, route.summary[locale], ...(withBody ? [route.example ? `\`${route.example}\`` : ""] : [])];
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
