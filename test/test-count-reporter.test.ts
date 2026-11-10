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

function run(where: ReadonlyArray<Where>, extra: ReadonlyArray<TestEvent> = []): TestTally {
  const tally = new TestTally();
  for (const w of where) tally.observe(start(w));
  for (const w of where) tally.observe(result("test:pass", w));
  for (const event of extra) tally.observe(event);
  return tally;
}

describe("The test-count reporter (scripts/test-count-reporter.ts)", () => {
  const cwd = "/repo";
  const unit = (name: string, line = 1): Where => ({ file: "/repo/test/a.test.ts", name, line, nesting: 1 });

  it("passes when every started test reported a result and the folder is at its floor, and says when the floor can go up", () => {
    const suite: Where = { file: "/repo/test/a.test.ts", name: "group", type: "suite" };
    const atFloor = run([suite, unit("one", 2), unit("two", 3)]).verdict({ test: 2 }, cwd);
    assert.equal(atFloor.ok, true);
    assert.deepEqual(atFloor.lines, ["test count: 2 tests in test/ (at least 2), every test that started reported a result"]);

    const above = run([suite, unit("one", 2), unit("two", 3), unit("three", 4)]).verdict({ test: 2 }, cwd);
    assert.equal(above.ok, true);
    assert.match(above.lines.join("\n"), /3 tests in test\/ \(at least 2; raise TEST_FLOORS\["test"\] in scripts\/test-count-reporter\.ts to 3\)/);
  });

  it("fails when a test started but never reported a result, even though the run itself passed", () => {
    const tally = run([unit("first", 2)]);
    tally.observe(start(unit("dropped", 9)));
    const verdict = tally.verdict({ test: 1 }, cwd);
    assert.equal(verdict.ok, false);
    assert.match(verdict.lines.join("\n"), /1 test started but never reported a result/);
    assert.match(verdict.lines.join("\n"), /test\/a\.test\.ts:9 dropped/);
  });

  it("tells apart tests that share a line (a loop) by name, and counts skipped and failed tests too", () => {
    const tally = new TestTally();
    for (const name of ["case 1", "case 2"]) tally.observe(start(unit(name, 5)));
    tally.observe(result("test:fail", unit("case 1", 5)));
    tally.observe(result("test:pass", { ...unit("case 2", 5), skip: true }));
    assert.equal(tally.verdict({ test: 2 }, cwd).ok, true);

    // Two tests with the same name on the same line: each needs its own result
    const twins = new TestTally();
    twins.observe(start(unit("same", 7)));
    twins.observe(start(unit("same", 7)));
    twins.observe(result("test:pass", unit("same", 7)));
    assert.equal(twins.verdict({}, cwd).ok, false);
  });

  it("fails when a folder reports fewer tests than its floor, and leaves folders without a floor alone", () => {
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

  it("ignores a result that had no start (a file that failed to load) and events that carry no test", () => {
    const tally = new TestTally();
    tally.observe(result("test:fail", unit("could not load")));
    tally.observe({ type: "test:diagnostic", data: { message: "tests 1", nesting: 0 } } as unknown as TestEvent);
    const verdict = tally.verdict({ test: 1 }, cwd);
    assert.equal(verdict.ok, true, verdict.lines.join("\n"));
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
