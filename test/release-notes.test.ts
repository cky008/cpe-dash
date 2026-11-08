import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import { releaseNotes } from "../scripts/release-notes.ts";

const CHANGELOG = `# Changelog

## [Unreleased]

### Fixed
- Not released yet.

## [1.2.0] — 2026-10-31

### Highlights
- **See the signal at a glance.** The dashboard puts the bands and the signal on one card.
- **Locks you can undo.** A lock that cuts the internet is rolled back on its own.

### Added
- **A thing.** Long technical details that belong in the changelog, not in the release.
- \`npm run thing\` without a bold lead. Second sentence.
- The scheduler as the only path: ephemeral sessions with a logout; more details.

### Fixed
- **A fix.** Details.

### Upgrading
- Nothing to do.
- Or set \`X=true\`.

## [1.1.0] — 2026-10-30

### Added
- Older.
`;

describe("release notes from CHANGELOG.md", () => {
  it("opens with a welcome, the upgrade notes and the highlights, then lists each change by its lead only", () => {
    assert.equal(
      releaseNotes(CHANGELOG, "v1.2.0"),
      [
        "Welcome to FengSui `v1.2.0`!",
        "",
        "> [!IMPORTANT]",
        "> **Before you upgrade**",
        "> - Nothing to do.",
        "> - Or set `X=true`.",
        "",
        "## Highlights",
        "",
        "### See the signal at a glance",
        "",
        "The dashboard puts the bands and the signal on one card.",
        "",
        "### Locks you can undo",
        "",
        "A lock that cuts the internet is rolled back on its own.",
        "",
        "## What's changed",
        "",
        "### 🚀 Features",
        "- A thing.",
        "- `npm run thing` without a bold lead.",
        "- The scheduler as the only path",
        "",
        "### 🐛 Bug fixes",
        "- A fix.",
        "",
        "**Full Changelog**: [`v1.1.0...v1.2.0`](https://github.com/cky008/cpe-dash/compare/v1.1.0...v1.2.0)",
        "",
        "---",
        "Details of every change: [CHANGELOG.md](https://github.com/cky008/cpe-dash/blob/v1.2.0/CHANGELOG.md) · Documentation: [fengsui.iocky.com](https://fengsui.iocky.com/) · Container image: `ghcr.io/cky008/cpe-dash:1.2.0`",
        "",
      ].join("\n")
    );
  });

  it("keeps older sections that have no highlights readable, with no big heading anywhere", () => {
    const notes = releaseNotes(CHANGELOG, "1.1.0");
    // The first release has nothing to compare with: its commits instead
    assert.match(notes, /^Welcome to FengSui `v1\.1\.0`!\n\n## What's changed\n\n### 🚀 Features\n- Older\.\n\n\*\*Full Changelog\*\*: \[`v1\.1\.0`\]\(https:\/\/github\.com\/cky008\/cpe-dash\/commits\/v1\.1\.0\)\n\n---/);
    assert.doesNotMatch(notes, /^# /m, "GitHub shows the release title already");
  });

  it("refuses branch names, unknown versions and empty sections", () => {
    assert.throws(() => releaseNotes(CHANGELOG, "main"), /Not a release tag/);
    assert.throws(() => releaseNotes(CHANGELOG, "v9.9.9"), /no section for 9\.9\.9/);
    assert.throws(() => releaseNotes("## [2.0.0] — 2026-11-02\n\n## [1.0.0]\n- x\n", "v2.0.0"), /empty/);
  });

  it("has notes for every release tag in the real CHANGELOG, every change listed", () => {
    const changelog = fs.readFileSync("CHANGELOG.md", "utf8");
    const versions = [...changelog.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].map((m) => m[1] ?? "");
    assert.ok(versions.length >= 9);
    versions.forEach((version, i) => {
      const notes = releaseNotes(changelog, `v${version}`);
      assert.ok(notes.length > 80, version);
      // Compared with the release before it (CHANGELOG lists the newest first)
      const previous = versions[i + 1];
      assert.ok(notes.includes(previous ? `/compare/v${previous}...v${version})` : `/commits/v${version})`), version);
      assert.doesNotMatch(notes, /^### (?:Added|Fixed|Security|Changed|Documentation|Upgrading)$/m, `${version}: every section is mapped`);
    });
  });
});
