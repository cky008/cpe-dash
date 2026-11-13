import { loadConfig } from "../src/config.ts";
import { HuaweiCpeClient } from "../src/protocols/hilink/client.ts";
import { parseRfSignalSnapshot } from "../src/protocols/hilink/parsers.ts";
import { inspectFieldFormat } from "../src/sanitize.ts";
import { getXmlTag } from "../src/protocols/hilink/xml.ts";

async function main(): Promise<void> {
  console.log("=== [FengSui Probe #3] 3CA Carrier Aggregation & High-Order RF Telemetry ===");

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
    const [signalXml, secCellXml, riXml, cellInfoXml, plmnXml] = await Promise.all([
      session.get("/api/device/signal"),
      session.get("/api/device/seccellinfo"),
      session.get("/api/device/ri"),
      session.get("/api/net/cell-info"),
      session.get("/api/net/current-plmn"),
    ]);
    return { signalXml, secCellXml, riXml, cellInfoXml, plmnXml };
  });

  if (!raw) {
    console.log(
      `[Yielded] Active human admin session detected (State=${preState.state}); probe yielded peacefully.`
    );
    return;
  }

  const telemetry = client.getTelemetry();
  const snap = parseRfSignalSnapshot({
    ...raw,
    redactIdentifiers: true,
  });

  const cellIdObs = inspectFieldFormat("cell_id", getXmlTag(raw.signalXml, "cell_id"));
  const cellHexObs = inspectFieldFormat("cellinfo", getXmlTag(raw.cellInfoXml, "cellinfo"));
  const tacDecObs = inspectFieldFormat("tac", getXmlTag(raw.signalXml, "tac"));
  const lacHexObs = inspectFieldFormat("lac", getXmlTag(raw.cellInfoXml, "lac"));

  console.log(`Ephemeral Session Hold Time   : ${telemetry.lastSessionHoldMs} ms (logged out in finally)`);
  console.log(`Operator / RAT                : ${snap.operatorName || "Unknown"} (PLMN ${snap.plmnNumeric}, RAT=${snap.ratCode})`);
  console.log(
    `CA Aggregation Banner         : ${snap.caBannerRaw || "(single carrier)"} [active=${snap.caActive}, carriers=${snap.caComponentCount}, totalBW=${snap.totalAggregatedBandwidthMhz} MHz]`
  );
  for (const [idx, cc] of snap.caCarriers.entries()) {
    console.log(
      `  -> CC#${idx + 1} [${cc.rat}] Band=${cc.band} | BW=${cc.bandwidthMhz} MHz | ARFCN=${cc.arfcn}`
    );
  }

  console.log(
    `LTE PCC (${snap.pccBand}) RF Metrics   : PCI=${snap.pci} | EARFCN="${snap.earfcnRaw}" | DL/UL BW=${snap.lteDlBandwidthMhz}/${snap.lteUlBandwidthMhz} MHz | RSRP=${snap.lteRsrpDbm} dBm | RSRQ=${snap.lteRsrqDb} dB | RSSI=${snap.lteRssiDbm} dBm | SINR=${snap.lteSinrDb} dB`
  );
  console.log(
    `5G NR Anchor Metrics          : NR-ARFCN="${snap.nrArfcnRaw}" | DL/UL BW=${snap.nrDlBandwidthMhz}/${snap.nrUlBandwidthMhz} MHz | RSRP=${snap.nrRsrpDbm} dBm | RSRQ=${snap.nrRsrqDb} dB | SINR=${snap.nrSinrDb} dB`
  );

  for (const scc of [...snap.lteScc, ...snap.nrScc]) {
    console.log(
      `  -> SCC [${scc.rat}] Band=${scc.band} (${scc.bandwidthMhz} MHz, ARFCN=${scc.arfcn}, PCI=${scc.pci}): RSRP=${scc.rsrpDbm} dBm, RSRQ=${scc.rsrqDb} dB, RSSI=${scc.rssiDbm} dBm, SINR=${scc.sinrDb} dB`
    );
  }

  console.log(
    `MIMO & Spatial Multiplexing   : TransMode=${snap.transmissionMode} | LTE RI=${snap.lteMimoRank} layers | NR Rank=${snap.nrMimoRank} layers | LTE CQI=(${snap.lteCqi0}, ${snap.lteCqi1}) | NR CQI=(${snap.nrCqi0}, ${snap.nrCqi1})`
  );
  console.log(
    `LTE MCS (UL / DL)             : UL=[${snap.lteUlMcs.map((m) => `${m.label}:${m.index}@${m.modulation ?? "N/A"}`).join(", ")}] | DL=[${snap.lteDlMcs.map((m) => `${m.label}:${m.index}@${m.modulation ?? "N/A"}`).join(", ")}]`
  );
  console.log(
    `5G NR MCS (UL / DL)           : UL=[${snap.nrUlMcs.map((m) => `${m.label}:${m.index}@${m.modulation ?? "N/A"}`).join(", ")}] | DL=[${snap.nrDlMcs.map((m) => `${m.label}:${m.index}@${m.modulation ?? "N/A"}`).join(", ")}]`
  );
  console.log(
    `LTE TxPower                   : PUSCH=${snap.lteTxPower.puschDbm} dBm, PUCCH=${snap.lteTxPower.pucchDbm} dBm, SRS=${snap.lteTxPower.srsDbm} dBm, PRACH=${snap.lteTxPower.prachDbm} dBm`
  );
  console.log(
    `5G NR TxPower                 : PUSCH=${snap.nrTxPower.puschDbm} dBm, PUCCH=${snap.nrTxPower.pucchDbm} dBm, SRS=${snap.nrTxPower.srsDbm} dBm, PRACH=${snap.nrTxPower.prachDbm} dBm`
  );
  console.log(
    `Redacted Tower Identity Proof : CellID=${snap.cellIdDisplay} (${cellIdObs.encodingHint}, ${cellIdObs.byteLength}B) <-> cellinfo (${cellHexObs.encodingHint}, ${cellHexObs.byteLength}B) match=${snap.identityVerification.eciDecimalMatchesHex} | eNodeB=(eci>>8) match=${snap.identityVerification.eNodeBDerivationMatchesTag}`
  );
  console.log(
    `Redacted TAC Equivalence Proof: TAC=${snap.tacDisplay} (${tacDecObs.encodingHint}, ${tacDecObs.byteLength}B) <-> lac (${lacHexObs.encodingHint}, ${lacHexObs.byteLength}B) match=${snap.identityVerification.tacDecimalMatchesHex}`
  );
}

main().catch((err: unknown) => {
  console.error("Probe #3 failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
