import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import type { Duplex } from "node:stream";
import { after, before, describe, it } from "node:test";
import { Cdp, withDeadline } from "../scripts/cdp.ts";

/**
 * The deadlines of the Chrome DevTools driver (scripts/cdp.ts) without a Chrome: a stand-in server on
 * 127.0.0.1 that never finishes the WebSocket handshake, or finishes it and never answers a call.
 * Each wait must fail by itself and say what it was waiting for, so no browser test can hang the gate.
 */

type SocketMode = "silent" | "accept";

/** An error whose message, whole, matches. */
const saying = (pattern: RegExp) => (err: unknown): boolean => err instanceof Error && pattern.test(err.message);

interface StubServer {
  url: string;
  close: () => Promise<void>;
}

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/**
 * A fake DevTools server on 127.0.0.1:0 that either holds the TCP socket without answering the
 * HTTP upgrade ("silent") or completes the WebSocket handshake and never sends a frame ("accept").
 */
async function startStubServer(mode: SocketMode): Promise<StubServer> {
  const sockets = new Set<Duplex>();
  const server = http.createServer();
  server.on("upgrade", (req, socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
    if (mode === "silent") return;
    const rawKey = req.headers["sec-websocket-key"];
    const key = typeof rawKey === "string" ? rawKey : "";
    const accept = crypto.createHash("sha1").update(`${key}${WS_GUID}`).digest("base64");
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "",
        "",
      ].join("\r\n")
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `ws://127.0.0.1:${port}`,
    close: () => {
      for (const socket of sockets) socket.destroy();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function useStubServer(mode: SocketMode): () => string {
  let stub: StubServer | null = null;
  before(
    async () => {
      stub = await startStubServer(mode);
    },
    { timeout: 10_000 }
  );
  after(
    async () => {
      await stub?.close();
    },
    { timeout: 10_000 }
  );
  return () => {
    assert.ok(stub);
    return stub.url;
  };
}

describe("a step with a deadline", () => {
  it("withDeadline resolves with the work when it settles first, and leaves no timer behind", async () => {
    const value = await withDeadline("fast work", 60_000, Promise.resolve(7));
    assert.equal(value, 7);
    const boom = new Error("own failure");
    await assert.rejects(() => withDeadline("failing work", 60_000, Promise.reject(boom)), (err: unknown) => err === boom);
  });

  it("withDeadline rejects with the step's name when the work never settles", async () => {
    await assert.rejects(
      () => withDeadline("the demo daemon", 50, new Promise<void>(() => {})),
      saying(/^timed out after 0\.05 s: the demo daemon$/)
    );
  });
});

describe("connecting to Chrome's DevTools socket", () => {
  const url = useStubServer("silent");

  it("Cdp.connect gives up on a socket that never opens, naming the socket", async () => {
    const target = url();
    await assert.rejects(
      () => Cdp.connect(target, 200),
      saying(/^timed out after 0\.2 s: Chrome's DevTools socket at ws:\/\/127\.0\.0\.1:\d+$/)
    );
  });
});

describe("a DevTools call", () => {
  const url = useStubServer("accept");

  it("Cdp.send gives up on a call Chrome never answers, naming the call", async () => {
    const cdp = await Cdp.connect(url());
    try {
      await assert.rejects(
        () => cdp.send("Target.createTarget", { url: "about:blank" }, undefined, 200),
        saying(/^timed out after 0\.2 s: Chrome's answer to Target\.createTarget$/)
      );
    } finally {
      cdp.close();
    }
  });
});
