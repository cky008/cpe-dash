import type { TokenPermission } from "../console-policy.ts";
import { CONTROL_FEATURES, type ControlAction, type WriteFeature } from "../features.ts";
import type { JsonSchemaProperty } from "../mcp-schema.ts";
import type { McpToolDefinition } from "../mcp-tool-provider.ts";
import { ACCESS_OPERATIONS } from "./access.ts";
import { CELLULAR_OPERATIONS } from "./cellular-settings.ts";
import { DAEMON_OPERATIONS } from "./daemon.ts";
import type { Fields, McpBinding, OperationRecord, RestBinding } from "./record.ts";
import { READ_OPERATIONS } from "./reads.ts";
import { ROUTER_OPERATIONS } from "./router.ts";
import { SMS_OPERATIONS } from "./sms.ts";

/**
 * The operation registry: every read and write FengSui offers, one record each (`record.ts` has the
 * shape, the area files the records). The REST route table, `permissionForRoute`, the MCP tools with
 * the permission, gate and schema of each, the API reference's route table and the demo's routes are
 * worked out from here; each entry writes only its handlers, keyed by the operation's name.
 * docs/dev/architecture.md 19.9.
 *
 * The records stand in the API reference's order (its tables follow `rest.group`). Zero dependencies:
 * the daemon, the scripts and the static demo share it.
 */

export const OPERATIONS = {
  ...READ_OPERATIONS,
  ...ROUTER_OPERATIONS,
  ...CELLULAR_OPERATIONS,
  ...DAEMON_OPERATIONS,
  ...ACCESS_OPERATIONS,
  ...SMS_OPERATIONS,
};

type Operations = typeof OPERATIONS;
export type OperationName = keyof Operations;

type With<Shape> = { [O in OperationName]: Operations[O] extends Shape ? O : never }[OperationName];

/** The operations with a REST route. */
export type RestOperation = With<{ rest: RestBinding }>;
/** The routes the HTTP server serves itself, before the API's dispatch. */
export type ServedOperation = With<{ rest: { served: string } }>;
/** The routes under `/api/sms/` (the SMS route module dispatches them). */
export type SmsRestOperation = With<{ rest: { group: "sms" } }>;
/** The other routes of the protected API. */
export type ApiOperation = Exclude<RestOperation, ServedOperation | SmsRestOperation>;
/** The operations with an MCP tool. */
export type McpOperation = With<{ mcp: McpBinding }>;

/** What an operation's first input check returns (`undefined`: it takes no input). */
export type InputOf<O extends OperationName> = Operations[O] extends { input: (fields: Fields) => infer T } ? T : undefined;
/** What its MCP tool's input check returns: the agent's own form, else the operation's. */
export type ToolInputOf<O extends OperationName> = Operations[O] extends { mcp: { input: (fields: Fields) => infer T } } ? T : InputOf<O>;

/**
 * The MCP tools, provider by provider, in the order `tools/list` gives them. Its own table: the REST
 * reference and the tool list order some operations differently (REST lists reboot, redial, the
 * security switches; MCP the switches, redial, reboot), and neither may change.
 */
export const MCP_TOOLS = {
  core: [
    "telemetry",
    "timeseries",
    "neighbors",
    "sessionStatus",
    "topology",
    "settings",
    "deviceReport",
    "bandLock",
    "cellLock",
    "unlock",
    "securitySwitches",
    "wifiAndAntenna",
    "reconnect",
    "reboot",
    "experimentalWrite",
    "probeEndpoints",
  ],
  access: ["accessControlView", "wifiAccess", "wifiMacFilter", "timeRule"],
  cellular: ["cellular", "networkMode", "operatorScan", "operatorSelect", "simSlot", "simPin", "airplaneSwitch", "roaming", "apn", "dataLimit", "trafficReset", "ussd"],
  sms: ["smsThreads", "smsThread", "smsStatus", "contacts", "smsPreview", "smsSync", "smsSend", "smsMarkRead", "smsDelete", "contactUpsert"],
} as const satisfies Readonly<Record<string, ReadonlyArray<McpOperation>>>;

export type McpProvider = keyof typeof MCP_TOOLS;
export type ProviderOperation<P extends McpProvider> = (typeof MCP_TOOLS)[P][number];

const RECORDS: Readonly<Record<OperationName, OperationRecord>> = OPERATIONS;

/** Every operation, in the registry's order. */
export const OPERATION_NAMES = Object.keys(OPERATIONS) as ReadonlyArray<OperationName>;

export function operationRecord(op: OperationName): OperationRecord {
  return RECORDS[op];
}

// ---------------------------------------------------------------------------- REST

const ROUTES = new Map<string, RestOperation>();
for (const op of OPERATION_NAMES) {
  const rest = RECORDS[op].rest;
  if (rest) ROUTES.set(`${rest.method} ${rest.path}`, op as RestOperation);
}

/** Every operation with a REST route, in the API reference's order. */
export const REST_OPERATIONS = [...ROUTES.values()] as ReadonlyArray<RestOperation>;

/** The REST route of an operation that has one. */
export function restBinding(op: RestOperation): RestBinding {
  return RECORDS[op].rest as RestBinding;
}

/** The operation at this method and path (`null`: no route). */
export function restOperation(method: string, pathname: string): RestOperation | null {
  return ROUTES.get(`${method} ${pathname}`) ?? null;
}

/** The protected API's operation at this method and path: not one the server serves itself, not an SMS route. */
export function apiOperation(method: string, pathname: string): ApiOperation | null {
  const op = restOperation(method, pathname);
  if (op === null) return null;
  const rest = restBinding(op);
  return rest.served === undefined && rest.group !== "sms" ? (op as ApiOperation) : null;
}

/** The SMS route at this method and path. */
export function smsOperation(method: string, pathname: string): SmsRestOperation | null {
  const op = restOperation(method, pathname);
  return op !== null && restBinding(op).group === "sms" ? (op as SmsRestOperation) : null;
}

/** An operation's first input check on the fields of a request (`undefined`: it takes none). */
export function operationInput<O extends OperationName>(op: O, fields: Fields): InputOf<O> {
  return RECORDS[op].input?.(fields) as InputOf<O>;
}

/** The paths a token may not use at all: a signed-in console only (`403 CONSOLE_ONLY`, whatever the method). */
export const CONSOLE_ONLY_PATHS: ReadonlySet<string> = new Set(REST_OPERATIONS.flatMap((op) => (restBinding(op).consoleOnly ? [restBinding(op).path] : [])));

const pathsWhere = (test: (record: OperationRecord, rest: RestBinding) => boolean): ReadonlySet<string> =>
  new Set(REST_OPERATIONS.flatMap((op) => (test(RECORDS[op], restBinding(op)) ? [restBinding(op).path] : [])));
/** POSTs that only read (a read session, a preview): what a path a route has no method for is judged by. */
const READING_POSTS = pathsWhere((record, rest) => rest.method === "POST" && record.access === "read");
const ACCESS_PATHS = [...pathsWhere((record) => record.permission === "access")];
const CONTROL_PATHS = pathsWhere((record, rest) => record.permission === "control" && !rest.path.startsWith("/api/control/"));

const isSmsPath = (pathname: string): boolean => pathname === "/api/sms" || pathname.startsWith("/api/sms/");

/**
 * The permission a token needs for a request: a registered route's own; any other path (a method a
 * route does not take, a sub-path, a typo, the console's routes) by where it lies, as the routes
 * around it would need: none to read, `sms-read` / `sms-write` under `/api/sms`, `access` for device
 * access, `control` for the router's other controls, every permission for anything else.
 */
export function permissionForRoute(method: string, pathname: string): TokenPermission | "all" | null {
  const op = restOperation(method, pathname);
  if (op !== null) return RECORDS[op].permission;
  const reading = method === "GET" || method === "HEAD";
  if (isSmsPath(pathname)) return reading || READING_POSTS.has(pathname) ? "sms-read" : "sms-write";
  if (reading || READING_POSTS.has(pathname)) return null;
  if (ACCESS_PATHS.some((route) => pathname === route || pathname.startsWith(`${route}/`))) return "access";
  if (pathname.startsWith("/api/control/") || CONTROL_PATHS.has(pathname)) return "control";
  return "all";
}

// ---------------------------------------------------------------------------- MCP

/** Every write tool takes it; the server refuses a call without `confirm: true` before the schema and before any session. */
const CONFIRM: JsonSchemaProperty = { type: "boolean", description: "Must be true: the user explicitly asked for this change." };

function toolDefinitionOf(record: OperationRecord, mcp: McpBinding): McpToolDefinition {
  const write = record.access === "write";
  const properties = write && !Object.hasOwn(mcp.properties, "confirm") ? { ...mcp.properties, confirm: CONFIRM } : mcp.properties;
  const required = write && !(mcp.required ?? []).includes("confirm") ? [...(mcp.required ?? []), "confirm"] : mcp.required;
  return {
    name: mcp.tool,
    title: mcp.title,
    description: mcp.description,
    annotations: mcp.annotations,
    inputSchema: { type: "object", properties, ...(required ? { required } : {}), additionalProperties: false },
  };
}

const TOOLS = new Map<string, McpOperation>();
const DEFINITIONS = new Map<OperationName, McpToolDefinition>();
for (const op of OPERATION_NAMES) {
  const record = RECORDS[op];
  if (!record.mcp) continue;
  TOOLS.set(record.mcp.tool, op as McpOperation);
  DEFINITIONS.set(op, toolDefinitionOf(record, record.mcp));
}

/** The operation an MCP tool runs (`null`: no such tool). */
export function toolOperation(tool: string): McpOperation | null {
  return TOOLS.get(tool) ?? null;
}

/** An operation's MCP tool, as `tools/list` gives it on a verified router. */
export function toolDefinition(op: McpOperation): McpToolDefinition {
  return DEFINITIONS.get(op) as McpToolDefinition;
}

/** An operation's MCP binding. */
export function mcpBinding(op: McpOperation): McpBinding {
  return RECORDS[op].mcp as McpBinding;
}

/** The tool's input check on its arguments: the agent's own form, else the operation's. */
export function toolInput<O extends McpOperation>(op: O, args: Fields): ToolInputOf<O> {
  const reader = mcpBinding(op).input ?? RECORDS[op].input;
  return reader?.(args) as ToolInputOf<O>;
}

// ---------------------------------------------------------------------------- the write gate

/** The router writes an operation runs (none: it changes nothing on the router). */
export function operationActions(op: OperationName): ReadonlyArray<ControlAction> {
  return RECORDS[op].actions ?? [];
}

/** The features an operation's router writes are filed under (the capability registry), each once, in order. */
export function operationFeatures(op: OperationName): ReadonlyArray<WriteFeature> {
  return [...new Set(operationActions(op).map((action) => CONTROL_FEATURES[action]))];
}

// ---------------------------------------------------------------------------- the entries' handlers

/**
 * An entry's handlers: one for each operation it serves, taking the input its first check returned.
 * Typed this way, an operation registered for an entry and without a handler there fails the typecheck.
 */
export type OperationHandlers<Ops extends OperationName, Call, Result = unknown> = { readonly [O in Ops]: (input: InputOf<O>, call: Call) => Result | Promise<Result> };

/** Check a request's fields with the operation's first check, then run its handler. */
export async function runOperation<Ops extends OperationName, Call, Result>(handlers: OperationHandlers<Ops, Call, Result>, op: Ops, fields: Fields, call: Call): Promise<Result> {
  const input = operationInput(op, fields);
  const handler = handlers[op] as (input: unknown, call: Call) => Result | Promise<Result>;
  return await handler(input, call);
}

/** A provider's MCP handlers: one for each tool in its list, taking the tool's checked input (and its arguments as sent). */
export type ToolHandlers<P extends McpProvider> = {
  readonly [O in ProviderOperation<P>]: (input: ToolInputOf<O>, args: Fields) => Record<string, unknown> | Promise<Record<string, unknown>>;
};

/** The operation of this provider a tool name names (`null`: none of its tools). */
export function providerOperation<P extends McpProvider>(provider: P, tool: string): ProviderOperation<P> | null {
  const op = toolOperation(tool);
  return op !== null && (MCP_TOOLS[provider] as ReadonlyArray<McpOperation>).includes(op) ? (op as ProviderOperation<P>) : null;
}

/** Check a tool's arguments with its input check, then run its handler. */
export async function runTool<P extends McpProvider>(handlers: ToolHandlers<P>, op: ProviderOperation<P>, args: Fields): Promise<Record<string, unknown>> {
  const input = toolInput(op, args);
  const handler = handlers[op] as (input: unknown, args: Fields) => Record<string, unknown> | Promise<Record<string, unknown>>;
  return await handler(input, args);
}
