import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import * as bandLock from "../src/band-lock.ts";
import * as codec from "../src/sms/codec.ts";
import {
  H168_383_LTE_BANDS,
  H168_383_NR_BANDS,
  LTE_DL_EARFCN_RANGES,
  MAX_PCI,
  NR_DL_ARFCN_RANGES,
  checkCellLockInput,
  validateArfcnInBand,
  validatePci,
} from "../src/rf-bounds.ts";
import { MAX_SMS_SEGMENTS, detectSmsTextMode } from "../src/sms/text-mode.ts";

/** Modules the browser bundle imports at runtime: they must not reach any Node built-in. */
const BROWSER_SHARED_MODULES = ["src/rf-bounds.ts", "src/sms/text-mode.ts", "src/text-sanitize.ts"];

function runtimeImports(file: string): string[] {
  const source = fs.readFileSync(file, "utf8");
  const specifiers: string[] = [];
  for (const match of source.matchAll(/^\s*(?:import|export)\s+(?!type\b)[^;]*?\sfrom\s+"([^"]+)"/gm)) {
    if (match[1]) specifiers.push(match[1]);
  }
  for (const match of source.matchAll(/^\s*import\s+"([^"]+)"/gm)) {
    if (match[1]) specifiers.push(match[1]);
  }
  return specifiers;
}

describe("Browser-shared modules (single source of truth for the web UI)", () => {
  it("reach no Node built-in through their runtime import graph", () => {
    const seen = new Set<string>();
    const visit = (file: string): void => {
      if (seen.has(file)) return;
      seen.add(file);
      for (const spec of runtimeImports(file)) {
        assert.ok(!spec.startsWith("node:") && !spec.startsWith("@"), `${file} imports ${spec}`);
        assert.ok(spec.startsWith("."), `${file} imports the package ${spec}`);
        visit(path.join(path.dirname(file), spec));
      }
    };
    for (const file of BROWSER_SHARED_MODULES) visit(file);
    assert.ok(seen.size >= BROWSER_SHARED_MODULES.length);
  });

  it("keeps band-lock and the SMS codec exporting the very same bounds and text-mode functions", () => {
    assert.equal(bandLock.H168_383_LTE_BANDS, H168_383_LTE_BANDS);
    assert.equal(bandLock.H168_383_NR_BANDS, H168_383_NR_BANDS);
    assert.equal(bandLock.LTE_DL_EARFCN_RANGES, LTE_DL_EARFCN_RANGES);
    assert.equal(bandLock.NR_DL_ARFCN_RANGES, NR_DL_ARFCN_RANGES);
    assert.equal(codec.detectSmsTextMode, detectSmsTextMode);
    assert.equal(codec.MAX_SMS_SEGMENTS, MAX_SMS_SEGMENTS);
  });

  it("bounds PCIs per RAT (LTE 0..503, NR 0..1007) with the backend's error messages", () => {
    assert.deepEqual(MAX_PCI, { LTE: 503, NR: 1007 });
    assert.equal(validatePci("LTE", 503), 503);
    assert.throws(() => validatePci("LTE", 504), /Invalid PCI "504" for LTE \(expected integer 0\.\.503\)/);
    assert.equal(validatePci("NR", 1007), 1007);
    assert.throws(() => validatePci("NR", 1008), /expected integer 0\.\.1007/);
    assert.throws(() => validatePci("NR", 1.5), /Invalid PCI/);
    assert.equal(validateArfcnInBand("LTE", 3, 1700), 1700);
    assert.throws(() => validateArfcnInBand("LTE", 3, 100), /Invalid ARFCN 100 for B3 \(3GPP DL EARFCN 1200\.\.1949\)/);
    assert.throws(() => validateArfcnInBand("NR", 2, 400000), /Invalid ARFCN 400000 for N2 \(3GPP DL NR-ARFCN\)/);
  });

  it("checks a cell lock request field by field without throwing (for inline form errors)", () => {
    assert.deepEqual(checkCellLockInput({ rat: "LTE", band: "B3", arfcn: 1700, pci: 357 }), {
      ok: true,
      value: { rat: "LTE", band: 3, arfcn: 1700, pci: 357 },
    });
    assert.deepEqual(checkCellLockInput({ rat: "NR", band: "n78", arfcn: 647424, pci: null }), {
      ok: true,
      value: { rat: "NR", band: 78, arfcn: 647424, pci: null },
    });
    const badBand = checkCellLockInput({ rat: "LTE", band: "B2", arfcn: 700, pci: 1 });
    assert.equal(badBand.ok, false);
    assert.equal(!badBand.ok && badBand.field, "band");
    const badArfcn = checkCellLockInput({ rat: "LTE", band: "B3", arfcn: 100, pci: 1 });
    assert.deepEqual(!badArfcn.ok && [badArfcn.field, badArfcn.range], ["arfcn", [1200, 1949]]);
    const badPci = checkCellLockInput({ rat: "LTE", band: "B3", arfcn: 1700, pci: 600 });
    assert.deepEqual(!badPci.ok && [badPci.field, badPci.range], ["pci", [0, 503]]);
    const nrPci = checkCellLockInput({ rat: "NR", band: "N78", arfcn: 647424, pci: 1000 });
    assert.equal(nrPci.ok, true);
    const nan = checkCellLockInput({ rat: "NR", band: "N78", arfcn: Number.NaN, pci: 1 });
    assert.equal(!nan.ok && nan.field, "arfcn");
  });

  it("counts SMS segments identically for the composer and the send path", () => {
    assert.deepEqual(detectSmsTextMode("Hello"), { textMode: 1, encoding: "7BIT", segments: 1, charUnits: 5 });
    assert.equal(detectSmsTextMode("€").charUnits, 2);
    assert.equal(detectSmsTextMode("你好").encoding, "UCS2");
    assert.equal(detectSmsTextMode("a".repeat(161)).segments, 2);
    assert.equal(detectSmsTextMode("\u0001ok").charUnits, 2);
    assert.equal(MAX_SMS_SEGMENTS, 4);
  });
});
