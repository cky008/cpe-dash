import fs from "node:fs";
import path from "node:path";

/**
 * GitHub release notes for a tag: its CHANGELOG.md section (the one place release notes are
 * written), followed by the image tag and a link to the full history at that tag.
 *
 *   node --experimental-strip-types scripts/release-notes.ts v1.4.2 > notes.md
 */
export function releaseNotes(changelog: string, tag: string, repository = "cky008/cpe-dash"): string {
  const version = tag.replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Not a release tag: ${tag}`);
  const lines = changelog.split("\n");
  const start = lines.findIndex((line) => line.startsWith(`## [${version}]`));
  if (start < 0) throw new Error(`CHANGELOG.md has no section for ${version}`);
  const next = lines.findIndex((line, i) => i > start && line.startsWith("## ["));
  const body = lines.slice(start + 1, next < 0 ? lines.length : next).join("\n").trim();
  if (!body) throw new Error(`The CHANGELOG.md section for ${version} is empty`);
  return [
    body,
    "",
    "---",
    `Container image: \`ghcr.io/${repository}:${version}\` · Full history: [CHANGELOG.md](https://github.com/${repository}/blob/v${version}/CHANGELOG.md)`,
    "",
  ].join("\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const tag = process.argv[2] ?? "";
  try {
    process.stdout.write(releaseNotes(fs.readFileSync(path.resolve(import.meta.dirname, "..", "CHANGELOG.md"), "utf8"), tag));
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}
