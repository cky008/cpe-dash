import { monitorEventLoopDelay } from "node:perf_hooks";
import type { GlobalTelemetrySnapshot } from "./cpe-domain.ts";
import { simIsLocked } from "./router-status.ts";
import type { SchedulerMode, SchedulerStatusSnapshot } from "./scheduler.ts";

/**
 * `GET /metrics` in the Prometheus text exposition format, for Prometheus / Grafana on the NAS. Read
 * from the cached snapshots only (scraping never opens a router session) and carrying no identifier:
 * no IMEI, IMSI, ICCID, cell, PCI, address or number appears as a value or a label (a sensor label is
 * its kind, never the router's own sensor name).
 */

const MODES: ReadonlyArray<SchedulerMode> = ["idle", "polling", "yielding_browser", "circuit_tripped", "cpe_unreachable", "standby_peer"];

interface Sample {
  labels?: Readonly<Record<string, string>>;
  value: number | null;
}

function family(name: string, type: "gauge" | "counter", help: string, samples: ReadonlyArray<Sample>): string[] {
  const lines = [`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`];
  for (const sample of samples) {
    if (sample.value === null || !Number.isFinite(sample.value)) continue;
    const labels = sample.labels ? `{${Object.entries(sample.labels).map(([k, v]) => `${k}="${v.replace(/["\\\n]/g, "_")}"`).join(",")}}` : "";
    lines.push(`${name}${labels} ${sample.value}`);
  }
  return lines;
}

/** The daemon process itself, to watch it over weeks on a NAS (no router data). */
export interface RuntimeSample {
  residentBytes: number;
  heapUsedBytes: number;
  /** User and system CPU time since the process started. */
  cpuSeconds: number;
  /** Event-loop delay over the last full window (seconds); `null` before the first window closed. */
  eventLoopDelayP99Sec: number | null;
  eventLoopDelayMaxSec: number | null;
  sseClients: number;
  /** Telegram notifications waiting for Telegram to answer (`null` without a bot). */
  telegramPending: number | null;
}

/**
 * Measures the event loop's delay in fixed windows (a minute in the daemon), so `/metrics` reports
 * the last full window however often, or rarely, it is scraped.
 */
export class RuntimeSampler {
  readonly #delay = monitorEventLoopDelay({ resolution: 20 });
  readonly #windowMs: number;
  #timer: ReturnType<typeof setInterval> | null = null;
  #last: { p99Sec: number; maxSec: number } | null = null;

  constructor(opts: { windowMs?: number } = {}) {
    this.#windowMs = opts.windowMs ?? 60_000;
  }

  start(): void {
    if (this.#timer) return;
    this.#delay.enable();
    this.#timer = setInterval(() => {
      // A percentile is its bucket's upper bound and may round past the exact maximum
      const maxSec = this.#delay.max / 1e9;
      this.#last = { p99Sec: Math.min(this.#delay.percentile(99) / 1e9, maxSec), maxSec };
      this.#delay.reset();
    }, this.#windowMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.#delay.disable();
  }

  sample(extra: Pick<RuntimeSample, "sseClients" | "telegramPending">): RuntimeSample {
    const memory = process.memoryUsage();
    const cpu = process.cpuUsage();
    return {
      residentBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      cpuSeconds: (cpu.user + cpu.system) / 1e6,
      eventLoopDelayP99Sec: this.#last?.p99Sec ?? null,
      eventLoopDelayMaxSec: this.#last?.maxSec ?? null,
      ...extra,
    };
  }
}

export interface MetricsInput {
  version: string;
  daemonUptimeSec: number;
  scheduler: SchedulerStatusSnapshot;
  telemetry: GlobalTelemetrySnapshot | null;
  /** The process's own figures (left out where no sampler runs). */
  runtime?: RuntimeSample;
}

/** Standard process / Node.js names, so ready-made Node dashboards and alerts apply. */
function runtimeFamilies(runtime: RuntimeSample): string[] {
  return [
    ...family("process_resident_memory_bytes", "gauge", "Resident memory of the daemon process.", [{ value: runtime.residentBytes }]),
    ...family("process_cpu_seconds_total", "counter", "User and system CPU time the daemon process has used.", [{ value: runtime.cpuSeconds }]),
    ...family("nodejs_heap_size_used_bytes", "gauge", "JavaScript heap in use.", [{ value: runtime.heapUsedBytes }]),
    ...family("nodejs_eventloop_lag_p99_seconds", "gauge", "Event-loop delay, 99th percentile over the last minute.", [{ value: runtime.eventLoopDelayP99Sec }]),
    ...family("nodejs_eventloop_lag_max_seconds", "gauge", "Event-loop delay, maximum over the last minute.", [{ value: runtime.eventLoopDelayMaxSec }]),
    ...family("fengsui_sse_clients", "gauge", "Open /api/events streams.", [{ value: runtime.sseClients }]),
    ...family("fengsui_telegram_outbox_pending", "gauge", "Telegram notifications waiting for Telegram to answer.", [{ value: runtime.telegramPending }]),
  ];
}

/** 1 / 0 for a reading that is there, nothing for one the router does not report. */
function flag(value: boolean | null | undefined): number | null {
  return value === null || value === undefined ? null : value ? 1 : 0;
}

/** What the router says of itself (battery, SIM card, radio, roaming, load) and its temperatures, by sensor kind. */
function statusFamilies(telemetry: GlobalTelemetrySnapshot | null): string[] {
  const status = telemetry?.status ?? null;
  const battery = status?.battery ?? null;
  const hottest = new Map<string, number>();
  for (const sensor of telemetry?.thermal?.sensors ?? []) hottest.set(sensor.kind, Math.max(hottest.get(sensor.kind) ?? -Infinity, sensor.celsius));
  return [
    ...family("fengsui_router_temperature_celsius", "gauge", "The hottest temperature the router reports, and the hottest of each kind of sensor it names.", [
      { value: telemetry?.thermal?.temperatureCelsius ?? null },
      ...[...hottest].map(([sensor, celsius]) => ({ labels: { sensor }, value: celsius })),
    ]),
    ...family("fengsui_battery_percent", "gauge", "Battery charge of a mobile router.", [{ value: battery?.percent ?? null }]),
    ...family("fengsui_battery_charging", "gauge", "1 while the router charges.", [{ value: flag(battery?.charging) }]),
    ...family("fengsui_battery_temperature_celsius", "gauge", "Battery temperature.", [{ value: battery?.temperatureC ?? null }]),
    ...family("fengsui_sim_locked", "gauge", "1 while the SIM card waits for its PIN or PUK.", [{ value: flag(simIsLocked(status?.sim ?? null)) }]),
    ...family("fengsui_airplane_mode", "gauge", "1 while the router's cellular radio is off.", [{ value: flag(status?.airplaneMode) }]),
    ...family("fengsui_roaming", "gauge", "1 while the router is registered on a network abroad.", [{ value: flag(status?.roaming?.active) }]),
    ...family("fengsui_router_cpu_percent", "gauge", "The router's own CPU use.", [{ value: status?.system?.cpuPercent ?? null }]),
    ...family("fengsui_router_memory_percent", "gauge", "The router's own memory use.", [{ value: status?.system?.memoryPercent ?? null }]),
  ];
}

export function renderMetrics(input: MetricsInput): string {
  const { scheduler, telemetry } = input;
  const rf = telemetry?.rf;
  const traffic = telemetry?.traffic;
  const sms = telemetry?.sms ?? null;
  const lines = [
    ...family("fengsui_info", "gauge", "FengSui build information.", [{ labels: { version: input.version }, value: 1 }]),
    ...family("fengsui_uptime_seconds", "gauge", "Seconds since the daemon started.", [{ value: input.daemonUptimeSec }]),
    ...family("fengsui_scheduler_mode", "gauge", "1 for the scheduler's current mode.", MODES.map((mode) => ({ labels: { mode }, value: scheduler.mode === mode ? 1 : 0 }))),
    ...family("fengsui_scheduler_queue_depth", "gauge", "Router sessions waiting in the queue.", [{ value: scheduler.queueDepth }]),
    ...family("fengsui_circuit_breaker_tripped", "gauge", "1 while the anti-lockout breaker is open.", [{ value: scheduler.circuitBreaker.tripped ? 1 : 0 }]),
    ...family("fengsui_cpe_sessions_total", "counter", "Router admin sessions completed.", [{ value: scheduler.totalSessionsCompleted }]),
    ...family("fengsui_cpe_browser_yields_total", "counter", "Times the daemon yielded to a person on the router's web page.", [{ value: scheduler.browserYieldCount }]),
    ...family("fengsui_cpe_session_hold_milliseconds", "gauge", "How long the last router session held the admin slot.", [{ value: scheduler.lastSessionHoldMs }]),
    ...family("fengsui_telemetry_timestamp_seconds", "gauge", "When the cached telemetry was captured (Unix time).", [{ value: telemetry ? telemetry.capturedAtMs / 1000 : null }]),
    ...family("fengsui_wan_connected", "gauge", "1 while the cellular data connection is up.", [{ value: telemetry ? (telemetry.device.connectionStatus === "901" ? 1 : 0) : null }]),
    // A router that reports no uptime of its own has none here (never one that just started)
    ...family("fengsui_router_uptime_seconds", "gauge", "Router uptime.", [{ value: telemetry && !telemetry.unavailable?.includes("uptime") ? telemetry.device.uptimeSec : null }]),
    ...statusFamilies(telemetry),
    ...family("fengsui_signal_rsrp_dbm", "gauge", "Primary cell RSRP.", [
      { labels: { rat: "lte" }, value: rf?.lteRsrpDbm ?? null },
      { labels: { rat: "nr" }, value: rf?.nrRsrpDbm ?? null },
    ]),
    ...family("fengsui_signal_rsrq_db", "gauge", "Primary cell RSRQ.", [
      { labels: { rat: "lte" }, value: rf?.lteRsrqDb ?? null },
      { labels: { rat: "nr" }, value: rf?.nrRsrqDb ?? null },
    ]),
    ...family("fengsui_signal_sinr_db", "gauge", "Primary cell SINR.", [
      { labels: { rat: "lte" }, value: rf?.lteSinrDb ?? null },
      { labels: { rat: "nr" }, value: rf?.nrSinrDb ?? null },
    ]),
    ...family("fengsui_carrier_components", "gauge", "Aggregated component carriers.", [{ value: rf?.caComponentCount ?? null }]),
    ...family("fengsui_aggregated_bandwidth_mhz", "gauge", "Total aggregated bandwidth.", [{ value: rf?.totalAggregatedBandwidthMhz ?? null }]),
    ...family("fengsui_throughput_bits_per_second", "gauge", "Current WAN throughput.", [
      { labels: { direction: "down" }, value: traffic?.downloadBps ?? null },
      { labels: { direction: "up" }, value: traffic?.uploadBps ?? null },
    ]),
    ...family("fengsui_month_traffic_bytes", "gauge", "Traffic this billing month.", [
      { labels: { direction: "down" }, value: traffic?.monthDownloadBytes ?? null },
      { labels: { direction: "up" }, value: traffic?.monthUploadBytes ?? null },
    ]),
    ...family("fengsui_today_traffic_bytes", "gauge", "Traffic today.", [{ value: traffic?.todayUsedBytes ?? null }]),
    ...family("fengsui_sms_unread", "gauge", "Unread SMS on the router.", [{ value: sms?.localUnread ?? null }]),
    ...family("fengsui_sms_storage_used", "gauge", "SMS slots in use on the router.", [{ value: sms ? sms.localInbox + sms.localOutbox + sms.localDraft : null }]),
    ...family("fengsui_sms_storage_capacity", "gauge", "SMS slots on the router.", [{ value: sms?.localMax ?? null }]),
    ...(input.runtime ? runtimeFamilies(input.runtime) : []),
  ];
  return `${lines.join("\n")}\n`;
}
