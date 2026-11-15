import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import { timingSafeEqualString } from "./constant-time.ts";
import { type CertificateTrust, type RouterCertificate, normalizeFingerprint } from "./router-trust.ts";

/**
 * Requests to a router whose certificate its owner trusted by fingerprint (`src/router-trust.ts`),
 * on Node's own TLS: the daemon's request function for routers. A request to an origin with a trusted
 * fingerprint first completes the TLS handshake, compares the certificate the router presented with
 * the trusted one, and only then sends anything; every other request goes out as before.
 *
 * The fingerprint stands in for the certificate chain, the host name and the dates: a router signs
 * its own certificate, names itself whatever its maker chose and often presents one long expired.
 * What must not change is the certificate itself.
 */

/** A code of FengSui's own in a failed request's cause, beside Node's socket codes. */
export const CERTIFICATE_CHANGED = "FENGSUI_CERT_CHANGED";

/** An answer larger than this is not a router's page. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const HANDSHAKE_TIMEOUT_MS = 10_000;

function failed(message: string, code?: string): TypeError {
  // The shape of a failed `fetch`: callers read the cause's code and message
  return new TypeError("fetch failed", { cause: Object.assign(new Error(message), code === undefined ? {} : { code }) });
}

function aborted(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("This operation was aborted", "AbortError");
}

/** A TLS connection to the router, handshake done, nothing sent yet. The chain is not verified here: the caller decides what it trusts. */
function handshake(url: URL, signal: AbortSignal | null): Promise<tls.TLSSocket> {
  return new Promise<tls.TLSSocket>((resolve, reject) => {
    if (signal?.aborted) return reject(aborted(signal));
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const socket = tls.connect({
      host,
      port: url.port === "" ? 443 : Number(url.port),
      rejectUnauthorized: false,
      ...(net.isIP(host) === 0 ? { servername: host } : {}),
      ALPNProtocols: ["http/1.1"],
      timeout: HANDSHAKE_TIMEOUT_MS,
    });
    const onAbort = (): void => {
      socket.destroy();
      if (signal) reject(aborted(signal));
    };
    const settle = (): void => signal?.removeEventListener("abort", onAbort);
    signal?.addEventListener("abort", onAbort, { once: true });
    socket.once("timeout", () => socket.destroy(Object.assign(new Error("the TLS handshake timed out"), { code: "ETIMEDOUT" })));
    socket.once("error", (err) => {
      settle();
      reject(new TypeError("fetch failed", { cause: err }));
    });
    socket.once("secureConnect", () => {
      settle();
      socket.setTimeout(0);
      resolve(socket);
    });
  });
}

function bodyOf(body: RequestInit["body"]): Buffer | null {
  if (body === undefined || body === null) return null;
  if (typeof body === "string") return Buffer.from(body, "utf8");
  if (body instanceof URLSearchParams) return Buffer.from(body.toString(), "utf8");
  if (body instanceof Uint8Array) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  throw new TypeError("This request body cannot be sent to a router trusted by its certificate");
}

/** One HTTP/1.1 request over a connection whose certificate was checked. */
function send(socket: tls.TLSSocket, url: URL, init: RequestInit): Promise<Response> {
  const signal = init.signal ?? null;
  return new Promise<Response>((resolve, reject) => {
    if (signal?.aborted) {
      socket.destroy();
      return reject(aborted(signal));
    }
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, name) => {
      headers[name] = value;
    });
    const body = bodyOf(init.body);
    if (init.body instanceof URLSearchParams && headers["content-type"] === undefined) headers["content-type"] = "application/x-www-form-urlencoded;charset=UTF-8";
    const req = http.request({
      createConnection: () => socket,
      host: url.hostname,
      method: init.method ?? "GET",
      path: `${url.pathname}${url.search}`,
      // One request per connection, read as it is sent: no stale socket to trip over, no decoding to undo
      headers: { ...headers, host: url.host, connection: "close", "accept-encoding": "identity", ...(body === null ? {} : { "content-length": String(body.length) }) },
    });
    const onAbort = (): void => {
      req.destroy();
      if (signal) reject(aborted(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const fail = (err: unknown): void => {
      signal?.removeEventListener("abort", onAbort);
      socket.destroy();
      reject(err instanceof TypeError ? err : new TypeError("fetch failed", { cause: err }));
    };
    req.once("error", fail);
    req.once("response", (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location !== undefined && (init.redirect ?? "follow") !== "manual") {
        // A router is never followed elsewhere: what `redirect: "error"` makes of it
        res.resume();
        return fail(failed("unexpected redirect"));
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) return fail(failed("the router's answer is too large"));
        chunks.push(chunk);
      });
      res.once("error", fail);
      res.once("end", () => {
        signal?.removeEventListener("abort", onAbort);
        const answer = new Headers();
        for (const [name, value] of Object.entries(res.headers)) {
          for (const one of Array.isArray(value) ? value : value === undefined ? [] : [value]) answer.append(name, one);
        }
        const empty = status === 204 || status === 205 || status === 304 || status < 200;
        resolve(new Response(empty ? null : Buffer.concat(chunks), { status: status >= 200 && status <= 599 ? status : 502, headers: answer }));
      });
    });
    req.end(body ?? undefined);
  });
}

function urlOf(input: Parameters<typeof fetch>[0]): URL {
  return new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
}

/**
 * The daemon's request function for routers: HTTPS requests to an origin `trust` names a fingerprint
 * for go out over a connection whose certificate is that one, and fail before anything is sent when
 * it is another (`CERTIFICATE_CHANGED`); everything else is `plain` (the global `fetch`).
 */
export function createRouterFetch(trust: CertificateTrust, plain: typeof fetch = globalThis.fetch): typeof fetch {
  return async (input, init = {}) => {
    const url = urlOf(input);
    const pinned = url.protocol === "https:" ? trust.fingerprintFor(url.origin) : null;
    if (pinned === null) return await plain(input, init);
    const socket = await handshake(url, init.signal ?? null);
    const presented = normalizeFingerprint(socket.getPeerX509Certificate()?.fingerprint256);
    if (presented === null || !timingSafeEqualString(presented, pinned)) {
      socket.destroy();
      throw failed("the router presented another certificate than the one trusted for it under Settings → Router: nothing was sent", CERTIFICATE_CHANGED);
    }
    return await send(socket, url, init);
  };
}

function isoOf(text: string | undefined): string | null {
  const ms = text === undefined ? Number.NaN : Date.parse(text);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function nameOf(text: string | undefined): string | null {
  const flat = (text ?? "").replace(/[\u0000-\u001f\u007f]+/g, ", ").trim().slice(0, 200);
  return flat === "" ? null : flat;
}

/**
 * The certificate the router at `url` presents, read from a TLS handshake alone: no request is sent,
 * and nothing of the router's is trusted by looking. `null`: not an HTTPS address, or no handshake.
 */
export async function peekCertificate(url: string, signal: AbortSignal | null = null): Promise<RouterCertificate | null> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return null;
  }
  if (target.protocol !== "https:") return null;
  let socket: tls.TLSSocket;
  try {
    socket = await handshake(target, signal);
  } catch {
    return null;
  }
  try {
    const cert = socket.getPeerX509Certificate();
    const fingerprint256 = normalizeFingerprint(cert?.fingerprint256);
    if (cert === undefined || fingerprint256 === null) return null;
    const host = target.hostname.replace(/^\[|\]$/g, "");
    // Vouched for by this machine's certificate authorities, and issued for this address
    const trusted = socket.authorized && (net.isIP(host) === 0 ? cert.checkHost(host) !== undefined : cert.checkIP(host) !== undefined);
    return { fingerprint256, subject: nameOf(cert.subject), issuer: nameOf(cert.issuer), validFrom: isoOf(cert.validFrom), validTo: isoOf(cert.validTo), trusted };
  } finally {
    socket.destroy();
  }
}
