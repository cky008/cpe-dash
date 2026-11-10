import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SchedulerStatusSnapshot } from "../src/api-contract.ts";
import { H168_383_LTE_BANDS, checkCellLockInput } from "../src/rf-bounds.ts";
import { bandText, cellLockForm, driverFamilyOf, locksNrBands, parseBandText } from "../web/src/core/lock-form.ts";

const status = (family: string | undefined): SchedulerStatusSnapshot => ({ device: family === undefined ? {} : { family } }) as unknown as SchedulerStatusSnapshot;

describe("web core: lock forms per router brand", () => {
  it("knows when another brand's driver speaks to the router", () => {
    assert.equal(driverFamilyOf(null), null);
    assert.equal(driverFamilyOf(status(undefined)), null, "a status from before brands existed is the HiLink stack's");
    assert.equal(driverFamilyOf(status("huawei")), null);
    assert.equal(driverFamilyOf(status("openwrt")), "openwrt");
    assert.equal(locksNrBands("openwrt"), true);
    assert.equal(locksNrBands("nradio"), true);
  });

  it("keeps the verified router's own form: its bands, and a frequency lock without a PCI", () => {
    const form = cellLockForm(status("huawei"));
    assert.deepEqual([form.driver, form.pciRequired], [false, false]);
    assert.deepEqual(form.bands("LTE"), H168_383_LTE_BANDS);
    assert.equal(form.check, checkCellLockInput, "the daemon's own check");
    assert.equal(form.check({ rat: "NR", band: 78, arfcn: 650000, pci: null }).ok, true);
    assert.equal(cellLockForm(null).driver, false);
  });

  it("offers every 3GPP band on another brand, checks the channel against the band, and always asks for a PCI", () => {
    const form = cellLockForm(status("zte-goform"));
    assert.deepEqual([form.driver, form.pciRequired], [true, true]);
    for (const band of [34, 39]) assert.ok(form.bands("LTE").includes(band), `B${band} is no band of the verified router, and one many others use`);
    assert.ok(form.bands("NR").includes(79));
    assert.deepEqual(form.range("LTE", 3), [1200, 1949]);
    assert.equal(form.range("NR", 999), undefined);

    assert.deepEqual(form.check({ rat: "LTE", band: 3, arfcn: 1850, pci: 142 }), { ok: true, value: { rat: "LTE", band: 3, arfcn: 1850, pci: 142 } });
    const noPci = form.check({ rat: "LTE", band: 3, arfcn: 1850, pci: null });
    assert.deepEqual([noPci.ok, !noPci.ok && noPci.field], [false, "pci"], "a driver locks one cell, never a frequency");
    const off = form.check({ rat: "LTE", band: 3, arfcn: 300, pci: 1 });
    assert.deepEqual([!off.ok && off.field, !off.ok && off.range], ["arfcn", [1200, 1949]]);
    const wide = form.check({ rat: "NR", band: 78, arfcn: 650000, pci: 1008 });
    assert.deepEqual([!wide.ok && wide.field, !wide.ok && wide.range], ["pci", [0, 1007]]);
    for (const band of [0, 999, 3.5, "B3"]) {
      const bad = form.check({ rat: "LTE", band, arfcn: 1850, pci: 1 });
      assert.equal(!bad.ok && bad.field, "band", String(band));
    }
    assert.equal(form.check({ rat: "LTE", band: 3, arfcn: Number.NaN, pci: 1 }).ok, false);
  });

  it("reads bands typed as text, and says when something is not a band", () => {
    assert.deepEqual(parseBandText("LTE", "1, 3，41"), [1, 3, 41]);
    assert.deepEqual(parseBandText("LTE", "B3 b1 B3"), [1, 3], "sorted, each once");
    assert.deepEqual(parseBandText("NR", "n78+n41"), [41, 78]);
    assert.equal(parseBandText("NR", " ALL "), "all");
    assert.equal(parseBandText("LTE", "   "), undefined, "an empty field leaves that RAT as it is");
    for (const text of ["1, x", "999", "n", "1.5", "-3", "1,,;"]) assert.equal(parseBandText("LTE", text) === null || text === "1,,;", true, text);
    assert.deepEqual(parseBandText("LTE", "1,,;"), [1]);
    assert.equal(parseBandText("LTE", "78"), null, "an NR band is no LTE band");
    assert.equal(parseBandText("LTE", ",;"), null);
    assert.deepEqual([bandText("all"), bandText([1, 3]), bandText([]), bandText(null), bandText(undefined)], ["all", "1, 3", "", "", ""]);
  });
});
