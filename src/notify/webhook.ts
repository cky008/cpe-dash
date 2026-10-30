import crypto from "node:crypto";
import { isAllowedCpeHost } from "../config.ts";
import type { EnrichedSmsMessage } from "../sms/types.ts";
import type { AlertEventRecord } from "../state-store.ts";
import type { NotificationChannel } from "./hub.ts";

export type WebhookEventName = "sms.received" | "alert";

/**
 * Validate the outbound webhook target: http(s) only, no embedded credentials or fragment, and
 * plain http only to a LAN/loopback host (payloads carry SMS bodies and one-time codes).
 */
export function normalizeWebhookUrl(raw: string): string {
  const parsed = new URL(raw.trim());
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`WEBHOOK_URL must use http(s), got "${parsed.protocol}"`);
  }
  if (parsed.username || parsed.password || parsed.hash) {
    throw new Error("WEBHOOK_URL must not embed credentials or a fragment");
  }
  if (parsed.protocol === "http:" && !isAllowedCpeHost(parsed.hostname)) {
    throw new Error("WEBHOOK_URL must use https for hosts outside the LAN (SMS bodies and codes would travel in clear text)");
  }
  return parsed.toString();
}

/** `X-FengSui-Signature` value: `sha256=` + HMAC-SHA256(secret, "<timestamp>.<raw body>"). */
export function signWebhookPayload(secret: string, timestamp: string, body: string): string {
  return `sha256=${crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`, "utf8").digest("hex")}`;
}

class WebhookDeliveryError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "WebhookDeliveryError";
    this.retryable = retryable;
  }
}

/**
 * JSON webhook channel (`POST WEBHOOK_URL`) for new SMS and alerts. With `WEBHOOK_SECRET` every
 * request is signed over the timestamp and body so receivers can verify origin and reject replays.
 */
export class WebhookNotifier implements NotificationChannel {
  readonly name = "webhook";
  readonly url: string;
  readonly #secret: string;
  readonly #fetchImpl: typeof fetch;
  readonly #timeoutMs: number;
  readonly #retryDelayMs: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;

  constructor(opts: {
    url: string;
    secret?: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    retryDelayMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  }) {
    this.url = normalizeWebhookUrl(opts.url);
    this.#secret = opts.secret ?? "";
    this.#fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.#timeoutMs = opts.timeoutMs ?? 10_000;
    this.#retryDelayMs = opts.retryDelayMs ?? 2000;
    this.#sleep = opts.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.#now = opts.now ?? Date.now;
  }

  async notifySms(message: EnrichedSmsMessage): Promise<void> {
    await this.deliver("sms.received", { message });
  }

  async notifyAlert(alert: AlertEventRecord): Promise<void> {
    await this.deliver("alert", { alert });
  }

  async deliver(event: WebhookEventName, data: Record<string, unknown>): Promise<void> {
    const timestamp = String(Math.floor(this.#now() / 1000));
    const body = JSON.stringify({ event, deliveredAt: new Date(this.#now()).toISOString(), data });
    const headers: Record<string, string> = {
      "Content-Type": "application/json; charset=utf-8",
      "User-Agent": "cpe-dash (FengSui) webhook",
      "X-FengSui-Event": event,
      "X-FengSui-Timestamp": timestamp,
    };
    if (this.#secret) headers["X-FengSui-Signature"] = signWebhookPayload(this.#secret, timestamp, body);

    try {
      await this.#postOnce(headers, body);
    } catch (err) {
      if (!(err instanceof WebhookDeliveryError) || !err.retryable) throw err;
      await this.#sleep(this.#retryDelayMs);
      await this.#postOnce(headers, body);
    }
  }

  async #postOnce(headers: Record<string, string>, body: string): Promise<void> {
    let res: Response;
    try {
      res = await this.#fetchImpl(this.url, {
        method: "POST",
        headers,
        body,
        redirect: "error",
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (err) {
      throw new WebhookDeliveryError(`Webhook request failed: ${err instanceof Error ? err.message : String(err)}`, true);
    }
    await res.body?.cancel().catch(() => undefined);
    if (!res.ok) {
      throw new WebhookDeliveryError(`Webhook responded ${res.status}`, res.status >= 500);
    }
  }
}
