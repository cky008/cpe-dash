import path from "node:path";
import type { TestEvent } from "node:test/reporters";

/**
 * A `node --test` reporter that checks the run against what the tests themselves did. It prints one summary per
 * folder after the run (the spec reporter prints the tests) and fails the run when:
 *
 *  - a test failed but its failure is not in the report. The runner can leave a result out: on Node 26 a test
 *    that ran right after an async one went unreported (the TAP reporter passed the run one test short, the
 *    spec reporter stopped on an internal assertion), and on Node 22 the end of a group. Each test also sends
 *    `test:complete` when it finishes, which is checked against the report;
 *  - a folder ran fewer tests than its floor below, which is what a file or a group that stopped running looks
 *    like from the outside.
 *
 * A passed result the runner left out does not fail the run (the test passed); the summary names it.
 *
 * `npm run test:coverage` (the gate) and `npm run test:ui` use it next to the spec reporter:
 *
 *   node --test --test-reporter=spec --test-reporter-destination=stdout \
 *     --test-reporter=./scripts/test-count-reporter.ts --test-reporter-destination=stdout test/*.test.ts
 */

/**
 * The fewest tests each folder (relative to the repository) may run. Raise a floor when you add tests (the
 * summary says when the count has passed it); lower one only when you remove tests on purpose.
 */
export const TEST_FLOORS: Readonly<Record<string, number>> = { test: 1264, "test/ui": 23 };

export interface TestCountVerdict {
  ok: boolean;
  lines: string[];
}

interface Located {
  file?: string | undefined;
  name: string;
  line?: number | undefined;
  column?: number | undefined;
  nesting: number;
}

/** One test or group, by where it is and its name (tests made in a loop share a line). */
interface Tracked {
  at: Located;
  started: number;
  /** Finished running (`test:complete`), and how many of those failed. */
  completed: number;
  completedFailed: number;
  /** Reported (`test:pass` / `test:fail`), and how many of those failed. */
  reported: number;
  reportedFailed: number;
  suite: boolean;
}

function plural(count: number, word = "test"): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export class TestTally {
  readonly #tracked = new Map<string, Tracked>();

  observe(event: TestEvent): void {
    switch (event.type) {
      case "test:start":
        this.#entry(event.data).started += 1;
        return;
      case "test:complete": {
        const entry = this.#entry(event.data);
        entry.completed += 1;
        if (!event.data.details.passed) entry.completedFailed += 1;
        if (event.data.details.type === "suite") entry.suite = true;
        return;
      }
      case "test:pass":
      case "test:fail": {
        const entry = this.#entry(event.data);
        entry.reported += 1;
        if (event.type === "test:fail") entry.reportedFailed += 1;
        if (event.data.details.type === "suite") entry.suite = true;
        return;
      }
      default:
        return;
    }
  }

  verdict(floors: Readonly<Record<string, number>>, cwd: string): TestCountVerdict {
    const lines: string[] = [];
    let ok = true;
    const where = ({ at }: Tracked): string => `  - ${at.file ? path.relative(cwd, at.file).split(path.sep).join("/") : "(no file)"}:${at.line ?? "?"} ${at.name}`;
    // Each file runs as a test of its own in a child process; only a failure to load it reaches the report
    const fileRun = ({ at }: Tracked): boolean => at.file !== undefined && path.resolve(cwd, at.name) === path.resolve(cwd, at.file);
    const entries = [...this.#tracked.values()].map((e) => (fileRun(e) ? { ...e, started: 0, completed: 0, completedFailed: 0 } : e));

    const hidden = entries.filter((e) => e.completedFailed > e.reportedFailed);
    if (hidden.length > 0) {
      ok = false;
      lines.push(`test count: ${plural(hidden.length)} failed, but the failure is not in the report:`, ...hidden.map(where));
    }
    // Ran (or started) and passed, but the runner left the result out: the test is still counted below
    const leftOut = entries.filter((e) => e.completedFailed <= e.reportedFailed && Math.max(e.started, e.completed) > e.reported);
    if (leftOut.length > 0) {
      lines.push(`test count: the test runner left ${plural(leftOut.length, "result")} out of its report (nothing failed there):`, ...leftOut.map(where));
    }

    const counts = new Map<string, number>();
    for (const entry of entries) {
      if (entry.suite) continue;
      const folder = entry.at.file ? path.dirname(entry.at.file) : "";
      counts.set(folder, (counts.get(folder) ?? 0) + Math.max(entry.completed, entry.reported));
    }
    for (const [folder, floor] of Object.entries(floors)) {
      const count = counts.get(path.resolve(cwd, folder));
      // A folder that ran nothing is a run of other files (one file by hand), not a loss
      if (count === undefined) continue;
      if (count < floor) {
        ok = false;
        lines.push(`test count: ${plural(count)} in ${folder}/, expected at least ${floor} (TEST_FLOORS in scripts/test-count-reporter.ts)`);
      } else {
        const raise = count > floor ? `; raise TEST_FLOORS["${folder}"] in scripts/test-count-reporter.ts to ${count}` : "";
        lines.push(`test count: ${plural(count)} in ${folder}/ (at least ${floor}${raise})`);
      }
    }
    return { ok, lines };
  }

  #entry(at: Located): Tracked {
    const key = JSON.stringify([at.file ?? "", at.line ?? 0, at.column ?? 0, at.nesting, at.name]);
    let entry = this.#tracked.get(key);
    if (!entry) {
      entry = { at: { file: at.file, name: at.name, line: at.line, column: at.column, nesting: at.nesting }, started: 0, completed: 0, completedFailed: 0, reported: 0, reportedFailed: 0, suite: false };
      this.#tracked.set(key, entry);
    }
    return entry;
  }
}

export default async function* testCountReporter(source: AsyncIterable<TestEvent>): AsyncGenerator<string> {
  const tally = new TestTally();
  for await (const event of source) tally.observe(event);
  const { ok, lines } = tally.verdict(TEST_FLOORS, process.cwd());
  // The runner sets a failing exit code only for the failures it reported and leaves it alone otherwise
  if (!ok) process.exitCode = 1;
  if (lines.length > 0) yield `${lines.join("\n")}\n`;
}
