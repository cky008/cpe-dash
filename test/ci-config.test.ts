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

  it("attaches the Claude Desktop extension to the release, built and attested in a job that cannot write the repository", () => {
    const release = fs.readFileSync(path.join(WORKFLOWS, "release.yml"), "utf8");
    const job = (name: string): string => {
      const start = release.indexOf(`\n  ${name}:\n`);
      assert.ok(start > 0, `release.yml has a ${name} job`);
      const next = release.slice(start + 1).search(/\n {2}[a-z-]+:\n/);
      return next < 0 ? release.slice(start) : release.slice(start, start + 1 + next);
    };
    const extension = job("extension");
    assert.match(extension, /\n {4}needs: check\n/);
    assert.match(extension, /\n {4}permissions:\n {6}contents: read\n {6}id-token: write\n {6}attestations: write\n/);
    assert.match(extension, /\n\s+npm run build:mcpb\n/);
    // A tag releases the version package.json names, so v1.2.3 ships fengsui-1.2.3.mcpb
    assert.match(extension, /"\$REF_NAME" != "v\$version"/);
    assert.match(extension, /uses: actions\/attest-build-provenance@[0-9a-f]{40} # v\d+\.\d+\.\d+\n\s+with:\n\s+subject-path: \$\{\{ steps\.mcpb\.outputs\.file \}\}/);
    assert.match(extension, /if: \$\{\{ !github\.event\.repository\.private && github\.ref_type == 'tag' \}\}/);
    assert.match(extension, /uses: actions\/upload-artifact@[0-9a-f]{40} # v\d+\.\d+\.\d+\n\s+with:\n\s+name: mcpb\n/);
    const notes = job("notes");
    assert.match(notes, /\n {4}needs: \[publish, extension\]\n/);
    assert.match(notes, /uses: actions\/download-artifact@[0-9a-f]{40} # v\d+\.\d+\.\d+\n\s+with:\n\s+name: mcpb\n/);
    assert.match(notes, /gh release upload "\$TAG" "\$RUNNER_TEMP"\/mcpb\/fengsui-\*\.mcpb --clobber/);
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
    // metadata-action derives the licence label from GitHub's licence field ("Other", so NOASSERTION) and that label
    // overrides the Dockerfile's: the release states the SPDX ID of package.json itself
    const license = (JSON.parse(fs.readFileSync(path.resolve(WORKFLOWS, "..", "..", "package.json"), "utf8")) as { license: string }).license;
    assert.ok(release.split("\n").some((line) => line.trim() === `org.opencontainers.image.licenses=${license}`), "release.yml labels the licence");
    assert.ok(dockerfile.includes(`org.opencontainers.image.licenses="${license}"`), "the Dockerfile labels the licence");
    for (const file of fs.readdirSync(WORKFLOWS)) {
      assert.doesNotMatch(fs.readFileSync(path.join(WORKFLOWS, file), "utf8"), /this private repository/, `${file} still calls the repository private`);
    }
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
    assert.deepEqual(scripts["check"]?.split("&&").map((step) => step.trim()), ["npm run typecheck", "npm run build:web", "npm run test:coverage", "npm run test:browser", "npm run audit:secrets"]);
    for (const doc of ["AGENTS.md", "CONTRIBUTING.md"]) {
      assert.ok(/`?npm run build:web`?\s*(?:→|：)/.test(fs.readFileSync(path.join(ROOT, doc), "utf8")), `${doc} lists the build among the gate's steps`);
    }
  });

  it("runs the browser tests inside the gate, against the build the gate just made, once per CI job", () => {
    const { scripts } = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
    // test/*.test.ts does not reach test/ui/: coverage never needs a browser, and the browser tests are their own step
    for (const name of ["test", "test:coverage"]) assert.match(scripts[name] ?? "", /--test(?: --test-reporter(?:-destination)?=\S+)* test\/\*\.test\.ts$/, name);
    // One file at a time (each runs its own headless Chrome, and the demo's file builds the demo first), and no test
    // may hang the job: a stuck page fails after the timeout and the failures get printed
    assert.match(scripts["test:browser"] ?? "", /^node --experimental-strip-types --test --test-concurrency=1 --test-timeout=\d+(?: --test-reporter(?:-destination)?=\S+)* test\/ui\/\*\.test\.ts$/);
    // On its own, test:ui builds the console first; inside the gate, build:web already ran
    assert.equal(scripts["test:ui"], "npm run build:web && npm run test:browser");
    const ci = fs.readFileSync(path.join(ROOT, ".github", "workflows", "ci-docker.yml"), "utf8");
    assert.match(ci, /\n\s+run: npm run check\n/);
    // No second browser run beside the gate (it was skipped once before a push, and CI went red)
    assert.doesNotMatch(ci, /npm run test:(?:ui|browser)/);
  });

  it("runs the gate on the engines floor, on the Node that Claude Desktop runs the extension with, and on the image's", () => {
    const ci = fs.readFileSync(path.join(ROOT, ".github", "workflows", "ci-docker.yml"), "utf8");
    const matrix = /^\s+node: \[([^\]]*)\]$/m.exec(ci)?.[1]?.split(",").map((entry) => entry.trim().replace(/^"|"$/g, ""));
    // 22: package.json's engines (>= 22.6); 24: the Node built into Claude Desktop (6.6395.0 ships 24.22.3); 26: the
    // LTS the container image runs
    assert.deepEqual(matrix, ["22.x", "24.x", "26.x"]);
    const { engines } = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as { engines: { node: string } };
    assert.equal(engines.node, ">=22.6.0", "the floor the first entry stands for");
    const dockerfile = fs.readFileSync(path.join(ROOT, "Dockerfile"), "utf8");
    assert.match(dockerfile, /^FROM node:26-alpine@/m, "the image's Node is the last entry");
    // Every entry packs the Claude Desktop extension the way a release does
    const { scripts } = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
    assert.equal(scripts["build:mcpb"], "node --experimental-strip-types scripts/build-mcpb.ts");
    assert.match(ci, /\n\s+run: npm run build:mcpb\n/);
  });

  it("gives every hook of the browser tests a timeout, so a stuck Chrome fails the gate instead of hanging it", () => {
    const uiDir = path.join(ROOT, "test", "ui");
    const uiTests = fs.readdirSync(uiDir).filter((name) => name.endsWith(".test.ts"));
    assert.ok(uiTests.length >= 2, `expected at least two browser test files, found ${uiTests.length}`);
    for (const file of uiTests) {
      const source = fs.readFileSync(path.join(uiDir, file), "utf8");
      const nodeTestImports = [...source.matchAll(/^import\s*\{([^}]*)\}\s*from\s*["']node:test["'];?/gm)];
      assert.ok(nodeTestImports.length > 0, `${file} imports from "node:test"`);
      assert.doesNotMatch(source, /^import\s+(?!\{)[^;\n]*from\s*["']node:test["']/m, `${file} uses named imports from "node:test"`);
      for (const match of nodeTestImports) {
        const names = (match[1] ?? "")
          .split(",")
          .map((part) => part.trim())
          .filter((part) => part !== "");
        assert.ok(names.length > 0, `${file} has a non-empty import from "node:test"`);
        for (const name of names) {
          assert.ok(name === "describe" || name === "it", `${file} imports ${name} from "node:test" instead of ./hooks.ts`);
        }
      }
      assert.match(source, /from\s+["']\.\/hooks\.ts["']/, `${file} imports from "./hooks.ts"`);
    }
    const hooks = fs.readFileSync(path.join(uiDir, "hooks.ts"), "utf8");
    assert.ok(hooks.includes("before(fn, { timeout: HOOK_TIMEOUT_MS })"), "hooks.ts gives before() HOOK_TIMEOUT_MS");
    assert.ok(hooks.includes("after(fn, { timeout: HOOK_TIMEOUT_MS })"), "hooks.ts gives after() HOOK_TIMEOUT_MS");
    const timeoutMatch = /export const HOOK_TIMEOUT_MS = (\d[\d_]*)/.exec(hooks);
    assert.ok(timeoutMatch, "hooks.ts exports HOOK_TIMEOUT_MS");
    const hookTimeoutMs = Number((timeoutMatch[1] ?? "").replaceAll("_", ""));
    assert.ok(hookTimeoutMs >= 60_000 && hookTimeoutMs <= 600_000, `HOOK_TIMEOUT_MS (${hookTimeoutMs}) must be between 60 000 and 600 000`);
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

  it("copies into the image's build stage every script the web build imports", () => {
    const copied = /^COPY ((?:scripts\/[a-z-]+\.ts )+)\.\/scripts\/$/m.exec(read("Dockerfile"))?.[1]?.trim().split(" ") ?? [];
    const imported = [...read("scripts/build-web.ts").matchAll(/from "\.\/([a-z-]+\.ts)"/g)].map((m) => `scripts/${m[1] ?? ""}`);
    assert.ok(imported.length >= 2, `found ${imported.length}`);
    assert.deepEqual(imported.filter((file) => !copied.includes(file)), [], "COPY these into the build stage");
  });

  it("ships the notices with the console, the demo and the container image", () => {
    assert.match(read("scripts/build-web.ts"), /THIRD_PARTY_NOTICES\.md[\s\S]{0,200}THIRD_PARTY_NOTICES\.txt/);
    assert.match(read(".dockerignore"), /^!THIRD_PARTY_NOTICES\.md$/m);
    const dockerfile = read("Dockerfile");
    assert.equal(dockerfile.match(/^COPY LICENSE THIRD_PARTY_NOTICES\.md \.\/$/gm)?.length, 2, "the build stage (for the console) and the runtime image");
  });
});
