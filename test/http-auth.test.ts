import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../src/config.ts";
import { type CredentialDirectory, type CredentialVerdict, HttpAuthGuard } from "../src/http-auth.ts";

/**
 * The console sign-in limit: every wrong password counts against the client's bucket, and a password
 * that is still being checked (scrypt, ~50–100 ms on the thread pool) counts until its answer is known.
 */

const config = loadConfig({ envPath: "/nonexistent/.env", ignoreProcessEnv: true, overrides: { RATE_LIMIT_MAX_AUTH_FAILURES: "3" } });

/** A login directory whose checks wait until the test lets them answer; `hashes` counts the checks begun. */
function slowDirectory() {
  const pending: Array<() => void> = [];
  const state = { hashes: 0 };
  const directory: CredentialDirectory = {
    verifyLogin: (candidate) => {
      state.hashes += 1;
      return new Promise<boolean>((resolve) => pending.push(() => resolve(candidate === "the right password")));
    },
    resolveBearer: () => null,
  };
  const answerAll = (): void => {
    for (const answer of pending.splice(0)) answer();
  };
  return { directory, state, answerAll };
}

describe("the console sign-in limit (HttpAuthGuard.guardLogin)", () => {
  it("counts the checks still running against the client's limit: a burst of guesses hashes no more than it may fail", async () => {
    const { directory, state, answerAll } = slowDirectory();
    const guard = new HttpAuthGuard(() => config, directory);
    const burst = Array.from({ length: 10 }, (_, i) => guard.guardLogin("192.168.8.50", `guess ${i}`));
    // The ones over the limit are answered at once, before any hashing
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(state.hashes, 3, "three checks run: the limit");
    answerAll();
    const verdicts: CredentialVerdict[] = await Promise.all(burst);
    assert.equal(verdicts.filter((v) => !v.ok && v.statusCode === 401).length, 3, "the three checked were wrong");
    assert.equal(verdicts.filter((v) => !v.ok && v.statusCode === 429).length, 7, "the rest wait, with a time to retry");
    for (const v of verdicts) if (!v.ok && v.statusCode === 429) assert.ok((v.retrySec ?? 0) >= 1);
    // Locked out now, the right password too, and still without hashing
    const locked = await guard.guardLogin("192.168.8.50", "the right password");
    assert.equal(locked.ok ? 200 : locked.statusCode, 429);
    assert.equal(state.hashes, 3);
  });

  it("lets another client sign in while one is guessing, and lets a double click through", async () => {
    const { directory, state, answerAll } = slowDirectory();
    const guard = new HttpAuthGuard(() => config, directory);
    const guesses = Array.from({ length: 5 }, (_, i) => guard.guardLogin("192.168.8.50", `guess ${i}`));
    const owner = [guard.guardLogin("192.168.8.10", "the right password"), guard.guardLogin("192.168.8.10", "the right password")];
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(state.hashes, 5, "three of the guesser's, both of the owner's");
    answerAll();
    await Promise.all(guesses);
    assert.deepEqual(await Promise.all(owner), [{ ok: true }, { ok: true }]);
  });

  it("frees the count of a check that failed, so it does not hold the client back", async () => {
    let calls = 0;
    const directory: CredentialDirectory = {
      verifyLogin: async () => {
        calls += 1;
        if (calls <= 3) throw new Error("the settings could not be read");
        return true;
      },
      resolveBearer: () => null,
    };
    const guard = new HttpAuthGuard(() => config, directory);
    // As many failed checks as the limit allows: none of them is left counted as still running
    for (let i = 0; i < 3; i += 1) await assert.rejects(guard.guardLogin("192.168.8.50", "x"), /could not be read/);
    assert.deepEqual(await guard.guardLogin("192.168.8.50", "x"), { ok: true });
  });
});
