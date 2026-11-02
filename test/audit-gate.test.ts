import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TYPE_ESCAPES, isForbiddenTrackedFile } from "../scripts/audit-secrets.ts";

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

  it("refuses to let captures, contact exports and secrets be tracked", () => {
    for (const file of [
      ".env",
      ".env.local",
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
      "keys/deploy.pem",
      "keys/deploy.key",
    ]) {
      assert.equal(isForbiddenTrackedFile(file), true, file);
    }
    for (const file of [".env.example", "data/.gitkeep", "src/sms/vcard.ts", "docs/screenshots/dashboard.webp", "test/helpers/strict-cpe.ts"]) {
      assert.equal(isForbiddenTrackedFile(file), false, file);
    }
  });
});
