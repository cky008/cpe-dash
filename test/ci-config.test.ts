import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const WORKFLOWS = path.resolve(import.meta.dirname, "..", ".github", "workflows");

function workflowFiles(): string[] {
  return fs
    .readdirSync(WORKFLOWS)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .map((name) => path.join(WORKFLOWS, name));
}

describe("GitHub Actions supply chain", () => {
  it("pins every action to a full commit SHA with its version in a comment", () => {
    const refs: string[] = [];
    for (const file of workflowFiles()) {
      for (const line of fs.readFileSync(file, "utf8").split("\n")) {
        const ref = /^\s*(?:-\s+)?uses:\s*(\S+)(.*)$/.exec(line);
        if (!ref) continue;
        refs.push(ref[1] ?? "");
        // A tag such as @v7 can be moved by whoever controls the action's repository; a SHA cannot
        assert.match(ref[1] ?? "", /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, `${path.basename(file)}: ${line.trim()}`);
        assert.match(ref[2] ?? "", /^\s+# v\d+\.\d+\.\d+$/, `${path.basename(file)}: version comment for Dependabot`);
      }
    }
    assert.ok(refs.length > 0, "found the workflows' actions");
  });

  it("publishes releases one at a time with write access only where images are pushed", () => {
    const release = fs.readFileSync(path.join(WORKFLOWS, "release.yml"), "utf8");
    assert.match(release, /^concurrency:\n {2}group: release\n {2}cancel-in-progress: false$/m);
    assert.match(release, /^permissions:\n {2}contents: read$/m);
    assert.equal(release.match(/packages: write/g)?.length, 1);
    // Only the notes job may write repository contents (its own release entry)
    assert.equal(release.match(/contents: write/g)?.length, 1);
    assert.match(release, /\n  notes:\n[\s\S]*?permissions:\n {6}contents: write\n/);
    assert.match(release, /scripts\/release-notes\.ts "\$TAG"/);
  });

  it("pins the base image by digest, attests releases and bounds the container", () => {
    const dockerfile = fs.readFileSync(path.resolve(WORKFLOWS, "..", "..", "Dockerfile"), "utf8");
    const froms = dockerfile.split("\n").filter((line) => line.startsWith("FROM "));
    assert.equal(froms.length, 2);
    for (const line of froms) assert.match(line, /node:\d+-alpine@sha256:[0-9a-f]{64}\s/, line);
    const digests = froms.map((line) => /sha256:[0-9a-f]{64}/.exec(line)?.[0]);
    assert.equal(digests.length, 2);
    assert.ok(digests[0], "first FROM line has a digest");
    assert.equal(digests[0], digests[1], "both Dockerfile FROM lines pin the same digest");
    const release = fs.readFileSync(path.join(WORKFLOWS, "release.yml"), "utf8");
    assert.match(release, /^\s+provenance: mode=max$/m);
    assert.match(release, /^\s+sbom: true$/m);
    const compose = fs.readFileSync(path.resolve(WORKFLOWS, "..", "..", "docker-compose.yml"), "utf8");
    assert.match(compose, /^\s+read_only:\s*true$/m);
    assert.match(compose, /^\s+cap_drop:\r?\n\s+-\s+ALL$/m);
    assert.match(compose, /^\s+security_opt:\r?\n\s+-\s+no-new-privileges:true$/m);
    assert.match(compose, /^\s+tmpfs:\r?\n\s+-\s+\/tmp$/m);
    assert.match(compose, /^\s+mem_limit: \d+[mg]$/m);
    // Synology's kernel has no pids cgroup: Docker drops pids_limit with a warning, so it stays a comment
    assert.doesNotMatch(compose, /^\s+pids_limit:/m);
    assert.match(compose, /^\s+# pids_limit: \d+$/m);
  });
});


describe("The local gate (npm run check)", () => {
  const ROOT = path.resolve(import.meta.dirname, "..");

  it("builds the web console too, so its size limit fails the gate as it fails CI, a release and the Docker build (R1-03)", () => {
    const { scripts } = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
    // The build takes well under a second and fails fast, before the tests
    assert.deepEqual(scripts["check"]?.split("&&").map((step) => step.trim()), ["npm run typecheck", "npm run build:web", "npm run test:coverage", "npm run audit:secrets"]);
    for (const doc of ["AGENTS.md", "CONTRIBUTING.md"]) {
      assert.ok(/`?npm run build:web`?\s*(?:→|：)/.test(fs.readFileSync(path.join(ROOT, doc), "utf8")), `${doc} lists the build among the gate's steps`);
    }
  });

  it("keeps the browser tests out of the gate and runs them in CI against a fresh build (ADR-R2-04)", () => {
    const { scripts } = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
    // test/*.test.ts does not reach test/ui/: the gate and its coverage never need a browser
    for (const name of ["test", "test:coverage"]) assert.match(scripts[name] ?? "", /--test test\/\*\.test\.ts$/, name);
    assert.equal(scripts["test:ui"], "npm run build:web && node --experimental-strip-types --test test/ui/*.test.ts");
    const ci = fs.readFileSync(path.join(ROOT, ".github", "workflows", "ci-docker.yml"), "utf8");
    assert.match(ci, /run: npm run check\n(?:\s+#[^\n]*\n)?\s+- name: Console in a headless browser[^\n]*\n\s+if: matrix\.node == '26\.x'\n\s+run: npm run test:ui\n/);
  });
});

describe("Third-party notices", () => {
  const ROOT = path.resolve(import.meta.dirname, "..");
  const read = (file: string): string => fs.readFileSync(path.join(ROOT, file), "utf8");

  it("names every project whose code the console's build contains, with its full license text", () => {
    const notices = read("THIRD_PARTY_NOTICES.md");
    for (const [name, license] of [
      ["Tailwind CSS", "Copyright (c) Tailwind Labs, Inc."],
      ["daisyUI", "Copyright (c) 2020 Pouya Saadeghi"],
      ["Lucide", "Copyright (c) 2026 Lucide Icons and Contributors"],
      ["Lucide", "Copyright (c) 2013-present Cole Bemis"],
    ] as const) {
      assert.match(notices, new RegExp(`^## ${name}$`, "m"), name);
      assert.ok(notices.includes(license), `${name}: ${license}`);
    }
    // The stylesheet's own sources: daisyUI and Tailwind are the only packages it compiles in
    assert.match(read("web/styles.css"), /@plugin "daisyui"/);
  });

  it("ships the notices with the console, the demo and the container image", () => {
    assert.match(read("scripts/build-web.ts"), /THIRD_PARTY_NOTICES\.md[\s\S]{0,200}THIRD_PARTY_NOTICES\.txt/);
    assert.match(read(".dockerignore"), /^!THIRD_PARTY_NOTICES\.md$/m);
    const dockerfile = read("Dockerfile");
    assert.equal(dockerfile.match(/^COPY LICENSE THIRD_PARTY_NOTICES\.md \.\/$/gm)?.length, 2, "the build stage (for the console) and the runtime image");
  });
});
