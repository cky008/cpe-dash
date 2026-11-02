import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { CpeLoginMethodError, LOGIN_UNCONFIRMED_CODE } from "../src/cpe-auth.ts";
import { createFengSuiCore, stopFengSuiCore } from "../src/core.ts";
import { CpeApiError, HuaweiCpeClient } from "../src/cpe-client.ts";
import type { DeviceProbeResult } from "../src/device-profile.ts";
import { CircuitBreakerOpenError } from "../src/scheduler.ts";
import { EncryptedStateStore } from "../src/state-store.ts";
import { TimeSeriesRingBuffer } from "../src/timeseries.ts";
import { MAX_XML_BYTES, getXmlTag } from "../src/xml.ts";
import { type CpeFamily, FAMILY_LOGINS, FAMILY_TOKEN_FLOWS, type FamilyLogin, type FamilyTokenFlow, blockNetwork, createCpeFamily } from "./helpers/cpe-family.ts";
import { type StrictFault, createStrictCpe } from "./helpers/strict-cpe.ts";

/**
 * Phase 1 of multi-model support: the client logs in with SCRAM (with or without the ECC channel),
 * legacy SHA-256 or base64, over the webserver/token or SesTokInfo token flow, and decides how
 * BEFORE it sends any password. Every variant runs on the strict mock family; no network.
 */

const SCHEME: Readonly<Record<FamilyLogin, string>> = { scram: "scram", "scram-ecc": "scram", sha256: "sha256", base64: "base64" };
const FLOW: Readonly<Record<FamilyTokenFlow, string>> = { token: "webserver-token", sestokinfo: "sestokinfo" };
const SUBMIT_PATHS = ["/api/user/authentication_login", "/api/user/login"];

function clientFor(cpe: { fetchImpl: typeof fetch; password: string }, password = cpe.password): HuaweiCpeClient {
  return new HuaweiCpeClient({ cpeUrl: "http://192.168.8.1", cpePassword: password, fetchImpl: cpe.fetchImpl, requestTimeoutMs: 2000 });
}

/** Swap one answer of the mock (keeps its request log and rules for everything else). */
function answerWith(cpe: CpeFamily, p: string, body: () => string): typeof fetch {
  return async (input, init) => {
    if (new URL(String(input)).pathname !== p) return await cpe.fetchImpl(input, init);
    cpe.stats.requests.push({ path: p, method: init?.method ?? "GET" });
    return new Response(body(), { status: 200 });
  };
}

const submissions = (cpe: CpeFamily): number => SUBMIT_PATHS.reduce((n, p) => n + cpe.count(p, "POST"), 0);

function coreFixture(cpe: { fetchImpl: typeof fetch; password: string }, opts: { password?: string; deviceProbe?: DeviceProbeResult } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fengsui-login-"));
  const stateStore = new EncryptedStateStore({ filePath: path.join(dir, "state.json"), encryptionKey: "login_key" });
  if (opts.deviceProbe) stateStore.update({ deviceProbe: opts.deviceProbe });
  const client = clientFor(cpe, opts.password ?? cpe.password);
  const core = createFengSuiCore({ client, stateStore, timeseries: new TimeSeriesRingBuffer({ retentionHours: 1 }), pollIntervalMs: 600_000, neighborScanIntervalMs: 600_000 });
  core.monitor.init();
  return {
    client,
    core,
    good: { url: "http://192.168.8.1", username: "admin", password: cpe.password },
    cleanup: async () => {
      await stopFengSuiCore(core);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("login methods and token flows (mock family)", () => {
  let restoreNetwork: () => void = () => undefined;
  before(() => {
    restoreNetwork = blockNetwork();
  });
  after(() => restoreNetwork());

  it("logs in with every method and token flow, reads, writes, logs out; a second session is refused meanwhile", async () => {
    for (const login of FAMILY_LOGINS) {
      for (const tokenFlow of FAMILY_TOKEN_FLOWS) {
        for (const rotateTokens of [true, false]) {
          const label = `${login} × ${tokenFlow}${rotateTokens ? "" : " (no token rotation)"}`;
          const cpe = createCpeFamily({ login, tokenFlow, rotateTokens });
          const client = clientFor(cpe);
          const other = clientFor(cpe);
          const outcome = await client.withSessionDetailed(async (session) => {
            const model = getXmlTag(await session.get("/api/device/information"), "DeviceName");
            await session.postXml("/api/net/reconnect", { reconnect_action: 1 });
            await session.postXml("/api/net/reconnect", { reconnect_action: 1 });
            const polite = await other.withSessionDetailed(async () => "never");
            const forced = await other.withSessionDetailed(async () => "never", { respectBrowserSession: false, retriesOnOccupied: 0 }).then(
              () => null,
              (err: unknown) => (err instanceof CpeApiError ? err.code : String(err))
            );
            return { model, facts: [session.loginScheme, session.tokenFlow, session.eccVerified], polite: polite.status, forced };
          });
          assert.equal(outcome.status, "ok", label);
          assert.deepEqual(outcome.status === "ok" ? outcome.value : null, {
            model: "H122-373",
            facts: [SCHEME[login], FLOW[tokenFlow], login === "scram-ecc"],
            polite: "yielded",
            forced: "108003",
          }, label);
          assert.deepEqual([cpe.stats.writes.length, cpe.stats.tokenRejections, cpe.stats.staleSessionRequests], [2, 0, 0], label);
          assert.deepEqual([cpe.stats.logins, cpe.stats.logouts, cpe.isSlotTaken(), cpe.stats.overlapLoginAttempts], [1, 1, false, 1], label);
          assert.equal(cpe.failedLogins(), 0, `${label}: the refused second session spent no attempt`);
        }
      }
    }
  });

  it("submits a wrong password exactly once with one method, then trips the breaker for every method", async () => {
    for (const login of FAMILY_LOGINS) {
      for (const tokenFlow of FAMILY_TOKEN_FLOWS) {
        const label = `${login} × ${tokenFlow}`;
        const cpe = createCpeFamily({ login, tokenFlow });
        const client = clientFor(cpe, "not the password");
        await assert.rejects(client.withSession(async () => "never"), (err: unknown) => err instanceof CpeApiError && err.code === "108006", label);
        const sent = cpe.stats.requests.length;
        await assert.rejects(client.withSession(async () => "never"), CpeApiError, label);
        assert.equal(cpe.stats.requests.length, sent, `${label}: the latched breaker sends nothing`);
        assert.deepEqual([cpe.stats.passwordSubmissions, submissions(cpe), cpe.failedLogins()], [1, 1, 1], `${label}: one submission`);
        const other = login === "sha256" || login === "base64" ? "/api/user/authentication_login" : "/api/user/login";
        assert.equal(cpe.count(other), 0, `${label}: no second method with the same password`);
        assert.deepEqual([client.getCircuitBreakerState().code, client.getCircuitBreakerState().remainCount], ["108006", 2], label);
        assert.equal(cpe.isSlotTaken(), false, label);
      }
    }
  });

  it("falls back to legacy SHA-256 only on a refused SCRAM probe, which costs no attempt", async () => {
    for (const scramProbe of ["100002", "100003", "not-a-challenge"] as const) {
      for (const probeRotatesToken of [false, true]) {
        for (const tokenFlow of FAMILY_TOKEN_FLOWS) {
          const label = `${scramProbe}${probeRotatesToken ? " + token" : ""} × ${tokenFlow}`;
          const cpe = createCpeFamily({ login: "sha256", tokenFlow, scramProbe, probeRotatesToken });
          assert.equal(await clientFor(cpe).withSession(async (session) => session.loginScheme), "sha256", label);
          assert.deepEqual([cpe.stats.scramProbes, cpe.stats.passwordSubmissions, cpe.failedLogins(), cpe.stats.tokenRejections], [1, 1, 0, 0], label);
          const tokenGets = cpe.count(tokenFlow === "token" ? "/api/webserver/token" : "/api/webserver/SesTokInfo");
          assert.equal(tokenGets, probeRotatesToken ? 1 : 2, `${label}: the hash uses the token in the probe's answer, else a fresh one`);

          const wrong = createCpeFamily({ login: "sha256", tokenFlow, scramProbe, probeRotatesToken });
          await assert.rejects(clientFor(wrong, "a wrong guess").withSession(async () => "never"), CpeApiError, label);
          assert.deepEqual([wrong.stats.scramProbes, wrong.stats.passwordSubmissions, wrong.failedLogins()], [1, 1, 1], label);
        }
      }
    }
  });

  it("never falls back on other probe answers, and sends no password for an unknown password_type", async () => {
    const html = createCpeFamily({ login: "sha256", tokenFlow: "token" });
    const htmlClient = new HuaweiCpeClient({ cpeUrl: "http://192.168.8.1", cpePassword: html.password, fetchImpl: answerWith(html, "/api/user/challenge_login", () => "<!DOCTYPE html><html><body>login</body></html>") });
    await assert.rejects(htmlClient.withSession(async () => "never"), /Invalid SCRAM challenge response/);
    assert.deepEqual([submissions(html), html.isSlotTaken(), htmlClient.getCircuitBreakerState().tripped], [0, false, false], "an HTML page is no router answer");

    const busy = createCpeFamily({ login: "sha256", tokenFlow: "token" });
    const busyClient = new HuaweiCpeClient({ cpeUrl: "http://192.168.8.1", cpePassword: busy.password, fetchImpl: answerWith(busy, "/api/user/challenge_login", () => "<error><code>108003</code></error>") });
    assert.equal(await busyClient.withSession(async () => "never"), null, "108003 on the probe yields, it does not fall back");
    assert.equal(submissions(busy), 0);

    const odd = createCpeFamily({ login: "sha256", tokenFlow: "token" });
    const oddClient = new HuaweiCpeClient({ cpeUrl: "http://192.168.8.1", cpePassword: odd.password, fetchImpl: answerWith(odd, "/api/user/challenge_login", () => "<error><code>108006</code></error>") });
    await assert.rejects(oddClient.withSession(async () => "never"), CpeApiError);
    assert.deepEqual([submissions(odd), oddClient.getCircuitBreakerState().code], [0, "108006"], "a login error on the probe latches without a submission");

    for (const passwordType of [null, "1", "9"]) {
      const cpe = createCpeFamily({ login: "base64", tokenFlow: "sestokinfo", passwordType });
      await assert.rejects(clientFor(cpe).withSession(async () => "never"), (err: unknown) => err instanceof CpeLoginMethodError && err.passwordType === passwordType && err.probeCode === "100002");
      assert.deepEqual([cpe.stats.scramProbes, cpe.stats.passwordSubmissions, cpe.isSlotTaken()], [1, 0, false], String(passwordType));
      const scram = createCpeFamily({ login: "scram", tokenFlow: "token", passwordType });
      assert.equal(await clientFor(scram).withSession(async (session) => session.loginScheme), "scram", `a SCRAM challenge that works settles it (${String(passwordType)})`);
    }
    const typeThree = createCpeFamily({ login: "base64", tokenFlow: "token", passwordType: "3" });
    assert.equal(await clientFor(typeThree).withSession(async (session) => session.loginScheme), "base64");
    assert.deepEqual([typeThree.stats.scramProbes, typeThree.stats.passwordSubmissions], [0, 1], "password_type 3 logs in with base64 and no probe");
  });

  it("never sends a legacy password to a router that logged in with SCRAM before (the H168-383 stays as it is)", async () => {
    let fault: StrictFault | undefined;
    const cpe = createStrictCpe({ fault: (p) => (p === "/api/user/challenge_login" ? fault : undefined) });
    const client = clientFor(cpe);
    assert.equal(client.knownLoginScheme, null);
    assert.equal(await client.withSession(async (session) => session.loginScheme), "scram");
    assert.equal(client.knownLoginScheme, "scram");
    fault = { cpeError: "100002" };
    await assert.rejects(client.withSession(async () => "never"), (err: unknown) => err instanceof CpeApiError && err.code === "100002");
    fault = { body: "<response>OK</response>" };
    await assert.rejects(client.withSession(async () => "never"), /Invalid SCRAM challenge response/);
    assert.deepEqual([cpe.count("/api/user/login"), cpe.failedLogins(), client.getCircuitBreakerState().tripped], [0, 0, false]);

    // The pin survives a restart through the stored identification, and is seeded by a saved test
    fault = undefined;
    const first = coreFixture(cpe);
    let probe: DeviceProbeResult | null = null;
    try {
      probe = (await first.core.scheduler.testConnectionDetailed(first.good)).probe;
    } finally {
      await first.cleanup();
    }
    assert.ok(probe);
    const restarted = coreFixture(cpe, { deviceProbe: probe });
    try {
      assert.equal(restarted.client.knownLoginScheme, "scram", "read back from the stored identification");
      fault = { cpeError: "100003" };
      await assert.rejects(restarted.core.monitor.refreshTelemetry(), CpeApiError);
      assert.equal(cpe.count("/api/user/login"), 0);
      fault = undefined;
      await restarted.core.scheduler.applyConnection({ url: "http://192.168.8.1", username: "admin", password: cpe.password }, { loginScheme: "sha256" });
      assert.equal(restarted.client.knownLoginScheme, "sha256", "a saved connection takes the scheme its test found");
    } finally {
      await restarted.cleanup();
    }
    const odd = coreFixture(cpe, { deviceProbe: { ...probe, identity: { ...probe.identity, loginScheme: "teleport" as never } } });
    assert.equal(odd.client.knownLoginScheme, null, "an unreadable stored scheme pins nothing");
    await odd.cleanup();
  });

  it("tests a connection with each method: model, login method, token flow and encryption in the result", async () => {
    for (const login of FAMILY_LOGINS) {
      for (const tokenFlow of FAMILY_TOKEN_FLOWS) {
        const label = `${login} × ${tokenFlow}`;
        const cpe = createCpeFamily({ login, tokenFlow });
        const fx = coreFixture(cpe);
        try {
          const { result, probe } = await fx.core.scheduler.testConnectionDetailed(fx.good);
          assert.deepEqual(result.ok ? { ...result, holdMs: 0 } : result, {
            ok: true,
            holdMs: 0,
            model: "H122-373",
            firmware: "10.0.2.1(H195SP3C983)",
            loginScheme: SCHEME[login],
            tokenFlow: FLOW[tokenFlow],
            ecc: login === "scram-ecc",
          }, label);
          assert.deepEqual([probe?.identity.loginScheme, probe?.identity.tokenFlow, probe?.identity.ecc], [SCHEME[login], FLOW[tokenFlow], login === "scram-ecc"], label);
          assert.deepEqual([cpe.stats.passwordSubmissions, cpe.isSlotTaken()], [1, false], label);
        } finally {
          await fx.cleanup();
        }
      }
    }
    const unknown = createCpeFamily({ login: "base64", tokenFlow: "token", passwordType: null });
    const fx = coreFixture(unknown);
    try {
      const result = await fx.core.scheduler.testConnection(fx.good);
      assert.deepEqual(result.ok ? null : [result.reason, result.code], ["unsupported_login", "100002"]);
      assert.match(result.ok ? "" : result.message, /no password was sent/);
      assert.equal(unknown.stats.passwordSubmissions, 0);
    } finally {
      await fx.cleanup();
    }
  });

  it("asks for the last-attempt confirmation and honours lockstatus with every method", async () => {
    for (const login of FAMILY_LOGINS) {
      const tokenFlow: FamilyTokenFlow = login === "base64" || login === "scram" ? "sestokinfo" : "token";
      const cpe = createCpeFamily({ login, tokenFlow });
      const fx = coreFixture(cpe);
      try {
        const first = await fx.core.scheduler.testConnection({ ...fx.good, password: "typo" });
        const second = await fx.core.scheduler.testConnection({ ...fx.good, password: "typo again" });
        assert.deepEqual([first, second].map((r) => (r.ok ? null : [r.reason, r.remainCount])), [["wrong_password", 2], ["wrong_password", 1]], login);
        const guarded = await fx.core.scheduler.testConnection({ ...fx.good, password: "third guess" });
        assert.deepEqual(guarded.ok ? null : [guarded.reason, guarded.remainCount], ["last_attempt", 1], login);
        assert.equal(cpe.stats.passwordSubmissions, 2, `${login}: the last attempt is not spent without a confirmation`);
        const locked = await fx.core.scheduler.testConnection({ ...fx.good, password: "third guess" }, { lastAttempt: true });
        assert.deepEqual(locked.ok ? null : [locked.reason, locked.code, locked.waitTimeSec], ["locked", "108007", 600], login);
        assert.equal(cpe.isLocked(), true);

        // Locked: lockstatus=1 in state-login stops every method before it sends a password
        const sent = cpe.stats.passwordSubmissions;
        const again = await fx.core.scheduler.testConnection(fx.good, { lastAttempt: true });
        assert.deepEqual(again.ok ? null : again.reason, "locked", login);
        await assert.rejects(fx.core.monitor.refreshTelemetry(), CircuitBreakerOpenError);
        assert.equal(await fx.core.monitor.refreshTelemetry(), null, `${login}: latched, the poll is skipped`);
        assert.equal(cpe.stats.passwordSubmissions, sent, `${login}: no submission while locked`);
      } finally {
        await fx.cleanup();
      }
    }
  });

  it("latches on 115002 (the router wants its password changed) and names it", async () => {
    const cpe = createCpeFamily({ login: "base64", tokenFlow: "token" });
    const fetchImpl = answerWith(cpe, "/api/user/login", () => "<error><code>115002</code><message></message></error>");
    const fx = coreFixture({ fetchImpl, password: cpe.password });
    try {
      const result = await fx.core.scheduler.testConnection(fx.good);
      assert.deepEqual(result.ok ? null : [result.reason, result.code], ["password_change_required", "115002"]);
      await assert.rejects(fx.core.monitor.refreshTelemetry(), (err: unknown) => err instanceof CircuitBreakerOpenError && err.code === "115002");
      const sent = cpe.stats.requests.length;
      assert.equal(await fx.core.monitor.refreshTelemetry(), null);
      assert.equal(cpe.stats.requests.length, sent, "no automatic retry");
      assert.equal(new CpeApiError("115002").isPasswordChangeRequired, true);
    } finally {
      await fx.cleanup();
    }
  });

  it("stops after an answer to a legacy password it cannot place, and retries only codes refused before the password check", async () => {
    for (const code of ["100001", "108008", "113018"]) {
      const cpe = createCpeFamily({ login: "sha256", tokenFlow: "token" });
      const fx = coreFixture({ fetchImpl: answerWith(cpe, "/api/user/login", () => `<error><code>${code}</code><message></message></error>`), password: cpe.password });
      try {
        await assert.rejects(fx.core.monitor.refreshTelemetry(), (err: unknown) => err instanceof CircuitBreakerOpenError && err.code === code, code);
        const sent = cpe.stats.requests.length;
        assert.equal(await fx.core.monitor.refreshTelemetry(), null, code);
        assert.equal(cpe.stats.requests.length, sent, `${code}: no second submission`);
        assert.equal(cpe.count("/api/user/login"), 1);
        const result = await fx.core.scheduler.testConnection(fx.good);
        assert.deepEqual(result.ok ? null : [result.reason, result.code, result.remainCount], ["unconfirmed_login", code, null], `${code}: not called a wrong password`);
      } finally {
        await fx.cleanup();
      }
    }
    for (const code of ["125001", "125002", "100003", "108010"]) {
      const cpe = createCpeFamily({ login: "base64", tokenFlow: "token" });
      const fx = coreFixture({ fetchImpl: answerWith(cpe, "/api/user/login", () => `<error><code>${code}</code><message></message></error>`), password: cpe.password });
      try {
        await assert.rejects(fx.core.monitor.refreshTelemetry(), (err: unknown) => err instanceof CpeApiError && !(err instanceof CircuitBreakerOpenError), code);
        assert.equal(fx.core.scheduler.isCircuitTripped(), false, `${code} is refused before the password check`);
      } finally {
        await fx.cleanup();
      }
    }
    // SCRAM keeps the H168-383's verified handling: an odd code after the proof is no latch
    const strict = createStrictCpe({ fault: (p) => (p === "/api/user/authentication_login" ? { cpeError: "100001" } : undefined) });
    const scram = clientFor(strict);
    await assert.rejects(scram.withSession(async () => "never"), CpeApiError);
    assert.equal(scram.getCircuitBreakerState().tripped, false);
  });

  it("latches after a legacy answer that is neither OK nor an error code, and not when no password went out (R1-01)", async () => {
    const unplaceable: Readonly<Record<string, () => string>> = {
      "a response that is not OK": () => "<response>error</response>",
      "an HTML page": () => "<!DOCTYPE html><html><body>login</body></html>",
      "an empty body": () => "",
      "a cut-off wrong-password answer": () => "<error><code>1080",
      "an oversized body": () => `<response>${"x".repeat(MAX_XML_BYTES)}</response>`,
    };
    for (const [label, body] of Object.entries(unplaceable)) {
      for (const login of ["sha256", "base64"] as const) {
        const cpe = createCpeFamily({ login, tokenFlow: "token" });
        const fx = coreFixture({ fetchImpl: answerWith(cpe, "/api/user/login", body), password: cpe.password });
        try {
          // The router may have counted it as a wrong attempt: one submission, then nothing
          await assert.rejects(fx.core.monitor.refreshTelemetry(), (err: unknown) => err instanceof CircuitBreakerOpenError && err.code === LOGIN_UNCONFIRMED_CODE, `${label} × ${login}`);
          const sent = cpe.stats.requests.length;
          assert.equal(await fx.core.monitor.refreshTelemetry(), null, `${label} × ${login}`);
          assert.deepEqual([cpe.stats.requests.length, cpe.count("/api/user/login")], [sent, 1], `${label} × ${login}: no second submission`);
          const result = await fx.core.scheduler.testConnection(fx.good);
          assert.deepEqual(result.ok ? null : [result.reason, result.code], ["unconfirmed_login", null], `${label} × ${login}`);
        } finally {
          await fx.cleanup();
        }
      }
    }

    // The token for user/login could not be had, so no password went out: nothing to latch on
    const tokenless = createCpeFamily({ login: "base64", tokenFlow: "token" });
    const fx = coreFixture({ fetchImpl: answerWith(tokenless, "/api/webserver/token", () => "<error><code>100001</code><message></message></error>"), password: tokenless.password });
    try {
      await assert.rejects(fx.core.monitor.refreshTelemetry(), (err: unknown) => err instanceof CpeApiError && !(err instanceof CircuitBreakerOpenError));
      assert.deepEqual([tokenless.count("/api/user/login"), fx.core.scheduler.isCircuitTripped()], [0, false]);
    } finally {
      await fx.cleanup();
    }

    // No answer at all (the connection failed): like a SCRAM login, the next session may try again
    const lost = createCpeFamily({ login: "sha256", tokenFlow: "token" });
    const dropping: typeof fetch = async (input, init) => {
      if (new URL(String(input)).pathname === "/api/user/login") throw new TypeError("fetch failed", { cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) });
      return await lost.fetchImpl(input, init);
    };
    const client = clientFor({ fetchImpl: dropping, password: lost.password });
    await assert.rejects(client.withSession(async () => "never"), /\/api\/user\/login/);
    assert.equal(client.getCircuitBreakerState().tripped, false);
  });

  it("needs the router to confirm a login (SCRAM server signature, legacy OK) and logs out one it did not", async () => {
    const cpe = createStrictCpe();
    const stripped: typeof fetch = async (input, init) => {
      const res = await cpe.fetchImpl(input, init);
      if (!String(input).endsWith("/api/user/authentication_login")) return res;
      const body = (await res.text()).replace(/<serversignature>[^<]*<\/serversignature>/, "");
      return new Response(body, { status: res.status, headers: res.headers });
    };
    const client = new HuaweiCpeClient({ cpeUrl: "http://192.168.8.1", cpePassword: cpe.password, fetchImpl: stripped });
    await assert.rejects(client.withSession(async () => "never"), /server signature missing/);
    assert.deepEqual([cpe.stats.logins, cpe.stats.logouts, cpe.isSlotTaken(), client.getCircuitBreakerState().tripped], [1, 1, false, false]);

    // A legacy login answer that is not OK may still have logged in, or may have been a wrong attempt: logged out and latched (R1-01)
    const legacy = createCpeFamily({ login: "base64", tokenFlow: "token" });
    const unsure = new HuaweiCpeClient({ cpeUrl: "http://192.168.8.1", cpePassword: legacy.password, fetchImpl: answerWith(legacy, "/api/user/login", () => "<response>maybe</response>") });
    await assert.rejects(unsure.withSession(async () => "never"), (err: unknown) => err instanceof CpeApiError && err.code === LOGIN_UNCONFIRMED_CODE && /neither OK nor an error code/.test(err.message));
    assert.deepEqual([legacy.count("/api/user/logout", "POST"), unsure.getCircuitBreakerState().tripped], [1, true]);
  });

  it("keeps legacy sessions off the encrypted channel and their cookie off SesInfo rewrites", async () => {
    const legacy = createCpeFamily({ login: "sha256", tokenFlow: "token" });
    await assert.rejects(
      clientFor(legacy).withSession((session) => session.postEncrypted("/api/sms/sms-list-contact", { pageindex: 1 }, 1)),
      /no encrypted channel/
    );
    assert.deepEqual([legacy.count("/api/webserver/publickey"), legacy.stats.writes.length, legacy.isSlotTaken()], [0, 0, false]);

    const ecc = createCpeFamily({ login: "scram-ecc", tokenFlow: "sestokinfo" });
    const echoed = await clientFor(ecc).withSession((session) => session.postEncrypted("/api/net/reconnect", { reconnect_action: 1 }, 1));
    assert.equal(echoed, "<response>OK</response>", "the verified ECC channel of a SCRAM login works");

    // After the login, every SesTokInfo answer names a different SessionID: it must not replace the cookie
    const ses = createCpeFamily({ login: "base64", tokenFlow: "sestokinfo", rotateTokens: false });
    let rewrites = 0;
    const rewriting: typeof fetch = async (input, init) => {
      const res = await ses.fetchImpl(input, init);
      if (!String(input).endsWith("/api/webserver/SesTokInfo") || !new Headers(init?.headers).get("cookie")) return res;
      rewrites += 1;
      return new Response((await res.text()).replace(/SessionID=[0-9a-f]+/, "SessionID=0000"), { status: res.status, headers: res.headers });
    };
    const client = new HuaweiCpeClient({ cpeUrl: "http://192.168.8.1", cpePassword: ses.password, fetchImpl: rewriting });
    await client.withSession(async (session) => {
      await session.postXml("/api/net/reconnect", { reconnect_action: 1 });
      await session.postXml("/api/net/reconnect", { reconnect_action: 1 });
    });
    assert.ok(rewrites >= 2, "tokens were fetched again after the login");
    assert.deepEqual([ses.stats.writes.length, ses.stats.staleSessionRequests, ses.stats.logouts], [2, 0, 1], "the session cookie stayed the router's");
  });
});
