import fs from "node:fs";
import path from "node:path";
import { supportedDevicesSection } from "../src/device-catalog.ts";
import { type DocLocale, apiReferenceBlocks, readBlock, replaceBlock } from "./api-reference.ts";

/**
 * Rewrites the guide's generated blocks from the code, in both languages: the tables of Supported devices
 * (`devices`, from src/device-catalog.ts) and the routes, events and error codes of the API reference
 * (`api-routes`, `api-events`, `api-errors`, from scripts/api-reference.ts). Everything around a block is
 * written by hand and left alone. The tests fail while a page differs from what this writes.
 *
 *   npm run docs:sync            rewrite the pages
 *   npm run docs:sync -- --check list the pages that are out of date, change nothing (exit 1 if any)
 */

const LOCALES: ReadonlyArray<{ dir: "zh" | "en"; locale: DocLocale }> = [
  { dir: "zh", locale: "zh-CN" },
  { dir: "en", locale: "en" },
];

/** Every generated block of the guide: page (under docs/guide/<lang>/), block name, content. */
export function generatedBlocks(locale: DocLocale): ReadonlyArray<{ page: string; name: string; content: string }> {
  return [
    { page: "supported-devices.md", name: "devices", content: supportedDevicesSection(locale) },
    ...Object.entries(apiReferenceBlocks(locale)).map(([name, content]) => ({ page: "api.md", name, content })),
  ];
}

/** The pages whose blocks differ from the code, after writing them unless `check`. */
export function syncDocs(root: string, check: boolean): string[] {
  const stale: string[] = [];
  for (const { dir, locale } of LOCALES) {
    for (const { page, name, content } of generatedBlocks(locale)) {
      const file = path.join(root, "docs", "guide", dir, page);
      const text = fs.readFileSync(file, "utf8");
      if (readBlock(text, name) === content) continue;
      stale.push(`docs/guide/${dir}/${page} (${name})`);
      if (!check) fs.writeFileSync(file, replaceBlock(text, name, content));
    }
  }
  return stale;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const check = process.argv.includes("--check");
  const stale = syncDocs(process.cwd(), check);
  if (stale.length === 0) console.log("Generated docs are up to date.");
  else console.log(`${check ? "Out of date" : "Rewrote"}:\n${stale.map((s) => `  ${s}`).join("\n")}`);
  if (check && stale.length > 0) process.exitCode = 1;
}
