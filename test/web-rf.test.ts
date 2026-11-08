import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  accessMode,
  bandLabel,
  bestModulation,
  caSummary,
  carrierChips,
  gaugeFraction,
  qualityLevel,
  signalBars,
  txPowerFraction,
} from "../web/src/core/rf.ts";
import { parseByteSize, routerMonthlyCapBytes, usageLevel, usageRatio } from "../web/src/core/traffic.ts";

describe("web core: RF grading and carrier aggregation", () => {
  it("grades RSRP / RSRQ / SINR and positions gauges", () => {
    assert.equal(qualityLevel("rsrp", -79), 4);
    assert.equal(qualityLevel("rsrp", -95), 2);
    assert.equal(qualityLevel("rsrp", -120), 0);
    assert.equal(qualityLevel("sinr", 13), 3);
    assert.equal(qualityLevel("rsrq", -10), 4);
    assert.equal(qualityLevel("rsrq", -16), 1);
    assert.equal(qualityLevel("sinr", null), null);
    assert.equal(gaugeFraction("rsrp", -44), 1);
    assert.equal(gaugeFraction("rsrp", -200), 0);
    assert.equal(gaugeFraction("sinr", 10), 0.5);
    assert.equal(gaugeFraction("sinr", null), 0);
    assert.equal(txPowerFraction(26), 1);
    assert.equal(txPowerFraction(-7), 0.5);
    assert.equal(txPowerFraction(null), 0);
  });

  it("derives SA / NSA from the serving RATs and labels the 3CA chain", () => {
    assert.equal(accessMode({ lteRsrpDbm: -87, nrRsrpDbm: -95 }), "NSA");
    assert.equal(accessMode({ lteRsrpDbm: null, nrRsrpDbm: -95 }), "SA");
    assert.equal(accessMode({ lteRsrpDbm: -87, nrRsrpDbm: null }), "LTE");
    assert.equal(accessMode({ lteRsrpDbm: null, nrRsrpDbm: null }), "NONE");
    assert.equal(bandLabel("LTE", "3"), "B3");
    assert.equal(bandLabel("NR", 78), "N78");
    assert.equal(bandLabel("NR", "n78"), "N78");
    assert.equal(bandLabel("NR", "NR 41"), "N41");
    const nsa = carrierChips({
      caCarriers: [
        { bandwidthMhz: 20, arfcn: 300, band: "B1", rat: "LTE" },
        { bandwidthMhz: 20, arfcn: 1850, band: "B3", rat: "LTE" },
        { bandwidthMhz: 100, arfcn: 650000, band: "N78", rat: "NR" },
      ],
    });
    assert.equal(caSummary(nsa), "PCC B1(20M) + SCC B3(20M) + 5G N78(100M)");
    assert.equal(nsa[2]?.role, "SCC");
    const sa = carrierChips({ caCarriers: [{ bandwidthMhz: 100, arfcn: 650000, band: "78", rat: "NR" }] });
    assert.equal(caSummary(sa), "PCC 5G N78(100M)");
    assert.equal(caSummary([]), "");
  });

  it("picks the highest modulation and the router-style signal bars", () => {
    assert.equal(
      bestModulation([
        { label: "c0", index: 20, modulation: "64qam" },
        { label: "c1", index: 27, modulation: "256QAM" },
        { label: "c2", index: 0, modulation: null },
        { label: "c3", index: 3, modulation: "weird" },
      ]),
      "256QAM"
    );
    assert.equal(bestModulation([]), null);
    assert.equal(signalBars({ lteRsrpDbm: -87, nrRsrpDbm: null }), 3);
    assert.equal(signalBars({ lteRsrpDbm: -87, nrRsrpDbm: -112 }), 0);
  });
});

describe("web core: usage caps", () => {
  it("parses byte sizes and grades usage against a cap", () => {
    assert.equal(parseByteSize("100GB"), 100 * 1024 ** 3);
    assert.equal(parseByteSize("1.5 tb"), 1.5 * 1024 ** 4);
    assert.equal(parseByteSize("500"), 500 * 1024 ** 3);
    assert.equal(parseByteSize("0MB"), null);
    assert.equal(parseByteSize("12 parsecs"), null);
    assert.equal(parseByteSize("lots"), null);
    assert.equal(routerMonthlyCapBytes("0MB"), null);
    assert.equal(routerMonthlyCapBytes("200GB"), 200 * 1024 ** 3);
    assert.equal(usageRatio(50, 100), 0.5);
    assert.equal(usageRatio(50, null), null);
    assert.equal(usageRatio(Number.NaN, 100), null);
    assert.deepEqual([usageLevel(null), usageLevel(0.5), usageLevel(0.8), usageLevel(1.2)], ["none", "ok", "warn", "over"]);
  });

});
