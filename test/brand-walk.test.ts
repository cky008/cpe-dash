import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionStatusResponse } from "../src/api-contract.ts";
import type { WriteFeature } from "../src/features.ts";
import { MCP_TOOLS, type McpOperation, REST_OPERATIONS, type RestOperation, operationFeatures, restBinding, toolDefinition } from "../src/operations/registry.ts";
import { BRAND_SCENARIOS, type DemoDaemonOptions, startDemoDaemon } from "../scripts/demo-router.ts";

/**
 * Every REST route and MCP tool, on a daemon in front of a router of every brand and form FengSui
 * has a driver for (the demo daemon's worlds: mock routers in this process, nothing leaves it). Where
 * a router lacks a capability, the answer is an error code and a sentence: never a 500, never an
 * exception's own words, never a Huawei endpoint on a router of another brand. A write without
 * `confirm: true` is refused before any session, and a write its owner turned off is told apart from
 * one FengSui has no implementation of.
 */

const TOKEN = "brand_walk_token_0123456789abcdef";
/** Everything open, so that every tool runs as far as the router lets it. */
const ENV = {
  MCP_ALLOW_MUTATIONS: "true",
  MCP_ALLOW_EXPERIMENTAL: "true",
  MCP_ALLOW_ACCESS_CONTROL: "true",
  MCP_SMS_ACCESS: "full",
  MCP_SMS_SEND_POLICY: "any",
  METRICS_ENABLED: "true",
};
type World = NonNullable<DemoDaemonOptions["scenario"]>;
const WORLDS: ReadonlyArray<World> = ["normal", "unverified", ...BRAND_SCENARIOS];
/** A bug's text: an exception's own words, or a value printed that never should be. */
const INTERNAL = /\bundefined\b|TypeError|ReferenceError|RangeError|Cannot read|is not a function|\[object Object\]|\bNaN\b|Invalid key length/;
/** A Huawei router's wording, which a router of another brand should never meet. */
const HILINK = /HiLink|device\/information|\/api\/(?:device|net|user|monitoring|dialup|global)\//;
/** Arguments for the tools that have no REST twin to borrow an example from. */
const TOOL_ARGS: Readonly<Record<string, Record<string, unknown>>> = {
  set_experimental_write: { feature: "reboot", enabled: true },
  probe_router_endpoints: { paths: ["/api/device/information"] },
  get_sms_thread: { threadKey: "+447700900123" },
};

const MCP_OPERATIONS = Object.values(MCP_TOOLS).flat() as ReadonlyArray<McpOperation>;
const isRest = (op: string): op is RestOperation => (REST_OPERATIONS as ReadonlyArray<string>).includes(op);
const exampleOf = (op: string): Record<string, unknown> => (isRest(op) ? (JSON.parse(restBinding(op).example?.replace("…", "") ?? "{}") as Record<string, unknown>) : {});

interface Answer {
  status: number;
  code: string | null;
  message: string;
}

/** The writes of one feature alone: its REST route and its MCP tool, if it has them. */
function writesOf(feature: WriteFeature): { route: RestOperation | null; tool: McpOperation | null } {
  const only = (op: string): boolean => {
    const features = operationFeatures(op as RestOperation);
    return features.length === 1 && features[0] === feature;
  };
  return { route: REST_OPERATIONS.find((op) => restBinding(op).method === "POST" && only(op)) ?? null, tool: MCP_OPERATIONS.find(only) ?? null };
}

async function walk(world: World): Promise<string[]> {
  const demo = await startDemoDaemon({ port: 0, token: TOKEN, scenario: world, env: ENV });
  const base = demo.baseUrl;
  const problems: string[] = [];
  const bearer = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" };
  const rest = async (method: string, path: string, body?: Record<string, unknown>, headers: Record<string, string> = bearer): Promise<Answer> => {
    const res = await fetch(`${base}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = path === "/api/events" ? "" : await res.text();
    if (path === "/api/events") await res.body?.cancel();
    const json = text.startsWith("{") ? (JSON.parse(text) as { errorCode?: unknown; message?: unknown }) : {};
    return { status: res.status, code: typeof json.errorCode === "string" ? json.errorCode : null, message: typeof json.message === "string" ? json.message : "" };
  };
  let id = 0;
  const mcp = async (name: string, args: Record<string, unknown>): Promise<Answer> => {
    const res = await fetch(`${base}/mcp`, { method: "POST", headers: { ...bearer, Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }) });
    const json = (await res.json()) as { error?: { code: number; message: string }; result?: { isError: boolean; structuredContent: { errorCode?: string; message?: string } } };
    if (json.error) return { status: 500, code: `rpc ${json.error.code}`, message: json.error.message };
    const answer = json.result?.structuredContent;
    return { status: json.result?.isError ? 409 : 200, code: answer?.errorCode ?? null, message: answer?.message ?? "" };
  };
  /** A clear answer: a success, or an error with its code and a sentence of plain words. */
  const judge = (where: string, answer: Answer): void => {
    if (answer.status >= 500 && answer.code !== "CPE_UPSTREAM_ERROR") problems.push(`${where}: ${answer.status} ${String(answer.code)} ${answer.message}`);
    else if (answer.status >= 400 && (answer.code === null || answer.message.trim() === "")) problems.push(`${where}: ${answer.status} without a code and a sentence`);
    else if (INTERNAL.test(answer.message)) problems.push(`${where}: ${answer.code ?? ""} ${answer.message}`);
    else if (world !== "normal" && world !== "unverified" && HILINK.test(answer.message)) problems.push(`${where}: Huawei's words on ${world}: ${answer.message}`);
  };
  try {
    await demo.stack.monitor.identifyDevice();
    await Promise.allSettled([demo.stack.monitor.refreshTopology({ ignoreCooldown: true }), demo.stack.monitor.refreshNeighbors({ ignoreCooldown: true })]);
    const device = ((await (await fetch(`${base}/api/session/status`, { headers: bearer })).json()) as SessionStatusResponse).status.device;
    if (device.model === null) problems.push("no model to go by after the identification");

    // Every read
    for (const op of REST_OPERATIONS.filter((o) => restBinding(o).method === "GET")) judge(`GET ${restBinding(op).path}`, await rest("GET", restBinding(op).path));

    // Every write without confirm: refused, before any session
    for (const op of REST_OPERATIONS.filter((o) => restBinding(o).example?.includes('"confirm":true') && !restBinding(o).consoleOnly)) {
      const { confirm: _confirm, ...unconfirmed } = exampleOf(op);
      const answer = await rest("POST", restBinding(op).path, unconfirmed);
      if (answer.status !== 400 || answer.code !== "VALIDATION_ERROR") problems.push(`POST ${restBinding(op).path} without confirm: ${answer.status} ${String(answer.code)}`);
    }
    // (MCP asks the write gate first: a write this router cannot take is refused as such, confirmed or not)
    for (const op of MCP_OPERATIONS.filter((o) => toolDefinition(o).inputSchema.properties["confirm"] !== undefined)) {
      const name = toolDefinition(op).name;
      const answer = await mcp(name, { ...exampleOf(op), ...TOOL_ARGS[name], confirm: false });
      if (!["CONFIRMATION_REQUIRED", "DEVICE_UNVERIFIED_READ_ONLY", "DEVICE_WRITE_DISABLED"].includes(answer.code ?? "")) problems.push(`${name} without confirm: ${String(answer.code)}`);
    }

    // A write its owner turned off, told apart from one FengSui has no implementation of here
    if (device.writes === "experimental") {
      const features = Object.entries(device.features) as Array<[WriteFeature, string]>;
      const off = features.find(([feature, state]) => state === "enabled" && writesOf(feature).route !== null && writesOf(feature).tool !== null)?.[0];
      const absent = features.find(([feature, state]) => state === "not_implemented" && writesOf(feature).route !== null && writesOf(feature).tool !== null)?.[0];
      const consoleHeaders = (cookie: string): Record<string, string> => ({ "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest", Origin: base, Cookie: cookie });
      const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: consoleHeaders(""), body: JSON.stringify({ password: TOKEN }) });
      const cookie = `fengsui_sid=${/fengsui_sid=([0-9a-f]{64})/.exec(login.headers.get("set-cookie") ?? "")?.[1] ?? ""}`;
      if (off) {
        const { route, tool } = writesOf(off);
        assert.equal((await rest("POST", "/api/console/experimental", { feature: off, enabled: false }, consoleHeaders(cookie))).status, 200, `${world}: ${off} off`);
        const byRest = route ? await rest("POST", restBinding(route).path, exampleOf(route)) : null;
        const byMcp = tool ? await mcp(toolDefinition(tool).name, { ...exampleOf(tool), confirm: true }) : null;
        for (const answer of [byRest, byMcp]) if (answer && answer.code !== "DEVICE_WRITE_DISABLED") problems.push(`${off} turned off: ${String(answer.code)} ${answer.message}`);
        assert.equal((await rest("POST", "/api/console/experimental", { feature: off, enabled: true }, consoleHeaders(cookie))).status, 200, `${world}: ${off} on`);
      }
      if (absent) {
        const { route, tool } = writesOf(absent);
        const byRest = route ? await rest("POST", restBinding(route).path, exampleOf(route)) : null;
        const byMcp = tool ? await mcp(toolDefinition(tool).name, { ...exampleOf(tool), confirm: true }) : null;
        for (const answer of [byRest, byMcp]) if (answer && answer.code !== "DEVICE_UNVERIFIED_READ_ONLY") problems.push(`${absent} not implemented: ${String(answer.code)} ${answer.message}`);
      }
    }

    // While the connection is paused: every read still answers, every write gets a code and a sentence, and no session is opened
    const pausing = await rest("POST", "/api/session/pause", { minutes: 15, confirm: true });
    if (pausing.status !== 200) problems.push(`pausing: ${pausing.status} ${String(pausing.code)} ${pausing.message}`);
    // A background read that was running as the pause began ends as it would have: count from after it
    if (!(await demo.stack.scheduler.whenSessionEnds(10_000))) problems.push("a session that began before the pause was still running 10 s later");
    const sessionsBefore = demo.stack.scheduler.getStatus().totalSessionsCompleted;
    let refusedAsPaused = 0;
    for (const op of REST_OPERATIONS.filter((o) => restBinding(o).method === "GET")) judge(`GET ${restBinding(op).path} while paused`, await rest("GET", restBinding(op).path));
    for (const op of REST_OPERATIONS.filter((o) => restBinding(o).method === "POST" && operationFeatures(o).length > 0)) {
      const answer = await rest("POST", restBinding(op).path, exampleOf(op));
      judge(`POST ${restBinding(op).path} while paused`, answer);
      if (answer.code === "ROUTER_PAUSED") refusedAsPaused += 1;
    }
    for (const op of MCP_OPERATIONS.filter((o) => operationFeatures(o).length > 0)) {
      const definition = toolDefinition(op);
      const answer = await mcp(definition.name, { ...exampleOf(op), ...TOOL_ARGS[definition.name], confirm: true });
      judge(`${definition.name} while paused`, answer);
      if (answer.code === "ROUTER_PAUSED") refusedAsPaused += 1;
    }
    if (demo.stack.scheduler.getStatus().totalSessionsCompleted !== sessionsBefore) problems.push("a session was opened on the router while the connection was paused");
    if (refusedAsPaused === 0) problems.push("no write was refused as paused");
    const resuming = await rest("POST", "/api/session/resume", { confirm: true });
    if (resuming.status !== 200) problems.push(`resuming: ${resuming.status} ${String(resuming.code)} ${resuming.message}`);

    // Every write, as its example says, the reboot last (the household's router goes away for a while after it)
    const writes = REST_OPERATIONS.filter((op) => restBinding(op).method === "POST");
    for (const op of [...writes.filter((o) => o !== "reboot"), ...writes.filter((o) => o === "reboot")]) {
      judge(`POST ${restBinding(op).path}`, await rest("POST", restBinding(op).path, exampleOf(op)));
    }
    // Every tool by name, listed on this router or not
    for (const op of [...MCP_OPERATIONS.filter((o) => o !== "reboot"), ...MCP_OPERATIONS.filter((o) => o === "reboot")]) {
      const definition = toolDefinition(op);
      const args = { ...exampleOf(op), ...TOOL_ARGS[definition.name], ...(definition.inputSchema.properties["confirm"] === undefined ? {} : { confirm: true }) };
      judge(definition.name, await mcp(definition.name, args));
    }
  } finally {
    await demo.close();
  }
  return problems.map((problem) => `${world}: ${problem}`);
}

describe("every route and tool on a router of every brand", { concurrency: true }, () => {
  for (const world of WORLDS) {
    it(`answers on ${world} with a code and a sentence where the router cannot, and keeps the write gate`, async () => {
      assert.deepEqual(await walk(world), []);
    });
  }
});
