import type { GlobalTelemetrySnapshot } from "./cpe-domain.ts";
import type { SchedulerMode, SchedulerStatusSnapshot } from "./scheduler.ts";

/**
 * `GET /metrics` in the Prometheus text exposition format, for Prometheus / Grafana on the NAS. Read
 * from the cached snapshots only (scraping never opens a router session) and carrying no identifier:
 * no IMEI, IMSI, cell, PCI, address or number appears as a value or a label.
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

export interface MetricsInput {
  version: string;
  daemonUptimeSec: number;
  scheduler: SchedulerStatusSnapshot;
  telemetry: GlobalTelemetrySnapshot | null;
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
    ...family("fengsui_router_uptime_seconds", "gauge", "Router uptime.", [{ value: telemetry?.device.uptimeSec ?? null }]),
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
  ];
  return `${lines.join("\n")}\n`;
}
