import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_NET_MODE_KEEP } from "../src/band-lock.ts";
import { CpeControlValidationError } from "../src/control-error.ts";
import { HuaweiCpeClient } from "../src/protocols/hilink/client.ts";
import { type GlobalTelemetrySnapshot, type PersistedLockState, netModeKeepOf } from "../src/cpe-domain.ts";
import { DeviceAccess, newWriteCheck } from "../src/device-access.ts";
import { HilinkRouterSession, huaweiDriver } from "../src/drivers/huawei.ts";
import type { VerifiedFeature } from "../src/firmware.ts";
import type { RouterSessionContext } from "../src/router-session.ts";
import type { WriteContext } from "../src/scheduler.ts";
import { createStrictCpe } from "./helpers/strict-cpe.ts";

/**
 * The cellular settings on the verified H168-383 (4.4.0.1): open only where they were checked on the
 * real router and filed in VERIFIED_FEATURES (2026-11-13: data roaming, the network mode, operator
 * selection and scan, clearing the traffic counters), sent in the form the router took, and its band
 * lock writing the mode the latest poll saw along. A strict mock that answers as the real router did.
 */

const H168 = { family: "huawei", model: "H168-383", softwareVersion: "4.4.0.1", access: "write", issue: 1 } as const;
const CHECKED: ReadonlyArray<VerifiedFeature> = (["roaming", "networkMode", "operatorSelect", "trafficReset"] as const).map((feature) => ({ ...H168, feature }));

function verifiedDevice(list: ReadonlyArray<VerifiedFeature> = CHECKED): DeviceAccess {
  const device = new DeviceAccess({ verifiedFeatures: list });
  device.see("H168-383", "4.4.0.1");
  return device;
}

/** A poll that saw this mode (only the band config matters to a band lock). */
function polled(bandConfig: Partial<GlobalTelemetrySnapshot["bandConfig"]>): GlobalTelemetrySnapshot {
  return { bandConfig: { networkMode: "00", networkBandHex: "2000004680380", lteBandHex: "40000007A0880800D5", activeLteBands: [1, 3], ...bandConfig } } as unknown as GlobalTelemetrySnapshot;
}

const UNLOCKED: PersistedLockState = { mode: "unlocked", updatedAtIso: "2026-11-13T00:00:00.000Z", lteBands: "all", nrBands: [], cellLock: null };

/** One session on the strict H168-383, as the verified model (`generic` false), with this poll behind it. */
async function onH168<T>(telemetry: GlobalTelemetrySnapshot | null, fn: (session: HilinkRouterSession, write: WriteContext) => Promise<T>) {
  const cpe = createStrictCpe({ cellular: true });
  const client = new HuaweiCpeClient({ cpeUrl: "http://192.168.8.1", cpePassword: cpe.password, fetchImpl: cpe.fetchImpl, requestTimeoutMs: 3000 });
  const ctx: RouterSessionContext = { device: verifiedDevice(), noteRouterModel: () => undefined, readSection: async (_section, read) => await read(), latestTelemetry: () => telemetry };
  const write: WriteContext = { generic: false, lteBands: null, check: newWriteCheck() };
  const value = await client.withSession((session) => fn(new HilinkRouterSession(session, ctx), write));
  const bodies = (path: string): string[] => cpe.stats.writes.filter((w) => w.path === path).map((w) => w.body.replace(/^<\?xml[^>]*\?>/, ""));
  return { value, cpe, write, bodies };
}

describe("H168-383: which cellular settings the gate opens", () => {
  it("opens the ones filed for it and no other, as verified writes", () => {
    const device = verifiedDevice();
    assert.deepEqual(
      (["roaming", "networkMode", "operatorSelect", "trafficReset", "ussd", "simSlot", "apn", "bandLock"] as const).map((feature) => device.writeState(feature)),
      ["verified", "verified", "verified", "verified", "not_implemented", "not_implemented", "not_implemented", "verified"]
    );
    assert.equal(device.writeAccess("networkMode"), "allowed", "a verified write, not an experimental one");
    // Like its other writes, a verified one: no switch turns it off, whatever a list says
    device.setDisabledWrites([{ model: "H168-383", feature: "roaming" }]);
    assert.equal(device.writeState("roaming"), "verified");
    // Nothing filed: as before, none of them
    const none = verifiedDevice([]);
    assert.deepEqual([none.writeState("roaming"), none.writeState("networkMode"), none.writeState("bandLock")], ["not_implemented", "not_implemented", "verified"]);
    // Filed for another model or brand: not this router's
    const elsewhere = verifiedDevice([{ ...CHECKED[0]!, model: "H155-381" }, { ...CHECKED[1]!, family: "zte-goform" }]);
    assert.deepEqual([elsewhere.writeState("roaming"), elsewhere.writeState("networkMode")], ["not_implemented", "not_implemented"]);
  });

  it("reads the cellular settings only where one of them is open", () => {
    assert.equal(huaweiDriver.reads("cellular", verifiedDevice()), true);
    assert.equal(huaweiDriver.reads("cellular", verifiedDevice([])), false);
  });
});

describe("H168-383: the cellular requests", () => {
  it("switches the network mode with the two fields its own page sends, reading both back", async () => {
    const fx = await onH168(null, (session, write) => session.setNetworkMode("lte", write));
    assert.deepEqual(fx.value, { previous: "auto" });
    assert.deepEqual(fx.bodies("/api/net/net-mode"), ["<request><NetworkMode>03</NetworkMode><LTEBandOption>0</LTEBandOption></request>"]);
    assert.deepEqual([fx.write.check.readback, fx.cpe.cellular?.netMode.NetworkMode, fx.cpe.cellular?.netMode.LTEBandOption], ["match", "03", "0"]);
    // The generic three fields are what the router refused with -1
    const sa = await onH168(null, (session, write) => session.setNetworkMode("nr_sa", write));
    assert.equal(sa.bodies("/api/net/net-mode")[0], "<request><NetworkMode>00</NetworkMode><networkOption>1</networkOption></request>");
  });

  it("writes data roaming with the connection's other settings, selects with Rat 255 and clears the counters", async () => {
    const roaming = await onH168(null, (session, write) => session.setRoaming(true, write));
    assert.deepEqual(roaming.bodies("/api/dialup/connection"), [
      "<request><RoamAutoConnectEnable>1</RoamAutoConnectEnable><MaxIdelTime>600</MaxIdelTime><ConnectMode>0</ConnectMode><MTU>1500</MTU><auto_dial_switch>1</auto_dial_switch><pdp_always_on>0</pdp_always_on></request>",
    ]);
    assert.equal(roaming.write.check.readback, "match");
    const manual = await onH168(null, (session, write) => session.selectOperator({ mode: "manual", plmn: "27201", rat: "4G" }, write));
    assert.deepEqual([manual.bodies("/api/net/register"), manual.value], [["<request><Mode>1</Mode><Plmn>27201</Plmn><Rat>255</Rat></request>"], { previous: { mode: "auto" } }]);
    assert.equal(manual.write.check.readback, "match", "Mode 1 read back, no other operator named");
    const scan = await onH168(null, (session, write) => session.scanOperators(write));
    assert.deepEqual(scan.value?.map((n) => n.state), ["available", "available"]);
    const clear = await onH168(null, (session, write) => session.resetTraffic(write));
    assert.deepEqual([clear.bodies("/api/monitoring/clear-traffic"), clear.write.check.readback], [["<request><ClearTraffic>1</ClearTraffic></request>"], "match"]);
  });

  it("never sends USSD, which nobody could check on it (the router reports it switched off)", async () => {
    const cpe = createStrictCpe({ cellular: true });
    const client = new HuaweiCpeClient({ cpeUrl: "http://192.168.8.1", cpePassword: cpe.password, fetchImpl: cpe.fetchImpl, requestTimeoutMs: 3000 });
    const ctx: RouterSessionContext = { device: verifiedDevice(), noteRouterModel: () => undefined, readSection: async (_section, read) => await read(), latestTelemetry: () => null };
    await assert.rejects(
      client.withSession((session) => new HilinkRouterSession(session, ctx).sendUssd({ kind: "send", code: "*100#" }, { generic: false, lteBands: null, check: newWriteCheck() })),
      CpeControlValidationError
    );
    assert.deepEqual(cpe.stats.writes, []);
  });
});

describe("H168-383: a band lock keeps the network mode", () => {
  it("names the mode the poll saw, and falls back to the verified request otherwise", () => {
    assert.deepEqual(netModeKeepOf(polled({ networkOption: "2", lteBandOption: "0" }).bandConfig), DEFAULT_NET_MODE_KEEP);
    assert.deepEqual(netModeKeepOf(polled({ networkOption: "1" }).bandConfig), { networkMode: "00", networkOption: "1" });
    assert.deepEqual(netModeKeepOf(polled({ networkMode: "03", networkOption: "2", lteBandOption: "2" }).bandConfig), { networkMode: "03", lteBandOption: "2" });
    for (const odd of [polled({ networkMode: "08", networkOption: "2" }), polled({ networkMode: "03" }), polled({ networkOption: "7" })]) {
      assert.deepEqual(netModeKeepOf(odd.bandConfig), DEFAULT_NET_MODE_KEEP);
    }
    assert.deepEqual([netModeKeepOf(null), netModeKeepOf(undefined)], [DEFAULT_NET_MODE_KEEP, DEFAULT_NET_MODE_KEEP]);
  });

  it("locks and unlocks with the mode's own field, byte for byte the verified request in the default mode", async () => {
    const lockCtx = (telemetry: GlobalTelemetrySnapshot) => ({ previousLock: () => UNLOCKED, cachedTelemetry: () => telemetry });
    const usual = polled({ networkOption: "2", lteBandOption: "0" });
    const verified = await onH168(usual, (session, write) => session.lockBands({ lteBands: [1, 3] }, lockCtx(usual), write));
    assert.deepEqual(verified.bodies("/api/net/net-mode"), ["<request><NetworkMode>00</NetworkMode><NetworkBand>3fffffff</NetworkBand><LTEBand>5</LTEBand><networkOption>2</networkOption></request>"]);

    const lteOnly = polled({ networkMode: "03", networkOption: "2", lteBandOption: "1" });
    const kept = await onH168(lteOnly, (session, write) => session.lockBands({ lteBands: [3] }, lockCtx(lteOnly), write));
    assert.deepEqual(kept.bodies("/api/net/net-mode"), ["<request><NetworkMode>03</NetworkMode><NetworkBand>3fffffff</NetworkBand><LTEBand>4</LTEBand><LTEBandOption>1</LTEBandOption></request>"]);
    assert.equal(kept.cpe.cellular?.netMode.NetworkMode, "03", "the router stays 4G FDD only");

    const unlocked = await onH168(lteOnly, (session, write) => session.unlockAll(write));
    assert.equal(unlocked.bodies("/api/net/net-mode")[0], "<request><NetworkMode>03</NetworkMode><NetworkBand>3fffffff</NetworkBand><LTEBand>7fffffffffffffff</LTEBand><LTEBandOption>1</LTEBandOption></request>");

    // SA only: 00 with its networkOption (the rollback after a lock writes this same unlock once the WAN is down)
    const saOnly = polled({ networkOption: "1" });
    const unlockedSa = await onH168(saOnly, (session, write) => session.unlockAll(write));
    assert.equal(unlockedSa.bodies("/api/net/net-mode")[0], "<request><NetworkMode>00</NetworkMode><NetworkBand>3fffffff</NetworkBand><LTEBand>7fffffffffffffff</LTEBand><networkOption>1</networkOption></request>");
  });

  it("refuses a 5G band lock while the router is set to 4G only, before writing anything", async () => {
    const lteOnly = polled({ networkMode: "03", lteBandOption: "0" });
    const cpe = createStrictCpe({ cellular: true });
    const client = new HuaweiCpeClient({ cpeUrl: "http://192.168.8.1", cpePassword: cpe.password, fetchImpl: cpe.fetchImpl, requestTimeoutMs: 3000 });
    const ctx: RouterSessionContext = { device: verifiedDevice(), noteRouterModel: () => undefined, readSection: async (_section, read) => await read(), latestTelemetry: () => lteOnly };
    await assert.rejects(
      client.withSession((session) =>
        new HilinkRouterSession(session, ctx).lockBands({ nrBands: [78] }, { previousLock: () => UNLOCKED, cachedTelemetry: () => lteOnly }, { generic: false, lteBands: null, check: newWriteCheck() })
      ),
      /4G-only network mode: a 5G band lock would do nothing/
    );
    assert.deepEqual(cpe.stats.writes, []);
  });
});
