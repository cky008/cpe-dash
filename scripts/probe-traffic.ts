import { loadConfig } from "../src/config.ts";
import { HuaweiCpeClient } from "../src/cpe-client.ts";
import {
  formatBytesBinary,
  formatRateBitsPerSec,
  parseTrafficSnapshot,
} from "../src/parsers.ts";

function formatDurationHms(totalSeconds: number): string {
  const sec = Math.max(0, Math.trunc(totalSeconds));
  const hours = Math.floor(sec / 3600);
  const mins = Math.floor((sec % 3600) / 60);
  const rem = sec % 60;
  return `${hours}h ${mins}m ${rem}s`;
}

async function main(): Promise<void> {
  console.log("=== [FengSui Probe #5] Instantaneous Throughput & Dual-Period Traffic Accounting ===");

  const cfg = loadConfig();
  const client = new HuaweiCpeClient({
    cpeUrl: cfg.cpeUrl,
    cpeUsername: cfg.cpeUsername,
    cpePassword: cfg.cpePassword,
    requestTimeoutMs: cfg.requestTimeoutMs,
    respectBrowserSession: cfg.respectBrowserSession,
  });
  client.rememberLoginScheme("scram");

  const preState = await client.getLoginState();
  console.log(
    `Pre-check /api/user/state-login -> State=${preState.state}, isLoggedInElsewhere=${preState.isLoggedInElsewhere}`
  );

  const raw = await client.withSession(async (session) => {
    const [trafficXml, monthXml, startDateXml, dailyLimitNote] = await Promise.all([
      session.get("/api/monitoring/traffic-statistics"),
      session.get("/api/monitoring/month_statistics"),
      session.get("/api/monitoring/start_date"),
      session
        .get("/api/monitoring/daily-data-limit")
        .then(() => "supported")
        .catch((err: unknown) => (err instanceof Error ? err.message : String(err))),
    ]);
    return { trafficXml, monthXml, startDateXml, dailyLimitNote };
  });

  if (!raw) {
    console.log(
      `[Yielded] Active human admin session detected (State=${preState.state}); probe yielded peacefully.`
    );
    return;
  }

  const telemetry = client.getTelemetry();
  const snap = parseTrafficSnapshot(raw);

  console.log(`Ephemeral Session Hold Time : ${telemetry.lastSessionHoldMs} ms (logged out in finally)`);
  console.log(
    `Instantaneous Download Rate : ${formatRateBitsPerSec(snap.downloadBps)} (${snap.downloadBytesPerSec} B/s)`
  );
  console.log(
    `Instantaneous Upload Rate   : ${formatRateBitsPerSec(snap.uploadBps)} (${snap.uploadBytesPerSec} B/s)`
  );
  console.log(
    `Today's Traffic (当日流量)  : ${formatBytesBinary(snap.todayUsedBytes)} (${snap.todayUsedBytes.toString()} B | online ${formatDurationHms(snap.todayDurationSec)})`
  );
  console.log(
    `Monthly Traffic (当月流量)  : ${formatBytesBinary(snap.monthTotalBytes)} [DL: ${formatBytesBinary(snap.monthDownloadBytes)} + UL: ${formatBytesBinary(snap.monthUploadBytes)} | since ${snap.monthLastClearDate || "N/A"}]`
  );
  console.log(
    `Current Dial-Up Session     : DL=${formatBytesBinary(snap.sessionDownloadBytes)}, UL=${formatBytesBinary(snap.sessionUploadBytes)} (uptime ${formatDurationHms(snap.sessionConnectTimeSec)})`
  );
  console.log(
    `Historical Cumulative Total : ${formatBytesBinary(snap.totalUsedBytes)} [DL: ${formatBytesBinary(snap.totalDownloadBytes)} + UL: ${formatBytesBinary(snap.totalUploadBytes)} | total ${formatDurationHms(snap.totalConnectTimeSec)}]`
  );
  console.log(
    `Billing Cycle & Quota Policy: StartDay=${snap.billingStartDay ?? "--"}, MonthlyLimit=${snap.dataLimitRaw || "0MB"}, AlarmThreshold=${snap.monthThresholdPercent ?? "--"}%, DailyQuotaAPI="${raw.dailyLimitNote}"`
  );
}

main().catch((err: unknown) => {
  console.error("Probe #5 failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
