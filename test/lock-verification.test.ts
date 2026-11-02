import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { AlertEngine } from "../src/alert-engine.ts";
import { createFengSuiCore, stopFengSuiCore } from "../src/core.ts";
import { HuaweiCpeClient } from "../src/cpe-client.ts";
import { type GlobalTelemetrySnapshot, type PersistedLockState, mergeBandLockState, verifyLockState } from "../src/cpe-domain.ts";
import { FengSuiMcpServer, type JsonRpcSuccessResponse } from "../src/mcp-server.ts";
import { EncryptedStateStore } from "../src/state-store.ts";
import { TimeSeriesRingBuffer } from "../src/timeseries.ts";
import { type StrictFault, createStrictCpe } from "./helpers/strict-cpe.ts";

/** Parse a real telemetry snapshot from the strict router (PCC B1/100/PCI 357, SCC B3/1700/PCI 25, NR N78/647424/PCI 357). */
async function snapshot(opts: { lteBandHex?: string; noNr?: boolean } = {}): Promise<GlobalTelemetrySnapshot> {
  const fault = (p: string): StrictFault | undefined => {
    if (p === "/api/net/net-mode" && opts.lteBandHex) {
      return { body: `<response><NetworkMode>00</NetworkMode><NetworkBand>3fffffff</NetworkBand><LTEBand>${opts.lteBandHex}</LTEBand></response>` };
    }
    if (opts.noNr && p === "/api/device/seccellinfo") return { body: "<response><lteseccell_list>1700,B3,20MHz,25,-84dBm,-6dB,-70dBm,14dB;</lteseccell_list><nrseccell_list></nrseccell_list></response>" };
    if (opts.noNr && p === "/api/device/signal") {
      return {
        body: "<response><pci>357</pci><rsrp>-87dBm</rsrp><sinr>13dB</sinr><earfcn>DL:100 UL:18100</earfcn><band>20MHz@100(B1) + 20MHz@1700(B3)</band><bandInfo>B1</bandInfo></response>",
      };
    }
    return undefined;
  };
  const cpe = createStrictCpe({ fault });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fengsui-lockver-"));
  const core = createFengSuiCore({
    client: new HuaweiCpeClient({ cpeUrl: "http://192.168.8.1", cpePassword: cpe.password, fetchImpl: cpe.fetchImpl }),
    stateStore: new EncryptedStateStore({ filePath: path.join(dir, "state.json"), encryptionKey: "lockver_key" }),
    timeseries: new TimeSeriesRingBuffer({ retentionHours: 24 }),
  });
  core.monitor.init();
  try {
    const snap = await core.monitor.refreshTelemetry();
    assert.ok(snap);
    return snap;
  } finally {
    await stopFengSuiCore(core);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const HOUR_AGO = "2026-10-30T09:00:00.000Z";
function lock(partial: Partial<PersistedLockState>): PersistedLockState {
  return { mode: "unlocked", updatedAtIso: HOUR_AGO, lteBands: "all", nrBands: [], cellLock: null, ...partial };
}

describe("lockState reconciliation against what the router reports", () => {
  it("reads back the LTE band mask: unlocked and explicit band locks", async () => {
    const full = await snapshot();
    const unlocked = verifyLockState(lock({}), full);
    assert.equal(unlocked.status, "consistent");
    assert.deepEqual(unlocked.routerLteBands, [1, 3, 5, 7, 8, 20, 28, 32, 38, 40, 41, 42, 43, 71]);
    assert.equal(unlocked.checkedAtIso, full.capturedAtIso);

    const b1b3 = await snapshot({ lteBandHex: "5" });
    assert.equal(verifyLockState(lock({}), b1b3).status, "drift", "someone locked LTE bands in the WebUI");
    assert.match(verifyLockState(lock({}), b1b3).issues[0] ?? "", /router enables only B1, B3/);
    assert.equal(verifyLockState(lock({ mode: "band_lock", lteBands: [1, 3] }), b1b3).status, "consistent");
    const reverted = verifyLockState(lock({ mode: "band_lock", lteBands: [1, 3] }), full);
    assert.equal(reverted.status, "drift", "the router dropped the applied band lock");
    assert.match(reverted.issues.join(" "), /differ from the applied lock \(B1, B3\)/);
  });

  it("checks NR band locks and cell locks against the serving carriers", async () => {
    const full = await snapshot();
    assert.equal(verifyLockState(lock({ mode: "band_lock", nrBands: [78] }), full).status, "consistent");
    const wrongNr = verifyLockState(lock({ mode: "band_lock", nrBands: [41] }), full);
    assert.equal(wrongNr.status, "drift");
    assert.match(wrongNr.issues.join(" "), /NR carrier N78 is outside the locked NR bands \(N41\)/);

    const servingCell = lock({ mode: "cell_lock", lteBands: [1], cellLock: { rat: "LTE", band: 1, arfcn: 100, pci: 357 } });
    assert.equal(verifyLockState(servingCell, full).status, "consistent");
    const sccOnly = lock({ mode: "cell_lock", lteBands: [3], cellLock: { rat: "LTE", band: 3, arfcn: 1700, pci: 25 } });
    const sccResult = verifyLockState(sccOnly, full);
    assert.equal(sccResult.status, "drift", "an LTE cell lock must be the primary serving cell");
    assert.match(sccResult.issues.join(" "), /serving LTE cell B1\/100\/PCI 357 is not the locked cell B3\/1700\/PCI 25/);
    const lteFreq = lock({ mode: "cell_lock", lteBands: [1], cellLock: { rat: "LTE", band: 1, arfcn: 100, pci: null } });
    assert.equal(verifyLockState(lteFreq, full).status, "consistent");

    const nrCell = lock({ mode: "cell_lock", nrBands: [78], cellLock: { rat: "NR", band: 78, arfcn: 647424, pci: 357 } });
    assert.equal(verifyLockState(nrCell, full).status, "consistent");
    assert.equal(verifyLockState({ ...nrCell, cellLock: { rat: "NR", band: 78, arfcn: 647424, pci: 1 } }, full).status, "drift");
    const idleNr = await snapshot({ noNr: true });
    assert.equal(verifyLockState(nrCell, idleNr).status, "unknown", "no NR carrier observed: nothing decides it");
    assert.equal(verifyLockState(lock({ mode: "band_lock", nrBands: [78] }), idleNr).status, "unknown");
  });

  it("reports settling right after a lock and unknown without telemetry", async () => {
    const full = await snapshot();
    const fresh = lock({ mode: "band_lock", lteBands: [3], updatedAtIso: new Date(full.capturedAtMs - 30_000).toISOString() });
    assert.equal(verifyLockState(fresh, full).status, "settling", "the modem may still be re-attaching");
    assert.equal(verifyLockState({ ...fresh, updatedAtIso: HOUR_AGO }, full).status, "drift");
    const none = verifyLockState(lock({}), null);
    assert.deepEqual(none, { status: "unknown", checkedAtIso: null, routerLteBands: null, issues: [] });
  });

  it("exposes the verification through MCP get_cpe_telemetry", async () => {
    const cpe = createStrictCpe();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fengsui-lockmcp-"));
    const core = createFengSuiCore({
      client: new HuaweiCpeClient({ cpeUrl: "http://192.168.8.1", cpePassword: cpe.password, fetchImpl: cpe.fetchImpl }),
      stateStore: new EncryptedStateStore({ filePath: path.join(dir, "state.json"), encryptionKey: "lockmcp_key" }),
      timeseries: new TimeSeriesRingBuffer({ retentionHours: 24 }),
    });
    core.monitor.init();
    core.stateStore.update({ lockState: lock({ mode: "band_lock", lteBands: [1, 3] }) });
    try {
      const server = new FengSuiMcpServer({ core });
      const res = (await server.handleRawJsonMessage(
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_cpe_telemetry", arguments: { refresh: true } } })
      )) as JsonRpcSuccessResponse;
      const content = (res.result as { structuredContent: { lockVerification: { status: string; issues: string[] } } }).structuredContent;
      assert.equal(content.lockVerification.status, "drift", "the strict router still enables all 14 LTE bands");
      assert.match(content.lockVerification.issues[0] ?? "", /differ from the applied lock \(B1, B3\)/);
    } finally {
      await stopFengSuiCore(core);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the other RAT's lock when a band lock names only one RAT (no false drift, no forgotten lock)", async () => {
    const b1b3 = await snapshot({ lteBandHex: "5" });
    const now = new Date(b1b3.capturedAtMs - 3_600_000).toISOString();
    // LTE locked to B1+B3 earlier; now only NR is locked: net-mode is not written, so LTE stays B1+B3
    const lteLocked = lock({ mode: "band_lock", lteBands: [1, 3] });
    const nrOnly = mergeBandLockState(lteLocked, { nrBands: ["N78"] }, lock({ mode: "band_lock", lteBands: "all", nrBands: [78], updatedAtIso: now }), [1, 3]);
    assert.deepEqual([nrOnly.mode, nrOnly.lteBands, nrOnly.nrBands], ["band_lock", [1, 3], [78]]);
    assert.equal(verifyLockState(nrOnly, b1b3).status, "consistent", "the router really enables only B1+B3");
    // NR locked to N78 earlier; now only LTE is locked: lock-freq is not written, so the NR lock stays
    const nrLocked = lock({ mode: "band_lock", nrBands: [78] });
    const lteOnly = mergeBandLockState(nrLocked, { lteBands: ["B1", "B3"] }, lock({ mode: "band_lock", lteBands: [1, 3], updatedAtIso: now }), [1, 3]);
    assert.deepEqual([lteOnly.mode, lteOnly.lteBands, lteOnly.nrBands], ["band_lock", [1, 3], [78]]);
    // A cell lock lives in lock-freq too: an LTE-only band lock leaves it in force
    const cell = lock({ mode: "cell_lock", lteBands: [1], cellLock: { rat: "LTE", band: 1, arfcn: 100, pci: 357 } });
    const keepsCell = mergeBandLockState(cell, { lteBands: ["B1", "B3"] }, lock({ mode: "band_lock", lteBands: [1, 3], updatedAtIso: now }), [1, 3]);
    assert.deepEqual([keepsCell.mode, keepsCell.cellLock], ["cell_lock", cell.cellLock]);
    assert.equal(keepsCell.updatedAtIso, now);
    // An NR band lock rewrites lock-freq (LTE part unlocked), so it ends the cell lock; LTE keeps the router's mask
    const endsCell = mergeBandLockState(cell, { nrBands: ["N78"] }, lock({ mode: "band_lock", nrBands: [78], updatedAtIso: now }), [1, 3]);
    assert.deepEqual([endsCell.mode, endsCell.lteBands, endsCell.nrBands, endsCell.cellLock], ["band_lock", [1, 3], [78], null]);
    // NR "all" clears lock-freq; with LTE unlocked too, everything is unlocked
    const unlocked = mergeBandLockState(nrLocked, { nrBands: "all" }, lock({ mode: "unlocked", updatedAtIso: now }), null);
    assert.deepEqual([unlocked.mode, unlocked.lteBands, unlocked.nrBands], ["unlocked", "all", []]);
    // Full commands are recorded as given
    const both = mergeBandLockState(nrLocked, { lteBands: "all", nrBands: "all" }, lock({ mode: "unlocked", updatedAtIso: now }), [1, 3]);
    assert.deepEqual([both.mode, both.lteBands, both.nrBands], ["unlocked", "all", []]);
  });

  it("records a one-RAT band lock on top of the lock already in force (controls service)", async () => {
    const cpe = createStrictCpe();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fengsui-lockmerge-"));
    const core = createFengSuiCore({
      client: new HuaweiCpeClient({ cpeUrl: "http://192.168.8.1", cpePassword: cpe.password, fetchImpl: cpe.fetchImpl }),
      stateStore: new EncryptedStateStore({ filePath: path.join(dir, "state.json"), encryptionKey: "lockmerge_key" }),
      timeseries: new TimeSeriesRingBuffer({ retentionHours: 24 }),
    });
    core.monitor.init();
    try {
      await core.controls.lockBands({ lteBands: ["B1", "B3"], nrBands: "all" });
      const nrOnly = await core.controls.lockBands({ nrBands: ["N78"] });
      assert.deepEqual([nrOnly.mode, nrOnly.lteBands, nrOnly.nrBands], ["band_lock", [1, 3], [78]]);
      assert.deepEqual(core.controls.getPersistedLockState(), nrOnly);
      const netModeWrites = cpe.stats.writes.filter((w) => w.path === "/api/net/net-mode").length;
      assert.equal(netModeWrites, 1, "the NR-only lock did not touch the LTE mask");
    } finally {
      await stopFengSuiCore(core);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("raises LOCK_DRIFT once a drift is sustained and LOCK_REALIGNED when it clears", async () => {
    const full = await snapshot();
    const b1b3 = await snapshot({ lteBandHex: "5" });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fengsui-lockalert-"));
    const cpe = createStrictCpe();
    const core = createFengSuiCore({
      client: new HuaweiCpeClient({ cpeUrl: "http://192.168.8.1", cpePassword: cpe.password, fetchImpl: cpe.fetchImpl }),
      stateStore: new EncryptedStateStore({ filePath: path.join(dir, "state.json"), encryptionKey: "lockalert_key" }),
      timeseries: new TimeSeriesRingBuffer({ retentionHours: 24 }),
    });
    core.monitor.init();
    core.stateStore.update({ lockState: lock({}) });
    const codes: string[] = [];
    core.scheduler.on("alert", (a: { code: string }) => codes.push(a.code));
    const engine = new AlertEngine({ scheduler: core.scheduler, monitor: core.monitor, controls: core.controls, lockDriftAfterMs: 60_000 });
    try {
      const at = (snap: GlobalTelemetrySnapshot, ms: number): GlobalTelemetrySnapshot => ({ ...snap, capturedAtMs: ms, capturedAtIso: new Date(ms).toISOString() });
      const t0 = Date.parse("2026-10-30T12:00:00Z");
      engine.ingestTelemetry(at(b1b3, t0));
      engine.ingestTelemetry(at(b1b3, t0 + 30_000));
      assert.deepEqual(codes, [], "a short drift does not alert");
      engine.ingestTelemetry(at(b1b3, t0 + 61_000));
      engine.ingestTelemetry(at(b1b3, t0 + 120_000));
      assert.deepEqual(codes, ["LOCK_DRIFT"], "fires once per episode");
      engine.ingestTelemetry(at(full, t0 + 125_000));
      assert.deepEqual(codes, ["LOCK_DRIFT", "LOCK_REALIGNED"]);
      assert.equal(core.controls.getLockVerification().status, "unknown", "no cached telemetry in this core yet");
    } finally {
      await stopFengSuiCore(core);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
