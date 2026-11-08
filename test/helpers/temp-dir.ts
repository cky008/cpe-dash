import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const created: string[] = [];

/**
 * A fresh temporary directory, removed when this test file's process exits (the runner gives every
 * file its own process), whatever the tests left in it: by then no background write is still queued.
 */
export function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  if (created.length === 0) {
    process.once("exit", () => {
      for (const leftover of created) fs.rmSync(leftover, { recursive: true, force: true });
    });
  }
  created.push(dir);
  return dir;
}

/**
 * Remove a `tempDir` now. The stores save in the background, so a write may still be landing when a
 * test ends; removing the directory under it fails with ENOTEMPTY, and what is left goes at exit.
 */
export function removeTempDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    if (!(err && typeof err === "object" && "code" in err && err.code === "ENOTEMPTY")) throw err;
  }
}
