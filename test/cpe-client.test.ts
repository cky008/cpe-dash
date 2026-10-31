import assert from "node:assert/strict";
import crypto from "node:crypto";
import { describe, it } from "node:test";
import { CpeApiError, CpeSessionClosedError, type EphemeralCpeSession, HuaweiCpeClient } from "../src/cpe-client.ts";
import { aesGcmDecrypt, aesGcmEncrypt, curve25519Mul } from "../src/crypto.ts";
import { getXmlTag } from "../src/xml.ts";

interface MockCpeOptions {
  password: string;
  loginStateXml?: string;
  failAuthCode?: string;
  occupiedAttempts?: number;
}

function createMockCpeFetch(opts: MockCpeOptions): {
  fetchImpl: typeof fetch;
  calls: Array<{ method: string; path: string; body: string }>;
} {
  const calls: Array<{ method: string; path: string; body: string }> = [];
  const saltHex = "11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff";
  const iterations = 100;
  const serverPriv = BigInt("0x09abcdef0123456789abcdef0123456789abcdef0123456789abcdef01234567");
  const serverPubHex = curve25519Mul(serverPriv, 9n).toString(16);

  let lastFirstNonce = "";
  let lastServerNonce = "";
  let remainingOccupied = opts.occupiedAttempts ?? 0;

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : "";
    const fullPath = `${url.pathname}${url.search}`;
    calls.push({ method, path: fullPath, body });

    const makeXmlRes = (xml: string, extraHeaders: Record<string, string> = {}): Response =>
      new Response(xml, {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          __requestverificationtokenone: "tok_one_0123456789abcdef01234567",
          __requestverificationtokentwo: "tok_two_0123456789abcdef01234567",
          "set-cookie": "SessionID=mock_session_cookie; Path=/; HttpOnly",
          ...extraHeaders,
        },
      });

    if (url.pathname === "/api/user/state-login") {
      return makeXmlRes(
        opts.loginStateXml ??
          `<response><State>-1</State><lockstatus>0</lockstatus><remainwaittime>0</remainwaittime><password_type>4</password_type></response>`
      );
    }

    if (url.pathname === "/api/monitoring/status") {
      return makeXmlRes(`<response><ConnectionStatus>901</ConnectionStatus></response>`);
    }

    if (url.pathname === "/api/webserver/token") {
      return makeXmlRes(
        `<response><token>${"0".repeat(32)}${"a".repeat(32)}</token></response>`
      );
    }

    if (url.pathname === "/api/user/challenge_login") {
      lastFirstNonce = getXmlTag(body, "firstnonce") ?? "";
      lastServerNonce = `${lastFirstNonce}0102030405060708`;
      return makeXmlRes(
        `<response><salt>${saltHex}</salt><iterations>${iterations}</iterations><servernonce>${lastServerNonce}</servernonce></response>`
      );
    }

    if (url.pathname === "/api/user/authentication_login") {
      if (opts.failAuthCode) {
        return makeXmlRes(
          `<error><code>${opts.failAuthCode}</code><remaincount>2</remaincount></error>`
        );
      }
      if (remainingOccupied > 0) {
        remainingOccupied -= 1;
        return makeXmlRes(`<error><code>108003</code><message>occupied</message></error>`);
      }

      const saltedPwd = crypto.pbkdf2Sync(
        Buffer.from(opts.password, "latin1"),
        Buffer.from(saltHex, "hex"),
        iterations,
        32,
        "sha256"
      );
      const serverKey = crypto
        .createHmac("sha256", Buffer.from("Server Key", "utf8"))
        .update(saltedPwd)
        .digest();
      const authMsg = Buffer.from(
        `${lastFirstNonce},${lastServerNonce},${lastServerNonce}`,
        "utf8"
      );
      const serverSig = crypto.createHmac("sha256", authMsg).update(serverKey).digest("hex");
      const pubSig = crypto
        .createHmac("sha256", serverKey)
        .update(Buffer.from(serverPubHex, "hex"))
        .digest("hex");

      return makeXmlRes(
        `<response><serversignature>${serverSig}</serversignature><ecc_server_pubkey>${serverPubHex}</ecc_server_pubkey><ecc_pubkey_signature>${pubSig}</ecc_pubkey_signature></response>`
      );
    }

    if (url.pathname === "/api/device/signal") {
      return makeXmlRes(`<response><band>78</band><rsrp>-80dBm</rsrp><sinr>22dB</sinr></response>`);
    }

    if (url.pathname === "/api/wlan/host-list") {
      const clientPub = url.searchParams.get("ecc-client-pubkey") ?? "";
      const encType = url.searchParams.get("enc-type");
      if (clientPub && encType === "3") {
        const shareHex = curve25519Mul(serverPriv, BigInt(`0x${clientPub}`)).toString(16);
        const decReq = aesGcmDecrypt(body, shareHex);
        assert.ok(decReq.includes("<request>"));
        const respPlain = `<response><Hosts><Host><IpAddress>192.168.8.101</IpAddress></Host></Hosts></response>`;
        return makeXmlRes(aesGcmEncrypt(respPlain, shareHex));
      }
      return makeXmlRes(`<response><Hosts/></response>`);
    }

    if (url.pathname === "/api/user/logout") {
      return makeXmlRes(`<response>OK</response>`);
    }

    return makeXmlRes(`<error><code>100002</code></error>`);
  };

  return { fetchImpl, calls };
}

describe("HuaweiCpeClient ephemeral session, browser avoidance & 108006 circuit breaker", () => {
  it("completes SCRAM + ECDH handshake, decrypts enc-type=3 payloads, and always logs out in finally", async () => {
    const { fetchImpl, calls } = createMockCpeFetch({ password: "unit_password" });
    const client = new HuaweiCpeClient({
      cpeUrl: "http://192.168.8.1",
      cpePassword: "unit_password",
      fetchImpl,
    });

    const data = await client.withSession(async (session) => {
      const sigXml = await session.get("/api/device/signal");
      const hostXml = await session.postEncrypted("/api/wlan/host-list", { Page: 1 }, 3);
      return {
        band: getXmlTag(sigXml, "band"),
        ip: getXmlTag(hostXml, "IpAddress"),
      };
    });

    assert.deepEqual(data, { band: "78", ip: "192.168.8.101" });
    assert.equal(calls.at(-1)?.path, "/api/user/logout");
    const telemetry = client.getTelemetry();
    assert.equal(telemetry.totalSessionsCompleted, 1);
    assert.equal(typeof telemetry.lastSessionHoldMs, "number");
    assert.equal(telemetry.circuitBreaker.tripped, false);
  });

  it("yields immediately when state-login != -1 (human user logged in via browser)", async () => {
    const { fetchImpl, calls } = createMockCpeFetch({
      password: "unit_password",
      loginStateXml: `<response><State>0</State><lockstatus>0</lockstatus></response>`,
    });
    const client = new HuaweiCpeClient({
      cpeUrl: "http://192.168.8.1",
      cpePassword: "unit_password",
      fetchImpl,
    });

    const res = await client.withSession(async () => "should_not_run");
    assert.equal(res, null);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.path, "/api/user/state-login");
    assert.equal(client.getTelemetry().browserYieldCount, 1);
  });

  it("trips and latches the anti-brute-force circuit breaker on 108006 without retrying", async () => {
    const { fetchImpl, calls } = createMockCpeFetch({
      password: "wrong_password",
      failAuthCode: "108006",
    });
    const client = new HuaweiCpeClient({
      cpeUrl: "http://192.168.8.1",
      cpePassword: "wrong_password",
      fetchImpl,
    });

    await assert.rejects(
      () => client.withSession(async () => "fail"),
      (err: unknown) => err instanceof CpeApiError && err.code === "108006"
    );

    const callsAfterFirst = calls.length;
    assert.equal(client.getCircuitBreakerState().tripped, true);

    // Second call must short-circuit locally with ZERO additional network requests!
    await assert.rejects(
      () => client.withSession(async () => "still_blocked"),
      (err: unknown) => err instanceof CpeApiError && err.code === "108006"
    );
    assert.equal(calls.length, callsAfterFirst);

    client.resetCircuitBreaker();
    assert.equal(client.getCircuitBreakerState().tripped, false);
  });

  it("trips circuit breaker immediately when state-login reports lockstatus=1 (108007)", async () => {
    const { fetchImpl, calls } = createMockCpeFetch({
      password: "unit_password",
      loginStateXml: `<response><State>-1</State><lockstatus>1</lockstatus><remainwaittime>180</remainwaittime></response>`,
    });
    const client = new HuaweiCpeClient({
      cpeUrl: "http://192.168.8.1",
      cpePassword: "unit_password",
      fetchImpl,
    });

    await assert.rejects(
      () => client.withSession(async () => "locked"),
      (err: unknown) => err instanceof CpeApiError && err.code === "108007"
    );
    assert.equal(calls.length, 1);
    assert.equal(client.getCircuitBreakerState().code, "108007");
  });

  it("retries gracefully when 108003 occupied occurs during transient race", async () => {
    const { fetchImpl } = createMockCpeFetch({
      password: "unit_password",
      occupiedAttempts: 1,
    });
    const client = new HuaweiCpeClient({
      cpeUrl: "http://192.168.8.1",
      cpePassword: "unit_password",
      fetchImpl,
    });

    const val = await client.withSession(
      async (s) => getXmlTag(await s.get("/api/device/signal"), "sinr"),
      { retriesOnOccupied: 2, occupiedRetryDelayMs: 5 }
    );
    assert.equal(val, "22dB");
  });

  it("yields null immediately on cross-IP 108003 occupied when respectBrowserSession is true and retriesOnOccupied is omitted", async () => {
    const { fetchImpl } = createMockCpeFetch({
      password: "unit_password",
      occupiedAttempts: 3,
    });
    const client = new HuaweiCpeClient({
      cpeUrl: "http://192.168.8.1",
      cpePassword: "unit_password",
      respectBrowserSession: true,
      fetchImpl,
    });

    const res = await client.withSession(async () => "should_yield_on_108003");
    assert.equal(res, null);
    assert.equal(client.getTelemetry().browserYieldCount, 1);
  });

  it("cancels a session during its occupied-retry wait without another login attempt, and is a no-op when idle", async () => {
    const { fetchImpl, calls } = createMockCpeFetch({ password: "unit_password", occupiedAttempts: 5 });
    const client = new HuaweiCpeClient({
      cpeUrl: "http://192.168.8.1",
      cpePassword: "unit_password",
      respectBrowserSession: false,
      fetchImpl,
    });
    assert.equal(client.abortActiveSession(new Error("nothing running")), false);
    const authAttempts = (): number => calls.filter((c) => c.path.startsWith("/api/user/authentication_login")).length;

    const pending = client.withSession(async () => "never reached", { retriesOnOccupied: 3, occupiedRetryDelayMs: 10_000 });
    while (authAttempts() < 1) await new Promise((resolve) => setTimeout(resolve, 2));
    await new Promise((resolve) => setTimeout(resolve, 10));
    const reason = new Error("daemon stopping");
    assert.equal(client.abortActiveSession(reason), true);
    await assert.rejects(pending, (err: unknown) => err === reason);
    assert.equal(authAttempts(), 1, "no login retry after the cancel");
    assert.equal(await client.waitForIdle(100), true);

    // A cancel during the unauthenticated pre-check never reaches the login endpoints either
    const slow: typeof fetch = async (input, init) => {
      if (String(input).includes("/api/user/state-login")) {
        await new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
      }
      return await fetchImpl(input, init);
    };
    const precheckClient = new HuaweiCpeClient({ cpeUrl: "http://192.168.8.1", cpePassword: "unit_password", fetchImpl: slow });
    const before = calls.length;
    const precheck = precheckClient.withSession(async () => "never reached");
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(precheckClient.abortActiveSession(reason), true);
    await assert.rejects(precheck, (err: unknown) => err === reason);
    assert.equal(calls.length, before, "nothing but the aborted pre-check");
  });

  it("refuses requests on a session that was already logged out, without touching the network", async () => {
    const { fetchImpl, calls } = createMockCpeFetch({ password: "unit_password" });
    const client = new HuaweiCpeClient({ cpeUrl: "http://192.168.8.1", cpePassword: "unit_password", fetchImpl });
    let leaked: EphemeralCpeSession | null = null;
    await client.withSession(async (session) => {
      leaked = session;
    });
    assert.ok(calls.some((c) => c.path.startsWith("/api/user/logout")));
    const callsAfterLogout = calls.length;
    const stale = leaked as EphemeralCpeSession | null;
    assert.ok(stale);
    await assert.rejects(() => stale.get("/api/device/signal"), CpeSessionClosedError);
    await assert.rejects(() => stale.postXml("/api/device/control", { Control: 1 }), CpeSessionClosedError);
    assert.equal(calls.length, callsAfterLogout, "a stale session sends nothing, not even a token request");
  });
});
