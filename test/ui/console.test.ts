import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { type ChromeHandle, type Page, type Viewport, closeChrome, launchChrome, openPage } from "../../scripts/cdp.ts";
import { type DemoDaemon, startDemoDaemon } from "../../scripts/demo-router.ts";

/**
 * The console in a real browser: a headless Chrome (scripts/cdp.ts) against the real daemon and the
 * in-process demo router (no `.env`, no network; the bot talks to an in-process stand-in). Run by
 * `npm run test:ui`, which builds the console first; `npm run check` runs without a browser.
 */

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const TOKEN = "fengsui-ui-test";
const DESKTOP: Viewport = { width: 1280, height: 900, scale: 1, mobile: false };
const PHONE: Viewport = { width: 390, height: 844, scale: 2, mobile: true };
const SETTINGS_TABS = ["Router", "Device", "Password", "Tokens", "Telegram", "Security", "Audit"] as const;
/** Roles a person operates, which a screen reader must be able to name. */
const CONTROL_ROLES: ReadonlySet<string> = new Set(["button", "checkbox", "switch", "textbox", "searchbox", "combobox", "listbox", "slider", "spinbutton", "radio", "link", "menuitem", "tab"]);

const visible = (id: string): string => `!document.getElementById(${JSON.stringify(id)}).classList.contains('hidden')`;
const isOpen = (id: string): string => `document.getElementById(${JSON.stringify(id)}).open === true`;

async function world(opts: { scenario?: "unverified"; telegram?: boolean } = {}): Promise<DemoDaemon> {
  const demo = await startDemoDaemon({ port: 0, token: TOKEN, ...opts });
  if (opts.scenario === "unverified") await demo.stack.monitor.identifyDevice();
  // The controls drawer waits for the router's settings; another model may lack some reads
  const reads = [demo.stack.monitor.refreshSettings({ ignoreCooldown: true }), demo.stack.monitor.refreshNeighbors({ ignoreCooldown: true })];
  if (opts.scenario === "unverified") await Promise.allSettled(reads);
  else await Promise.all(reads);
  return demo;
}

/** Wait for something the daemon (not the page) must see. */
async function until(condition: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

async function signIn(page: Page, demo: DemoDaemon, viewport: Viewport = DESKTOP): Promise<void> {
  await page.viewport(viewport);
  await page.goto(`${demo.baseUrl}/`);
  await page.evaluate(`localStorage.setItem("fengsui.followSystem", "0"); localStorage.setItem("fengsui.locale", "en"); true`);
  await page.goto(`${demo.baseUrl}/`);
  // Both views start hidden until the auth check answers
  await page.waitUntil(`${visible("loginView")} || ${visible("appView")}`, "the sign-in page or the console");
  if (await page.evaluate<boolean>(visible("loginView"))) {
    await page.evaluate(`document.getElementById('loginToken').value = ${JSON.stringify(TOKEN)}; document.getElementById('loginForm').requestSubmit(); true`);
  }
  await page.waitUntil(visible("appView"), "the console");
  await page.waitUntil("document.querySelector('#operatorCard')?.textContent?.length > 40", "telemetry");
}

async function openSettings(page: Page, tab: (typeof SETTINGS_TABS)[number]): Promise<void> {
  if (!(await page.evaluate<boolean>(isOpen("settingsDialog")))) {
    await page.click('[data-action="open-settings"]');
    await page.waitUntil(isOpen("settingsDialog"), "the settings dialog");
  }
  await page.click(`#settingsDialog nav button[aria-label=${JSON.stringify(tab)}]`);
  // A tab that loads its data shows a spinner until it is there
  await page.waitUntil("!document.querySelector('#settingsDialog .loading')", `the ${tab} tab`);
}

async function closeDialogs(page: Page): Promise<void> {
  await page.evaluate("for (const d of document.querySelectorAll('dialog[open]')) d.close(); true");
}

/** Controls on screen that have no accessible name, with their markup for the failure message. */
async function namelessControls(page: Page): Promise<string[]> {
  type AxNode = { ignored?: boolean; role?: { value?: unknown }; name?: { value?: unknown }; backendDOMNodeId?: number };
  const { nodes } = await page.send<{ nodes: AxNode[] }>("Accessibility.getFullAXTree");
  const found: string[] = [];
  for (const node of nodes) {
    const role = String(node.role?.value ?? "");
    if (node.ignored || !CONTROL_ROLES.has(role) || String(node.name?.value ?? "").trim()) continue;
    const markup =
      node.backendDOMNodeId === undefined
        ? ""
        : (await page.send<{ outerHTML: string }>("DOM.getOuterHTML", { backendNodeId: node.backendDOMNodeId }).catch(() => ({ outerHTML: "" }))).outerHTML;
    found.push(`${role} ${markup.slice(0, 160)}`);
  }
  return found;
}

/** How far the page, or an open dialog, scrolls sideways (0: it fits). */
async function sidewaysOverflow(page: Page): Promise<number> {
  return await page.evaluate<number>(
    "Math.max(document.scrollingElement.scrollWidth - window.innerWidth, ...[...document.querySelectorAll('dialog[open] .modal-box')].map((box) => box.scrollWidth - box.clientWidth))"
  );
}

describe("the console in a browser", () => {
  let chrome: ChromeHandle | null = null;
  let page: Page;
  let demo: DemoDaemon | null = null;

  before(async () => {
    assert.ok(fs.existsSync(path.join(ROOT, "dist", "web", "public", "index.html")), "build the console first: npm run build:web");
    demo = await world({ telegram: true });
    chrome = await launchChrome();
    page = await openPage(chrome);
    await page.send("DOM.enable");
    await page.send("Accessibility.enable");
  });

  after(async () => {
    if (chrome) await closeChrome(chrome);
    await demo?.close();
  });

  const live = (): DemoDaemon => {
    assert.ok(demo, "the demo daemon is running");
    return demo;
  };

  it("signs in and shows the router's live telemetry without a script error", async () => {
    await signIn(page, live());
    assert.match(await page.evaluate<string>("document.getElementById('operatorCard').textContent"), /Carrier-Lab/);
    assert.deepEqual(page.exceptions, []);
  });

  it("asks before a router write: a cancel leaves the router alone, a confirmation writes", async () => {
    const d = live();
    await signIn(page, d);
    await page.click('[data-action="open-controls"]');
    const upnp = "[...document.querySelectorAll('#controlsDialog label')].find((label) => label.textContent.trim().startsWith('UPnP'))?.querySelector('input')";
    await page.waitUntil(`${upnp} && !${upnp}.disabled`, "the UPnP switch");
    const wasOn = await page.evaluate<boolean>(`${upnp}.checked`);
    // What reached the router (the strict model logs every write, decrypted)
    const upnpWrites = (): string[] => (d.router.cpe?.stats.writes ?? []).filter((write) => write.path === "/api/security/upnp").map((write) => write.body);
    const before = upnpWrites().length;

    await page.evaluate(`${upnp}.click(); true`);
    await page.waitUntil(isOpen("confirmDialog"), "the confirmation");
    await page.click("#confirmCancel");
    await page.waitUntil(`!${isOpen("confirmDialog")}`, "the confirmation to close");
    assert.equal(await page.evaluate<boolean>(`${upnp}.checked`), wasOn, "the switch went back");
    await sleep(300);
    assert.equal(upnpWrites().length, before, "nothing reached the router");

    await page.evaluate(`${upnp}.click(); true`);
    await page.waitUntil(isOpen("confirmDialog"), "the confirmation");
    await page.click("#confirmOk");
    await until(() => upnpWrites().length === before + 1, "the write at the router");
    assert.match(upnpWrites().at(-1) ?? "", new RegExp(`<UpnpStatus>${wasOn ? 0 : 1}</UpnpStatus>`));
    // The audit entry follows once the control session has ended
    const audited = () => d.stack.audit.list(500).find((e) => e.action === "set_security_switches");
    await until(() => audited() !== undefined, "the audit entry");
    assert.deepEqual([audited()?.outcome, audited()?.channel], ["applied", "web"]);
    // The drawer then shows what the router reports again (this model answers the same either way)
    await page.waitUntil(`!${upnp}.disabled`, "the switch to settle");
    await closeDialogs(page);
  });

  it("says what self-healing will do, before a lock and in the drawer, and shows the window a lock opens", async () => {
    const d = live();
    await signIn(page, d);
    await page.click('[data-action="open-controls"]');
    const drawer = "document.getElementById('controlsDialog').textContent";
    await page.waitUntil(`${drawer}.includes('Lock rollback') && ${drawer}.includes('within 10 min')`, "the self-healing section");
    assert.match(await page.evaluate<string>(drawer), /Redials after 3 min down; 0\/4 in 24 h/);

    // The lock confirmation says the lock would be rolled back; a cancel writes nothing
    const lockWrites = (): number => (d.router.cpe?.stats.writes ?? []).filter((write) => write.path === "/api/net/net-mode" || write.path === "/api/net/lock-freq").length;
    const before = lockWrites();
    await page.evaluate("[...document.querySelectorAll('#controlsDialog button')].find((b) => b.textContent.trim() === 'Lock the selected bands').click(); true");
    await page.waitUntil(isOpen("confirmDialog"), "the confirmation");
    assert.match(await page.evaluate<string>("document.getElementById('confirmDialog').textContent"), /Lock rollback is on: unless the WAN is back/);
    await page.click("#confirmCancel");
    await sleep(300);
    assert.equal(lockWrites(), before, "a cancel writes nothing");

    // A lock opens the window, shown at once; the unlock closes it
    const post = (route: string, body: string): string =>
      `fetch(${JSON.stringify(route)}, { method: 'POST', headers: { 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/json' }, body: ${JSON.stringify(body)} }).then((res) => res.status)`;
    assert.equal(await page.evaluate<number>(post("/api/control/band-lock", '{"lteBands":[3]}')), 200);
    await page.waitUntil(`/Watching the last lock|the lock is kept once/.test(${drawer})`, "the lock window in the drawer");
    assert.equal(await page.evaluate<number>(post("/api/control/unlock", "{}")), 200);
    await page.waitUntil(`${drawer}.includes('within 10 min')`, "the window closed again");
    await closeDialogs(page);
  });

  it("closes every dialog, the token it just showed included, when the session ends elsewhere", async () => {
    await signIn(page, live());
    await openSettings(page, "Tokens");
    const name = "[...document.querySelectorAll('#settingsDialog input')].find((input) => input.getAttribute('aria-label') === 'Name (who uses it)')";
    await page.evaluate(`${name}.value = 'UI test'; true`);
    await page.clickText("#settingsDialog button", "Create token");
    await page.waitUntil("document.querySelector('#settingsDialog code')?.textContent?.startsWith('fsk_')", "the new token on screen");
    // Signed out in another tab: the next request finds no session
    await page.evaluate("fetch('/api/auth/logout', { method: 'POST', headers: { 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/json' }, body: '{}' }).then((res) => res.status)");
    await page.waitUntil(visible("loginView"), "the sign-in page", 30_000);
    assert.equal(await page.evaluate<number>("document.querySelectorAll('dialog[open]').length"), 0);
  });

  it("lists the Telegram chats with how they were linked and unlinks one", async () => {
    const d = live();
    const bot = d.stack.telegramBot;
    assert.ok(bot, "the demo daemon runs its bot against the stand-in");
    let update = 0;
    const auth = (chat: { id: number; type: string }, code: string, topic?: number): Promise<void> =>
      bot.handleUpdate({ update_id: ++update, message: { message_id: update, chat, from: { id: 2002 }, text: `/auth ${code}`, ...(topic ? { message_thread_id: topic, is_topic_message: true } : {}) } });
    await auth({ id: 2002, type: "private" }, d.stack.settings.issueCode("pair"));
    await auth({ id: -1004, type: "supergroup" }, d.stack.settings.issueCode("pair-group"), 9);

    await signIn(page, d);
    await openSettings(page, "Telegram");
    const rows = "[...document.querySelectorAll('#settingsDialog section li')]";
    await page.waitUntil(`${rows}.length === 3`, "the three chats");
    const texts = await page.evaluate<string[]>(`${rows}.map((li) => li.innerText.replace(/\\s+/g, ' ').trim())`);
    // Privacy mode (on by default) leaves a long ID's last three digits
    assert.match(texts[0] ?? "", /^Group …004 linked with a group pairing code · posts to topic #9 · only member 2002 can act · linked just now Unlink$/);
    assert.match(texts[1] ?? "", /^Private chat 2002 linked with a pairing code · linked just now Unlink$/);
    assert.match(texts[2] ?? "", /^Private chat 1003 \.env listed in TELEGRAM_CHAT_IDS \(\.env\): remove it there$/);

    await page.click('#settingsDialog button[aria-label="Unlink Private chat 2002"]');
    await page.waitUntil(isOpen("confirmDialog"), "the confirmation");
    assert.match(await page.evaluate<string>("document.getElementById('confirmBody').textContent"), /Private chat 2002/);
    await page.click("#confirmOk");
    await page.waitUntil(`${rows}.length === 2`, "the list without the chat");
    assert.equal(bot.state.isAuthorized("2002", bot.allowedChatIds), false);
    assert.equal(bot.state.isAuthorized("-1004", bot.allowedChatIds), true);
    await closeDialogs(page);
  });

  it("shows a term's help fully on screen, even for a '?' at a card's edge or inside a drawer", async () => {
    await signIn(page, live());
    /** Hover the leftmost visible "?" under `scope` and return where its tip landed. */
    const hoverLeftmost = (scope: string): Promise<{ text: string; left: number; right: number; top: number; bottom: number; vw: number; vh: number; inDialog: boolean } | null> =>
      page.evaluate(`(() => {
        const marks = [...document.querySelectorAll(${JSON.stringify(scope + " .fs-help")})].filter((m) => m.getBoundingClientRect().width > 0);
        marks.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
        const mark = marks[0];
        if (!mark) return null;
        mark.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
        const tip = document.querySelector(".fs-help-tip");
        if (!tip || tip.hidden) return null;
        const r = tip.getBoundingClientRect();
        return { text: tip.textContent, left: r.left, right: r.right, top: r.top, bottom: r.bottom, vw: innerWidth, vh: innerHeight, inDialog: Boolean(tip.closest("dialog")) };
      })()`);
    const onScreen = (t: NonNullable<Awaited<ReturnType<typeof hoverLeftmost>>>): boolean => t.left >= 0 && t.top >= 0 && t.right <= t.vw && t.bottom <= t.vh;

    const card = await hoverLeftmost("#operatorCard");
    assert.ok(card, "a tip appears on hover");
    assert.match(card.text, /NSA/);
    assert.ok(onScreen(card), `tip off screen: ${JSON.stringify(card)}`);
    await page.evaluate(`document.querySelector("#operatorCard .fs-help").dispatchEvent(new MouseEvent("mouseout", { bubbles: true })); true`);
    assert.equal(await page.evaluate<boolean>(`document.querySelector(".fs-help-tip").hidden`), true, "it goes away");

    // Inside a modal drawer the tip must sit in the drawer's top layer, not behind it
    await page.click('[data-action="open-controls"]');
    await page.waitUntil(isOpen("controlsDialog"), "the controls drawer");
    await page.waitUntil(`document.querySelectorAll("#controlsDialog .fs-help").length > 3`, "help marks in the drawer");
    const drawer = await hoverLeftmost("#controlsDialog");
    assert.ok(drawer && drawer.inDialog && onScreen(drawer), `drawer tip: ${JSON.stringify(drawer)}`);
    await closeDialogs(page);
  });

  it("gives every control in the dashboard, the settings tabs and the drawers a name", async () => {
    await signIn(page, live());
    const problems: string[] = [];
    const scan = async (where: string): Promise<void> => {
      for (const problem of await namelessControls(page)) problems.push(`${where}: ${problem}`);
    };
    // The scan must catch an icon-only button nobody named
    await page.evaluate("(() => { const b = document.createElement('button'); b.id = 'namelessCanary'; b.innerHTML = '<svg class=\\'ico\\'></svg>'; document.getElementById('appView').append(b); return true; })()");
    const canary = await namelessControls(page);
    await page.evaluate("document.getElementById('namelessCanary').remove(); true");
    assert.ok(canary.length === 1 && canary[0]?.includes("namelessCanary"), JSON.stringify(canary));
    await scan("dashboard");
    for (const tab of SETTINGS_TABS) {
      await openSettings(page, tab);
      await scan(`settings → ${tab}`);
    }
    await closeDialogs(page);
    for (const [action, dialog] of [
      ["open-controls", "controlsDialog"],
      ["open-appearance", "appearanceDialog"],
      ["open-alerts", "alertsDialog"],
    ] as const) {
      await page.click(`[data-action="${action}"]`);
      await page.waitUntil(isOpen(dialog), dialog);
      await scan(dialog);
      await closeDialogs(page);
    }
    await page.click('[data-view="sms"]');
    await page.waitUntil("document.querySelector('#smsListPane [data-thread-key]') !== null", "the SMS threads");
    await page.click("#smsListPane [data-thread-key]");
    await page.waitUntil(
      "document.querySelectorAll('#smsChatPane .fs-bubble, #smsChatPane [data-uid]').length > 0 || document.querySelector('#smsChatPane')?.textContent?.length > 40",
      "a conversation"
    );
    await scan("SMS");
    assert.deepEqual(problems, []);
  });

  it("fits a phone screen without scrolling sideways", async () => {
    await signIn(page, live(), PHONE);
    const overflow: string[] = [];
    const measure = async (where: string): Promise<void> => {
      const px = await sidewaysOverflow(page);
      if (px > 0) overflow.push(`${where}: ${px}px`);
    };
    await measure("dashboard");
    for (const tab of SETTINGS_TABS) {
      await openSettings(page, tab);
      await measure(`settings → ${tab}`);
    }
    await closeDialogs(page);
    await page.click('[data-action="open-controls"]');
    await page.waitUntil(isOpen("controlsDialog"), "the controls drawer");
    await measure("controls");
    await closeDialogs(page);
    await page.click('[data-view="sms"]');
    await page.waitUntil("document.querySelector('#smsListPane [data-thread-key]') !== null", "the SMS threads");
    await measure("SMS");
    assert.deepEqual(overflow, []);
  });

  it("asks for another model's name before an experimental write, and only takes it typed right", async () => {
    const other = await world({ scenario: "unverified" });
    try {
      await signIn(page, other);
      await openSettings(page, "Device");
      const bandLock = "#settingsDialog li[data-feature=bandLock] input";
      await page.waitUntil(`document.querySelector(${JSON.stringify(bandLock)}) !== null`, "the experimental writes");
      await page.click(bandLock);
      await page.waitUntil(isOpen("confirmDialog"), "the risk dialog");
      const type = (text: string): Promise<unknown> =>
        page.evaluate(`(() => { const input = document.getElementById('confirmTypeInput'); input.value = ${JSON.stringify(text)}; input.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
      assert.equal(await page.evaluate<boolean>("document.getElementById('confirmOk').disabled"), true, "nothing typed yet");
      await type("B535");
      assert.equal(await page.evaluate<boolean>("document.getElementById('confirmOk').disabled"), true, "not the whole model");
      await type("b535-232");
      await page.waitUntil("document.getElementById('confirmOk').disabled === false", "the model typed (any case)");
      await page.click("#confirmOk");
      await until(() => other.stack.settings.experimentalConsents.some((consent) => consent.feature === "bandLock"), "the consent");
      assert.deepEqual(page.exceptions, []);
      await closeDialogs(page);
    } finally {
      await other.close();
    }
  });
});
