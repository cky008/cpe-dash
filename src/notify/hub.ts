import type { MutexSessionScheduler } from "../scheduler.ts";
import type { SmsService } from "../sms/service.ts";
import type { EnrichedSmsMessage } from "../sms/types.ts";
import type { AlertEventRecord } from "../state-store.ts";

export type AlertSeverity = AlertEventRecord["severity"];

export interface NotificationChannel {
  readonly name: string;
  notifySms?(message: EnrichedSmsMessage): Promise<void>;
  notifyAlert?(alert: AlertEventRecord): Promise<void>;
}

export interface ChannelDeliveryStats {
  delivered: number;
  failed: number;
  lastError: string | null;
}

const SEVERITY_RANK: Readonly<Record<AlertSeverity, number>> = { info: 0, warning: 1, critical: 2 };

/**
 * The severity an alert is routed with when it differs from its own. A recovery reaches every
 * channel its problem reached (`WAN_UP` follows `WAN_DOWN`), and a dropped carrier is worth a push
 * although it only rates `info` in the history.
 */
const NOTIFY_SEVERITY: ReadonlyMap<string, AlertSeverity> = new Map([
  ["WAN_UP", "warning"],
  ["SIGNAL_RECOVERED", "warning"],
  ["LOCK_REALIGNED", "warning"],
  ["CA_DROPPED", "warning"],
  ["CPE_RECOVERED", "critical"],
  ["DUPLICATE_DAEMON_CLEARED", "critical"],
]);

export function isAlertSeverity(value: string): value is AlertSeverity {
  return value === "info" || value === "warning" || value === "critical";
}

/**
 * Fans new SMS (`SmsService` `sms:new`) and alerts (`MutexSessionScheduler` `alert`) out to the
 * configured channels. Delivery happens off the CPE session; one failing channel never blocks the
 * others, and logs carry only the channel name and error, never message content or numbers.
 */
export class NotificationHub {
  readonly scheduler: MutexSessionScheduler;
  readonly sms: SmsService | null;
  readonly channels: ReadonlyArray<NotificationChannel>;
  readonly alertMinSeverity: AlertSeverity;
  readonly #log: (line: string) => void;
  #stats = new Map<string, ChannelDeliveryStats>();
  #started = false;

  readonly #onSms = (message: EnrichedSmsMessage): void => {
    void this.dispatchSms(message);
  };

  readonly #onAlert = (alert: AlertEventRecord): void => {
    void this.dispatchAlert(alert);
  };

  constructor(opts: {
    scheduler: MutexSessionScheduler;
    sms?: SmsService | null;
    channels: ReadonlyArray<NotificationChannel>;
    alertMinSeverity?: AlertSeverity;
    log?: (line: string) => void;
  }) {
    this.scheduler = opts.scheduler;
    this.sms = opts.sms ?? null;
    this.channels = opts.channels;
    this.alertMinSeverity = opts.alertMinSeverity ?? "warning";
    this.#log = opts.log ?? (() => undefined);
    for (const channel of this.channels) this.#stats.set(channel.name, { delivered: 0, failed: 0, lastError: null });
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.sms?.on("sms:new", this.#onSms);
    this.scheduler.on("alert", this.#onAlert);
  }

  stop(): void {
    if (!this.#started) return;
    this.#started = false;
    this.sms?.off("sms:new", this.#onSms);
    this.scheduler.off("alert", this.#onAlert);
  }

  getStats(): Record<string, ChannelDeliveryStats> {
    return Object.fromEntries([...this.#stats].map(([name, s]) => [name, { ...s }]));
  }

  async dispatchSms(message: EnrichedSmsMessage): Promise<void> {
    await this.#fanOut("sms.received", (channel) => channel.notifySms?.(message));
  }

  async dispatchAlert(alert: AlertEventRecord): Promise<void> {
    const routed = NOTIFY_SEVERITY.get(alert.code) ?? alert.severity;
    if (SEVERITY_RANK[routed] < SEVERITY_RANK[this.alertMinSeverity]) return;
    await this.#fanOut("alert", (channel) => channel.notifyAlert?.(alert));
  }

  async #fanOut(event: string, send: (channel: NotificationChannel) => Promise<void> | undefined): Promise<void> {
    await Promise.all(
      this.channels.map(async (channel) => {
        const pending = send(channel);
        if (!pending) return;
        const stats = this.#stats.get(channel.name);
        try {
          await pending;
          if (stats) stats.delivered += 1;
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          if (stats) {
            stats.failed += 1;
            stats.lastError = reason.slice(0, 200);
          }
          this.#log(`[notify] ${channel.name} failed to deliver ${event}: ${reason}`);
        }
      })
    );
  }
}
