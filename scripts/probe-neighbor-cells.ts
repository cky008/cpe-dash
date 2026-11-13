import { buildLteCellLockXml, buildNrCellLockXml } from "../src/band-lock.ts";
import { loadConfig } from "../src/config.ts";
import { HuaweiCpeClient } from "../src/protocols/hilink/client.ts";
import { parseNeighborCellsXml } from "../src/protocols/hilink/parsers.ts";
import { getXmlTag } from "../src/protocols/hilink/xml.ts";

async function main(): Promise<void> {
  console.log("=== [FengSui Probe #4] 4G LTE / 5G NR Neighbor Cell Scanner ===");

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
    const [nbrXml, signalXml] = await Promise.all([
      session.get("/api/device/nbrcellinfo"),
      session.get("/api/device/signal"),
    ]);
    return { nbrXml, signalXml };
  });

  if (!raw) {
    console.log(
      `[Yielded] Active human admin session detected (State=${preState.state}); probe yielded peacefully.`
    );
    return;
  }

  const telemetry = client.getTelemetry();
  const servingBand = getXmlTag(raw.signalXml, "bandInfo") ?? "--";
  const servingPci = getXmlTag(raw.signalXml, "pci") ?? "--";
  const { lteNeighbors, nrNeighbors } = parseNeighborCellsXml(raw.nbrXml);

  console.log(`Ephemeral Session Hold Time : ${telemetry.lastSessionHoldMs} ms (logged out in finally)`);
  console.log(`Serving Primary Cell        : Band=${servingBand}, PCI=${servingPci}`);
  console.log(
    `Discovered Candidates       : 4G LTE=${lteNeighbors.length} cells | 5G NR=${nrNeighbors.length} cells`
  );

  const allCells = [...lteNeighbors, ...nrNeighbors];
  if (allCells.length === 0) {
    console.log("  (Modem currently reports 0 neighbor cells in /api/device/nbrcellinfo)");
    return;
  }

  console.log("\n  #  RAT   Band   ARFCN     PCI    RSRP(dBm)  RSRQ(dB)  RSSI(dBm)  SINR(dB)");
  console.log("  -------------------------------------------------------------------------");
  for (const [idx, c] of allCells.entries()) {
    const row = [
      String(idx + 1).padStart(3, " "),
      c.rat.padEnd(4, " "),
      c.band.padEnd(5, " "),
      String(c.arfcn ?? "--").padEnd(8, " "),
      String(c.pci ?? "--").padEnd(5, " "),
      String(c.rsrpDbm ?? "--").padStart(8, " "),
      String(c.rsrqDb ?? "--").padStart(8, " "),
      String(c.rssiDbm ?? "--").padStart(9, " "),
      String(c.sinrDb ?? "--").padStart(8, " "),
    ].join("  ");
    console.log(row);
  }

  // Dry-run lock payload preview for strongest candidate (read-only: never POSTed)
  const strongest = [...allCells]
    .filter((c) => c.arfcn !== null && c.pci !== null && c.band !== "--")
    .sort((a, b) => (b.rsrpDbm ?? -999) - (a.rsrpDbm ?? -999))[0];

  if (strongest && strongest.arfcn !== null && strongest.pci !== null) {
    const dryRunXml =
      strongest.rat === "NR"
        ? buildNrCellLockXml({ band: strongest.band, nrArfcn: strongest.arfcn, pci: strongest.pci })
        : buildLteCellLockXml({ band: strongest.band, earfcn: strongest.arfcn, pci: strongest.pci });
    console.log(
      `\n[Dry-Run Only] Strongest Candidate (${strongest.rat} ${strongest.band} ARFCN=${strongest.arfcn} PCI=${strongest.pci}, RSRP=${strongest.rsrpDbm} dBm) Lock XML:`
    );
    console.log(`  ${dryRunXml}`);
  }
}

main().catch((err: unknown) => {
  console.error("Probe #4 failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
