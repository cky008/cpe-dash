import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  LTE_BANDS,
  NR_BANDS,
  aggregatePeakRateMbps,
  carrierPeakRateMbps,
  decomposePci,
  earfcnToFrequencyMhz,
  earfcnToLteBand,
  frequencyMhzToGscn,
  frequencyMhzToNrArfcn,
  gscnToFrequencyMhz,
  lteBandInfo,
  modulationOrder,
  nrArfcnToBand,
  nrArfcnToFrequencyMhz,
  nrBandInfo,
  nrBandsForArfcn,
  signalGrade,
} from "../src/rf-math.ts";
import { LTE_DL_EARFCN_RANGES, NR_DL_ARFCN_RANGES } from "../src/rf-bounds.ts";

describe("rf-math: band tables", () => {
  it("agree with the H168-383 lock bounds the daemon already enforces", () => {
    for (const [band, range] of Object.entries(LTE_DL_EARFCN_RANGES)) {
      assert.deepEqual(lteBandInfo(Number(band))?.dlEarfcn, range, `B${band}`);
    }
    for (const [band, range] of Object.entries(NR_DL_ARFCN_RANGES)) {
      assert.deepEqual(nrBandInfo(Number(band))?.dlArfcn, range, `n${band}`);
    }
  });

  it("keep LTE EARFCN ranges disjoint and ascending", () => {
    const sorted = [...LTE_BANDS].sort((a, b) => a.dlEarfcn[0] - b.dlEarfcn[0]);
    for (let i = 1; i < sorted.length; i++) {
      const previous = sorted[i - 1];
      const current = sorted[i];
      assert.ok(previous && current && previous.dlEarfcn[1] < current.dlEarfcn[0], `B${previous?.band} overlaps B${current?.band}`);
    }
    for (const info of LTE_BANDS) assert.ok(info.dlEarfcn[0] <= info.dlEarfcn[1]);
  });

  it("put every NR band in its frequency range", () => {
    for (const info of NR_BANDS) {
      assert.equal(info.range, info.band >= 257 ? "FR2" : "FR1");
      assert.ok(info.dlArfcn[0] < info.dlArfcn[1], `n${info.band}`);
    }
    assert.equal(nrBandInfo(4), undefined);
  });
});

describe("rf-math: LTE channel numbers", () => {
  it("map EARFCNs to their band, at both edges", () => {
    assert.equal(earfcnToLteBand(300), 1);
    assert.equal(earfcnToLteBand(1850), 3);
    assert.equal(earfcnToLteBand(0), 1);
    assert.equal(earfcnToLteBand(599), 1);
    assert.equal(earfcnToLteBand(600), 2);
    assert.equal(earfcnToLteBand(6300), 20);
    assert.equal(earfcnToLteBand(38950), 40);
    assert.equal(earfcnToLteBand(55240), 48);
    assert.equal(earfcnToLteBand(54540), 47);
    assert.equal(earfcnToLteBand(66436), 66);
    assert.equal(earfcnToLteBand(68700), 71);
    assert.equal(earfcnToLteBand(70600), 88);
  });

  it("return null for gaps, negatives, fractions and out-of-range values", () => {
    for (const value of [5000, 10360, 35999, 60255, 70646, -1, 1.5, Number.NaN, 262144]) {
      assert.equal(earfcnToLteBand(value), null, String(value));
    }
  });

  it("convert EARFCNs to downlink frequencies (TS 36.101 §5.7.3)", () => {
    assert.equal(earfcnToFrequencyMhz(300), 2140);
    assert.equal(earfcnToFrequencyMhz(1850), 1870);
    assert.equal(earfcnToFrequencyMhz(3800), 1844.9);
    assert.equal(earfcnToFrequencyMhz(39150), 2350);
    assert.equal(earfcnToFrequencyMhz(5000), null);
  });
});

describe("rf-math: NR channel numbers", () => {
  it("map NR-ARFCNs to the preferred band among overlapping ones", () => {
    assert.equal(nrArfcnToBand(650000), 78);
    assert.deepEqual(nrBandsForArfcn(650000), [78, 77]);
    assert.equal(nrArfcnToBand(670000), 77);
    assert.equal(nrArfcnToBand(504990), 41);
    assert.deepEqual(nrBandsForArfcn(504990), [41, 90]);
    assert.equal(nrArfcnToBand(428000), 1);
    assert.deepEqual(nrBandsForArfcn(428000), [1, 66, 65]);
    assert.equal(nrArfcnToBand(154810), 28);
    assert.equal(nrArfcnToBand(723360), 79);
    assert.deepEqual(nrBandsForArfcn(2079167), [257, 261]);
  });

  it("return nothing outside the raster", () => {
    assert.deepEqual(nrBandsForArfcn(0), []);
    assert.equal(nrArfcnToBand(1), null);
    assert.equal(nrArfcnToBand(-5), null);
    assert.equal(nrArfcnToBand(3279166), null);
    assert.equal(nrArfcnToBand(12.5), null);
  });

  it("convert NR-ARFCNs on all three raster segments (TS 38.104 §5.4.2.1)", () => {
    assert.equal(nrArfcnToFrequencyMhz(428000), 2140);
    assert.equal(nrArfcnToFrequencyMhz(650000), 3750);
    assert.equal(nrArfcnToFrequencyMhz(600000), 3000);
    assert.equal(nrArfcnToFrequencyMhz(2016667), 24250.08);
    assert.equal(nrArfcnToFrequencyMhz(2079167), 28000.08);
    assert.equal(nrArfcnToFrequencyMhz(3279166), null);
  });

  it("convert frequencies back to NR-ARFCNs", () => {
    assert.equal(frequencyMhzToNrArfcn(2140), 428000);
    assert.equal(frequencyMhzToNrArfcn(3750), 650000);
    assert.equal(frequencyMhzToNrArfcn(28000.08), 2079167);
    assert.equal(frequencyMhzToNrArfcn(-1), null);
    assert.equal(frequencyMhzToNrArfcn(Number.POSITIVE_INFINITY), null);
  });
});

describe("rf-math: synchronization raster", () => {
  it("converts GSCNs in each range (TS 38.104 Table 5.4.3.1-1)", () => {
    assert.equal(gscnToFrequencyMhz(2), 1.25);
    assert.equal(gscnToFrequencyMhz(3), 1.35);
    assert.equal(gscnToFrequencyMhz(4), 1.45);
    assert.equal(gscnToFrequencyMhz(7499), 3000);
    assert.equal(gscnToFrequencyMhz(7711), 3305.28);
    assert.equal(gscnToFrequencyMhz(22256), 24250.08);
    assert.equal(gscnToFrequencyMhz(1), null);
    assert.equal(gscnToFrequencyMhz(26640), null);
    assert.equal(gscnToFrequencyMhz(4.5), null);
  });

  it("round-trips frequencies through the GSCN", () => {
    for (const gscn of [2, 3, 4, 5000, 7498, 7499, 7711, 22255, 22256, 26639]) {
      const mhz = gscnToFrequencyMhz(gscn);
      assert.ok(mhz !== null);
      assert.equal(frequencyMhzToGscn(mhz), gscn, `GSCN ${gscn}`);
    }
    assert.equal(frequencyMhzToGscn(0), null);
    assert.equal(frequencyMhzToGscn(100001), null);
  });
});

describe("rf-math: cell identities and grades", () => {
  it("splits a PCI into its SSS group and PSS index", () => {
    assert.deepEqual(decomposePci("LTE", 211), { pci: 211, sssGroup: 70, pssIndex: 1 });
    assert.deepEqual(decomposePci("NR", 1007), { pci: 1007, sssGroup: 335, pssIndex: 2 });
    assert.equal(decomposePci("LTE", 504), null);
    assert.equal(decomposePci("NR", -1), null);
  });

  it("grades signal readings at the thresholds", () => {
    assert.equal(signalGrade("rsrp", -80), "excellent");
    assert.equal(signalGrade("rsrp", -80.1), "good");
    assert.equal(signalGrade("rsrp", -100), "fair");
    assert.equal(signalGrade("rsrp", -115), "poor");
    assert.equal(signalGrade("rsrp", -116), "very_poor");
    assert.equal(signalGrade("sinr", 13), "good");
    assert.equal(signalGrade("rsrq", -19.5), "very_poor");
    assert.equal(signalGrade("sinr", null), null);
    assert.equal(signalGrade("sinr", Number.NaN), null);
  });
});

describe("rf-math: peak data rate", () => {
  it("matches the TS 38.306 example for 100 MHz at 30 kHz, 4 layers, 256QAM", () => {
    assert.equal(carrierPeakRateMbps({ rat: "NR", bandwidthMhz: 100, layers: 4, modulationBits: 8, scsKhz: 30 }), 2337);
  });

  it("uses the uplink and FR2 overheads and resource blocks", () => {
    const ul = carrierPeakRateMbps({ rat: "NR", bandwidthMhz: 100, layers: 2, modulationBits: 8, scsKhz: 30, direction: "UL" });
    assert.ok(ul !== null && ul > 1200 && ul < 1260);
    const fr2 = carrierPeakRateMbps({ rat: "NR", bandwidthMhz: 400, layers: 2, modulationBits: 6, scsKhz: 120 });
    assert.ok(fr2 !== null && fr2 > 2000);
    const fr2At60 = carrierPeakRateMbps({ rat: "NR", bandwidthMhz: 200, layers: 2, modulationBits: 6, scsKhz: 60, range: "FR2" });
    assert.ok(fr2At60 !== null && fr2At60 > 0);
    assert.equal(carrierPeakRateMbps({ rat: "NR", bandwidthMhz: 200, layers: 2, modulationBits: 6, scsKhz: 60 }), null);
  });

  it("estimates LTE within a few percent of the category peaks", () => {
    const cat4 = carrierPeakRateMbps({ rat: "LTE", bandwidthMhz: 20, layers: 2, modulationBits: 6 });
    assert.equal(cat4, 151.2);
    const narrow = carrierPeakRateMbps({ rat: "LTE", bandwidthMhz: 1.4, layers: 1, modulationBits: 2 });
    assert.ok(narrow !== null && narrow > 0 && narrow < 3);
    assert.equal(carrierPeakRateMbps({ rat: "LTE", bandwidthMhz: 7, layers: 2, modulationBits: 6 }), null);
  });

  it("refuses impossible layers, modulations and scaling factors", () => {
    assert.equal(carrierPeakRateMbps({ rat: "LTE", bandwidthMhz: 20, layers: 0, modulationBits: 6 }), null);
    assert.equal(carrierPeakRateMbps({ rat: "LTE", bandwidthMhz: 20, layers: 2, modulationBits: 12 }), null);
    assert.equal(carrierPeakRateMbps({ rat: "NR", bandwidthMhz: 100, layers: 2, modulationBits: 8, scaling: 0.5 }), null);
    assert.equal(carrierPeakRateMbps({ rat: "NR", bandwidthMhz: 33, layers: 2, modulationBits: 8 }), null);
  });

  it("adds carriers up and stops at one it cannot compute", () => {
    const total = aggregatePeakRateMbps([
      { rat: "LTE", bandwidthMhz: 20, layers: 2, modulationBits: 6 },
      { rat: "NR", bandwidthMhz: 100, layers: 4, modulationBits: 8, scsKhz: 30, scaling: 0.75 },
    ]);
    assert.equal(total, 1904);
    assert.equal(aggregatePeakRateMbps([{ rat: "LTE", bandwidthMhz: 2, layers: 1, modulationBits: 2 }]), null);
    assert.equal(aggregatePeakRateMbps([]), 0);
  });

  it("knows the modulation orders", () => {
    assert.equal(modulationOrder("256qam"), 8);
    assert.equal(modulationOrder(" QPSK "), 2);
    assert.equal(modulationOrder("1024QAM"), 10);
    assert.equal(modulationOrder("8PSK"), null);
    assert.equal(modulationOrder("constructor"), null);
  });
});
