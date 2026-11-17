import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stopFengSuiCore } from "../src/core.ts";
import { DeviceAccess, newWriteCheck } from "../src/device-access.ts";
import { DriverRouterSession } from "../src/drivers/adapter.ts";
import { DriverCpeClient, sessionTransport } from "../src/drivers/client.ts";
import { CounterRates } from "../src/drivers/snapshot.ts";
import type { DriverSession } from "../src/drivers/types.ts";
import { zteGoformProtocol } from "../src/drivers/zte/goform.ts";
import { LanHttp, deadlineSignal } from "../src/protocols/transport.ts";
import { SchedulerStoppedError } from "../src/scheduler.ts";
import { CpeSessionDeadlineError } from "../src/session-errors.ts";
import { type SessionAttempt, SessionClient } from "../src/session-client.ts";
import { DLINK_PASSWORD, DLINK_URL, dlinkRouter } from "./helpers/dlink-router.ts";
import { daemonOn } from "./helpers/driver-daemon.ts";
import type { LanRouterMock } from "./helpers/lan-router.ts";
import { createBrandSmsFixture } from "./helpers/sms-brand-fixture.ts";
import { ZTE_PASSWORD, zteRouter } from "./helpers/zte-goform-router.ts";

/**
 * A session cut short: its deadline passed, or the daemon is stopping. Whatever the work was in the
 * middle of, a request the session owes the router (the connect after a disconnect) still goes out,
 * once, before the logout; and nothing of the work goes out once the session is over. Mock routers
 * only.
 */

const SCAN = '2,"DemoNet","27201",7,1;1,"Three","27202",7,1';

/** Wait until `seen` holds (the mock routers answer within a tick). */
async function until(seen: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400 && !seen(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(seen(), what);
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A transport on a router that answers everything, with the session's own signal to cut it by. */
function transport() {
  const sent: string[] = [];
  let calls = 0;
  const session = new AbortController();
  const fetchImpl: typeof fetch = async (input, init) => {
    calls += 1;
    if (init?.signal?.aborted) throw init.signal.reason;
    sent.push(`${init?.method ?? "GET"} ${new URL(String(input)).pathname}`);
    return new Response("{}", { status: 200 });
  };
  const http = new LanHttp({ baseUrl: "http://192.168.0.1", fetchImpl, timeoutMs: 1000, signal: session.signal });
  return { http, session, sent, calls: (): number => calls };
}

describe("a session's transport: what the session owes, and its end", () => {
  it("sends an owed request once however often it is asked for, and keeps a refusal as its answer", async () => {
    const { http, sent } = transport();
    assert.equal(http.owes, false);
    const connect = http.owe(async () => {
      await http.request({ method: "POST", path: "/connect" });
    });
    assert.equal(http.owes, true, "owed from the moment it is taken on");
    await Promise.all([connect(), connect()]);
    await connect();
    assert.deepEqual(sent, ["POST /connect"]);
    assert.equal(http.owes, false);
    await http.settleOwed();
    assert.deepEqual(sent, ["POST /connect"], "nothing is left for the session's end to send");

    // One the router refused was sent: it is not sent again, by the work or at the session's end
    let tries = 0;
    const refused = http.owe(async () => {
      tries += 1;
      throw new Error("refused by the router");
    });
    await assert.rejects(refused(), /refused by the router/);
    await assert.rejects(refused(), /refused by the router/);
    await http.settleOwed();
    assert.equal(tries, 1);
  });

  it("counts a send that died with the session as not sent, and sends it at the session's end, once", async () => {
    const { http, session, sent } = transport();
    const connect = http.owe(async () => {
      await http.request({ method: "POST", path: "/connect" });
    });
    session.abort(new Error("the deadline passed"));
    await assert.rejects(connect(), /the deadline passed/);
    assert.deepEqual(sent, [], "it never left");
    assert.equal(http.owes, true, "so it is still owed");

    // The session's end: a signal of its own, and what is owed first
    const bound = deadlineSignal(1000);
    http.retarget(bound.signal);
    await http.settleOwed();
    bound.clear();
    assert.deepEqual(sent, ["POST /connect"]);
    // Work that wakes late asks for the same send, not another
    await connect();
    await http.settleOwed();
    assert.deepEqual(sent, ["POST /connect"]);
  });

  it("settles what is owed in the order it was taken on, and never throws", async () => {
    const { http, session, sent } = transport();
    http.owe(async () => {
      await http.request({ method: "POST", path: "/first" });
    });
    http.owe(() => Promise.reject(new Error("the router is gone")));
    http.owe(async () => {
      await http.request({ method: "POST", path: "/third" });
    });
    session.abort(new Error("stopping"));
    const bound = deadlineSignal(1000);
    http.retarget(bound.signal);
    await http.settleOwed();
    bound.clear();
    assert.deepEqual(sent, ["POST /first", "POST /third"]);
  });

  it("waits inside the session only as long as the session lasts", async () => {
    const { http, session } = transport();
    const startedAt = performance.now();
    await http.sleep(20);
    assert.ok(performance.now() - startedAt >= 15);
    const waiting = http.sleep(60_000);
    session.abort(new Error("stopping"));
    await assert.rejects(waiting, /stopping/);
    await assert.rejects(http.sleep(1), /stopping/, "nothing waits in a session that is over");
  });

  it("lets nothing out once the session is over, not even as far as the socket", async () => {
    const { http, sent, calls } = transport();
    await http.request({ method: "GET", path: "/status" });
    http.close();
    await assert.rejects(http.request({ method: "GET", path: "/status" }), /session is over/);
    await assert.rejects(http.request({ method: "POST", path: "/connect" }), /session is over/);
    assert.deepEqual(sent, ["GET /status"]);
    assert.equal(calls(), 1, "no request was handed to fetch after the end");
  });
});

describe("the session client: work that a cut leaves behind", () => {
  /** A protocol whose logout notes when it runs, on a transport of a plain list. */
  function recordingClient(events: string[], sessionMaxHoldMs: number) {
    return new SessionClient<{ name: string }>(
      {
        retryOccupiedLogin: false,
        attempt(): SessionAttempt<{ name: string }> {
          return {
            precheck: () => Promise.resolve(null),
            login: () => Promise.resolve(),
            session: { name: "session" },
            logout: () => {
              events.push("logout");
              return Promise.resolve(1);
            },
          };
        },
      },
      { cpeUrl: "http://192.168.0.1", cpeUsername: "admin", cpePassword: "session_cut_password", sessionMaxHoldMs }
    );
  }

  it("lets work that ends with the cut finish before the logout begins", async () => {
    const events: string[] = [];
    const client = recordingClient(events, 60);
    // Work that waits on the session and cleans up when the wait is cut, as a driver's does
    const cutShort = client.withSession(
      () =>
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => {
            events.push("work unwinding");
            // A few turns of the event loop, as an aborted request and a finally block take
            setTimeout(() => {
              events.push("work ended");
              reject(new Error("cut"));
            }, 20);
          }, 60);
        })
    );
    await assert.rejects(cutShort, CpeSessionDeadlineError);
    assert.deepEqual(events, ["work unwinding", "work ended", "logout"]);
  });

  it("does not wait long for work that never ends: the slot is freed all the same", async () => {
    const events: string[] = [];
    const client = recordingClient(events, 60);
    const startedAt = performance.now();
    await assert.rejects(client.withSession(() => new Promise<never>(() => undefined)), CpeSessionDeadlineError);
    assert.deepEqual(events, ["logout"]);
    assert.ok(performance.now() - startedAt < 1500, "bounded: a hung piece of work never pins the slot");
  });
});

/** The posts a ZTE router took that matter here, in order. */
const zteSteps = (state: { posts: Array<{ goformId: string }> }): string[] => state.posts.map((post) => post.goformId).filter((id) => id.endsWith("_NETWORK") || id === "LOGOUT");

/** After its disconnect the router never says the connection went down: whoever waits for that, waits. */
function neverReportsDown(mock: LanRouterMock, state: { posts: Array<{ goformId: string }> }): void {
  const answer = mock.handler;
  mock.handler = (req) => {
    const between = state.posts.some((post) => post.goformId === "DISCONNECT_NETWORK") && !state.posts.some((post) => post.goformId === "CONNECT_NETWORK");
    if (between && req.method === "GET" && (req.query.get("cmd") ?? "").includes("ppp_status")) return new Promise(() => undefined);
    return answer(req);
  };
}

describe("a driver session: its transport ends with it", () => {
  it("hands the work the session's transport, and closes it once the session has signed out", async () => {
    const { client, state, mock } = zteRouter();
    let kept: LanHttp | null = null;
    await client.withSession(async (session) => {
      kept = sessionTransport(session);
      assert.ok(kept, "a session the client opened has its transport");
      assert.equal(kept.cut.aborted, false);
      assert.equal(kept.owes, false);
    });
    assert.equal(state.loggedIn, false);
    const held = kept as LanHttp | null;
    assert.ok(held);
    // Whoever kept hold of it (work a cut left behind) sends nothing in a session that is over
    const requests = mock.requests.length;
    await assert.rejects(held.request({ method: "GET", path: "/goform/goform_get_cmd_process" }), /session is over/);
    assert.equal(mock.requests.length, requests);
    // A stand-in session no client opened has none: nothing can cut it short
    assert.equal(sessionTransport({} as never), null);
  });

  it("does not let an owed request the router never answers keep the logout from its turn", async () => {
    const { state, mock } = zteRouter();
    const client = new DriverCpeClient({ protocol: zteGoformProtocol, cpeUrl: "http://192.168.0.1", cpePassword: ZTE_PASSWORD, fetchImpl: mock.fetchImpl, requestTimeoutMs: 2000, sessionMaxHoldMs: 150, logoutTimeoutMs: 300 });
    const startedAt = performance.now();
    await assert.rejects(
      client.withSession(async (session) => {
        const http = sessionTransport(session);
        assert.ok(http);
        // Owed, and whatever sends it never comes back
        http.owe(() => new Promise<void>(() => undefined));
        await http.sleep(60_000);
      }),
      CpeSessionDeadlineError
    );
    assert.equal(state.loggedIn, false, "signed out all the same");
    assert.ok(performance.now() - startedAt < 1500, "after half of the logout's time at most");
  });

  it("redials a session no client opened as off, then on, each once, also when the off is refused", async () => {
    const sent: boolean[] = [];
    let refuseOff = false;
    const standIn = {
      family: "zte-goform",
      open: true,
      data: {
        enabled: () => Promise.resolve(null),
        set: (on: boolean): Promise<void> => {
          sent.push(on);
          return !on && refuseOff ? Promise.reject(new Error("refused by the router")) : Promise.resolve();
        },
      },
    } as unknown as DriverSession;
    const session = new DriverRouterSession(standIn, { device: new DeviceAccess({ family: "zte-goform" }), noteRouterModel: () => undefined, readSection: (_section, read) => read(), latestTelemetry: () => null }, new CounterRates());
    const write = { generic: true, lteBands: null, check: newWriteCheck() };
    assert.equal((await session.reconnect(write)).reconnecting, true);
    assert.deepEqual(sent, [false, true]);
    assert.equal(write.check.readback, "pending", "the polls that follow tell whether a new connection came up");
    refuseOff = true;
    sent.length = 0;
    await assert.rejects(session.reconnect({ generic: true, lteBands: null, check: newWriteCheck() }), /refused by the router/);
    assert.deepEqual(sent, [false, true], "connected again all the same, once");
  });
});

describe("zte-goform: a redial cut short between its disconnect and its connect", () => {
  it("sends the connect it owes before signing out when the session's deadline passes, and nothing afterwards", async () => {
    const { state, mock } = zteRouter();
    neverReportsDown(mock, state);
    const fx = daemonOn("zte-goform", mock.fetchImpl, "http://192.168.0.1", ZTE_PASSWORD, "", { connection: { sessionMaxHoldMs: 400 } });
    try {
      await assert.rejects(fx.core.controls.reconnectCellular(), CpeSessionDeadlineError);
      assert.deepEqual(zteSteps(state), ["DISCONNECT_NETWORK", "CONNECT_NETWORK", "LOGOUT"], "connected again, then signed out");
      assert.equal(state.values["ppp_status"], "ppp_connected", "the router is not left offline");
      assert.equal(state.loggedIn, false);
      // The work that was cut is over: nothing of it wakes later and reaches the router
      const requests = mock.requests.length;
      await pause(1300);
      assert.equal(mock.requests.length, requests, "not one request after the session ended");
      assert.deepEqual(zteSteps(state), ["DISCONNECT_NETWORK", "CONNECT_NETWORK", "LOGOUT"]);
    } finally {
      await fx.cleanup();
    }
  });

  it("sends the connect it owes before signing out when the daemon stops in the middle", async () => {
    const { state, mock } = zteRouter();
    neverReportsDown(mock, state);
    const fx = daemonOn("zte-goform", mock.fetchImpl, "http://192.168.0.1", ZTE_PASSWORD, "", { stopGraceMs: 30 });
    try {
      const redialing = assert.rejects(fx.core.controls.reconnectCellular(), SchedulerStoppedError);
      await until(() => state.posts.some((post) => post.goformId === "DISCONNECT_NETWORK"), "the disconnect went out");
      await stopFengSuiCore(fx.core);
      await redialing;
      assert.deepEqual(zteSteps(state), ["DISCONNECT_NETWORK", "CONNECT_NETWORK", "LOGOUT"]);
      assert.equal(state.values["ppp_status"], "ppp_connected");
    } finally {
      await fx.cleanup();
    }
  });

  it("connects again as well when a search for networks, made with the connection down, is cut by a stop", async () => {
    // A search that never ends: the router's page waits for it with the connection down
    const { state, mock } = zteRouter({ operators: { scan: SCAN, busy: 100_000 } });
    const fx = daemonOn("zte-goform", mock.fetchImpl, "http://192.168.0.1", ZTE_PASSWORD, "", { stopGraceMs: 30 });
    try {
      const searching = assert.rejects(fx.core.controls.scanOperators({ confirm: true }), SchedulerStoppedError);
      await until(() => state.posts.some((post) => post.goformId === "SCAN_NETWORK"), "the search began, with the connection down");
      assert.equal(state.values["ppp_status"], "ppp_disconnected");
      await stopFengSuiCore(fx.core);
      await searching;
      assert.deepEqual(zteSteps(state), ["DISCONNECT_NETWORK", "SCAN_NETWORK", "CONNECT_NETWORK", "LOGOUT"]);
      assert.equal(state.values["ppp_status"], "ppp_connected");
    } finally {
      await fx.cleanup();
    }
  });
});

describe("d-link: a restart of the data connection cut short", () => {
  it("sends the connect it owes before signing out when the daemon stops between the two", async () => {
    const { state, writes, mock } = dlinkRouter({ autoConnect: false });
    // After the disconnect the router's status never answers: the restart waits for the connection to go down
    const answer = mock.handler;
    mock.handler = (req) => {
      const between = writes.some((write) => write["CfgType"] === "connect_btn" && write["connect"] === 0) && !writes.some((write) => write["CfgType"] === "connect_btn" && write["connect"] === 1);
      if (between && req.method === "GET" && req.query.get("DynUpdate") === "up_5s") return new Promise(() => undefined);
      return answer(req);
    };
    const fx = daemonOn("dlink", mock.fetchImpl, DLINK_URL, DLINK_PASSWORD, "admin", { stopGraceMs: 30 });
    try {
      const changing = assert.rejects(fx.core.controls.setNetworkMode("lte", { confirm: true }), SchedulerStoppedError);
      await until(() => writes.some((write) => write["CfgType"] === "connect_btn" && write["connect"] === 0), "the disconnect went out");
      await stopFengSuiCore(fx.core);
      await changing;
      assert.deepEqual(
        writes.filter((write) => write["CfgType"] === "connect_btn").map((write) => write["connect"]),
        [0, 1],
        "connected again, once"
      );
      assert.equal(state.connected, true, "the router is not left offline");
      assert.equal(state.sid, null, "and signed out");
    } finally {
      await fx.cleanup();
    }
  });
});

describe("zte-goform: a message to several recipients cut short", () => {
  it("sends the recipients still to come nothing once the session is cut, and reports what the router took as submitted", async () => {
    // The router takes each message and then never says whether it went out
    const { state, mock } = zteRouter({ sendStatus: "1" });
    const fx = createBrandSmsFixture({
      family: "zte-goform",
      cpeUrl: "http://192.168.0.1",
      username: "",
      password: ZTE_PASSWORD,
      fetchImpl: mock.fetchImpl,
      // The router is asked once a second, as the daemon does: the session's deadline passes while the first wait runs
      service: { sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)), sendStatusTimeoutMs: 45_000 },
      connection: { sessionMaxHoldMs: 500 },
    });
    try {
      const outcome = await fx.service.send({ phones: ["+353830000001", "+353830000002"], content: "hello", source: "web" });
      assert.equal(outcome.result.submitted, true, "the router took the first message: not a failed send, so nobody sends it again");
      const sends = (): string[] => state.posts.filter((post) => post.goformId === "SEND_SMS").map((post) => post.fields.get("Number") ?? "");
      assert.deepEqual(sends(), ["+353830000001"], "the second recipient was not reached");
      assert.equal(state.loggedIn, false, "signed out");
      // The loop that was cut is over: no later turn of it reaches the router, signed in or not
      const requests = mock.requests.length;
      await pause(1300);
      assert.equal(mock.requests.length, requests, "not one request after the session ended");
      assert.deepEqual(sends(), ["+353830000001"]);
    } finally {
      await fx.cleanup();
    }
  });
});
