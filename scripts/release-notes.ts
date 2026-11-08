import fs from "node:fs";
import path from "node:path";

/**
 * GitHub release notes for a tag, written from its CHANGELOG.md section (the one place release notes are
 * written) in the shape people read quickly: a welcome line, what to do before upgrading, the highlights
 * (`### Highlights`, one short heading and paragraph each), then every change grouped and listed by its lead
 * sentence only. The details stay in CHANGELOG.md and the documentation, which the notes link to.
 *
 *   node --experimental-strip-types scripts/release-notes.ts v1.7.0 > notes.md
 */

/** CHANGELOG section -> release-notes group, in the order they are listed. */
const GROUPS: ReadonlyArray<readonly [ReadonlyArray<string>, string]> = [
  [["Added"], "🚀 Features"],
  [["Changed", "Daemon", "Web console"], "🌟 Enhancements"],
  [["Fixed", "Fixed in this release"], "🐛 Bug fixes"],
  [["Security"], "🔒 Security"],
  [["Documentation"], "📚 Documentation"],
  [["Tests", "Container and CI"], "🧰 Maintenance"],
  [["Known limitations", "Not possible on this router"], "⚠️ Known limitations"],
];

/** The top-level bullets of a section, each as one line (nested bullets and continuation lines are details). */
function bullets(lines: ReadonlyArray<string>): string[] {
  return lines.filter((line) => line.startsWith("- ")).map((line) => line.slice(2).trim());
}

/** `**Lead.** Rest` -> ["Lead.", "Rest"]; without a bold lead, the first sentence is the lead. */
function splitLead(item: string): [string, string] {
  const bold = /^\*\*(.+?)\*\*[,.:]?\s*(.*)$/.exec(item);
  if (bold) return [bold[1] ?? "", bold[2] ?? ""];
  const end = item.search(/\.\s/);
  return end < 0 ? [item, ""] : [item.slice(0, end + 1), item.slice(end + 1).trim()];
}

export function releaseNotes(changelog: string, tag: string, repository = "cky008/cpe-dash"): string {
  const version = tag.replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Not a release tag: ${tag}`);
  const lines = changelog.split("\n");
  const start = lines.findIndex((line) => line.startsWith(`## [${version}]`));
  if (start < 0) throw new Error(`CHANGELOG.md has no section for ${version}`);
  const next = lines.findIndex((line, i) => i > start && line.startsWith("## ["));
  const body = lines.slice(start + 1, next < 0 ? lines.length : next);
  if (!body.join("").trim()) throw new Error(`The CHANGELOG.md section for ${version} is empty`);

  const sections = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of body) {
    const heading = /^### (.+)$/.exec(line);
    if (heading) sections.set(heading[1]?.trim() ?? "", (current = []));
    else current?.push(line);
  }

  const out = [`Welcome to FengSui \`v${version}\`!`, ""];
  const upgrading = bullets(sections.get("Upgrading") ?? []);
  if (upgrading.length > 0) out.push("> [!IMPORTANT]", "> **Before you upgrade**", ...upgrading.map((item) => `> - ${item}`), "");
  const highlights = bullets(sections.get("Highlights") ?? []);
  if (highlights.length > 0) {
    out.push("## Highlights", "");
    for (const item of highlights) {
      const [lead, rest] = splitLead(item);
      out.push(`### ${lead.replace(/[.:]$/, "")}`, "");
      if (rest) out.push(rest, "");
    }
  }

  const listed = new Set(["Upgrading", "Highlights"]);
  const groups: string[] = [];
  const addGroup = (title: string, names: ReadonlyArray<string>): void => {
    const items = names.flatMap((name) => {
      listed.add(name);
      return bullets(sections.get(name) ?? []);
    });
    if (items.length > 0) groups.push(`### ${title}`, ...items.map((item) => `- ${splitLead(item)[0]}`), "");
  };
  for (const [names, title] of GROUPS) addGroup(title, names);
  // A section name the map does not know keeps its own heading
  for (const name of sections.keys()) if (!listed.has(name)) addGroup(name, [name]);
  if (groups.length > 0) out.push("## What's changed", "", ...groups);

  out.push(
    "---",
    `Details of every change: [CHANGELOG.md](https://github.com/${repository}/blob/v${version}/CHANGELOG.md) · Documentation: [cky008.github.io/cpe-dash](https://cky008.github.io/cpe-dash/) · Container image: \`ghcr.io/${repository}:${version}\``,
    ""
  );
  return out.join("\n");
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
