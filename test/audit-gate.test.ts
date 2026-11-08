import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TYPE_ESCAPES, isForbiddenTrackedFile, isTypeScriptFile, scanTypeEscapes } from "../scripts/audit-secrets.ts";

function escapesIn(line: string): string[] {
  return TYPE_ESCAPES.filter((escape) => escape.regex.test(line)).map((escape) => escape.name);
}

describe("audit:secrets gate", () => {
  it("rejects explicit any wherever a type can appear, not only after a colon", () => {
    // Built at run time so this file itself passes the gate it tests
    const ANY = ["a", "ny"].join("");
    const TS = ["@", "ts-"].join("");
    for (const line of [
      `const x: ${ANY} = 1;`,
      `const y = z as ${ANY};`,
      `const list = new Array<${ANY}>();`,
      `type Bag = Record<string, ${ANY}>;`,
      `const seen = new Map<${ANY}, string>();`,
      `let pair: [string, ${ANY}];`,
      `type Fn = (raw: string) => ${ANY};`,
      `type Maybe = string | ${ANY};`,
      `const rows: ${ANY}[] = [];`,
      `// ${TS}ignore`,
      `// ${TS}expect-error`,
    ]) {
      assert.notDeepEqual(escapesIn(line), [], line);
    }
    for (const line of [
      "// any device that answers keeps its slot",
      "if (rows.some((r) => r.any)) return;",
      "const anyRow = rows[0];",
      "type Company = { many: string };",
      "throw new Error(\"any of these | many\");",
    ]) {
      assert.deepEqual(escapesIn(line), [], line);
    }
  });

  it("recognizes both .ts and .tsx files for type-escape auditing (1a)", () => {
    assert.equal(isTypeScriptFile("web/App.tsx"), true);
    assert.equal(isTypeScriptFile("src/server.ts"), true);
    assert.equal(isTypeScriptFile("src/server.js"), false);
    assert.equal(isTypeScriptFile("docs/readme.md"), false);
  });

  it("catches explicit type escapes split across consecutive lines without duplicate reports (1b)", () => {
    const ANY = ["a", "ny"].join("");
    const splitColon = ["const value:", `  ${ANY} = payload;`].join("\n");
    assert.deepEqual(
      scanTypeEscapes(splitColon).map((f) => ({ line: f.line, name: f.name })),
      [{ line: 2, name: "explicit " + ANY }]
    );

    const splitAs = ["const value = raw as", `  ${ANY};`].join("\n");
    assert.deepEqual(
      scanTypeEscapes(splitAs).map((f) => ({ line: f.line, name: f.name })),
      [{ line: 2, name: "explicit " + ANY }]
    );

    const negative = ["// returns:", "// a value"].join("\n");
    assert.deepEqual(scanTypeEscapes(negative), []);

    const singleLine = [`const x: ${ANY} = 1;`, "const y = 2;"].join("\n");
    assert.deepEqual(
      scanTypeEscapes(singleLine).map((f) => ({ line: f.line, name: f.name })),
      [{ line: 1, name: "explicit " + ANY }]
    );
  });

  it("refuses to let captures, contact exports and secrets be tracked", () => {
    for (const file of [
      ".env",
      ".env.local",
      "smoke/.env",
      "test/fixtures/.env.local",
      "data/state.json",
      ".probe-cache/x.json",
      "captures/router.har",
      "captures/router.pcap",
      "captures/router.pcapng",
      "captures/router.pcap.gz",
      "captures/session.saz",
      "exports/contacts.vcf",
      "apk/CPEManager.apk",
      "apk/CPEManager.apk.1",
      "win/CpeNet.dll",
      "bin/tool.exe",
      "bin/TOOL.EXE",
      "app/classes.dex",
      "lib/native.so",
      "lib/NATIVE.SO",
      "certs/client.p12",
      "certs/CLIENT.P12",
      "certs/client.pfx",
      "certs/CLIENT.PFX",
      "keys/deploy.pem",
      "keys/deploy.key",
    ]) {
      assert.equal(isForbiddenTrackedFile(file), true, file);
    }
    for (const file of [
      ".env.example",
      "smoke/.env.example",
      "test/fixtures/.env.example",
      "data/.gitkeep",
      "src/sms/vcard.ts",
      "docs/screenshots/dashboard.webp",
      "test/helpers/strict-cpe.ts",
    ]) {
      assert.equal(isForbiddenTrackedFile(file), false, file);
    }
  });
});
