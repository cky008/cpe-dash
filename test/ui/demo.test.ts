import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { describe, it } from "node:test";
import { type ChromeHandle, type Page, closeChrome, launchChrome, openPage } from "../../scripts/cdp.ts";
import { setup, step, teardown } from "./hooks.ts";

/**
 * The live demo as visitors get it: `build-web.ts --demo` (its size limit included), served as static
 * files, opened in a headless Chrome. The page runs FengSui's own services in front of a demo router;
 * the Node built-ins those use are the demo's stand-ins (web/src/demo/node/), which only a browser
 * runs, so this is where they are tested together. Nothing leaves the page.
 */

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const DEMO = path.join(ROOT, "dist", "demo");
const TYPES: Readonly<Record<string, string>> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".txt": "text/plain" };

/** A call to the page's own back end (what the console's `fetch` reaches), answered as JSON. */
function api(method: "GET" | "POST", route: string, body?: unknown): string {
  const init = method === "POST" ? `{ method: "POST", body: ${JSON.stringify(JSON.stringify(body ?? {}))} }` : "{}";
  return `window.__fengsuiDemo.fetch(${JSON.stringify(route)}, ${init}).then(async (r) => ({ status: r.status, json: await r.json() }))`;
}

interface Answer {
  status: number;
  json: Record<string, unknown> & { ok?: boolean; errorCode?: string };
}

describe("the live demo in a browser", () => {
  let server: http.Server | null = null;
  let base = "";
  let chrome: ChromeHandle | null = null;

  setup(async () => {
    const build = spawnSync(process.execPath, ["--experimental-strip-types", path.join(ROOT, "scripts", "build-web.ts"), "--demo"], { cwd: ROOT, encoding: "utf8", timeout: 180_000 });
    assert.equal(build.status, 0, `the demo build failed:\n${build.stdout}\n${build.stderr}`);
    server = http.createServer((req, res) => {
      const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://demo.invalid").pathname);
      const file = path.join(DEMO, pathname === "/" ? "index.html" : pathname);
      if (!file.startsWith(DEMO) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream" });
      res.end(fs.readFileSync(file));
    });
    await step("the demo's static server", () => new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve)));
    const address = server.address();
    base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    chrome = await step("headless Chrome", () => launchChrome());
  });

  teardown(async () => {
    try {
      const runningChrome = chrome;
      if (runningChrome) await step("closing Chrome", () => closeChrome(runningChrome));
    } finally {
      server?.close();
    }
  });

  async function open(query: string): Promise<Page> {
    assert.ok(chrome, "Chrome is running");
    const page = await openPage(chrome);
    await page.goto(`${base}/${query}`);
    await page.evaluate(`localStorage.setItem("fengsui.locale", "en"); true`);
    await page.goto(`${base}/${query}`);
    await page.waitUntil("document.querySelector('#operatorCard')?.textContent?.length > 40", "the router's telemetry", 30_000);
    return page;
  }

  it("opens on each demo router with live readings, nothing to sign in to and no script error", async () => {
    for (const [query, model] of [["", "H168-383"], ["?router=other", "B535-232"], ["?router=zte", "MU5001"], ["?router=dlink", "DWR-961"]] as const) {
      const page = await open(query);
      const profile = await page.evaluate<Answer>(api("GET", "/api/device/profile"));
      assert.equal((profile.json["profile"] as { identity: { model: string } }).identity.model, model, query || "the H168-383");
      assert.match(await page.evaluate<string>("document.body.textContent"), /Demo mode/);
      assert.deepEqual(page.exceptions, [], `${query || "the H168-383"}: no script error`);
    }
  });

  it("writes through the daemon's own gate, the radio follows the lock, and the audit log names the web console", async () => {
    const page = await open("");
    const lock = await page.evaluate<Answer>(api("POST", "/api/control/band-lock", { lteBands: [3], nrBands: [78], confirm: true }));
    assert.equal(lock.status, 200, JSON.stringify(lock.json));
    await page.evaluate<Answer>(api("POST", "/api/telemetry/refresh", { confirm: true }));
    const telemetry = await page.evaluate<Answer>(api("GET", "/api/telemetry"));
    assert.deepEqual((telemetry.json["lockVerification"] as { status: string; issues: string[] }).issues, []);
    assert.equal((telemetry.json["telemetry"] as { rf: { pccBand: string } }).rf.pccBand, "B3");
    // A write without confirm is refused before anything reaches the router, as on the daemon
    const unconfirmed = await page.evaluate<Answer>(api("POST", "/api/control/unlock", {}));
    assert.equal(unconfirmed.json.errorCode, "VALIDATION_ERROR");
    const audit = await page.evaluate<Answer>(api("GET", "/api/audit?limit=5"));
    const entries = audit.json["entries"] as Array<{ action: string; channel: string }>;
    assert.equal(entries[0]?.action, "lock_band");
    assert.equal(entries[0]?.channel, "web", "the caller is read before the first await, which a page's AsyncLocalStorage stand-in keeps");
    assert.deepEqual(page.exceptions, []);
  });

  it("sends an SMS over the router's encrypted channel and changes the console password with any current one", async () => {
    const page = await open("");
    const sent = await page.evaluate<Answer>(api("POST", "/api/sms/send", { phone: "+353830000001", content: "See you at 7", confirm: true }));
    assert.equal(sent.status, 200, JSON.stringify(sent.json));
    const password = await page.evaluate<Answer>(api("POST", "/api/console/password", { current: "anything", next: "a-new-demo-password-1" }));
    assert.equal(password.status, 200, JSON.stringify(password.json));
    const audit = (await page.evaluate<Answer>(api("GET", "/api/audit?limit=5"))).json["entries"] as Array<{ action: string; channel: string }>;
    assert.deepEqual(
      audit.filter((entry) => entry.action === "settings.password" || entry.action === "sms_send").map((entry) => `${entry.action} ${entry.channel}`).sort(),
      ["settings.password web", "sms_send web"]
    );
    const chats = await page.evaluate<Answer>(api("GET", "/api/console/telegram/chats"));
    assert.deepEqual((chats.json["chats"] as Array<{ chatId: string }>).map((chat) => chat.chatId).sort(), ["-1002", "1001", "1003"]);
    assert.deepEqual(page.exceptions, []);
  });

  it("takes another model's implemented writes, each with a switch, and refuses one switched off", async () => {
    const page = await open("?router=other");
    const view = await page.evaluate<Answer>(api("GET", "/api/console/experimental"));
    assert.equal((view.json["device"] as { features: Record<string, string> }).features["mobileData"], "enabled");
    const off = await page.evaluate<Answer>(api("POST", "/api/console/experimental", { feature: "mobileData", enabled: false }));
    assert.equal(off.status, 200, JSON.stringify(off.json));
    const refused = await page.evaluate<Answer>(api("POST", "/api/control/mobile-data", { enabled: false, confirm: true }));
    assert.equal(refused.json.errorCode, "DEVICE_WRITE_DISABLED");
    assert.deepEqual(page.exceptions, []);
  });

  it("signs out, and any password signs back in", async () => {
    const page = await open("?router=zte");
    assert.equal((await page.evaluate<Answer>(api("POST", "/api/auth/logout"))).status, 200);
    assert.equal((await page.evaluate<Answer>(api("GET", "/api/telemetry"))).status, 401);
    assert.equal((await page.evaluate<Answer>(api("POST", "/api/auth/login", { password: "whatever" }))).status, 200);
    assert.equal((await page.evaluate<Answer>(api("GET", "/api/telemetry"))).status, 200);
    assert.deepEqual(page.exceptions, []);
  });
});
