import { TOKEN_PERMISSIONS, type TokenPermission, permissionsForScope } from "./console-policy.ts";
import type { FengSuiCore } from "./core.ts";
import { CpeControlValidationError } from "./cpe-domain.ts";
import { WRITE_FEATURES, type WriteFeature } from "./device-access.ts";
import { parseJsonSafeNullProto } from "./json-safe.ts";
import { type AgentExperimentalOptions, CoreMcpTools } from "./mcp-core-tools.ts";
import { MCP_META_PROTOCOL_VERSION, MCP_META_SERVER_INFO, decodeMcpHeaderValue, mcpNameOf } from "./mcp-headers.ts";
import { validateToolArguments } from "./mcp-schema.ts";
import { McpToolError, type McpToolDefinition, type McpToolProvider } from "./mcp-tool-provider.ts";
import {
  type AvoidanceBroadcastPayload,
  BrowserSessionYieldedError,
  CircuitBreakerOpenError,
  DeviceNotIdentifiedError,
  DeviceReadOnlyError,
  type MutexSessionScheduler,
  PeerDaemonStandbyError,
  SchedulerQueueFullError,
  SchedulerStoppedError,
} from "./scheduler.ts";
import type { SelfHealStatus } from "./self-heal-status.ts";
import { TimeSeriesValidationError } from "./timeseries.ts";
import { FENGSUI_VERSION } from "./version.ts";

/**
 * Protocol revisions this server implements, newest first. `2026-07-28` is stateless: each request
 * carries its version in `_meta`, `server/discover` replaces the `initialize` handshake, and results
 * carry `resultType`. The older revisions keep the `initialize` flow (dual-era server).
 */
export const SUPPORTED_MCP_PROTOCOL_VERSIONS = [
  "2026-07-28",
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
] as const;

export const LATEST_MCP_PROTOCOL_VERSION = SUPPORTED_MCP_PROTOCOL_VERSIONS[0];
/** Stateless revisions (no `initialize`; version, client info and capabilities in every request's `_meta`). */
export const MODERN_MCP_PROTOCOL_VERSIONS: ReadonlyArray<string> = ["2026-07-28"];
/** `initialize` is the legacy handshake, so it negotiates at most this revision. */
export const LATEST_LEGACY_MCP_PROTOCOL_VERSION = "2025-11-25";
/** JSON-RPC errors defined by 2026-07-28. */
export const MCP_HEADER_MISMATCH = -32020;
export const MCP_UNSUPPORTED_PROTOCOL_VERSION = -32022;
/** Resource not found: `-32002` up to 2025-11-25, `-32602` (Invalid params) since 2026-07-28. */
export const MCP_LEGACY_RESOURCE_NOT_FOUND = -32002;

/** Removed by 2026-07-28 (stateless core): a modern request for one is an unknown method. */
const REMOVED_IN_MODERN: ReadonlySet<string> = new Set(["initialize", "ping", "logging/setLevel"]);

/**
 * `ttlMs` for the 2026-07-28 `CacheableResult`s. Lists change only when the router does (another
 * model, a section it turns out to lack), and every call is checked again on the server; resource
 * contents are live router data. `cacheScope` is always `private`: results belong to one API token.
 */
const MODERN_CACHE_TTL_MS: Readonly<Record<string, number>> = {
  "server/discover": 300_000,
  "tools/list": 300_000,
  "resources/list": 300_000,
  "resources/read": 0,
};

/** Routing headers of a Streamable HTTP POST (`MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`). */
export interface McpHttpRequestHeaders {
  protocolVersion?: string;
  method?: string;
  name?: string;
}

/** A JSON-RPC answer plus the HTTP status the Streamable HTTP transport must use for it. */
export interface McpHttpOutcome {
  status: number;
  body: JsonRpcResponse | null;
}

const SERVER_INFO = {
  name: "fengsui-cpe-dash",
  title: "FengSui (烽燧) Huawei H168-383 5G CPE MCP Server",
  version: FENGSUI_VERSION,
} as const;

function isSupportedVersion(version: string): boolean {
  return (SUPPORTED_MCP_PROTOCOL_VERSIONS as ReadonlyArray<string>).includes(version);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcSuccessResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

/** What the caller's token may do (a trusted caller: everything). */
type Grant = ReadonlySet<TokenPermission>;
const FULL_GRANT: Grant = new Set(TOKEN_PERMISSIONS);

/** `true` stands for a read token (it reads SMS), `false` for a trusted caller; a list is the token's permissions. */
function grantOf(access: boolean | ReadonlyArray<TokenPermission>): Grant {
  if (Array.isArray(access)) return new Set(access);
  return access === true ? new Set(permissionsForScope("read")) : FULL_GRANT;
}

/** The permission a tool needs: the provider's word, else `control` for a write and none for a read. */
function permissionFor(provider: McpToolProvider, toolName: string): TokenPermission | null {
  return provider.requiredPermission ? provider.requiredPermission(toolName) : provider.isMutating(toolName) ? "control" : null;
}

function mayUse(grant: Grant, provider: McpToolProvider, toolName: string): boolean {
  const needed = permissionFor(provider, toolName);
  return needed === null || grant.has(needed);
}

function mayRead(grant: Grant, provider: McpToolProvider, uri: string): boolean {
  const needed = provider.resourcePermission?.(uri) ?? null;
  return needed === null || grant.has(needed);
}

export interface FengSuiMcpServerOptions {
  /** Served by the built-in `CoreMcpTools` provider, which always comes first. */
  core: FengSuiCore;
  /**
   * List and run the write tools (the console's master switch, else `MCP_ALLOW_MUTATIONS`; read per call so a
   * change applies at once); left out, they stay hidden and refused, as by default.
   */
  allowMutations?: boolean | (() => boolean);
  /**
   * Whether core tools return REDACT_SENSITIVE_IN_API copies of telemetry and topology; read per
   * call so a `.env` reload applies (default: always redact).
   */
  redactSensitive?: () => boolean;
  /** Further domain providers (e.g. `SmsMcpTools`). */
  toolProviders?: ReadonlyArray<McpToolProvider>;
  /** What WAN self-healing will do next, for `get_cpe_session_status` (default: off). */
  selfHealStatus?: () => SelfHealStatus;
  /** Agents testing experimental writes on a model nobody verified (`set_experimental_write`); absent: never offered. */
  experimental?: AgentExperimentalOptions;
}

/**
 * Zero-dependency Model Context Protocol (MCP) JSON-RPC 2.0 server, mounted by the serve daemon on
 * Streamable HTTP (`POST /mcp`). Stdio-only agents reach it through `cpe-dash mcp`
 * (`McpStdioBridge`), so every tool call shares the daemon's single CPE session scheduler.
 *
 * This class is the protocol engine (versions, routing headers, confirmation and schema gates, the
 * mutation switch, error mapping); the tools and resources come from `McpToolProvider`s.
 */
export class FengSuiMcpServer {
  readonly #allowMutations: () => boolean;
  /** `CoreMcpTools` followed by the configured domain providers, in listing order. */
  readonly toolProviders: ReadonlyArray<McpToolProvider>;
  /** Attached to `BROWSER_SESSION_YIELDED` tool errors. */
  readonly #avoidanceState: () => AvoidanceBroadcastPayload;
  /** The write gate's view of the router (a read-only model hides and refuses the router writes). */
  readonly #scheduler: MutexSessionScheduler;

  get allowMutations(): boolean {
    return this.#allowMutations();
  }

  constructor(options: FengSuiMcpServerOptions) {
    const allow = options.allowMutations;
    this.#allowMutations = typeof allow === "function" ? allow : () => allow === true;
    this.toolProviders = [
      new CoreMcpTools(options.core, { redactSensitive: options.redactSensitive, selfHealStatus: options.selfHealStatus, experimental: options.experimental }),
      ...(options.toolProviders ?? []),
    ];
    const { scheduler } = options.core;
    this.#scheduler = scheduler;
    this.#avoidanceState = () => scheduler.getAvoidanceState();
  }

  /**
   * Tools this caller may see: mutating tools are hidden by `MCP_ALLOW_MUTATIONS=false` and for
   * read-only tokens; on a router of an unverified model, router writes unless their features are
   * open there (phase 3: then in their experimental form); and tools for what this router turned
   * out not to provide.
   */
  getToolDefinitions(access: boolean | ReadonlyArray<TokenPermission> = false): ReadonlyArray<McpToolDefinition> {
    const grant = grantOf(access);
    return this.toolProviders.flatMap((p) =>
      p
        .getToolDefinitions()
        .filter((tool) => mayUse(grant, p, tool.name) && (this.allowMutations || !p.isMutating(tool.name)) && (p.isAvailable?.(tool.name) ?? true))
        .flatMap((tool) => {
          const shown = this.#onThisRouter(p, tool);
          return shown.definition ? [shown.definition] : [];
        })
    );
  }

  /**
   * How a tool shows on this router. Not a router write, a verified model or no model yet: as it is
   * (the scheduler still checks the model before the write). On a model nobody verified, a router
   * write shows only while each of its features is open there, then in its generic form, marked
   * experimental (or verified by users) and asking for `confirm: true`; `refused` names the first
   * feature that is not open.
   */
  #onThisRouter(provider: McpToolProvider, tool: McpToolDefinition): { definition: McpToolDefinition | null; refused: WriteFeature | null } {
    const device = this.#scheduler.device;
    if (!isRouterWrite(provider, tool.name) || device.writes !== "read_only") return { definition: tool, refused: null };
    const features = provider.routerWriteFeatures?.(tool.name) ?? [];
    const refused = features.length === 0 ? null : (features.find((feature) => device.writeAccess(feature) === "read_only") ?? null);
    if (features.length === 0 || refused) return { definition: null, refused };
    const experimental = features.some((feature) => device.writeAccess(feature) === "experimental");
    const model = device.snapshot().model ?? "?";
    const generic = provider.adaptForGenericWrite?.(tool, { lteBands: device.experimentalLteBands }) ?? tool;
    const required = generic.inputSchema.required ?? [];
    return {
      refused: null,
      definition: {
        ...generic,
        description: `${experimental ? "EXPERIMENTAL" : "VERIFIED BY USERS"} on this router (${model}, a model FengSui was not verified on${experimental ? "; its owner turned this write on in Settings → Device, and every result is read back" : ""}): ${generic.description} Pass confirm: true only when the user explicitly asked for this exact change.`,
        inputSchema: {
          ...generic.inputSchema,
          properties: {
            ...generic.inputSchema.properties,
            confirm: generic.inputSchema.properties["confirm"] ?? { type: "boolean", description: "Must be true: a write on a model FengSui was not verified on." },
          },
          required: required.includes("confirm") ? required : [...required, "confirm"],
        },
      },
    };
  }

  isSupportedProtocolVersion(version: string | undefined): boolean {
    if (!version) return true;
    return (SUPPORTED_MCP_PROTOCOL_VERSIONS as ReadonlyArray<string>).includes(version.trim());
  }

  /**
   * Process a raw JSON-RPC 2.0 string message (stdio semantics: errors are JSON-RPC errors).
   * Returns `null` when the message is a valid JSON-RPC notification (`id === undefined`).
   */
  async handleRawJsonMessage(rawText: string): Promise<JsonRpcResponse | null> {
    return (await this.#handle(rawText, null, FULL_GRANT)).body;
  }

  /**
   * Process a Streamable HTTP POST body. Adds the 2026-07-28 transport rules: the routing headers
   * must mirror the body (`400` + `-32020` otherwise), unsupported versions answer `400` + `-32022`,
   * and a modern request for an unknown method answers `404`. Legacy requests keep `200` throughout.
   */
  /**
   * `permissions`: what the caller's token may do (it sees and calls only that); `readOnly` stands for a
   * read token's (SMS reading); neither: everything (a trusted caller).
   */
  async handleHttpMessage(
    rawText: string,
    headers: McpHttpRequestHeaders,
    opts: { readOnly?: boolean; permissions?: ReadonlyArray<TokenPermission> } = {}
  ): Promise<McpHttpOutcome> {
    return await this.#handle(rawText, headers, grantOf(opts.permissions ?? opts.readOnly === true));
  }

  async #handle(rawText: string, http: McpHttpRequestHeaders | null, grant: Grant): Promise<McpHttpOutcome> {
    const reply = (status: number, id: JsonRpcId, code: number, message: string, data?: unknown): McpHttpOutcome => ({
      status,
      body: { jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } },
    });
    let parsed: unknown;
    try {
      parsed = parseJsonSafeNullProto(rawText);
    } catch {
      return reply(200, null, -32700, "Parse error: invalid JSON");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return reply(200, null, -32600, "Invalid Request: expected single JSON-RPC 2.0 object (batches disabled)");
    }
    const req = parsed as Partial<JsonRpcRequest>;
    const hasId = Object.prototype.hasOwnProperty.call(req, "id") && req.id !== undefined;
    if (hasId && typeof req.id !== "string" && typeof req.id !== "number") {
      return reply(200, null, -32600, "Invalid JSON-RPC id: must be string or number");
    }
    const rpcId: JsonRpcId = hasId ? (req.id as string | number) : null;
    if (req.jsonrpc !== "2.0" || typeof req.method !== "string" || !req.method) {
      return reply(200, rpcId, -32600, "Invalid JSON-RPC 2.0 envelope");
    }
    const method = req.method;
    const params = asRecord(req.params) ?? (Object.create(null) as Record<string, unknown>);

    // Notifications (e.g. `notifications/initialized`, `notifications/cancelled`) produce no response
    if (!hasId) {
      return { status: 202, body: null };
    }

    const metaVersion = asRecord(params["_meta"])?.[MCP_META_PROTOCOL_VERSION];
    const requested = typeof metaVersion === "string" ? metaVersion : undefined;
    const unsupported = (version: string): McpHttpOutcome =>
      reply(http ? 400 : 200, rpcId, MCP_UNSUPPORTED_PROTOCOL_VERSION, "Unsupported protocol version", {
        supported: [...SUPPORTED_MCP_PROTOCOL_VERSIONS],
        requested: version,
      });
    const headerVersion = http?.protocolVersion?.trim() || undefined;
    if (headerVersion !== undefined && !isSupportedVersion(headerVersion)) return unsupported(headerVersion);
    if (requested !== undefined && !isSupportedVersion(requested)) return unsupported(requested);
    const modern = requested !== undefined && MODERN_MCP_PROTOCOL_VERSIONS.includes(requested);

    if (http && (requested !== undefined || (headerVersion !== undefined && MODERN_MCP_PROTOCOL_VERSIONS.includes(headerVersion)))) {
      const mismatch = (message: string): McpHttpOutcome => reply(400, rpcId, MCP_HEADER_MISMATCH, `Header mismatch: ${message}`);
      if (headerVersion === undefined) return mismatch("missing MCP-Protocol-Version header");
      if (requested === undefined) return mismatch(`MCP-Protocol-Version ${headerVersion} but the body _meta carries no protocol version`);
      if (headerVersion !== requested) return mismatch(`MCP-Protocol-Version header ${headerVersion} does not match body ${requested}`);
      if (modern) {
        if (!http.method) return mismatch("missing Mcp-Method header");
        if (http.method !== method) return mismatch(`Mcp-Method header value '${http.method}' does not match body value '${method}'`);
        const bodyName = mcpNameOf(method, params);
        if (bodyName !== null) {
          const headerName = http.name === undefined ? undefined : decodeMcpHeaderValue(http.name);
          if (headerName === undefined) return mismatch("missing Mcp-Name header");
          if (headerName !== bodyName) return mismatch(`Mcp-Name header value '${headerName ?? "?"}' does not match body value '${bodyName}'`);
        }
      }
    }

    try {
      if (modern && REMOVED_IN_MODERN.has(method)) {
        throw new McpProtocolRpcError(-32601, `Method not found: ${method} (removed in ${requested})`);
      }
      const result = await this.#dispatchMethod(method, params, modern, grant);
      // Stateless results declare their completion, cacheability and the server in `_meta`
      const ttlMs = MODERN_CACHE_TTL_MS[method];
      const body = modern
        ? {
            ...(asRecord(result) ?? {}),
            ...(ttlMs !== undefined ? { ttlMs, cacheScope: "private" } : {}),
            resultType: "complete",
            _meta: { ...(asRecord(asRecord(result)?.["_meta"]) ?? {}), [MCP_META_SERVER_INFO]: { ...SERVER_INFO } },
          }
        : result;
      return { status: 200, body: { jsonrpc: "2.0", id: rpcId, result: body } };
    } catch (err) {
      if (err instanceof McpProtocolRpcError) {
        return reply(http && modern && err.code === -32601 ? 404 : 200, rpcId, err.code, err.message, err.data);
      }
      return reply(200, rpcId, -32603, err instanceof Error ? err.message : "Internal MCP error");
    }
  }

  #instructions(): string {
    const device = this.#scheduler.device;
    const model = device.snapshot().model ?? "?";
    const open = WRITE_FEATURES.filter((feature) => device.writeAccess(feature) !== "read_only");
    let readOnly: string[] = [];
    if (device.writes === "read_only") {
      readOnly =
        open.length === 0
          ? [`This router (${model}) is a model FengSui was not verified on: it is read-only, so no tool can change it.`]
          : [
              `This router (${model}) is a model FengSui was not verified on: it is read-only except the experimental writes its owner turned on (${open.join(", ")}). Their tools say so and need confirm: true; pass it only when the user explicitly asked for that exact change.`,
            ];
    }
    return [...this.toolProviders.flatMap((p) => (p.instructions ? [p.instructions()] : [])), ...readOnly].filter(Boolean).join(" ");
  }

  async #dispatchMethod(method: string, params: Record<string, unknown>, modern: boolean, grant: Grant): Promise<unknown> {
    switch (method) {
      case "initialize": {
        const requestedVer =
          typeof params["protocolVersion"] === "string" ? params["protocolVersion"] : "";
        const negotiated =
          isSupportedVersion(requestedVer) && !MODERN_MCP_PROTOCOL_VERSIONS.includes(requestedVer)
            ? requestedVer
            : LATEST_LEGACY_MCP_PROTOCOL_VERSION;

        return {
          protocolVersion: negotiated,
          capabilities: {
            tools: { listChanged: false },
            resources: { subscribe: false, listChanged: false },
          },
          serverInfo: { ...SERVER_INFO },
          instructions: this.#instructions(),
        };
      }

      case "server/discover":
        // A DiscoverResult is a CacheableResult whatever version the probe declared
        return {
          resultType: "complete",
          ttlMs: MODERN_CACHE_TTL_MS["server/discover"],
          cacheScope: "private",
          supportedVersions: [...SUPPORTED_MCP_PROTOCOL_VERSIONS],
          capabilities: {
            tools: { listChanged: false },
            resources: { subscribe: false, listChanged: false },
          },
          instructions: this.#instructions(),
          _meta: { [MCP_META_SERVER_INFO]: { ...SERVER_INFO } },
        };

      case "ping":
        return {};

      case "tools/list":
        return {
          tools: this.getToolDefinitions([...grant]),
        };

      case "tools/call": {
        const toolName = typeof params["name"] === "string" ? params["name"] : "";
        const rawArgs = params["arguments"];
        const args =
          rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
            ? (rawArgs as Record<string, unknown>)
            : (Object.create(null) as Record<string, unknown>);
        return await this.#executeToolCall(toolName, args, grant);
      }

      case "resources/list":
        return { resources: this.toolProviders.flatMap((p) => (p.listResources?.() ?? []).filter((r) => mayRead(grant, p, r.uri))) };

      case "resources/read": {
        const uri = typeof params["uri"] === "string" ? params["uri"] : "";
        // A resource the token may not read is answered as one that does not exist
        const data = this.toolProviders.map((p) => (mayRead(grant, p, uri) ? p.readResource?.(uri) : undefined)).find((value) => value !== undefined);
        if (data === undefined) {
          throw new McpProtocolRpcError(modern ? -32602 : MCP_LEGACY_RESOURCE_NOT_FOUND, `Resource not found: "${uri}"`, { uri });
        }
        return {
          contents: [
            {
              uri,
              mimeType: "application/json",
              text: JSON.stringify(data, null, 2),
            },
          ],
        };
      }

      default:
        throw new McpProtocolRpcError(-32601, `Method not found: ${method}`);
    }
  }

  async #executeToolCall(
    toolName: string,
    args: Record<string, unknown>,
    grant: Grant
  ): Promise<{
    content: Array<{ type: "text"; text: string }>;
    structuredContent: Record<string, unknown>;
    isError: boolean;
  }> {
    const wrapOk = (payload: Record<string, unknown>) => ({
      content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
      structuredContent: payload,
      isError: false,
    });

    const wrapErr = (code: string, message: string, extra: Record<string, unknown> = {}) => {
      const payload = { ok: false, errorCode: code, message, ...extra };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
        structuredContent: payload,
        isError: true,
      };
    };

    const provider = this.toolProviders.find((p) => p.handles(toolName));
    const needed = provider ? permissionFor(provider, toolName) : null;
    if (provider && needed !== null && !grant.has(needed)) {
      // A token that may change nothing keeps the old answer; another one is told what it lacks
      const changesNothing = [...grant].every((permission) => permission === "sms-read");
      return provider.isMutating(toolName) && changesNothing
        ? wrapErr("READ_ONLY_TOKEN", "This Bearer token is read-only; mutating tools need a token allowed to make the change (set in the console under Settings → Tokens)")
        : wrapErr("TOKEN_NOT_PERMITTED", `This token may not use ${toolName}: it needs the "${needed}" permission (set in the console under Settings → Tokens)`, { permission: needed });
    }
    if (provider?.isMutating(toolName) && !this.allowMutations) {
      return wrapErr(
        "MUTATIONS_DISABLED",
        "Mutating MCP tools are disabled by server configuration (MCP_ALLOW_MUTATIONS=false)"
      );
    }
    // The write gate, before anything else touches the call (the scheduler refuses it as well); the
    // tool's contract is the one this router shows (an experimental write asks for confirm)
    const listed = provider?.getToolDefinitions().find((tool) => tool.name === toolName);
    const shown = provider && listed ? this.#onThisRouter(provider, listed) : null;
    if (provider && listed && shown?.definition === null) {
      const refused = new DeviceReadOnlyError(this.#scheduler.device.snapshot().model ?? "?", shown.refused);
      return wrapErr("DEVICE_UNVERIFIED_READ_ONLY", refused.messageEn, { messageZh: refused.messageZh, model: refused.model, feature: refused.feature });
    }
    // Enforce the advertised contract before any work: explicit confirmation first, then the schema
    // (also for a tool left out of the list because this router lacks what it reads: called by name, it still runs)
    const definition = shown?.definition ?? listed;
    if (definition) {
      if (definition.inputSchema.properties["confirm"] !== undefined && args["confirm"] !== true) {
        return wrapErr("CONFIRMATION_REQUIRED", `${toolName} requires explicit { confirm: true }`);
      }
      const violation = validateToolArguments(definition.inputSchema, args);
      if (violation) {
        return wrapErr("VALIDATION_ERROR", `Invalid arguments for ${toolName}: ${violation}`);
      }
    }

    try {
      if (!provider) {
        throw new McpProtocolRpcError(-32602, `Unknown MCP tool "${toolName}"`);
      }
      return wrapOk(await provider.execute(toolName, args));
    } catch (err) {
      if (err instanceof McpProtocolRpcError) {
        throw err;
      }
      if (err instanceof BrowserSessionYieldedError) {
        return wrapErr("BROWSER_SESSION_YIELDED", err.messageEn, {
          messageZh: err.messageZh,
          avoidance: this.#avoidanceState(),
        });
      }
      if (err instanceof PeerDaemonStandbyError) {
        return wrapErr("PEER_DAEMON_ACTIVE", err.message, { peerAddress: err.peerAddress });
      }
      if (err instanceof DeviceReadOnlyError) {
        return wrapErr("DEVICE_UNVERIFIED_READ_ONLY", err.messageEn, { messageZh: err.messageZh, model: err.model, feature: err.feature });
      }
      if (err instanceof DeviceNotIdentifiedError) {
        return wrapErr("DEVICE_NOT_IDENTIFIED", err.messageEn, { messageZh: err.messageZh });
      }
      if (err instanceof CircuitBreakerOpenError) {
        return wrapErr("CIRCUIT_BREAKER_OPEN", err.message, { circuitBreaker: err.circuitBreaker });
      }
      if (err instanceof SchedulerQueueFullError || err instanceof SchedulerStoppedError) {
        return wrapErr("QUEUE_FULL", err.message);
      }
      if (err instanceof CpeControlValidationError || err instanceof TimeSeriesValidationError) {
        return wrapErr("VALIDATION_ERROR", err.message);
      }
      if (err instanceof McpToolError) {
        return wrapErr(err.code, err.message, { ...err.details });
      }
      return wrapErr(
        "CPE_EXECUTION_ERROR",
        err instanceof Error ? err.message : String(err)
      );
    }
  }
}

function isRouterWrite(provider: McpToolProvider, toolName: string): boolean {
  return provider.isRouterWrite?.(toolName) ?? provider.isMutating(toolName);
}

class McpProtocolRpcError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "McpProtocolRpcError";
    this.code = code;
    this.data = data;
  }
}
