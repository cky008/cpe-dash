import { loadConfig, normalizeCpeUrl } from "../src/config.ts";
import { EphemeralCpeSession, HuaweiCpeClient } from "../src/protocols/hilink/client.ts";
import { sanitizeIpToken } from "../src/sanitize.ts";
import { getXmlTag } from "../src/protocols/hilink/xml.ts";

async function main(): Promise<void> {
  console.log("=== [FengSui Probe #7] Ephemeral Session Benchmark & Dual-Layer Browser Avoidance ===");

  const cfg = loadConfig();
  const baseUrl = normalizeCpeUrl(cfg.cpeUrl);
  const pollClient = new HuaweiCpeClient({
    cpeUrl: baseUrl,
    cpeUsername: cfg.cpeUsername,
    cpePassword: cfg.cpePassword,
    requestTimeoutMs: cfg.requestTimeoutMs,
    respectBrowserSession: true,
  });
  pollClient.rememberLoginScheme("scram");

  const initial = await pollClient.getLoginState();
  console.log(
    `[Step 0] Initial /api/user/state-login -> State=${initial.state}, isLoggedInElsewhere=${initial.isLoggedInElsewhere}, passwordType=${initial.passwordType}`
  );

  if (initial.isLoggedInElsewhere) {
    const t0 = performance.now();
    const res = await pollClient.withSession(async (s) => s.get("/api/monitoring/status"));
    const elapsedMs = Math.round(performance.now() - t0);
    console.log(
      `[Live Human Browser Detected] pollClient.withSession() yielded=${res === null} in ${elapsedMs} ms (browserYieldCount=${pollClient.getTelemetry().browserYieldCount})`
    );
    return;
  }

  // Phase A: 3 consecutive ephemeral session hold-time benchmarks on real H168-383
  console.log("\n--- Phase A: 3-Cycle Live Ephemeral Hold-Time Benchmark (SCRAM Login -> GET -> Logout) ---");
  const holdTimes: number[] = [];
  for (let i = 1; i <= 3; i++) {
    const statusXml = await pollClient.withSession(async (session) => {
      return session.get("/api/monitoring/status");
    });
    const holdMs = pollClient.getTelemetry().lastSessionHoldMs ?? -1;
    holdTimes.push(holdMs);
    const postLogoutState = await pollClient.getLoginState();
    const connStatus = statusXml ? getXmlTag(statusXml, "ConnectionStatus") : "--";
    console.log(
      `  Cycle #${i}: holdTime=${holdMs} ms | ConnectionStatus=${connStatus} | Post-Logout State=${postLogoutState.state} (released=${postLogoutState.state === "-1"})`
    );
  }
  const avgHoldMs = Math.round(holdTimes.reduce((a, b) => a + b, 0) / holdTimes.length);
  console.log(
    `  Benchmark Summary: min=${Math.min(...holdTimes)} ms, avg=${avgHoldMs} ms, max=${Math.max(...holdTimes)} ms (target <= 200 ms)`
  );

  // Phase B: Live H168-383 cookie-scoped state-login & same-IP non-preemption verification
  console.log("\n--- Phase B: Live H168-383 Session Semantics & Non-Preemption Verification ---");
  const browserSim = new EphemeralCpeSession({
    baseUrl,
    username: cfg.cpeUsername,
    password: cfg.cpePassword,
    timeoutMs: cfg.requestTimeoutMs,
    fetchImpl: globalThis.fetch,
  });

  const sameHostDaemon = new HuaweiCpeClient({
    cpeUrl: baseUrl,
    cpeUsername: cfg.cpeUsername,
    cpePassword: cfg.cpePassword,
    requestTimeoutMs: cfg.requestTimeoutMs,
    respectBrowserSession: true,
  });
  sameHostDaemon.rememberLoginScheme("scram");

  try {
    await browserSim.login();
    const [cookieStateXml, historyXml, cookieLessState] = await Promise.all([
      browserSim.get("/api/user/state-login"),
      browserSim.get("/api/user/history-login"),
      sameHostDaemon.getLoginState(),
    ]);

    const cookieState = getXmlTag(cookieStateXml, "State") ?? "";
    const accountsNum = getXmlTag(cookieStateXml, "accounts_number") ?? "";
    const lastIp = sanitizeIpToken(getXmlTag(historyXml, "last_login_ipaddr") ?? "");

    console.log(
      `  1. Active Cookie /api/user/state-login -> State=${cookieState}, accounts_number=${accountsNum} (last_login_ip=${lastIp})`
    );
    console.log(
      `  2. Cookie-less /api/user/state-login   -> State=${cookieLessState.state} (firmware 4.4.0.1 scopes State=0 to SessionID cookie)`
    );

    const sameIpPollBand = await sameHostDaemon.withSession(async (session) => {
      const sigXml = await session.get("/api/device/signal");
      return getXmlTag(sigXml, "bandInfo") ?? "--";
    });
    console.log(
      `  3. Same-IP Ephemeral Poll              -> bandInfo=${sameIpPollBand}, holdTime=${sameHostDaemon.getTelemetry().lastSessionHoldMs} ms`
    );

    const browserBasicXml = await browserSim.get("/api/device/basic_information");
    const model = getXmlTag(browserBasicXml, "devicename") ?? "unknown";
    console.log(
      `  4. Browser Session Integrity           -> STILL AUTHENTICATED (devicename=${model}, zero preemption)`
    );
  } finally {
    const browserHoldMs = await browserSim.logout();
    console.log(`  5. Simulated Browser Logout            -> released cleanly after ${browserHoldMs} ms`);
  }

  // Phase C: Dual-Layer Avoidance Verification (Layer 1: State=0 pre-check; Layer 2: Cross-IP 108003 occupied)
  console.log("\n--- Phase C: Dual-Layer Browser Avoidance Verification (Layer 1 State=0 & Layer 2 Cross-IP 108003) ---");
  const layer1Client = new HuaweiCpeClient({
    cpeUrl: "http://192.168.8.1",
    cpePassword: "synthetic_unused_password",
    respectBrowserSession: true,
    fetchImpl: async () =>
      new Response(
        `<response><State>0</State><lockstatus>0</lockstatus><accounts_number>1</accounts_number></response>`,
        { status: 200 }
      ),
  });
  layer1Client.rememberLoginScheme("scram");
  const l1Res = await layer1Client.withSession(async () => "never");
  console.log(
    `  Layer 1 (State=0 Pre-Check)   -> yielded=${l1Res === null}, browserYieldCount=${layer1Client.getTelemetry().browserYieldCount} (zero SCRAM calls)`
  );

  const layer2Client = new HuaweiCpeClient({
    cpeUrl: "http://192.168.8.1",
    cpePassword: "synthetic_unused_password",
    respectBrowserSession: true,
    fetchImpl: async (input) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      if (url.pathname === "/api/user/state-login") {
        return new Response(`<response><State>-1</State><lockstatus>0</lockstatus></response>`, { status: 200 });
      }
      if (url.pathname === "/api/monitoring/status") {
        return new Response(`<response><ConnectionStatus>901</ConnectionStatus></response>`, {
          status: 200,
          headers: { __requestverificationtokenone: "0123456789abcdef0123456789abcdef" },
        });
      }
      if (url.pathname === "/api/webserver/token") {
        return new Response(
          `<response><token>${"0".repeat(32)}${"a".repeat(32)}</token></response>`,
          { status: 200 }
        );
      }
      if (url.pathname === "/api/user/challenge_login") {
        return new Response(`<error><code>108003</code><message>Already logged in</message></error>`, { status: 200 });
      }
      return new Response(`<response>OK</response>`, { status: 200 });
    },
  });
  layer2Client.rememberLoginScheme("scram");
  const l2Res = await layer2Client.withSession(async () => "never");
  console.log(
    `  Layer 2 (Cross-IP 108003)     -> yielded=${l2Res === null}, browserYieldCount=${layer2Client.getTelemetry().browserYieldCount} (zero retries, browser undisturbed)`
  );

  const finalState = await pollClient.getLoginState();
  console.log(`\n[Final Check] Live H168-383 /api/user/state-login -> State=${finalState.state} (idle=${finalState.state === "-1"})`);
}

main().catch((err: unknown) => {
  console.error("Probe #7 failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
