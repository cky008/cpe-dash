import {
  bandsToHexMask,
  buildLteBandNetModeXml,
  buildLteCellLockXml,
  buildNrBandLockXml,
  buildNrCellLockXml,
  buildUnlockAllLocksXml,
  hexMaskToBands,
} from "../src/band-lock.ts";
import { loadConfig } from "../src/config.ts";
import { HuaweiCpeClient } from "../src/cpe-client.ts";
import { sanitizeXml } from "../src/sanitize.ts";
import { getXmlBlocks, getXmlTag } from "../src/xml.ts";

async function main(): Promise<void> {
  const offlineOnly = process.argv.includes("--offline");
  console.log("=== [FengSui Probe #2] BandMask & Cell Lock Algorithm Verification ===");

  // 1. Offline vector verification against CpeVendorHUAWEI v3.8.4 & H168-383 reference vectors
  const refLteBands = [1, 3, 5, 7, 8, 20, 28, 32, 38, 40, 41, 42, 43, 71];
  const computedLteMask = bandsToHexMask(refLteBands);
  const computedN78Mask = bandsToHexMask(["N78"]);

  console.log(`[Vector 1] H168-383 14-Band LTE Mask : 0x${computedLteMask}`);
  console.log(`           Decoded Bands             : ${hexMaskToBands(computedLteMask).map((b) => `B${b}`).join(", ")}`);
  console.log(`[Vector 2] 5G NR N78 Mask            : 0x${computedN78Mask}`);
  console.log(`[Sample]   LTE B1+B3 Lock XML        : ${buildLteBandNetModeXml(["B1", "B3"])}`);
  console.log(`[Sample]   5G N78 Band Lock XML      : ${buildNrBandLockXml(["N78"])}`);
  console.log(`[Sample]   4G Cell Lock (B3/1850/211): ${buildLteCellLockXml({ band: 3, earfcn: 1850, pci: 211 })}`);
  console.log(`[Sample]   5G Cell Lock (N78/650000) : ${buildNrCellLockXml({ band: 78, nrArfcn: 650000, pci: 211 })}`);
  console.log(`[Sample]   Full Unlock XML           : ${buildUnlockAllLocksXml()}`);

  if (offlineOnly) return;

  // 2. Live read-only hardware verification against H168-383
  const cfg = loadConfig();
  const secrets = [cfg.cpePassword, cfg.apiToken, cfg.dataEncryptionKey].filter(Boolean);
  const client = new HuaweiCpeClient({
    cpeUrl: cfg.cpeUrl,
    cpeUsername: cfg.cpeUsername,
    cpePassword: cfg.cpePassword,
    requestTimeoutMs: cfg.requestTimeoutMs,
    respectBrowserSession: cfg.respectBrowserSession,
  });
  client.rememberLoginScheme("scram");

  console.log("\n--- Live Read-Only Verification on H168-383 ---");
  const preState = await client.getLoginState();
  console.log(
    `Pre-check /api/user/state-login -> State=${preState.state}, isLoggedInElsewhere=${preState.isLoggedInElsewhere}, isLocked=${preState.isLocked}`
  );

  const liveResult = await client.withSession(async (session) => {
    const [featureXml, netModeXml, modeListXml, lockFreqXml] = await Promise.all([
      session.get("/api/net/net-feature-switch"),
      session.get("/api/net/net-mode"),
      session.get("/api/net/net-mode-list"),
      session.get("/api/net/lock-freq").catch((err: unknown) =>
        err instanceof Error ? `<probe_note>${err.message}</probe_note>` : ""
      ),
    ]);
    return { featureXml, netModeXml, modeListXml, lockFreqXml };
  });

  const telemetry = client.getTelemetry();
  if (!liveResult) {
    console.log(
      `[Yielded] Active browser admin session detected (State=${preState.state}); probe yielded peacefully without login.`
    );
    return;
  }

  const selectBandSwitch = getXmlTag(liveResult.featureXml, "select_band_switch");
  const lockFreqSwitch = getXmlTag(liveResult.featureXml, "lock_freq_switch");
  const networkMode = getXmlTag(liveResult.netModeXml, "NetworkMode") ?? "";
  const liveLteMask = getXmlTag(liveResult.netModeXml, "LTEBand") ?? "";
  const decodedLiveBands = liveLteMask ? hexMaskToBands(liveLteMask) : [];

  console.log(`Ephemeral Session Hold Time : ${telemetry.lastSessionHoldMs} ms (logged out cleanly)`);
  console.log(`Feature Switches            : select_band_switch=${selectBandSwitch}, lock_freq_switch=${lockFreqSwitch}`);
  console.log(`Active NetworkMode          : ${networkMode} | LTEBand=0x${liveLteMask}`);
  console.log(`Decoded Active LTE Bands    : ${decodedLiveBands.map((b) => `B${b}`).join(", ")}`);

  const lteListSection = getXmlBlocks(liveResult.modeListXml, "LTEBandList")[0] ?? "";
  for (const block of getXmlBlocks(lteListSection, "LTEBand")) {
    const name = getXmlTag(block, "Name") ?? "";
    const val = (getXmlTag(block, "Value") ?? "").toLowerCase();
    const nums = [...name.matchAll(/BC(\d+)/gi)].map((m) => Number.parseInt(m[1]!, 10));
    if (nums.length > 0 && val) {
      const recomputed = bandsToHexMask(nums);
      console.log(
        `Router Advertised LTE List  : match=${recomputed === val} (router=0x${val}, computed=0x${recomputed})`
      );
    }
  }

  console.log(
    `GET /api/net/lock-freq      : ${sanitizeXml(liveResult.lockFreqXml, secrets).replace(/\s+/g, " ")}`
  );
}

main().catch((err: unknown) => {
  console.error("Probe #2 failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
