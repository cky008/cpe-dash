import { isAllowedCpeHost } from "../config.ts";
import { readBoundedResponseText } from "../http-body.ts";
import { parseJsonSafeNullProto } from "../json-safe.ts";

export class TelegramApiError extends Error {
  readonly method: string;
  readonly errorCode: number | null;

  constructor(method: string, errorCode: number | null, description: string) {
    super(`Telegram ${method} failed${errorCode !== null ? ` (${errorCode})` : ""}: ${description}`);
    this.name = "TelegramApiError";
    this.method = method;
    this.errorCode = errorCode;
  }
}

const TOKEN_RE = /^\d{3,20}:[A-Za-z0-9_-]{20,128}$/;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/**
 * Normalize the Bot API base URL (`https://api.telegram.org` or a self-hosted / reverse-proxied
 * Bot API server). Rejects non-HTTP(S) schemes, embedded credentials, queries and fragments.
 */
export function normalizeTelegramApiBase(raw: string): string {
  const parsed = new URL(raw.trim());
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`TELEGRAM_API_BASE must use http(s), got "${parsed.protocol}"`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("TELEGRAM_API_BASE must not contain credentials, query or fragment");
  }
  if (parsed.protocol === "http:" && !isAllowedCpeHost(parsed.hostname)) {
    throw new Error("TELEGRAM_API_BASE must use https outside the LAN (the bot token is part of every request URL)");
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
}

/**
 * Minimal Telegram Bot API client. The bot token only ever appears in the request URL: error
 * messages carry the method name and Telegram's description, never the URL or token.
 */
export class TelegramApi {
  readonly apiBase: string;
  readonly #token: string;
  readonly #fetchImpl: typeof fetch;
  readonly #timeoutMs: number;

  constructor(opts: { token: string; apiBase?: string; fetchImpl?: typeof fetch; timeoutMs?: number }) {
    if (!TOKEN_RE.test(opts.token)) {
      throw new Error("TELEGRAM_BOT_TOKEN has an invalid format (expected <digits>:<secret> from @BotFather)");
    }
    this.#token = opts.token;
    this.apiBase = normalizeTelegramApiBase(opts.apiBase ?? "https://api.telegram.org");
    this.#fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.#timeoutMs = opts.timeoutMs ?? 20_000;
  }

  async call<T = unknown>(
    method: string,
    payload: Record<string, unknown> = {},
    opts: { timeoutMs?: number; signal?: AbortSignal } = {}
  ): Promise<T> {
    if (!/^[A-Za-z]{2,40}$/.test(method)) throw new Error(`Invalid Telegram method "${method}"`);
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? this.#timeoutMs);
    let res: Response;
    try {
      res = await this.#fetchImpl(`${this.apiBase}/bot${this.#token}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify(payload),
        redirect: "error",
        signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
      });
    } catch (err) {
      if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) throw err;
      throw new TelegramApiError(method, null, err instanceof Error ? err.message : "network error");
    }
    let parsed: unknown;
    try {
      parsed = parseJsonSafeNullProto(await readBoundedResponseText(res, MAX_RESPONSE_BYTES));
    } catch {
      throw new TelegramApiError(method, res.status, "invalid JSON response");
    }
    const envelope = (parsed ?? {}) as { ok?: unknown; result?: unknown; error_code?: unknown; description?: unknown };
    if (envelope.ok !== true) {
      throw new TelegramApiError(
        method,
        typeof envelope.error_code === "number" ? envelope.error_code : res.status,
        typeof envelope.description === "string" ? envelope.description : "request rejected"
      );
    }
    return envelope.result as T;
  }

  /** Download a small text document (e.g. a `.vcf` export) by `file_id`, bounded to `maxBytes`. */
  async downloadFileText(fileId: string, maxBytes: number): Promise<string> {
    const meta = await this.call<{ file_path?: unknown; file_size?: unknown }>("getFile", { file_id: fileId });
    const filePath = meta.file_path;
    if (
      typeof filePath !== "string" ||
      filePath.length > 256 ||
      !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(filePath) ||
      filePath.split("/").some((segment) => segment === "." || segment === "..")
    ) {
      throw new TelegramApiError("getFile", null, "missing file path");
    }
    if (typeof meta.file_size === "number" && meta.file_size > maxBytes) {
      throw new TelegramApiError("getFile", null, `file exceeds ${maxBytes} bytes`);
    }
    let res: Response;
    try {
      res = await this.#fetchImpl(`${this.apiBase}/file/bot${this.#token}/${filePath}`, {
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new TelegramApiError("downloadFile", null, err instanceof Error ? err.message : "network error");
    }
    if (!res.ok) throw new TelegramApiError("downloadFile", res.status, "download failed");
    return await readBoundedResponseText(res, maxBytes);
  }
}
