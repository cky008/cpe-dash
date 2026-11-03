import { startDemoDaemon } from "./demo-router.ts";

/**
 * Offline demo: the real daemon (scheduler, monitor, SMS, SSE, REST, MCP, web UI) against the
 * in-process strict H168-383 model from test/helpers — no request ever leaves this process.
 *
 *   npm run build:web && npm run demo        → http://127.0.0.1:18484  (token printed on start)
 *   DEMO_SCENARIO=yield   a "human admin" logs in every few minutes (avoidance banner)
 *   DEMO_SCENARIO=breaker wrong CPE password: the anti-lockout breaker trips (423 banner)
 *   DEMO_SCENARIO=unverified another Huawei model (LTE-only, legacy login): read-only, badge, device report
 *
 * It never reads the project's .env: config comes from a throwaway env file with explicit
 * overrides, Telegram and webhooks are off, and the data directory is a temp dir removed on exit.
 * Every identifier is an RFC / reserved placeholder (AGENTS.md 铁律二). The household itself lives
 * in scripts/demo-router.ts, shared with the GitHub Pages demo.
 */

const PORT = Number(process.env["DEMO_PORT"] ?? 18484);
const SCENARIO = process.env["DEMO_SCENARIO"] ?? "normal";
const TOKEN = process.env["DEMO_TOKEN"] ?? "fengsui-demo";

const demo = await startDemoDaemon({
  port: PORT,
  token: TOKEN,
  scenario: SCENARIO === "yield" || SCENARIO === "breaker" || SCENARIO === "unverified" ? SCENARIO : "normal",
  log: (line) => console.log(line),
});
const { human } = demo.router;

console.log(`\n  烽燧 FengSui demo (${SCENARIO}) on ${demo.baseUrl}`);
console.log(`  API token: ${TOKEN}   ·   mock router only, data in ${demo.dataDir}\n`);

const timers: Array<ReturnType<typeof setInterval>> = [];
timers.push(setInterval(() => demo.router.advance(), 5000));
timers.push(setInterval(() => demo.router.pushOtp(), 90_000));
if (SCENARIO === "yield") {
  // A person opens the router's own admin page 15 s after start, then every 2 minutes for 45 s
  const humanVisit = (): void => {
    human.loginSameIp();
    setTimeout(() => human.logout(), 45_000);
  };
  timers.push(setTimeout(humanVisit, 15_000));
  timers.push(setInterval(humanVisit, 120_000));
}

let closing = false;
const shutdown = (): void => {
  if (closing) return;
  closing = true;
  for (const timer of timers) clearInterval(timer);
  void demo.close().finally(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
