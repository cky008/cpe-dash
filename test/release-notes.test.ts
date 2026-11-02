import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import { releaseNotes } from "../scripts/release-notes.ts";

const CHANGELOG = `# Changelog

## [Unreleased]

### Fixed
- Not released yet.

## [1.2.0] — 2026-10-31

### Added
- **A thing.** Details.

### Upgrading
- Nothing to do.

## [1.1.0] — 2026-10-30

### Added
- Older.
`;

describe("release notes from CHANGELOG.md", () => {
  it("takes exactly the tag's section and adds the image and the history link", () => {
    const notes = releaseNotes(CHANGELOG, "v1.2.0");
    assert.equal(
      notes,
      "### Added\n- **A thing.** Details.\n\n### Upgrading\n- Nothing to do.\n\n---\nContainer image: `ghcr.io/cky008/cpe-dash:1.2.0` · Full history: [CHANGELOG.md](https://github.com/cky008/cpe-dash/blob/v1.2.0/CHANGELOG.md)\n"
    );
    assert.match(releaseNotes(CHANGELOG, "1.1.0"), /^### Added\n- Older\.\n\n---/);
  });

  it("refuses branch names, unknown versions and empty sections", () => {
    assert.throws(() => releaseNotes(CHANGELOG, "main"), /Not a release tag/);
    assert.throws(() => releaseNotes(CHANGELOG, "v9.9.9"), /no section for 9\.9\.9/);
    assert.throws(() => releaseNotes("## [2.0.0] — 2026-11-02\n\n## [1.0.0]\n- x\n", "v2.0.0"), /empty/);
  });

  it("has notes for every release tag in the real CHANGELOG", () => {
    const changelog = fs.readFileSync("CHANGELOG.md", "utf8");
    const versions = [...changelog.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].map((m) => m[1] ?? "");
    assert.ok(versions.length >= 9);
    for (const version of versions) assert.ok(releaseNotes(changelog, `v${version}`).length > 80, version);
  });
});
