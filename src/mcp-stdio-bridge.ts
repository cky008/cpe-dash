import type { Readable, Writable } from "node:stream";
import { readBoundedResponseText } from "./http-body.ts";
import { parseJsonSafeNullProto } from "./json-safe.ts";
import { MCP_META_PROTOCOL_VERSION, encodeMcpHeaderValue, mcpNameOf } from "./mcp-headers.ts";

/**
 * A zero-state stdio <-> Streamable HTTP bridge for local agents that only speak stdio: `cpe-dash mcp`
 * and the Claude Desktop extension (`desktop-extension.ts`) run it. Each NDJSON line is POSTed to the
 * serve daemon's `/mcp` with the Bearer API_TOKEN and the daemon's answer is written back as one line.
 *
 * This process never creates a CPE client, scheduler or store: the daemon's `MutexSessionScheduler`
 * stays the only path to the router's single admin session. (A second in-process scheduler could
 * not see the daemon's mutex, so the two processes would take turns logging in, yield to each
 * other as if the other were a human, keep separate breakers and overwrite the same state file.)
 */

export const MAX_STDIO_LINE_BYTES = 64 * 1024;
const MAX_DAEMON_RESPONSE_BYTES = 8 * 1024 * 1024;
const DEFAULT_FORWARD_TIMEOUT_MS = 5 * 60_000;

/**
 * JSON-RPC errors returned by the bridge itself, in the implementation-defined range (-32000..-32019)
 * but clear of the SDKs' -32000/-32001 and the pre-2026 resource-not-found -32002.
 */
export const BRIDGE_DAEMON_UNREACHABLE = -32010;
export const BRIDGE_DAEMON_REJECTED = -32011;
/** The bridge has no usable daemon address or token, so it forwards nothing (the Claude Desktop extension). */
export const BRIDGE_NOT_SET_UP = -32012;

/**
 * Split an NDJSON byte stream into lines. A line longer than `maxLineBytes` is never buffered:
 * `onOversized` fires once and the rest of that line is discarded up to the next newline.
 */
export function attachNdjsonLineReader(
  input: Readable,
  handlers: { onLine: (line: string) => void; onOversized: () => void },
  maxLineBytes = MAX_STDIO_LINE_BYTES
): () => void {
  let chunks: Buffer[] = [];
  let bufferedBytes = 0;
  let discardingOversized = false;

  const onData = (rawChunk: Buffer | string): void => {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk, "utf8");
    let offset = 0;
    while (offset < chunk.length) {
      const nlIdx = chunk.indexOf(0x0a, offset);
      if (discardingOversized) {
        if (nlIdx === -1) return;
        discardingOversized = false;
        offset = nlIdx + 1;
        continue;
      }
      if (nlIdx === -1) {
        const rem = chunk.subarray(offset);
        if (bufferedBytes + rem.length > maxLineBytes) {
          chunks = [];
          bufferedBytes = 0;
          discardingOversized = true;
          handlers.onOversized();
          return;
        }
        chunks.push(rem);
        bufferedBytes += rem.length;
        return;
      }
      const seg = chunk.subarray(offset, nlIdx);
      offset = nlIdx + 1;
      if (bufferedBytes + seg.length > maxLineBytes) {
        chunks = [];
        bufferedBytes = 0;
        handlers.onOversized();
        continue;
      }
      const lineBuf = chunks.length === 0 ? seg : Buffer.concat([...chunks, seg], bufferedBytes + seg.length);
      chunks = [];
      bufferedBytes = 0;
      const trimmed = lineBuf.toString("utf8").trim();
      if (trimmed) handlers.onLine(trimmed);
    }
  };

  input.on("data", onData);
  return () => {
    input.off("data", onData);
    chunks = [];
    bufferedBytes = 0;
  };
}

/** What the person can do about a failure, appended to the error the agent shows. */
export interface BridgeHints {
  /** The daemon could not be reached. */
  unreachable: string;
  /** The daemon refused the token (HTTP 401). */
  unauthorized?: string;
}

/** `cpe-dash mcp` runs next to the daemon (same host or container). */
const CLI_HINTS: BridgeHints = { unreachable: 'Start "cpe-dash serve": it is the only process that talks to the CPE.' };

export interface McpStdioBridgeOptions {
  /** Daemon `/mcp` URL (`AppConfig.mcpDaemonUrl`). */
  daemonUrl: string;
  apiToken: string;
  fetchImpl?: typeof fetch;
  /** Upper bound per forwarded request (tool calls queue behind the daemon's CPE sessions). */
  requestTimeoutMs?: number;
  log?: (line: string) => void;
  hints?: BridgeHints;
}

/** Answers one NDJSON line: the bridge, or a stand-in that only explains why nothing is forwarded. */
export interface StdioForwarder {
  /** The response line, or `null` for a notification. */
  forward(line: string): Promise<string | null>;
}

function rpcError(id: string | number | null, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** The request id of one line (`null` for a malformed line, which still gets an answer), or `undefined` for a notification. */
function requestIdOf(line: string): string | number | null | undefined {
  try {
    const rawId = asRecord(parseJsonSafeNullProto(line))?.["id"];
    return typeof rawId === "string" || typeof rawId === "number" ? rawId : undefined;
  } catch {
    return null;
  }
}

/**
 * Answers every request with the same JSON-RPC error and forwards nothing: the Claude Desktop extension runs this
 * when its settings are unusable, so the agent shows the person what to fix instead of a silent failure.
 */
export function refusingForwarder(code: number, message: string): StdioForwarder {
  return {
    forward: async (line) => {
      const id = requestIdOf(line);
      return id === undefined ? null : rpcError(id, code, message);
    },
  };
}

export class McpStdioBridge implements StdioForwarder {
  readonly daemonUrl: string;
  readonly #apiToken: string;
  readonly #fetchImpl: typeof fetch;
  readonly #timeoutMs: number;
  readonly #log: (line: string) => void;
  readonly #hints: BridgeHints;
  /** Negotiated protocol revision, echoed as `MCP-Protocol-Version` after `initialize`. */
  #protocolVersion: string | null = null;

  constructor(options: McpStdioBridgeOptions) {
    this.daemonUrl = options.daemonUrl;
    this.#apiToken = options.apiToken;
    this.#fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.#timeoutMs = options.requestTimeoutMs ?? DEFAULT_FORWARD_TIMEOUT_MS;
    this.#log = options.log ?? (() => undefined);
    this.#hints = options.hints ?? CLI_HINTS;
  }

  /**
   * Forward one JSON-RPC line. Resolves the response line, or `null` for notifications. Daemon
   * failures become JSON-RPC errors for the request's `id`, so the agent always gets an answer.
   */
  async forward(line: string): Promise<string | null> {
    let id: string | number | null = null;
    let isRequest = false;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${this.#apiToken}`,
    };
    let requestVersion: string | undefined;
    try {
      const envelope = asRecord(parseJsonSafeNullProto(line));
      const rawId = envelope?.["id"];
      if (typeof rawId === "string" || typeof rawId === "number") {
        id = rawId;
        isRequest = true;
      }
      // Mirror the routing fields into the Streamable HTTP headers (required by 2026-07-28)
      const method = envelope?.["method"];
      const params = asRecord(envelope?.["params"]) ?? {};
      const metaVersion = asRecord(params["_meta"])?.[MCP_META_PROTOCOL_VERSION];
      if (typeof metaVersion === "string") requestVersion = metaVersion;
      if (typeof method === "string" && /^[\x21-\x7e]+$/.test(method)) {
        headers["Mcp-Method"] = method;
        const name = mcpNameOf(method, params);
        if (name !== null) headers["Mcp-Name"] = encodeMcpHeaderValue(name);
      }
    } catch {
      // Malformed JSON is forwarded as-is so the daemon answers it with its own -32700
      isRequest = true;
    }
    const version = requestVersion ?? this.#protocolVersion;
    if (version && /^[\x21-\x7e]{1,64}$/.test(version)) headers["MCP-Protocol-Version"] = version;

    let res: Response;
    try {
      res = await this.#fetchImpl(this.daemonUrl, {
        method: "POST",
        headers,
        body: line,
        redirect: "error",
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (err) {
      // An error about the request (a header fetch would not send, say) can quote it: never pass the token on
      const raw = err instanceof Error ? err.message : String(err);
      const reason = this.#apiToken ? raw.replaceAll(this.#apiToken, "<token>") : raw;
      this.#log(`[fengsui-mcp] daemon unreachable at ${this.daemonUrl}: ${reason}`);
      return isRequest ? rpcError(id, BRIDGE_DAEMON_UNREACHABLE, `FengSui daemon unreachable at ${this.daemonUrl} (${reason}). ${this.#hints.unreachable}`) : null;
    }

    if (res.status === 202) {
      await res.body?.cancel().catch(() => undefined);
      return null;
    }
    let payload: Record<string, unknown> | null = null;
    try {
      payload = asRecord(parseJsonSafeNullProto(await readBoundedResponseText(res, MAX_DAEMON_RESPONSE_BYTES)));
    } catch {
      payload = null;
    }
    if (payload?.["jsonrpc"] === "2.0") {
      const negotiated = asRecord(payload["result"])?.["protocolVersion"];
      if (typeof negotiated === "string") this.#protocolVersion = negotiated;
      return JSON.stringify(payload);
    }
    // An ApiErrorEnvelope (401 token, 404 MCP disabled, 421 host, 429 rate limit, ...)
    const code = typeof payload?.["errorCode"] === "string" ? payload["errorCode"] : "UNEXPECTED_RESPONSE";
    const message = typeof payload?.["message"] === "string" ? payload["message"] : "";
    this.#log(`[fengsui-mcp] daemon rejected the request: HTTP ${res.status} ${code}`);
    const hint = res.status === 401 && this.#hints.unauthorized ? ` ${this.#hints.unauthorized}` : "";
    return isRequest
      ? rpcError(id, BRIDGE_DAEMON_REJECTED, `FengSui daemon rejected the request (HTTP ${res.status} ${code})${message ? `: ${message}` : ""}${hint}`)
      : null;
  }

  /**
   * Serve NDJSON on `input`/`output`. Returns `detach()` and `drained()` (resolves once every
   * forwarded request has been answered, e.g. before exiting on stdin end).
   */
  attach(input: Readable, output: Writable): StdioSession {
    return serveNdjson(this, input, output, this.#log);
  }
}

export interface StdioSession {
  detach: () => void;
  /** Resolves once every line read so far has its answer written. */
  drained: () => Promise<void>;
}

/** Read NDJSON lines from `input`, hand each to `forwarder`, write each answer to `output` as one line. */
export function serveNdjson(forwarder: StdioForwarder, input: Readable, output: Writable, log: (line: string) => void): StdioSession {
  const inflight = new Set<Promise<void>>();
  let closed = false;
  const write = (line: string): void => {
    if (!closed) output.write(`${line}\n`);
  };
  const onOutputError = (err: Error): void => {
    // The agent went away (EPIPE): stop writing, keep the process from crashing
    closed = true;
    log(`[fengsui-mcp] stdout closed: ${err.message}`);
  };
  output.on("error", onOutputError);
  const detachReader = attachNdjsonLineReader(input, {
    onLine: (line) => {
      const task = forwarder.forward(line).then((response) => {
        if (response !== null) write(response);
      });
      inflight.add(task);
      void task.finally(() => inflight.delete(task));
    },
    onOversized: () => write(rpcError(null, -32600, `MCP stdio frame exceeds ${MAX_STDIO_LINE_BYTES / 1024} KiB limit`)),
  });
  return {
    detach: () => {
      detachReader();
      output.off("error", onOutputError);
    },
    drained: async () => {
      while (inflight.size > 0) await Promise.allSettled([...inflight]);
    },
  };
}

/** The parts of `process` a stdio bridge uses. */
export interface BridgeProcess {
  readonly stdin: Readable;
  readonly stdout: Writable;
  once(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  exit(code?: number): void;
}

/**
 * Serve stdio until stdin ends (the agent closed it) or a signal arrives, then exit once every request read so far
 * has its answer. `cpe-dash mcp` and the Claude Desktop extension end the same way.
 */
export function runStdioProcess(forwarder: StdioForwarder, proc: BridgeProcess, log: (line: string) => void): void {
  const session = serveNdjson(forwarder, proc.stdin, proc.stdout, log);
  const finish = (): void => {
    session.detach();
    void session.drained().finally(() => proc.exit(0));
  };
  proc.stdin.once("end", finish);
  proc.once("SIGINT", finish);
  proc.once("SIGTERM", finish);
}
