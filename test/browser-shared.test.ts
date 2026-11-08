import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import * as bandLock from "../src/band-lock.ts";
import * as controlError from "../src/control-error.ts";
import * as cpeDomain from "../src/cpe-domain.ts";
import * as parsers from "../src/parsers.ts";
import * as codec from "../src/sms/codec.ts";
import * as contacts from "../src/sms/contacts.ts";
import * as otp from "../src/sms/otp.ts";
import * as vcard from "../src/sms/vcard.ts";
import * as units from "../src/units.ts";
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
import { maskIdentityDigits, maskIpAddress, maskMacTail, maskPhoneNumber } from "../src/privacy-mask.ts";
import * as sanitize from "../src/sanitize.ts";
import { MAX_SMS_SEGMENTS, detectSmsTextMode } from "../src/sms/text-mode.ts";

/**
 * Modules the browser bundles (the console and the static demo) import at runtime: they must not
 * reach any Node built-in.
 */
const BROWSER_SHARED_MODULES = [
  "src/rf-bounds.ts",
  "src/sms/text-mode.ts",
  "src/text-sanitize.ts",
  "src/privacy-mask.ts",
  "src/self-heal-status.ts",
  "src/access-plan.ts",
  "src/access-state.ts",
  "src/console-policy.ts",
  "src/control-error.ts",
  "src/control-input.ts",
  "src/device-access.ts",
  "src/device-profile.ts",
  "src/feedback.ts",
  "src/firmware.ts",
  "src/timeseries.ts",
  "src/units.ts",
  "src/sms/otp.ts",
  "src/sms/phone.ts",
  "src/sms/thread-view.ts",
  "src/sms/vcard.ts",
];

function webSources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? webSources(full) : entry.name.endsWith(".ts") ? [full] : [];
  });
}

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

  it("are the only daemon modules the web sources import at runtime", () => {
    for (const file of webSources("web/src")) {
      for (const spec of runtimeImports(file)) {
        const target = path.relative(process.cwd(), path.join(path.dirname(file), spec));
        if (!target.startsWith("src/")) continue;
        assert.ok(BROWSER_SHARED_MODULES.includes(target), `${file} imports ${target}, which is not a browser-shared module`);
      }
    }
  });

  it("keeps the daemon's modules re-exporting the shared implementations", () => {
    assert.equal(codec.extractVerificationCode, otp.extractVerificationCode);
    assert.equal(contacts.parseVcardContacts, vcard.parseVcardContacts);
    assert.equal(parsers.formatBytesBinary, units.formatBytesBinary);
    assert.equal(parsers.formatRateBitsPerSec, units.formatRateBitsPerSec);
    assert.equal(cpeDomain.CpeControlValidationError, controlError.CpeControlValidationError);
  });

  it("decodes quoted-printable vCards without Node's Buffer", () => {
    const vcf = "BEGIN:VCARD\nFN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:=E6=BC=94=E7=A4=BA\nTEL:+447700900123\nEND:VCARD";
    assert.deepEqual(vcard.parseVcardContacts(vcf), [{ name: "演示", phones: ["+447700900123"] }]);
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
    assert.equal(validateArfcnInBand("LTE", 3, 1850), 1850);
    assert.throws(() => validateArfcnInBand("LTE", 3, 300), /Invalid ARFCN 300 for B3 \(3GPP DL EARFCN 1200\.\.1949\)/);
    assert.throws(() => validateArfcnInBand("NR", 2, 400000), /Invalid ARFCN 400000 for N2 \(3GPP DL NR-ARFCN\)/);
  });

  it("checks a cell lock request field by field without throwing (for inline form errors)", () => {
    assert.deepEqual(checkCellLockInput({ rat: "LTE", band: "B3", arfcn: 1850, pci: 211 }), {
      ok: true,
      value: { rat: "LTE", band: 3, arfcn: 1850, pci: 211 },
    });
    assert.deepEqual(checkCellLockInput({ rat: "NR", band: "n78", arfcn: 650000, pci: null }), {
      ok: true,
      value: { rat: "NR", band: 78, arfcn: 650000, pci: null },
    });
    const badBand = checkCellLockInput({ rat: "LTE", band: "B2", arfcn: 700, pci: 1 });
    assert.equal(badBand.ok, false);
    assert.equal(!badBand.ok && badBand.field, "band");
    const badArfcn = checkCellLockInput({ rat: "LTE", band: "B3", arfcn: 300, pci: 1 });
    assert.deepEqual(!badArfcn.ok && [badArfcn.field, badArfcn.range], ["arfcn", [1200, 1949]]);
    const badPci = checkCellLockInput({ rat: "LTE", band: "B3", arfcn: 1850, pci: 600 });
    assert.deepEqual(!badPci.ok && [badPci.field, badPci.range], ["pci", [0, 503]]);
    const nrPci = checkCellLockInput({ rat: "NR", band: "N78", arfcn: 650000, pci: 1000 });
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

  it("masks identifiers the same way on the daemon (REDACT_SENSITIVE_IN_API) and in the UI privacy mode", () => {
    assert.equal(sanitize.maskPhoneNumber, maskPhoneNumber);
    assert.equal(maskPhoneNumber("+353830000001"), "+353*******01");
    assert.equal(maskPhoneNumber("DemoBank"), "DemoBank");
    assert.equal(maskIdentityDigits("860000000000000", 6), "860000*********");
    assert.equal(maskIdentityDigits(" 2720 1000 0000 000 ", 5), "27201**********");
    assert.equal(maskIdentityDigits("1234", 6), "****");
    assert.equal(maskIdentityDigits("", 6), "");
    assert.equal(maskMacTail("02:00:5e:10:00:01"), "02:00:5E:**:**:**");
    assert.equal(maskMacTail("02-00-5E-10-00-01"), "02:00:5E:**:**:**");
    assert.equal(maskMacTail("not a mac"), "**:**:**:**:**:**");
    assert.equal(maskMacTail(""), "");
    assert.equal(maskIpAddress("198.51.100.42"), "198.51.*.*");
    assert.equal(maskIpAddress("2001:db8:abcd:12::42"), "2001:db8:****");
    assert.equal(maskIpAddress("fe80::1;2001:db8::42"), "fe80:****;2001:db8:****");
    assert.equal(maskIpAddress("garbage"), "****");
    assert.equal(maskIpAddress(""), "");
  });
});
