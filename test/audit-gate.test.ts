import assert from "node:assert/strict";
import { describe, it } from "node:test";
import crypto from "node:crypto";
import { PUBLIC_VENDOR_KEYS, TYPE_ESCAPES, isForbiddenTrackedFile, isTypeScriptFile, scanPhoneLiterals, scanPrivateKeys, scanTypeEscapes } from "../scripts/audit-secrets.ts";
import { FIBERHOME_PRO_RSA_KEY } from "../src/drivers/fiberhome.ts";

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

  it("refuses full international phone numbers outside the reserved test ranges", () => {
    // Built at run time so this file itself passes the rule it tests
    const irish = ["+353", "831234567"].join("");
    const british = ["+44", "7911123456"].join("");
    assert.deepEqual(scanPhoneLiterals(`grouped whether written \`0831234567\` or \`${irish}\``), [{ line: 1 }]);
    assert.deepEqual(scanPhoneLiterals(`first\nTEL:${british}\nlast ${irish}`), [{ line: 2 }, { line: 3 }]);
    for (const text of [
      "+353830000001 and +353830000099, MSISDN=+353830000000",
      "+447700900123",
      "+8613000000000",
      "TEL:+3538300${n} and the prefix +35383000000",
      "load-test numbers +99910000000 / +99919999999 (999: no subscriber anywhere), LU +35212345678",
      "integrity sha512-Ab+12345678Cd== and x+1234567",
      "offsets +0100 and +0000, version 1.7.2+353",
    ]) {
      assert.deepEqual(scanPhoneLiterals(text), [], text);
    }
    // Real-format Irish mobiles outside the reserved block, once allowed for a load test, are refused like any other
    const formerBounds = [["+3538300", "10000"].join(""), ["+3538300", "99999"].join("")];
    assert.deepEqual(scanPhoneLiterals(formerBounds.join(" / ")), [{ line: 1 }, { line: 1 }]);
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
      "apk/client.apk",
      "apk/client.apk.1",
      "win/client.dll",
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

describe("audit gate: private keys", () => {
  /** The key as `git log -p` shows a commit adding (`+`) or removing (`-`) it. */
  const asDiff = (text: string, marker: string): string => text.split("\n").map((line) => `${marker}${line}`).join("\n");

  it("lets the one published vendor key through, in the tree and in the history, and nothing else", () => {
    assert.equal(PUBLIC_VENDOR_KEYS.size, 1);
    const source = `export const KEY = \`${FIBERHOME_PRO_RSA_KEY}\`;\n`;
    assert.equal(scanPrivateKeys(source), 0);
    assert.equal(scanPrivateKeys(asDiff(source, "+")), 0);
    assert.equal(scanPrivateKeys(asDiff(source, "-")), 0);
    // One character of it changed is another key
    const lines = FIBERHOME_PRO_RSA_KEY.split("\n");
    const line = lines[5] ?? "";
    lines[5] = `${line.slice(0, 10)}${line[10] === "A" ? "B" : "A"}${line.slice(11)}`;
    assert.equal(scanPrivateKeys(lines.join("\n")), 1);
  });

  it("fails every other private key, however it is labelled, and a key cut short", () => {
    const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pkcs1 = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
    const pkcs8 = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    assert.equal(scanPrivateKeys(pkcs1), 1);
    assert.equal(scanPrivateKeys(pkcs8), 1);
    assert.equal(scanPrivateKeys(asDiff(pkcs8, "+")), 1);
    assert.equal(scanPrivateKeys(`${pkcs1}\n${FIBERHOME_PRO_RSA_KEY}\n${pkcs8}`), 2);
    const header = FIBERHOME_PRO_RSA_KEY.split("\n")[0] ?? "";
    assert.equal(scanPrivateKeys(`${header}\nMIIE\n`), 1, "no end line");
    // The vendor key's body under another label does not match the end line: not listed
    assert.equal(scanPrivateKeys(FIBERHOME_PRO_RSA_KEY.replace("END PRIVATE", "END RSA PRIVATE")), 1);
    assert.equal(scanPrivateKeys("nothing here"), 0);
  });
});
