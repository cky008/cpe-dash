import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  HUAWEI_LTE_ALL_BANDS_MASK,
  HUAWEI_NETWORK_ALL_BANDS_MASK,
  LOCK_MODE_BAND,
  LOCK_MODE_CELL,
  LOCK_MODE_FREQ,
  LOCK_MODE_UNLOCK,
  NETWORK_MODE_AUTO,
  bandsToHexMask,
  buildLteBandNetModeXml,
  buildLteCellLockXml,
  buildNrBandLockXml,
  buildNrCellLockXml,
  buildUnlockAllLocksXml,
  decomposeLteEci,
  decomposeNrNci,
  hexMaskToBands,
  parseBandNumber,
} from "../src/band-lock.ts";
import { getXmlBlocks, getXmlTag } from "../src/xml.ts";

describe("BandMask bitwise codec & Cell Lock payload builders (CpeVendorHUAWEI v3.8.4)", () => {
  it("parses LTE/NR band labels and validates bounds", () => {
    assert.equal(parseBandNumber(1), 1);
    assert.equal(parseBandNumber("B3"), 3);
    assert.equal(parseBandNumber("LTE BC71"), 71);
    assert.equal(parseBandNumber("n78"), 78);
    assert.throws(() => parseBandNumber(0), /Invalid band/);
    assert.throws(() => parseBandNumber(256), /Invalid band/);
    assert.throws(() => parseBandNumber("invalid"), /Invalid band/);
  });

  it("matches exact H168-383 hardware LTEBand bitmask and N78 NR bitmask", () => {
    const h168SupportedLte = [1, 3, 5, 7, 8, 20, 28, 32, 38, 40, 41, 42, 43, 71];
    const hex = bandsToHexMask(h168SupportedLte);
    assert.equal(hex, "40000007a0880800d5");
    assert.deepEqual(hexMaskToBands(hex.toUpperCase()), h168SupportedLte);

    assert.equal(bandsToHexMask(["B1", "B3"]), "5");
    assert.equal(bandsToHexMask(["N78"]), "20000000000000000000");
    assert.deepEqual(hexMaskToBands("20000000000000000000"), [78]);
    assert.equal(bandsToHexMask([]), "0");
    assert.deepEqual(hexMaskToBands("0"), []);
    assert.deepEqual(hexMaskToBands(""), []);
    assert.throws(() => hexMaskToBands("not-hex"), /Invalid hexadecimal/);
  });

  it("builds LTE net-mode band lock and reset XML payloads", () => {
    const lockB1B3 = buildLteBandNetModeXml(["B1", "B3"]);
    assert.equal(getXmlTag(lockB1B3, "NetworkMode"), NETWORK_MODE_AUTO);
    assert.equal(getXmlTag(lockB1B3, "NetworkBand"), HUAWEI_NETWORK_ALL_BANDS_MASK);
    assert.equal(getXmlTag(lockB1B3, "LTEBand"), "5");
    assert.equal(getXmlTag(lockB1B3, "networkOption"), "2");

    const resetAll = buildLteBandNetModeXml("all", "03");
    assert.equal(getXmlTag(resetAll, "NetworkMode"), "03");
    assert.equal(getXmlTag(resetAll, "LTEBand"), HUAWEI_LTE_ALL_BANDS_MASK);
    assert.throws(() => buildLteBandNetModeXml([]), /At least one LTE band/);
  });

  it("builds 5G NR band lock, 4G/5G cell lock, frequency lock, and unlock XML payloads", () => {
    const nrBandXml = buildNrBandLockXml(["N78", "N41"]);
    const nrInfo = getXmlBlocks(nrBandXml, "nr_info")[0]!;
    assert.equal(getXmlTag(nrInfo, "lock_mode"), String(LOCK_MODE_BAND));
    assert.equal(getXmlTag(nrInfo, "all_bands"), bandsToHexMask([41, 78]));
    assert.equal(getXmlBlocks(nrInfo, "freq_info").length, 2);
    assert.throws(() => buildNrBandLockXml([]), /At least one 5G NR band/);

    const lteCellXml = buildLteCellLockXml({ band: "B3", earfcn: 1700, pci: 357 });
    const lteCellBlock = getXmlBlocks(lteCellXml, "lte_info")[0]!;
    assert.equal(getXmlTag(lteCellBlock, "lock_mode"), String(LOCK_MODE_CELL));
    assert.equal(getXmlTag(lteCellBlock, "band"), "3");
    assert.equal(getXmlTag(lteCellBlock, "freq"), "1700");
    assert.equal(getXmlTag(lteCellBlock, "pci"), "357");
    assert.equal(getXmlTag(lteCellBlock, "all_bands"), "4");

    const lteFreqOnlyXml = buildLteCellLockXml({ band: 1, earfcn: 100 });
    assert.equal(
      getXmlTag(getXmlBlocks(lteFreqOnlyXml, "lte_info")[0]!, "lock_mode"),
      String(LOCK_MODE_FREQ)
    );

    const nrCellXml = buildNrCellLockXml({ band: "N78", nrArfcn: 647424, pci: 357 });
    const lteInNr = getXmlBlocks(nrCellXml, "lte_info")[0]!;
    const nrCellBlock = getXmlBlocks(nrCellXml, "nr_info")[0]!;
    assert.equal(getXmlTag(lteInNr, "lock_mode"), String(LOCK_MODE_UNLOCK));
    assert.equal(getXmlTag(nrCellBlock, "lock_mode"), String(LOCK_MODE_CELL));
    assert.equal(getXmlTag(nrCellBlock, "band"), "78");
    assert.equal(getXmlTag(nrCellBlock, "freq"), "647424");
    assert.equal(getXmlTag(nrCellBlock, "pci"), "357");
    assert.equal(getXmlTag(nrCellBlock, "all_bands"), "20000000000000000000");

    assert.throws(() => buildLteCellLockXml({ band: 3, earfcn: 0, pci: 10 }), /Invalid ARFCN/);
    assert.throws(() => buildNrCellLockXml({ band: 78, nrArfcn: 647424, pci: 1008 }), /Invalid PCI/);

    const unlockXml = buildUnlockAllLocksXml();
    assert.equal(getXmlTag(getXmlBlocks(unlockXml, "lte_info")[0]!, "lock_mode"), "0");
    assert.equal(getXmlTag(getXmlBlocks(unlockXml, "nr_info")[0]!, "lock_mode"), "0");
  });

  it("decomposes 28-bit LTE ECI and 36-bit NR NCI into NodeB ID and Sector ID", () => {
    // Synthetic 28-bit ECI fixture: 0x0800001E = 134217758 -> eNodeB = 524288, sector = 30
    const lteDec = decomposeLteEci("134217758");
    assert.deepEqual(lteDec, { eci: 134217758, eNodeBId: 524288, sectorId: 30 });
    const lteHex = decomposeLteEci("0x0800001E");
    assert.deepEqual(lteHex, { eci: 134217758, eNodeBId: 524288, sectorId: 30 });
    assert.throws(() => decomposeLteEci("-1"), /Invalid 28-bit LTE ECI/);
    assert.throws(() => decomposeLteEci("268435456"), /Invalid 28-bit LTE ECI range/);

    // Synthetic 36-bit NR NCI: gNodeB (24-bit) = 4194305, sector (12-bit) = 7 -> (4194305 << 12) | 7
    const nciVal = (4194305n << 12n) | 7n;
    const nrDec = decomposeNrNci(nciVal.toString(10), 24);
    assert.deepEqual(nrDec, { nci: nciVal, gNodeBId: 4194305n, sectorId: 7 });
    assert.throws(() => decomposeNrNci("100", 20), /gNodeB bit length/);
    assert.throws(() => decomposeNrNci(-1n, 24), /Invalid 36-bit NR NCI/);
  });
});
