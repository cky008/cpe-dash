import assert from "node:assert/strict";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { CERTIFICATE_CHANGED, createRouterFetch, peekCertificate } from "../src/pinned-fetch.ts";
import { LanHttp } from "../src/protocols/transport.ts";
import { CertificateTrust, formatFingerprint, normalizeFingerprint } from "../src/router-trust.ts";
import { CpeTransportError } from "../src/session-errors.ts";
import { selfSignedCertificate } from "./helpers/self-signed.ts";

/**
 * A router whose page is HTTPS with a certificate it signed itself, as a TLS server on the loopback
 * address with a certificate made for the test. FengSui talks to it only where its owner trusted
 * that certificate, and only while the router presents the same one.
 */

const OTHER = "AB".repeat(32);

describe("a certificate trusted by its fingerprint", () => {
  it("keeps a fingerprint as 64 upper-case digits, however it was typed", () => {
    const typed = "ab:cd:".repeat(16).slice(0, -1);
    assert.equal(normalizeFingerprint(typed), "ABCD".repeat(16));
    assert.equal(normalizeFingerprint(` ${"ab cd ".repeat(16)}`), "ABCD".repeat(16));
    assert.deepEqual([normalizeFingerprint("abcd"), normalizeFingerprint(`${"AB".repeat(32)}0`), normalizeFingerprint("zz".repeat(32)), normalizeFingerprint(42), normalizeFingerprint("a".repeat(400))], [null, null, null, null, null]);
    assert.equal(formatFingerprint("ABCD".repeat(16)), "AB:CD:".repeat(16).slice(0, -1));
  });

  it("names the fingerprint of the router in use, and of a candidate for the length of its test", async () => {
    const trust = new CertificateTrust();
    assert.equal(trust.fingerprintFor("https://192.168.8.1"), null);
    trust.use("https://192.168.8.1/", OTHER);
    assert.deepEqual([trust.fingerprintFor("https://192.168.8.1"), trust.fingerprintFor("https://192.168.8.1:8443"), trust.fingerprintFor("http://192.168.8.1")], [OTHER, null, null]);
    const tried = await trust.during("https://192.168.0.1", "CD".repeat(32), async () => [trust.fingerprintFor("https://192.168.0.1"), trust.fingerprintFor("https://192.168.8.1")]);
    assert.deepEqual(tried, ["CD".repeat(32), OTHER]);
    assert.equal(trust.fingerprintFor("https://192.168.0.1"), null, "a test's trust ends with the test");
    // A candidate without a fingerprint gets the usual verification, even at the address in use
    assert.equal(await trust.during("https://192.168.8.1", null, async () => trust.fingerprintFor("https://192.168.8.1")), null);
    await assert.rejects(trust.during("https://192.168.8.1", null, () => Promise.reject(new Error("the test failed"))), /the test failed/);
    assert.equal(trust.fingerprintFor("https://192.168.8.1"), OTHER);
    assert.equal(await trust.during("http://192.168.8.1", OTHER, async () => "plain"), "plain", "nothing to trust on an address that is not HTTPS");
    trust.use("http://192.168.8.1", OTHER);
    assert.equal(trust.fingerprintFor("http://192.168.8.1"), null);
    trust.use("https://192.168.8.1", null);
    assert.equal(trust.fingerprintFor("https://192.168.8.1"), null);
    trust.use("not a url", OTHER);
    assert.equal(trust.fingerprintFor("https://192.168.8.1"), null);
  });
});

describe("requests to a router with a certificate of its own", () => {
  const identity = selfSignedCertificate("192.168.8.1");
  let server: https.Server;
  let origin = "";
  const seen: Array<{ method: string; url: string; headers: Record<string, string | string[] | undefined>; body: string }> = [];

  before(async () => {
    server = https.createServer({ key: identity.key, cert: identity.cert }, (req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
        if (req.url === "/redirect") return void res.writeHead(302, { Location: "https://203.0.113.10/" }).end();
        if (req.url === "/nothing") return void res.writeHead(204).end();
        if (req.url === "/huge") return void res.writeHead(200).end(Buffer.alloc(9 * 1024 * 1024, 0x61));
        if (req.url === "/slow") return void setTimeout(() => res.writeHead(200).end("late"), 2000).unref();
        res.writeHead(200, { "Content-Type": "text/xml", "Set-Cookie": ["SessionID=abc; HttpOnly; Secure", "lang=en; Secure"] }).end("<response>OK</response>");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  const trusting = (fingerprint: string | null): { fetchImpl: typeof fetch; plain: string[] } => {
    const trust = new CertificateTrust();
    trust.use(origin, fingerprint);
    const plain: string[] = [];
    const fetchImpl = createRouterFetch(trust, async (input) => {
      plain.push(String(input));
      return new Response("plain");
    });
    return { fetchImpl, plain };
  };
  const causeOf = (err: unknown): { code?: string; message?: string } => (err instanceof TypeError && err.cause && typeof err.cause === "object" ? (err.cause as { code?: string; message?: string }) : {});

  it("sends a request once the router presented the trusted certificate, and reads the answer whole", async () => {
    const { fetchImpl, plain } = trusting(identity.fingerprint256);
    seen.length = 0;
    const res = await fetchImpl(`${origin}/api/webserver/token?a=1`, { headers: { "X-Requested-With": "XMLHttpRequest", Cookie: "SessionID=old" } });
    assert.deepEqual([res.status, await res.text(), res.headers.get("content-type"), res.headers.getSetCookie()], [200, "<response>OK</response>", "text/xml", ["SessionID=abc; HttpOnly; Secure", "lang=en; Secure"]]);
    const posted = await fetchImpl(new URL(`${origin}/api/user/login`), { method: "POST", body: "<request>x</request>", headers: { "Content-Type": "text/xml" } });
    assert.equal(posted.status, 200);
    await fetchImpl(`${origin}/goform/set`, { method: "POST", body: new URLSearchParams({ goformId: "LOGIN", isTest: "false" }) });
    await fetchImpl(`${origin}/bytes`, { method: "POST", body: new Uint8Array([104, 105]) });
    assert.deepEqual(seen.map((r) => [r.method, r.url, r.body]), [
      ["GET", "/api/webserver/token?a=1", ""],
      ["POST", "/api/user/login", "<request>x</request>"],
      ["POST", "/goform/set", "goformId=LOGIN&isTest=false"],
      ["POST", "/bytes", "hi"],
    ]);
    assert.deepEqual([seen[0]?.headers["x-requested-with"], seen[0]?.headers["cookie"], seen[0]?.headers["host"], seen[0]?.headers["connection"]], ["XMLHttpRequest", "SessionID=old", origin.slice(8), "close"]);
    assert.deepEqual([seen[1]?.headers["content-type"], seen[1]?.headers["content-length"], seen[2]?.headers["content-type"]], ["text/xml", "20", "application/x-www-form-urlencoded;charset=UTF-8"]);
    assert.equal((await fetchImpl(`${origin}/nothing`)).status, 204);
    assert.deepEqual(plain, [], "nothing went the usual way");
    await assert.rejects(fetchImpl(`${origin}/form`, { method: "POST", body: new FormData() }), /cannot be sent/);
  });

  it("sends nothing to a router that presents another certificate", async () => {
    const { fetchImpl } = trusting(OTHER);
    seen.length = 0;
    const err = await fetchImpl(`${origin}/api/user/login`, { method: "POST", body: "<request><Password>x</Password></request>" }).catch((e: unknown) => e);
    assert.ok(err instanceof TypeError);
    assert.equal(causeOf(err).code, CERTIFICATE_CHANGED);
    assert.match(causeOf(err).message ?? "", /another certificate/);
    assert.deepEqual(seen, [], "the router saw no request");
    // Through the transport every driver uses: a transport failure with that code
    const http = new LanHttp({ baseUrl: origin, fetchImpl, timeoutMs: 2000, signal: new AbortController().signal });
    await assert.rejects(http.request({ method: "GET", path: "/" }), (failure: unknown) => failure instanceof CpeTransportError && failure.causeCode === CERTIFICATE_CHANGED);
    const good = new LanHttp({ baseUrl: origin, fetchImpl: trusting(identity.fingerprint256).fetchImpl, timeoutMs: 2000, signal: new AbortController().signal });
    assert.deepEqual([(await good.request({ method: "GET", path: "/" })).text, good.cookie("SessionID")], ["<response>OK</response>", "abc"]);
  });

  it("leaves every other request to the usual fetch: an origin nobody trusted by hand, and plain HTTP", async () => {
    const { fetchImpl, plain } = trusting(null);
    assert.equal(await (await fetchImpl(`${origin}/`)).text(), "plain");
    const other = trusting(identity.fingerprint256);
    await other.fetchImpl("http://192.168.8.1/api/x");
    await other.fetchImpl(new Request("https://192.168.0.1/"));
    assert.deepEqual([plain, other.plain], [[`${origin}/`], ["http://192.168.8.1/api/x", "[object Request]"]]);
  });

  it("follows no redirect, gives up on an answer that is no page, and stops when it is told to", async () => {
    const { fetchImpl } = trusting(identity.fingerprint256);
    const refused = await fetchImpl(`${origin}/redirect`, { redirect: "error" }).catch((e: unknown) => e);
    assert.equal(causeOf(refused).message, "unexpected redirect");
    assert.equal(causeOf(await fetchImpl(`${origin}/redirect`).catch((e: unknown) => e)).message, "unexpected redirect", "never followed, whatever the caller left out");
    const manual = await fetchImpl(`${origin}/redirect`, { redirect: "manual" });
    assert.deepEqual([manual.status, manual.headers.get("location")], [302, "https://203.0.113.10/"]);
    assert.match(causeOf(await fetchImpl(`${origin}/huge`).catch((e: unknown) => e)).message ?? "", /too large/);
    const gone = AbortSignal.abort(new Error("the session is over"));
    await assert.rejects(fetchImpl(`${origin}/`, { signal: gone }), /the session is over/);
    const controller = new AbortController();
    const slow = fetchImpl(`${origin}/slow`, { signal: controller.signal });
    setTimeout(() => controller.abort(new Error("out of time")), 50);
    await assert.rejects(slow, /out of time/);
  });

  it("fails like any request when nothing answers", async () => {
    const closed = https.createServer({ key: identity.key, cert: identity.cert });
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const dead = `https://127.0.0.1:${(closed.address() as AddressInfo).port}`;
    await new Promise((resolve) => closed.close(resolve));
    const trust = new CertificateTrust();
    trust.use(dead, identity.fingerprint256);
    const err = await createRouterFetch(trust)(`${dead}/`).catch((e: unknown) => e);
    assert.equal(causeOf(err).code, "ECONNREFUSED");
    assert.equal(await peekCertificate(dead), null);
  });

  it("reads the certificate a router presents without sending a request or trusting it", async () => {
    seen.length = 0;
    const cert = await peekCertificate(`${origin}/index.html`);
    assert.ok(cert);
    assert.deepEqual([cert.fingerprint256, cert.subject, cert.issuer, cert.trusted], [identity.fingerprint256, "CN=192.168.8.1", "CN=192.168.8.1", false]);
    assert.ok(cert.validFrom !== null && cert.validTo !== null && Date.parse(cert.validTo) > Date.parse(cert.validFrom));
    assert.deepEqual(seen, [], "a handshake alone");
    assert.deepEqual([await peekCertificate("http://192.168.8.1"), await peekCertificate("not a url")], [null, null]);
    assert.equal(await peekCertificate(origin, AbortSignal.abort()), null);
  });
});
