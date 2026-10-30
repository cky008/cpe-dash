import type { Readable, Writable } from "node:stream";
import { readBoundedResponseText } from "./http-body.ts";
import { parseJsonSafeNullProto } from "./json-safe.ts";

/**
 * `cpe-dash mcp`: a zero-state stdio <-> Streamable HTTP bridge for local agents that only speak
 * stdio (Claude Desktop, Cursor, ...). Each NDJSON line is POSTed to the serve daemon's `/mcp`
 * with the Bearer API_TOKEN and the daemon's answer is written back as one line.
 *
 * This process never creates a CPE client, scheduler or store: the daemon's `MutexSessionScheduler`
 * stays the only path to the router's single admin session. (A second in-process scheduler could
 * not see the daemon's mutex, so the two processes would take turns logging in, yield to each
 * other as if the other were a human, keep separate breakers and overwrite the same state file.)
 */

export const MAX_STDIO_LINE_BYTES = 64 * 1024;
const MAX_DAEMON_RESPONSE_BYTES = 8 * 1024 * 1024;
const DEFAULT_FORWARD_TIMEOUT_MS = 5 * 60_000;

/** JSON-RPC implementation-defined server errors returned by the bridge itself. */
export const BRIDGE_DAEMON_REJECTED = -32001;
export const BRIDGE_DAEMON_UNREACHABLE = -32002;

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

export interface McpStdioBridgeOptions {
  /** Daemon `/mcp` URL (`AppConfig.mcpDaemonUrl`). */
  daemonUrl: string;
  apiToken: string;
  fetchImpl?: typeof fetch;
  /** Upper bound per forwarded request (tool calls queue behind the daemon's CPE sessions). */
  requestTimeoutMs?: number;
  log?: (line: string) => void;
}

function rpcError(id: string | number | null, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export class McpStdioBridge {
  readonly daemonUrl: string;
  readonly #apiToken: string;
  readonly #fetchImpl: typeof fetch;
  readonly #timeoutMs: number;
  readonly #log: (line: string) => void;
  /** Negotiated protocol revision, echoed as `MCP-Protocol-Version` after `initialize`. */
  #protocolVersion: string | null = null;

  constructor(options: McpStdioBridgeOptions) {
    this.daemonUrl = options.daemonUrl;
    this.#apiToken = options.apiToken;
    this.#fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.#timeoutMs = options.requestTimeoutMs ?? DEFAULT_FORWARD_TIMEOUT_MS;
    this.#log = options.log ?? (() => undefined);
  }

  /**
   * Forward one JSON-RPC line. Resolves the response line, or `null` for notifications. Daemon
   * failures become JSON-RPC errors for the request's `id`, so the agent always gets an answer.
   */
  async forward(line: string): Promise<string | null> {
    let id: string | number | null = null;
    let isRequest = false;
    try {
      const envelope = asRecord(parseJsonSafeNullProto(line));
      const rawId = envelope?.["id"];
      if (typeof rawId === "string" || typeof rawId === "number") {
        id = rawId;
        isRequest = true;
      }
    } catch {
      // Malformed JSON is forwarded as-is so the daemon answers it with its own -32700
      isRequest = true;
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${this.#apiToken}`,
    };
    if (this.#protocolVersion) headers["MCP-Protocol-Version"] = this.#protocolVersion;

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
      const reason = err instanceof Error ? err.message : String(err);
      this.#log(`[fengsui-mcp] daemon unreachable at ${this.daemonUrl}: ${reason}`);
      return isRequest
        ? rpcError(
            id,
            BRIDGE_DAEMON_UNREACHABLE,
            `FengSui daemon unreachable at ${this.daemonUrl} (${reason}). Start "cpe-dash serve": it is the only process that talks to the CPE.`
          )
        : null;
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
    return isRequest
      ? rpcError(id, BRIDGE_DAEMON_REJECTED, `FengSui daemon rejected the request (HTTP ${res.status} ${code})${message ? `: ${message}` : ""}`)
      : null;
  }

  /**
   * Serve NDJSON on `input`/`output`. Returns `detach()` and `drained()` (resolves once every
   * forwarded request has been answered, e.g. before exiting on stdin end).
   */
  attach(input: Readable, output: Writable): { detach: () => void; drained: () => Promise<void> } {
    const inflight = new Set<Promise<void>>();
    let closed = false;
    const write = (line: string): void => {
      if (!closed) output.write(`${line}\n`);
    };
    const onOutputError = (err: Error): void => {
      // The agent went away (EPIPE): stop writing, keep the process from crashing
      closed = true;
      this.#log(`[fengsui-mcp] stdout closed: ${err.message}`);
    };
    output.on("error", onOutputError);
    const detachReader = attachNdjsonLineReader(input, {
      onLine: (line) => {
        const task = this.forward(line).then((response) => {
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
}
