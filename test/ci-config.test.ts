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
  });

  it("pins the base image by digest, attests releases and bounds the container", () => {
    const dockerfile = fs.readFileSync(path.resolve(WORKFLOWS, "..", "..", "Dockerfile"), "utf8");
    const froms = dockerfile.split("\n").filter((line) => line.startsWith("FROM "));
    assert.equal(froms.length, 2);
    for (const line of froms) assert.match(line, /node:\d+-alpine@sha256:[0-9a-f]{64}\s/, line);
    const release = fs.readFileSync(path.join(WORKFLOWS, "release.yml"), "utf8");
    assert.match(release, /^\s+provenance: mode=max$/m);
    assert.match(release, /^\s+sbom: true$/m);
    const compose = fs.readFileSync(path.resolve(WORKFLOWS, "..", "..", "docker-compose.yml"), "utf8");
    assert.match(compose, /^\s+mem_limit: \d+[mg]$/m);
    assert.match(compose, /^\s+pids_limit: \d+$/m);
  });
});

