import { loadConfig } from "../src/config.ts";
import { HuaweiCpeClient } from "../src/cpe-client.ts";
import { parseHostInfoJson, summarizeTopologyJson } from "../src/parsers.ts";

function formatLease(sec: number | null, source: string): string {
  if (source.toUpperCase() === "STATIC") return "STATIC";
  if (sec === null || sec <= 0) return "--";
  const hours = (sec / 3600).toFixed(1);
  return `${hours}h (${sec}s)`;
}

async function main(): Promise<void> {
  console.log("=== [FengSui Probe #6] Terminal Topology, Access Medium & Dual-Stack DHCP Leases ===");

  const cfg = loadConfig();
  const client = new HuaweiCpeClient({
    cpeUrl: cfg.cpeUrl,
    cpeUsername: cfg.cpeUsername,
    cpePassword: cfg.cpePassword,
    requestTimeoutMs: cfg.requestTimeoutMs,
    respectBrowserSession: cfg.respectBrowserSession,
  });

  const preState = await client.getLoginState();
  console.log(
    `Pre-check /api/user/state-login -> State=${preState.state}, isLoggedInElsewhere=${preState.isLoggedInElsewhere}`
  );

  const raw = await client.withSession(async (session) => {
    const [hostInfoJson, topologyJson] = await Promise.all([
      session.get("/api/system/HostInfo"),
      session.get("/api/system/topology"),
    ]);
    return { hostInfoJson, topologyJson };
  });

  if (!raw) {
    console.log(
      `[Yielded] Active human admin session detected (State=${preState.state}); probe yielded peacefully.`
    );
    return;
  }

  const telemetry = client.getTelemetry();
  const hosts = parseHostInfoJson(raw.hostInfoJson, { sanitize: true });
  const activeHosts = hosts.filter((h) => h.active);
  const topo = summarizeTopologyJson(raw.topologyJson);

  const mediumCounts: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const h of activeHosts) {
    mediumCounts[h.medium] = (mediumCounts[h.medium] ?? 0) + 1;
  }

  console.log(`Ephemeral Session Hold Time : ${telemetry.lastSessionHoldMs} ms (logged out in finally)`);
  console.log(
    `HostInfo Summary            : total=${hosts.length} known records | active=${activeHosts.length} online`
  );
  console.log(
    `Topology Tree Summary       : topLevel=${topo.topLevelNodes}, totalActive=${topo.totalActiveNodes}, meshChildren=${topo.meshChildNodes}, ethernet=${topo.ethernetNodes}, wireless=${topo.wirelessNodes}`
  );
  console.log(
    `Active Medium Breakdown     : ${Object.entries(mediumCounts)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ") || "none"}`
  );

  console.log(
    "\n  #  Alias          Masked MAC         Medium      L2Port  Rate(Mbps)  RSSI  IPv4           IPv6(Active/Count)  DHCP Lease"
  );
  console.log(
    "  --------------------------------------------------------------------------------------------------------------------------"
  );
  for (const [idx, h] of activeHosts.entries()) {
    const v6Summary = h.ipv6Active
      ? `yes(${h.ipv6Addresses.length}: ${h.ipv6Addresses[0] ?? "fe80::1"})`
      : `no(${h.ipv6Addresses.length})`;
    const row = [
      String(idx + 1).padStart(3, " "),
      h.displayName.padEnd(13, " "),
      h.macAddress.padEnd(17, " "),
      h.medium.padEnd(10, " "),
      (h.layer2Interface || "--").padEnd(6, " "),
      String(h.negotiatedRateMbps ?? "--").padStart(10, " "),
      String(h.rssi ?? "--").padStart(4, " "),
      (h.ipv4Address || "--").padEnd(13, " "),
      v6Summary.padEnd(18, " "),
      formatLease(h.leaseTimeRemainingSec, h.addressSource),
    ].join("  ");
    console.log(row);
  }
}

main().catch((err: unknown) => {
  console.error("Probe #6 failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
