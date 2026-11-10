import path from "node:path";
import type { TestEvent } from "node:test/reporters";

/**
 * A `node --test` reporter that checks the run reported every test it should have. It prints one summary per
 * folder after the run (the spec reporter prints the tests) and fails the run when:
 *
 *  - a test started but never reported a result. Seen on Node 26: a synchronous test right after an async one
 *    that awaits a file write ran without a result; the TAP reporter passed the run one test short and the
 *    spec reporter stopped on an internal assertion;
 *  - a folder reports fewer tests than its floor below, which is what a file or a group that stopped running
 *    looks like from the outside.
 *
 * `npm run test:coverage` (the gate) and `npm run test:ui` use it next to the spec reporter:
 *
 *   node --test --test-reporter=spec --test-reporter-destination=stdout \
 *     --test-reporter=./scripts/test-count-reporter.ts --test-reporter-destination=stdout test/*.test.ts
 */

/**
 * The fewest tests each folder (relative to the repository) may report. Raise a floor when you add tests (the
 * summary says when the count has passed it); lower one only when you remove tests on purpose.
 */
export const TEST_FLOORS: Readonly<Record<string, number>> = { test: 1048, "test/ui": 22 };

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

function plural(count: number): string {
  return `${count} test${count === 1 ? "" : "s"}`;
}

export class TestTally {
  /** Tests that started and have not reported yet, by where they are and their name (a loop shares one line). */
  private readonly open = new Map<string, { at: Located; count: number }>();
  /** Absolute folder -> tests that reported a result (passed, failed, skipped or todo). */
  private readonly counts = new Map<string, number>();

  observe(event: TestEvent): void {
    if (event.type === "test:start") {
      const key = this.key(event.data);
      const entry = this.open.get(key);
      if (entry) entry.count += 1;
      else this.open.set(key, { at: event.data, count: 1 });
      return;
    }
    if (event.type !== "test:pass" && event.type !== "test:fail") return;
    const key = this.key(event.data);
    const entry = this.open.get(key);
    // A result without a start (a file that failed to load) is the runner's own failure, already counted there
    if (entry) {
      entry.count -= 1;
      if (entry.count === 0) this.open.delete(key);
    }
    if (event.data.details.type === "suite") return;
    const folder = event.data.file ? path.dirname(event.data.file) : "";
    this.counts.set(folder, (this.counts.get(folder) ?? 0) + 1);
  }

  verdict(floors: Readonly<Record<string, number>>, cwd: string): TestCountVerdict {
    const lines: string[] = [];
    let ok = true;
    const unreported = [...this.open.values()];
    if (unreported.length > 0) {
      ok = false;
      const total = unreported.reduce((sum, entry) => sum + entry.count, 0);
      lines.push(`test count: ${plural(total)} started but never reported a result:`);
      for (const { at } of unreported) {
        const file = at.file ? this.relative(at.file, cwd) : "(no file)";
        lines.push(`  - ${file}:${at.line ?? "?"} ${at.name}`);
      }
    }
    for (const [folder, floor] of Object.entries(floors)) {
      const count = this.counts.get(path.resolve(cwd, folder));
      // A folder that ran nothing is a run of other files (one file by hand), not a loss
      if (count === undefined) continue;
      if (count < floor) {
        ok = false;
        lines.push(`test count: ${plural(count)} in ${folder}/, expected at least ${floor} (TEST_FLOORS in scripts/test-count-reporter.ts)`);
      } else if (unreported.length === 0) {
        const raise = count > floor ? `; raise TEST_FLOORS["${folder}"] in scripts/test-count-reporter.ts to ${count}` : "";
        lines.push(`test count: ${plural(count)} in ${folder}/ (at least ${floor}${raise}), every test that started reported a result`);
      }
    }
    return { ok, lines };
  }

  private key(at: Located): string {
    return JSON.stringify([at.file ?? "", at.line ?? 0, at.column ?? 0, at.nesting, at.name]);
  }

  private relative(file: string, cwd: string): string {
    return path.relative(cwd, file).split(path.sep).join("/");
  }
}

export default async function* testCountReporter(source: AsyncIterable<TestEvent>): AsyncGenerator<string> {
  const tally = new TestTally();
  for await (const event of source) tally.observe(event);
  const { ok, lines } = tally.verdict(TEST_FLOORS, process.cwd());
  // The runner sets a failing exit code only for failed tests and leaves it alone otherwise
  if (!ok) process.exitCode = 1;
  if (lines.length > 0) yield `${lines.join("\n")}\n`;
}
