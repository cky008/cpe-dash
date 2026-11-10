import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import type { TestEvent } from "node:test/reporters";
import { TEST_FLOORS, TestTally } from "../scripts/test-count-reporter.ts";
import { removeTempDir, tempDir } from "./helpers/temp-dir.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const REPORTER = path.join(ROOT, "scripts", "test-count-reporter.ts");

interface Where {
  file: string;
  name: string;
  line?: number;
  nesting?: number;
  type?: "suite" | "test";
  skip?: boolean;
}

// Only the fields the tally reads; the runner sends more
function start(w: Where): TestEvent {
  return { type: "test:start", data: { file: w.file, name: w.name, line: w.line ?? 1, column: 3, nesting: w.nesting ?? 0 } } as unknown as TestEvent;
}

function result(kind: "test:pass" | "test:fail", w: Where): TestEvent {
  return {
    type: kind,
    data: { file: w.file, name: w.name, line: w.line ?? 1, column: 3, nesting: w.nesting ?? 0, skip: w.skip, details: { duration_ms: 1, type: w.type ?? "test" } },
  } as unknown as TestEvent;
}

// What the test itself sends when it finishes running, before the runner orders the report
function complete(w: Where, passed = true): TestEvent {
  return { type: "test:complete", data: { file: w.file, name: w.name, line: w.line ?? 1, column: 3, nesting: w.nesting ?? 0, details: { passed, duration_ms: 1, type: w.type ?? "test" } } } as unknown as TestEvent;
}

/** A run as the runner sends it: each test finishes, then the report starts and settles it. */
function run(where: ReadonlyArray<Where>, extra: ReadonlyArray<TestEvent> = []): TestTally {
  const tally = new TestTally();
  for (const w of where) tally.observe(complete(w));
  for (const w of where) tally.observe(start(w));
  for (const w of where) tally.observe(result("test:pass", w));
  for (const event of extra) tally.observe(event);
  return tally;
}

describe("The test-count reporter (scripts/test-count-reporter.ts)", () => {
  const cwd = "/repo";
  const unit = (name: string, line = 1): Where => ({ file: "/repo/test/a.test.ts", name, line, nesting: 1 });

  it("passes at the floor, says when the floor can go up, and counts no group as a test", () => {
    const suite: Where = { file: "/repo/test/a.test.ts", name: "group", type: "suite" };
    const atFloor = run([suite, unit("one", 2), unit("two", 3)]).verdict({ test: 2 }, cwd);
    assert.equal(atFloor.ok, true);
    assert.deepEqual(atFloor.lines, ["test count: 2 tests in test/ (at least 2)"]);

    const above = run([suite, unit("one", 2), unit("two", 3), unit("three", 4)]).verdict({ test: 2 }, cwd);
    assert.equal(above.ok, true);
    assert.deepEqual(above.lines, ['test count: 3 tests in test/ (at least 2; raise TEST_FLOORS["test"] in scripts/test-count-reporter.ts to 3)']);
  });

  it("fails when a test failed but the runner left the failure out of its report", () => {
    const tally = run([unit("first", 2)]);
    tally.observe(complete(unit("dropped", 9), false));
    tally.observe(start(unit("dropped", 9)));
    const verdict = tally.verdict({ test: 1 }, cwd);
    assert.equal(verdict.ok, false);
    assert.match(verdict.lines.join("\n"), /1 test failed, but the failure is not in the report:\n {2}- test\/a\.test\.ts:9 dropped/);
    // Reported as failed, it is the runner's own failure: nothing hidden
    const reported = run([unit("first", 2)], [complete(unit("seen", 9), false), start(unit("seen", 9)), result("test:fail", unit("seen", 9))]);
    assert.equal(reported.verdict({ test: 2 }, cwd).ok, true);
  });

  it("names a passed result the runner left out without failing the run, and still counts the test", () => {
    // Node 26: the test ran and passed (test:complete), its start was reported, its result never was
    const tally = run([unit("first", 2)], [complete(unit("unreported", 9)), start(unit("unreported", 9))]);
    // Node 22: the end of a group went missing
    tally.observe(start({ file: "/repo/test/a.test.ts", name: "group", type: "suite" }));
    const verdict = tally.verdict({ test: 2 }, cwd);
    assert.equal(verdict.ok, true, verdict.lines.join("\n"));
    assert.deepEqual(verdict.lines, [
      "test count: the test runner left 2 results out of its report (nothing failed there):",
      "  - test/a.test.ts:9 unreported",
      "  - test/a.test.ts:1 group",
      "test count: 2 tests in test/ (at least 2)",
    ]);
  });

  it("tells apart tests that share a line (a loop) by name, and counts skipped and failed tests too", () => {
    const tally = new TestTally();
    for (const name of ["case 1", "case 2"]) tally.observe(start(unit(name, 5)));
    tally.observe(result("test:fail", unit("case 1", 5)));
    tally.observe(result("test:pass", { ...unit("case 2", 5), skip: true }));
    assert.deepEqual(tally.verdict({ test: 2 }, cwd), { ok: true, lines: ["test count: 2 tests in test/ (at least 2)"] });

    // Two tests with the same name on the same line: each needs its own result
    const twins = new TestTally();
    twins.observe(complete(unit("same", 7), false));
    twins.observe(complete(unit("same", 7), false));
    twins.observe(result("test:fail", unit("same", 7)));
    assert.equal(twins.verdict({}, cwd).ok, false);
  });

  it("fails when a folder runs fewer tests than its floor, and leaves folders without a floor alone", () => {
    const short = run([unit("only")]).verdict({ test: 5 }, cwd);
    assert.equal(short.ok, false);
    assert.match(short.lines.join("\n"), /1 test in test\/, expected at least 5 \(TEST_FLOORS in scripts\/test-count-reporter\.ts\)/);

    const ui = (name: string): Where => ({ file: "/repo/test/ui/console.test.ts", name });
    const elsewhere: Where = { file: "/tmp/scratch/x.test.ts", name: "scratch" };
    const mixed = run([unit("one"), ui("a"), ui("b"), elsewhere]).verdict({ test: 1, "test/ui": 2 }, cwd);
    assert.equal(mixed.ok, true, mixed.lines.join("\n"));
    assert.match(mixed.lines.join("\n"), /2 tests in test\/ui\/ \(at least 2\)/);
    assert.doesNotMatch(mixed.lines.join("\n"), /scratch/);

    // A floor whose folder ran nothing is a run of other files (one file by hand), not a loss
    assert.equal(run([elsewhere]).verdict({ test: 5 }, cwd).ok, true);
  });

  it("counts a result that had no start (a file that failed to load) and ignores events that carry no test", () => {
    const tally = new TestTally();
    // The run of the file itself finishes too; the report only names it when the file failed to load
    tally.observe(complete({ file: "/repo/test/b.test.ts", name: "test/b.test.ts" }));
    tally.observe(complete({ file: "/repo/test/c.test.ts", name: "test/c.test.ts" }, false));
    tally.observe(result("test:fail", { file: "/repo/test/c.test.ts", name: "test/c.test.ts" }));
    tally.observe(result("test:fail", unit("could not load")));
    tally.observe({ type: "test:diagnostic", data: { message: "tests 1", nesting: 0 } } as unknown as TestEvent);
    assert.deepEqual(tally.verdict({ test: 2 }, cwd), { ok: true, lines: ["test count: 2 tests in test/ (at least 2)"] });
  });

  it("holds a floor for the unit tests and the browser tests, as they run in npm run check and npm run test:ui", () => {
    assert.ok((TEST_FLOORS["test"] ?? 0) >= 1000);
    assert.ok((TEST_FLOORS["test/ui"] ?? 0) >= 1);
    const { scripts } = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
    for (const name of ["test:coverage", "test:ui"]) {
      assert.match(scripts[name] ?? "", /--test-reporter=spec --test-reporter-destination=stdout --test-reporter=\.\/scripts\/test-count-reporter\.ts --test-reporter-destination=stdout /, name);
    }
  });

  it("loads as a reporter in a real run and fails it when a folder falls below its floor", () => {
    const dir = tempDir("fengsui-count-");
    try {
      fs.mkdirSync(path.join(dir, "test"));
      fs.writeFileSync(path.join(dir, "test", "one.test.ts"), 'import { it } from "node:test";\nit("runs", () => {});\n');
      // Without the parent's test context the child runs its files instead of nesting in this test
      const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== "NODE_TEST_CONTEXT"));
      const child = spawnSync(process.execPath, ["--experimental-strip-types", "--test", `--test-reporter=${REPORTER}`, "test/one.test.ts"], {
        cwd: dir,
        env,
        encoding: "utf8",
        timeout: 30_000,
      });
      assert.equal(child.status, 1, child.stdout + child.stderr);
      assert.match(child.stdout, /1 test in test\/, expected at least \d+/);
    } finally {
      removeTempDir(dir);
    }
  });
});
