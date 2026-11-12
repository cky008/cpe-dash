import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { type ChromeHandle, type Page, type Viewport, closeChrome, launchChrome, openPage } from "../../scripts/cdp.ts";
import { type DemoDaemon, startDemoDaemon } from "../../scripts/demo-router.ts";
import { MODULES } from "../../src/device-catalog.ts";

/**
 * The console in a real browser: a headless Chrome (scripts/cdp.ts) against the real daemon and the
 * in-process demo router (no `.env`, no network; the bot talks to an in-process stand-in). Run by
 * `npm run test:ui`, which builds the console first; `npm run check` runs without a browser.
 */

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const TOKEN = "fengsui-ui-test";
const DESKTOP: Viewport = { width: 1280, height: 900, scale: 1, mobile: false };
const PHONE: Viewport = { width: 390, height: 844, scale: 2, mobile: true };
const SETTINGS_TABS = ["Router", "Device", "General", "Password", "Tokens & AI", "Telegram", "Security", "Audit"] as const;
/** Roles a person operates, which a screen reader must be able to name. */
const CONTROL_ROLES: ReadonlySet<string> = new Set(["button", "checkbox", "switch", "textbox", "searchbox", "combobox", "listbox", "slider", "spinbutton", "radio", "link", "menuitem", "tab"]);

const visible = (id: string): string => `!document.getElementById(${JSON.stringify(id)}).classList.contains('hidden')`;
const isOpen = (id: string): string => `document.getElementById(${JSON.stringify(id)}).open === true`;

const UNSAFE_IN_CODE: Readonly<Record<string, string>> = { "<": "\\u003C", ">": "\\u003E", "/": "\\u002F", "\u2028": "\\u2028", "\u2029": "\\u2029" };
/** A string as a JS literal inside a page expression: JSON, plus escapes for what JSON leaves raw (CodeQL js/bad-code-sanitization). */
const literal = (value: string): string => JSON.stringify(value).replace(/[<>/\u2028\u2029]/g, (c) => UNSAFE_IN_CODE[c] ?? c);

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
    await openSettings(page, "Tokens & AI");
    const name = "[...document.querySelectorAll('#settingsDialog input')].find((input) => input.getAttribute('aria-label') === 'Name (who uses it)')";
    await page.evaluate(`${name}.value = 'UI test'; true`);
    await page.clickText("#settingsDialog button", "Create token");
    await page.waitUntil("document.querySelector('#settingsDialog code')?.textContent?.startsWith('fsk_')", "the new token on screen");
    // Signed out in another tab: the next request finds no session
    await page.evaluate("fetch('/api/auth/logout', { method: 'POST', headers: { 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/json' }, body: '{}' }).then((res) => res.status)");
    await page.waitUntil(visible("loginView"), "the sign-in page", 30_000);
    assert.equal(await page.evaluate<number>("document.querySelectorAll('dialog[open]').length"), 0);
  });

  it("takes a token it just showed off the page when the settings close, not only off the screen", async () => {
    await signIn(page, live());
    await openSettings(page, "Tokens & AI");
    const name = "[...document.querySelectorAll('#settingsDialog input')].find((input) => input.getAttribute('aria-label') === 'Name (who uses it)')";
    await page.evaluate(`${name}.value = 'UI test, closed'; true`);
    await page.clickText("#settingsDialog button", "Create token");
    await page.waitUntil("document.querySelector('#settingsDialog code')?.textContent?.startsWith('fsk_')", "the new token on screen");
    const token = await page.evaluate<string>("document.querySelector('#settingsDialog code').textContent");
    await closeDialogs(page);
    // The close event comes a task later; the token must then be gone from the page, not just hidden
    await page.waitUntil(`!document.body.textContent.includes(${JSON.stringify(token)})`, "the token gone from the page", 3000);
  });

  it("creates a token with its permissions, edits them, and sets the agents' switch and a self-healing window", async () => {
    const d = live();
    await signIn(page, d);
    await openSettings(page, "Tokens & AI");
    const name = "[...document.querySelectorAll('#settingsDialog input')].find((input) => input.getAttribute('aria-label') === 'Name (who uses it)')";
    await page.evaluate(`${name}.value = 'Dashboard'; true`);
    // Untick reading SMS: a dashboard reads the router only
    await page.evaluate("document.querySelector('#settingsDialog [data-new-token] input[data-permission=\"sms-read\"]').click(); true");
    await page.clickText("#settingsDialog button", "Create token");
    await page.waitUntil("document.querySelector('#settingsDialog code')?.textContent?.startsWith('fsk_')", "the new token on screen");
    const row = "[...document.querySelectorAll('#settingsDialog li')].find((li) => li.textContent.includes('Dashboard'))";
    await page.waitUntil(`${row}?.textContent.includes('Data only')`, "its badge");
    assert.deepEqual(d.stack.settings.listTokens().find((t) => t.name === "Dashboard")?.permissions, []);

    await page.evaluate(`[...${row}.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Permissions').click(); true`);
    await page.waitUntil(`${row}?.querySelector('[data-editing] input[data-permission="control"]') !== null`, "the editor");
    await page.evaluate(`${row}.querySelector('[data-editing] input[data-permission="control"]').click(); [...${row}.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Save').click(); true`);
    await page.waitUntil(`${row}?.textContent.includes('Router') && !${row}?.querySelector('[data-editing]')`, "the new badge");
    assert.deepEqual(d.stack.settings.listTokens().find((t) => t.name === "Dashboard")?.permissions, ["control"]);

    // The agents' master switch, then a window typed on the General tab
    const pick = (key: string, value: string): string =>
      `(() => { const s = document.querySelector(${literal(`#settingsDialog select[data-setting="${key}"]`)}); s.value = ${literal(value)}; s.dispatchEvent(new Event('change')); return true; })()`;
    await page.evaluate(pick("agentWrites", "0"));
    await page.waitUntil(`document.querySelector('#settingsDialog select[data-setting="agentWrites"]')?.value === '0' && !document.querySelector('#settingsDialog select[data-setting="agentWrites"]').disabled`, "the switch saved");
    assert.equal(d.stack.settings.behaviourOverrides.agentWrites, true);
    await openSettings(page, "General");
    await page.evaluate(`(() => { const box = document.querySelector('#settingsDialog input[data-setting="lockRollbackAfterMin"]'); box.value = '15'; box.dispatchEvent(new Event('change')); return true; })()`);
    await page.waitUntil(`document.querySelector('#settingsDialog input[data-setting="lockRollbackAfterMin"]')?.value === '15' && document.querySelector('#settingsDialog')?.textContent.includes('Follow .env again')`, "the window saved");
    assert.equal(d.stack.settings.behaviourOverrides.lockRollbackAfterMin, 15);
    assert.equal(d.stack.selfHeal?.lockRollbackAfterMs, 15 * 60_000, "the running watchdog follows at once");
    await closeDialogs(page);
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

  it("lets a term's help go: Escape hides it first, a redrawn card leaves none behind, one mark points at it", async () => {
    await signIn(page, live());
    const state = (): Promise<{ hidden: boolean; described: number }> =>
      page.evaluate(`(() => ({ hidden: document.querySelector(".fs-help-tip")?.hidden ?? true, described: document.querySelectorAll("[aria-describedby='fsHelpTip']").length }))()`);
    const marks = (scope: string): string => `[...document.querySelectorAll(${JSON.stringify(scope + " .fs-help")})].filter((m) => m.getBoundingClientRect().width > 0)`;
    const hover = (scope: string, i: number): string => `${marks(scope)}[${i}].dispatchEvent(new MouseEvent("mouseover", { bubbles: true }))`;
    const escape = async (): Promise<void> => {
      for (const type of ["keyDown", "keyUp"]) await page.send("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    };
    // Two marks in turn: only the one explained points at the tip, and none once it is hidden. Read in the same
    // task as the hovers: the dashboard redraws its cards from the event stream, which would take the mark away
    const turn = await page.evaluate<{ hidden: boolean; described: number }>(
      `(() => { ${hover("#dashboardView", 0)}; ${hover("#dashboardView", 1)}; return { hidden: document.querySelector(".fs-help-tip").hidden, described: document.querySelectorAll("[aria-describedby='fsHelpTip']").length }; })()`
    );
    assert.deepEqual(turn, { hidden: false, described: 1 });
    // Escape dismisses it without moving the pointer or the focus (WCAG 2.2, 1.4.13 Content on Hover or Focus)
    await escape();
    assert.deepEqual(await state(), { hidden: true, described: 0 });
    // A card redrawn under the pointer takes its mark away without a mouseout: the next move hides the tip
    await page.evaluate(`(() => { const m = ${marks("#dashboardView")}[0]; m.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })); m.remove(); document.getElementById("dashboardView").dispatchEvent(new MouseEvent("mouseover", { bubbles: true })); return true; })()`);
    assert.deepEqual(await state(), { hidden: true, described: 0 });
    // In a drawer the first Escape takes the tip away and leaves the drawer open; the next one closes it
    await page.click('[data-action="open-controls"]');
    await page.waitUntil(isOpen("controlsDialog"), "the controls drawer");
    await page.waitUntil(`${marks("#controlsDialog")}.length > 3`, "help marks in the drawer");
    await page.evaluate(`${hover("#controlsDialog", 0)}; true`);
    assert.equal((await state()).hidden, false);
    await escape();
    assert.equal((await state()).hidden, true);
    assert.equal(await page.evaluate<boolean>(isOpen("controlsDialog")), true, "the drawer stays open");
    await escape();
    await page.waitUntil(`!${isOpen("controlsDialog")}`, "the drawer to close on the second Escape");
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

  it("sends a reply once, however often Cmd+Enter is pressed while it goes out", async () => {
    const d = live();
    const cpe = d.router.cpe;
    assert.ok(cpe, "the H168-383 world");
    await signIn(page, d);
    await page.click('[data-view="sms"]');
    await page.waitUntil("document.querySelector('#smsListPane [data-thread-key]') !== null", "the SMS threads");
    // A conversation with a number (a sender name such as a bank's cannot be answered)
    await page.click('#smsListPane [data-thread-key^="+"]');
    // The conversation itself, not just the reply box (which exists before a thread has loaded)
    await page.waitUntil("document.querySelectorAll('#smsChatPane .bubble').length > 0 && document.querySelector('#smsChatPane form textarea') !== null", "the conversation");
    const text = "One reply, sent once";
    const sent = (): number => cpe.outbox.filter((m) => m.content === text).length;
    // Three presses in one task: the first starts the send, a held-key repeat and a second press find it in flight
    await page.evaluate(`(() => {
      const area = document.querySelector('#smsChatPane form textarea');
      area.value = ${JSON.stringify(text)};
      area.dispatchEvent(new Event('input', { bubbles: true }));
      for (let i = 0; i < 3; i++) area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, ctrlKey: true, repeat: i === 1, bubbles: true, cancelable: true }));
      return true;
    })()`);
    await until(() => sent() > 0, "the reply");
    // Typing while it is in flight does not re-arm the button either (an emptied box means it already finished)
    assert.equal(
      await page.evaluate<boolean>(`(() => { const area = document.querySelector('#smsChatPane form textarea'); area.dispatchEvent(new Event('input', { bubbles: true })); return area.form.querySelector('button[type="submit"]').disabled || area.value === ''; })()`),
      true
    );
    // Each send holds the router while it polls send-status, so a second one would land seconds later
    for (const deadline = Date.now() + 8000; Date.now() < deadline && sent() < 2; ) await sleep(200);
    assert.equal(sent(), 1);
    assert.deepEqual(page.exceptions, []);
  });

  it("copies a code from the thread list with Enter on its chip, without opening that thread", async () => {
    const d = live();
    await signIn(page, d);
    await page.click('[data-view="sms"]');
    await page.waitUntil("document.querySelector('#smsListPane [data-copy-otp]') !== null", "a thread with a code");
    await page.click('#smsListPane [data-thread-key^="+"]');
    await page.waitUntil("document.querySelectorAll('#smsChatPane .bubble').length > 0", "the conversation");
    const active = "document.querySelector('#smsListPane .thread-row.is-active')?.dataset.threadKey ?? ''";
    const before = await page.evaluate<string>(active);
    const toasts = await page.evaluate<number>("document.getElementById('toasts').childElementCount");
    await page.evaluate("document.querySelector('#smsListPane [data-copy-otp]').focus(); true");
    // A real key press (trusted), so the chip's own Enter activation can run
    await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
    await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await page.waitUntil(`document.getElementById('toasts').childElementCount > ${toasts}`, "the copy's toast (copied or not allowed)", 5000);
    assert.equal(await page.evaluate<string>(active), before, "the thread with the code did not open");
    assert.deepEqual(page.exceptions, []);
  });

  it("keeps a deleted message in Recently deleted, says so, and restores it into its conversation", async () => {
    const d = live();
    await signIn(page, d);
    await page.click('[data-view="sms"]');
    await page.waitUntil(`document.querySelector('#smsListPane [data-thread-key^="+"]') !== null`, "the conversations");
    await page.click('#smsListPane [data-thread-key^="+"]');
    await page.waitUntil("document.querySelectorAll('#smsChatPane .bubble').length > 0", "the conversation");
    const bubbles = await page.evaluate<number>("document.querySelectorAll('#smsChatPane .bubble').length");
    await page.evaluate(`document.querySelector('#smsChatPane button[aria-label="Delete"]').click(); true`);
    await page.waitUntil(isOpen("confirmDialog"), "the confirmation");
    assert.match(await page.evaluate<string>("document.getElementById('confirmDialog').textContent"), /Recently deleted for 30 days/);
    await page.click("#confirmOk");
    await page.waitUntil(`document.querySelectorAll('#smsChatPane .bubble').length === ${bubbles - 1}`, "the message gone from the conversation");
    await page.waitUntil("document.querySelector('#smsSidebar [data-sms-trash=nav] .count')?.textContent === '1'", "the bin's count");
    assert.equal(d.stack.sms?.listTrash().length, 1);

    await page.click("#smsSidebar [data-sms-trash=nav]");
    await page.waitUntil(`${isOpen("smsTrashDialog")} && document.querySelector('#smsTrashDialog [data-trash=restore]') !== null`, "Recently deleted with the message");
    assert.match(await page.evaluate<string>("document.getElementById('smsTrashDialog').textContent"), /Deleted for good in 29 days|Deleted for good in 30 days/);
    await page.click("#smsTrashDialog [data-trash=restore]");
    await page.waitUntil("document.querySelector('#smsTrashDialog')?.textContent.includes('Nothing deleted recently')", "the bin empty again");
    await page.waitUntil(`document.querySelectorAll('#smsChatPane .bubble').length === ${bubbles}`, "the message back in its conversation");
    assert.ok(await page.evaluate<boolean>("document.getElementById('smsChatPane').textContent.includes('Kept only in FengSui')"), "marked as FengSui's own copy");
    assert.deepEqual(page.exceptions, []);
    await closeDialogs(page);
  });

  it("offers only what the router's SMS interface can do: no send, one delete per conversation", async () => {
    const d = live();
    const sms = d.stack.sms;
    assert.ok(sms, "SMS is on");
    await signIn(page, d);
    await page.click('[data-view="sms"]');
    await page.waitUntil(`document.querySelector('#smsListPane [data-thread-key^="+"]') !== null`, "the conversations");
    await page.click('#smsListPane [data-thread-key^="+"]');
    await page.waitUntil("document.querySelectorAll('#smsChatPane .bubble').length > 0", "the conversation");
    // The demo router is a HiLink one: as a router that cannot send and deletes whole conversations would have listed
    const original = sms.getStatus.bind(sms);
    sms.getStatus = () => ({ ...original(), abilities: { send: false, delete: "conversation", markRead: "router" } });
    try {
      sms.emit("sms:status", sms.getStatus());
      await page.waitUntil("document.querySelector('#smsChatPane [data-sms-delete-thread]') !== null", "the conversation's delete");
      assert.ok(await page.evaluate<boolean>(`[...document.querySelectorAll('#smsChatPane button[aria-label="Delete"]')].every((b) => b.classList.contains('hidden'))`), "no delete on single messages");
      assert.ok(await page.evaluate<boolean>("document.querySelector('#smsChatPane form').classList.contains('hidden')"), "no reply box");
      assert.match(await page.evaluate<string>("document.getElementById('smsChatPane').textContent"), /offers no way to send/);
      assert.ok(await page.evaluate<boolean>("document.querySelector('.fab-compose').classList.contains('hidden')"), "no new message button");

      const bubbles = await page.evaluate<number>("document.querySelectorAll('#smsChatPane .bubble').length");
      const trashed = sms.listTrash().length;
      await page.click("#smsChatPane [data-sms-delete-thread]");
      await page.waitUntil(isOpen("confirmDialog"), "the confirmation");
      assert.match(await page.evaluate<string>("document.getElementById('confirmDialog').textContent"), new RegExp(`deletes a whole conversation at a time: all ${bubbles} messages`));
      await page.click("#confirmOk");
      // One request named every message of the conversation
      await until(() => sms.listTrash().length === trashed + bubbles, "the whole conversation in Recently deleted");
      // Put the conversation back for the tests after this one (FengSui's own copies)
      await sms.restoreMessages({ uids: sms.listTrash().slice(0, bubbles).map((m) => m.uid) });
    } finally {
      sms.getStatus = original;
      sms.emit("sms:status", sms.getStatus());
    }
    await page.waitUntil("document.querySelector('#smsChatPane [data-sms-delete-thread]') === null && !document.querySelector('.fab-compose').classList.contains('hidden')", "the HiLink router's buttons back");
    assert.deepEqual(page.exceptions, []);
    await closeDialogs(page);
  });

  it("puts a code chip's label back after two quick copies", async () => {
    const d = live();
    assert.ok(chrome, "Chrome is running");
    await chrome.cdp.send("Browser.grantPermissions", { origin: d.baseUrl, permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] });
    await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await signIn(page, d);
    await page.click('[data-view="sms"]');
    await page.waitUntil("document.querySelector('#smsListPane [data-copy-otp]') !== null", "a thread with a code");
    await page.evaluate("document.querySelector('#smsListPane [data-copy-otp]').closest('[data-thread-key]').click(); true");
    const hint = "document.querySelector('#smsChatPane [data-copy-otp] [data-copy-hint]')";
    await page.waitUntil(`${hint} !== null`, "the code in the conversation");
    const label = await page.evaluate<string>(`${hint}.textContent`);
    await page.evaluate(`(() => { const chip = document.querySelector('#smsChatPane [data-copy-otp]'); chip.click(); chip.click(); return true; })()`);
    // Both copies worked (the clipboard is allowed here), so the label said so...
    await page.waitUntil(`${hint}.textContent !== ${JSON.stringify(label)}`, "the copied label", 3000);
    // ...and comes back once the pause is over, not stuck on what the second click read
    await page.waitUntil(`${hint}.textContent === ${JSON.stringify(label)}`, "the label back", 5000);
    await sleep(600);
    assert.equal(await page.evaluate<string>(`${hint}.textContent`), label);
  });

  it("sends a new message once, however often Cmd+Enter is pressed while it goes out", async () => {
    const d = live();
    const cpe = d.router.cpe;
    assert.ok(cpe, "the H168-383 world");
    await signIn(page, d);
    await page.click('[data-view="sms"]');
    await page.waitUntil("document.querySelector('#smsListPane [data-thread-key]') !== null", "the SMS threads");
    // "N" opens a new message while nothing that takes typing has the focus
    await page.evaluate(`(() => { document.activeElement?.blur?.(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true })); return true; })()`);
    await page.waitUntil(isOpen("newSmsDialog"), "the new message");
    const text = "One new message, sent once";
    const sent = (): number => cpe.outbox.filter((m) => m.content === text).length;
    await page.evaluate(`(() => {
      const dialog = document.getElementById('newSmsDialog');
      const phone = dialog.querySelector('input[type="text"]');
      const content = dialog.querySelector('textarea');
      phone.value = "+447700900123";
      phone.dispatchEvent(new Event('input', { bubbles: true }));
      content.value = ${JSON.stringify(text)};
      content.dispatchEvent(new Event('input', { bubbles: true }));
      for (let i = 0; i < 3; i++) content.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, ctrlKey: true, repeat: i === 1, bubbles: true, cancelable: true }));
      return true;
    })()`);
    await until(() => sent() > 0, "the message");
    for (const deadline = Date.now() + 8000; Date.now() < deadline && sent() < 2; ) await sleep(200);
    assert.equal(sent(), 1);
    await closeDialogs(page);
    assert.deepEqual(page.exceptions, []);
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

  it("shows another model's writes on by default, and turns one off and back on with a click each, with no model to type", async () => {
    const other = await world({ scenario: "unverified" });
    try {
      await signIn(page, other);
      // The header names the model as not verified, and no longer as read-only
      await page.waitUntil("document.getElementById('readOnlyBadge').title.includes('B535-232')", "the model badge");
      assert.equal(await page.evaluate<string>("document.querySelector('#readOnlyBadge [data-role=text]').textContent"), "Unverified model");
      assert.doesNotMatch(await page.evaluate<string>("document.getElementById('readOnlyBadge').title"), /read-only|locked/i);
      await openSettings(page, "Device");
      const row = (feature: string, rest = ""): string => `document.querySelector('#settingsDialog li[data-feature=${feature}]${rest}')`;
      await page.waitUntil(`${row("bandLock", " input")} !== null`, "the experimental writes");
      assert.equal(await page.evaluate<boolean>(`${row("bandLock", " input")}.checked`), true, "on by default");
      assert.match(await page.evaluate<string>(`${row("bandLock")}.textContent`), /never checked on a real router/, "said at the switch");
      assert.equal(await page.evaluate<boolean>(`${row("cellLock", " input")} === null`), true, "no switch for a write FengSui has nothing for on this model");
      assert.match(await page.evaluate<string>("document.querySelector('#settingsDialog [data-role=writes]').textContent"), /^Writes: 8 available \(never checked on a real router\)$/);
      // Its row of Supported devices, worked out by the daemon, with a link to the brand's section
      const support = "document.querySelector('#settingsDialog [data-support=huawei]')";
      assert.match(await page.evaluate<string>(`${support}.textContent`), /The row of “B535-232”/);
      assert.equal(await page.evaluate<number>(`${support}.querySelectorAll('li[data-mark]').length`), MODULES.length, "a mark per console module");
      assert.equal(await page.evaluate<string>(`${support}.querySelector('li[data-mark="△"]').title`), "partly, or with a condition");
      assert.equal(await page.evaluate<string>(`${support}.querySelector('a[href*="supported-devices"]').getAttribute('href')`), "https://fengsui.iocky.com/en/docs/supported-devices/#brand-huawei");
      // The device report, with what it found per feature summed up above it
      await page.clickText("#settingsDialog button", "Create device report");
      await page.waitUntil("document.querySelector('#settingsDialog [data-role=report-summary]') !== null", "the report's summary");
      assert.match(await page.evaluate<string>("document.querySelector('#settingsDialog [data-role=report-summary] [data-result=works]').textContent"), /^\d+ work: Signal/);

      await page.click("#settingsDialog li[data-feature=bandLock] input");
      await until(() => other.stack.settings.disabledWrites.some((entry) => entry.feature === "bandLock"), "turned off");
      await page.waitUntil(`${row("bandLock", "[data-state=disabled] input")}?.checked === false && !${row("bandLock", " input")}.disabled`, "shown as off");
      assert.equal(await page.evaluate<boolean>(isOpen("confirmDialog")), false, "no dialog: nothing to type, nothing to consent to");
      assert.equal(other.stack.scheduler.device.writeAccess("bandLock"), "disabled", "the gate refuses it from now on");
      assert.match(await page.evaluate<string>("document.querySelector('#settingsDialog [data-role=writes]').textContent"), /^Writes: 7 available/);

      await page.click("#settingsDialog li[data-feature=bandLock] input");
      await until(() => other.stack.settings.disabledWrites.length === 0, "turned back on");
      await page.waitUntil(`${row("bandLock", "[data-state=enabled] input")}?.checked === true`, "shown as on");
      assert.equal(other.stack.scheduler.device.writeAccess("bandLock"), "experimental");
      assert.deepEqual(page.exceptions, []);
      await closeDialogs(page);
    } finally {
      await other.close();
    }
  });

  it("lets the owner allow AI agents to test the router: the switch on every model, the prompt where there are writes to test", async () => {
    // The verified model: the switch (the read-only endpoint probe), no write test to walk an agent through
    const d = live();
    await signIn(page, d);
    await openSettings(page, "Device");
    await page.waitUntil(`document.querySelector('#settingsDialog [data-agent-test=section] select[data-setting="agentExperimental"]') !== null`, "the switch");
    assert.equal(await page.evaluate<boolean>("document.querySelector('#settingsDialog [data-agent-test=prompt]') === null"), true);
    await closeDialogs(page);

    const other = await world({ scenario: "unverified" });
    try {
      await signIn(page, other);
      await openSettings(page, "Device");
      const pre = "document.querySelector('#settingsDialog [data-agent-test=prompt] pre')";
      await page.waitUntil(`${pre}?.textContent.includes('B535-232')`, "the prompt for this model");
      const prompt = await page.evaluate<string>(`${pre}.textContent`);
      assert.match(prompt, /probe_router_endpoints/);
      assert.match(prompt, /github\.com\/cky008\/cpe-dash\/issues\/new/);
      await page.evaluate(`(() => { const s = document.querySelector('#settingsDialog select[data-setting="agentExperimental"]'); s.value = '0'; s.dispatchEvent(new Event('change')); return true; })()`);
      await until(() => other.stack.settings.behaviourOverrides.agentExperimental === true, "the switch saved");
      assert.deepEqual(page.exceptions, []);
      await closeDialogs(page);
    } finally {
      await other.close();
    }
  });

  it("starts an agent's test with one confirmation, SMS and the agent's token included, copies the prompt, and ends it with one click", async () => {
    const other = await world({ scenario: "unverified" });
    try {
      assert.ok(chrome, "Chrome is running");
      await chrome.cdp.send("Browser.grantPermissions", { origin: other.baseUrl, permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] });
      await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
      // The agent is connected with the read-only token of the connection guide
      const agent = other.stack.settings.createToken({ name: "Claude", permissions: ["sms-read"], lifetimeDays: 1 }).record;
      other.stack.agentTest.noteAgentCall(agent.id);
      await signIn(page, other);
      await openSettings(page, "Device");
      const start = "#settingsDialog [data-agent-test=prompt] .btn-primary";
      await page.waitUntil(`document.querySelector(${JSON.stringify(start)})?.textContent.includes('Copy prompt and start test')`, "the one-click start");
      assert.equal(await page.evaluate<string>("document.querySelector('#settingsDialog [data-agent-test=token]').value"), agent.id, "the agent's token is chosen");
      await page.click(start);
      await page.waitUntil(isOpen("confirmDialog"), "one confirmation");
      const body = await page.evaluate<string>("document.getElementById('confirmBody').textContent");
      for (const item of ["Let AI agents test this router", "Let agents change the router", "The token “Claude”: may change the router", "never checked on a real one", "End test"]) {
        assert.ok(body.includes(item), item);
      }
      assert.doesNotMatch(body, /Experimental writes:/, "the test turns no write on: they are on already");
      // SMS is in unless the owner unticks it
      assert.equal(await page.evaluate<boolean>("!document.getElementById('confirmCheckRow').classList.contains('hidden') && document.getElementById('confirmCheckInput').checked"), true, "SMS ticked");
      assert.match(await page.evaluate<string>("document.getElementById('confirmCheckLabel').textContent"), /^Also test SMS: .*at most 10 an hour/);
      await page.click("#confirmOk");
      await until(() => other.stack.settings.agentTest !== null, "the test started");
      assert.deepEqual(other.stack.settings.behaviourOverrides, { agentExperimental: true, agentWrites: true, agentSms: "full", agentSmsSendPolicy: "any" });
      assert.equal(other.stack.settings.disabledWrites.length, 0, "no write's switch was touched");
      assert.deepEqual(other.stack.settings.listTokens().find((t) => t.id === agent.id)?.permissions, ["sms-read", "control", "sms-write"]);
      assert.match(await page.evaluate<string>("navigator.clipboard.readText()"), /^Please test how FengSui works with this router \(B535-232\)/, "the prompt is copied");
      await page.waitUntil("document.querySelector('#settingsDialog [data-agent-test=status]')?.textContent.includes('Ending the test puts back')", "the test in progress");
      assert.equal(await page.evaluate<boolean>("document.querySelector('#settingsDialog [data-agent-test=token]') === null"), true, "nothing left to choose");

      await page.clickText("#settingsDialog [data-agent-test=prompt] button", "End test");
      await until(() => other.stack.settings.agentTest === null, "the test ended");
      assert.deepEqual([other.stack.settings.behaviourOverrides, other.stack.settings.disabledWrites], [{}, []]);
      assert.equal(other.stack.scheduler.device.writeAccess("bandLock"), "experimental", "ending the test leaves the writes on");
      assert.deepEqual(other.stack.settings.listTokens().find((t) => t.id === agent.id)?.permissions, ["sms-read"]);
      await page.waitUntil(`document.querySelector(${JSON.stringify(start)})?.textContent.includes('Copy prompt and start test')`, "ready to start again");

      // Unticked, SMS stays out: the rest goes on
      await page.click(start);
      await page.waitUntil(isOpen("confirmDialog"), "the confirmation again");
      await page.evaluate("(() => { const box = document.getElementById('confirmCheckInput'); box.click(); return box.checked; })()");
      await page.click("#confirmOk");
      await until(() => other.stack.settings.agentTest !== null, "the test started without SMS");
      assert.deepEqual(other.stack.settings.behaviourOverrides, { agentExperimental: true, agentWrites: true });
      assert.deepEqual(other.stack.settings.listTokens().find((t) => t.id === agent.id)?.permissions, ["sms-read", "control"]);
      assert.equal(other.stack.settings.agentTest?.sms, false);
      // The daemon has the test before the page shows its answer: wait for the button, not just the daemon
      await page.waitUntil("[...document.querySelectorAll('#settingsDialog [data-agent-test=prompt] button')].some((b) => b.textContent.includes('End test'))", "the test in progress again");
      await page.clickText("#settingsDialog [data-agent-test=prompt] button", "End test");
      await until(() => other.stack.settings.agentTest === null, "ended again");
      assert.deepEqual(page.exceptions, []);
      await closeDialogs(page);
    } finally {
      await other.close();
    }
  });

  it("puts the reminder in a system notification while the console is in a background tab, and a click on it reads the reminder", async () => {
    const other = await world({ scenario: "unverified" });
    try {
      other.stack.agentTest.begin({ model: "B535-232" });
      await signIn(page, other);
      // A tab in the background whose notifications are allowed: stand-ins record what the page shows
      await page.evaluate(`(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
        window.__notices = [];
        window.Notification = class {
          static permission = 'granted';
          static requestPermission() { return Promise.resolve('granted'); }
          constructor(title, options) { this.title = title; this.options = options; this.listeners = {}; window.__notices.push(this); }
          addEventListener(name, fn) { this.listeners[name] = fn; }
          close() { this.closed = true; }
        };
        return true;
      })()`);
      const record = other.stack.settings.agentTest;
      assert.ok(record);
      other.stack.settings.setAgentTest({ ...record, lastActivityAtIso: new Date(Date.now() - 4 * 3_600_000).toISOString() });
      other.stack.agentTest.check();
      await page.waitUntil("window.__notices.length === 1", "the system notification");
      assert.equal(await page.evaluate<string>("window.__notices[0].title"), "FengSui · What the AI agent test turned on is still on");
      assert.match(await page.evaluate<string>("window.__notices[0].options.body"), /^What the AI agent test turned on is still on \(B535-232\)/);
      assert.equal(other.stack.settings.agentTest?.acknowledgedAtIso, null, "a notification is not a read");
      await page.evaluate("window.__notices[0].listeners.click(); true");
      await page.waitUntil(isOpen("alertsDialog"), "the alerts it opens");
      await until(() => other.stack.settings.agentTest?.acknowledgedAtIso !== null, "the reminder read");
      assert.deepEqual(page.exceptions, []);
      await closeDialogs(page);
    } finally {
      await other.close();
    }
  });

  it("names the page's live updates in words where there is room, and draws no bare dot where there is not", async () => {
    const d = live();
    const pill = (): Promise<{ display: string; text: string; labelWidth: number; title: string }> =>
      page.evaluate(
        `(() => { const el = document.getElementById('ssePill'); const label = el.querySelector('[data-role=text]'); return { display: getComputedStyle(el).display, text: label.textContent, labelWidth: Math.round(label.getBoundingClientRect().width), title: el.title }; })()`
      );
    // A wide screen: the pill with its label
    await signIn(page, d, { width: 1600, height: 900, scale: 1, mobile: false });
    await page.waitUntil("document.querySelector('#ssePill [data-role=text]').textContent === 'Live updates'", "the live stream");
    const wide = await pill();
    assert.notEqual(wide.display, "none");
    assert.deepEqual([wide.text, wide.title], ["Live updates", "Live updates · The page updates by itself; no need to reload"]);
    assert.ok(wide.labelWidth > 40, `the label is drawn (${wide.labelWidth}px)`);
    // A medium screen has no room for the label: while the page is live, no pill at all (it used to be a dot alone)
    await signIn(page, d, { width: 1280, height: 800, scale: 1, mobile: false });
    await page.waitUntil("document.querySelector('#ssePill [data-role=text]').textContent === 'Live updates'", "the live stream");
    assert.equal((await pill()).display, "none");
    // Not receiving updates is said there, in words
    await page.evaluate("(() => { const el = document.getElementById('ssePill'); el.classList.remove('2xl:inline-flex'); el.classList.add('lg:inline-flex'); el.querySelector('[data-role=text]').textContent = 'Live updates: reconnecting'; return true; })()");
    const stale = await pill();
    assert.notEqual(stale.display, "none");
    assert.ok(stale.labelWidth > 40, `the label is drawn (${stale.labelWidth}px)`);
    assert.deepEqual(page.exceptions, []);
  });

  it("keeps every header button on screen at any width, in both languages, however long the status pills get", async () => {
    // The longest header: a model nobody verified whose owner turned every write off (the badge says both)
    const other = await world({ scenario: "unverified" });
    const offscreen: string[] = [];
    try {
      const deadline = Date.now() + 8000;
      while (other.stack.scheduler.device.writeState("bandLock") !== "enabled") {
        assert.ok(Date.now() < deadline, "the router is identified");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      for (const feature of ["bandLock", "reboot", "reconnect", "mobileData", "smsWrite"] as const) other.stack.settings.disableWrite("B535-232", feature);
      other.stack.scheduler.device.setDisabledWrites(other.stack.settings.disabledWrites);
      for (const locale of ["en", "zh-CN"]) {
        for (const width of [640, 768, 1024, 1180, 1280, 1366]) {
          await signIn(page, other, { width, height: 800, scale: 1, mobile: false });
          await page.evaluate(`localStorage.setItem("fengsui.locale", ${JSON.stringify(locale)}); true`);
          await page.goto(`${other.baseUrl}/`);
          await page.waitUntil(visible("appView"), "the console");
          await page.waitUntil("document.getElementById('readOnlyBadge').offsetWidth > 0 && document.querySelector('#readOnlyBadge [data-role=text]').textContent !== ''", "the model badge");
          const over = await page.evaluate<number>("Math.round(Math.max(0, ...[...document.querySelectorAll('.fs-header button, .fs-header a')].map((el) => el.getBoundingClientRect().right - window.innerWidth)))");
          if (over > 0) offscreen.push(`${locale} ${width}px: ${over}px`);
        }
      }
      assert.deepEqual(offscreen, []);
      assert.deepEqual(page.exceptions, []);
    } finally {
      await page.evaluate(`localStorage.setItem("fengsui.locale", "en"); true`).catch(() => undefined);
      await other.close();
    }
  });
});

describe("the console on routers of other brands", () => {
  let chrome: ChromeHandle | null = null;
  let page: Page;

  before(async () => {
    assert.ok(fs.existsSync(path.join(ROOT, "dist", "web", "public", "index.html")), "build the console first: npm run build:web");
    chrome = await launchChrome();
    page = await openPage(chrome);
  });

  after(async () => {
    if (chrome) await closeChrome(chrome);
  });

  /** A daemon on another brand's router, identified and with its slow reads done. */
  async function brand(scenario: "zte" | "nradio" | "openwrt"): Promise<DemoDaemon> {
    const demo = await startDemoDaemon({ port: 0, token: TOKEN, scenario });
    await demo.stack.monitor.identifyDevice();
    await Promise.allSettled([demo.stack.monitor.refreshTopology({ ignoreCooldown: true }), demo.stack.monitor.refreshNeighbors({ ignoreCooldown: true })]);
    return demo;
  }

  it("shows a ZTE mobile router's battery, SIM card, ICCID and sensors, and fits a phone screen", async () => {
    const demo = await brand("zte");
    try {
      await signIn(page, demo);
      await page.waitUntil("document.getElementById('healthCard').textContent.includes('Battery')", "the battery row");
      const health = await page.evaluate<string>("document.getElementById('healthCard').textContent");
      assert.match(health, /Battery\s*\d+% · on battery/);
      assert.match(health, /4G modem 41 · 5G modem 44 · PA 39 · Wi-Fi 47 · Battery 34 °C/, "each sensor apart");
      assert.match(health, /Router load\s*CPU 18% · memory 46%/);
      assert.match(health, /Firmware update\s*Available/);
      assert.match(health, /Uptime\s*—/, "no uptime of the router's own");
      const operator = await page.evaluate<string>("document.getElementById('operatorCard').textContent");
      assert.match(operator, /SIM\s*Ready/);
      assert.match(operator, /SIM slot\s*\??\s*Physical card/);
      assert.match(operator, /PIN\s*\??\s*Off · PIN 3 · PUK 10 tries left/);
      assert.match(operator, /Roaming\s*\??\s*Not roaming/);
      // The ICCID is masked until the identity card is revealed
      const identity = await page.evaluate<string>("document.getElementById('identityCard').textContent");
      assert.match(identity, /ICCID\s*893530\*{13}/);
      assert.doesNotMatch(identity, /8935301000000000000/);
      await signIn(page, demo, PHONE);
      assert.equal(await sidewaysOverflow(page), 0, "the new rows fit a phone screen");
      assert.deepEqual(page.exceptions, []);
    } finally {
      await demo.close();
    }
  });

  it("offers a driver brand's antenna in the controls drawer, asks first, and writes the router's own code", async () => {
    const demo = await brand("nradio");
    try {
      await signIn(page, demo);
      await page.click('[data-action="open-controls"]');
      await page.waitUntil(isOpen("controlsDialog"), "the controls drawer");
      await page.waitUntil(`[...document.querySelectorAll('#controlsDialog button')].some((b) => b.textContent.trim() === 'External')`, "the antenna section");
      await page.evaluate(`[...document.querySelectorAll('#controlsDialog button')].find((b) => b.textContent.trim() === 'External').click(); true`);
      await page.waitUntil(isOpen("confirmDialog"), "the antenna's confirmation");
      assert.match(await page.evaluate<string>("document.getElementById('confirmDialog').textContent"), /never checked on a real router/);
      await page.click("#confirmOk");
      await until(() => demo.stack.scheduler.genericWrites.some((w) => w.feature === "antenna"), "the antenna write");
      const write = demo.stack.scheduler.genericWrites.find((w) => w.feature === "antenna");
      assert.deepEqual([write?.endpoints, write?.readback], [["nradio:/api/device/antenna_set_type"], "match"]);
      assert.deepEqual(page.exceptions, []);
      await closeDialogs(page);
    } finally {
      await demo.close();
    }
  });

  /** Open the controls drawer and wait for the cellular settings to be read and drawn. */
  async function openCellular(row: string): Promise<void> {
    await page.click('[data-action="open-controls"]');
    await page.waitUntil(isOpen("controlsDialog"), "the controls drawer");
    await page.waitUntil(`document.querySelector('#controlsDialog [data-section="cellular"][data-loaded="1"] [data-cellular="${row}"]') !== null`, `the ${row} row of the cellular settings, once they are read`);
  }
  const cellularRows = `[...document.querySelectorAll('#controlsDialog [data-section="cellular"] [data-cellular]')].map((el) => el.dataset.cellular)`;
  const confirmText = "document.getElementById('confirmDialog').textContent";

  it("shows a ZTE router's cellular settings, asks before each write with what it risks, and sends it once", async () => {
    const demo = await brand("zte");
    try {
      await signIn(page, demo);
      await openCellular("ussd");
      // What ZTE's goform pages have: no airplane switch, no counters to clear
      assert.deepEqual(await page.evaluate<string[]>(cellularRows), ["networkMode", "operatorSelect", "simSlot", "simPin", "roaming", "apn", "dataLimit", "ussd"]);

      // The network mode: the confirmation says the setting is put back if the internet stays down
      await page.evaluate(`(() => { const select = document.querySelector('[data-cellular="networkMode"] select'); select.value = 'lte'; select.dispatchEvent(new Event('change')); return true; })()`);
      await page.click('[data-cellular="networkMode"] button');
      await page.waitUntil(isOpen("confirmDialog"), "the mode's confirmation");
      const modeText = await page.evaluate<string>(confirmText);
      assert.match(modeText, /Switch to "4G only"/);
      assert.match(modeText, /more than 3 minutes after the change, FengSui puts this setting back/);
      assert.match(modeText, /never checked on a real router/);
      await page.click("#confirmOk");
      await until(() => demo.stack.scheduler.genericWrites.some((w) => w.feature === "networkMode"), "the mode write");
      const mode = demo.stack.scheduler.genericWrites.find((w) => w.feature === "networkMode");
      assert.deepEqual([mode?.endpoints, mode?.readback], [["zte-goform:SET_BEARER_PREFERENCE"], "match"]);
      await page.waitUntil(`document.querySelector('[data-section="cellular"]').textContent.includes('Now: 4G only')`, "the mode the router reads back");

      // The PIN: the attempts the router reports are in the confirmation, and a cancel sends nothing
      await page.evaluate(`(() => { const pin = document.querySelector('[data-cellular="simPin"] input'); pin.value = '1234'; return true; })()`);
      await page.click('[data-cellular="simPin"] button');
      await page.waitUntil(isOpen("confirmDialog"), "the PIN's confirmation");
      assert.match(await page.evaluate<string>(confirmText), /The router reports 3 attempts left\. FengSui sends this once and does not try again/);
      await page.evaluate(`document.getElementById('confirmDialog').close(); true`);
      assert.equal(demo.stack.scheduler.genericWrites.filter((w) => w.feature === "simPin").length, 0, "nothing sent on a cancel");

      // USSD: the operator's answer is shown as text, and neither it nor the code is kept anywhere
      await page.evaluate(`(() => { const code = document.querySelector('[data-cellular="ussd"] input'); code.value = '*100#'; return true; })()`);
      await page.click('[data-cellular="ussd"] button');
      await page.waitUntil(isOpen("confirmDialog"), "the USSD confirmation");
      assert.match(await page.evaluate<string>(confirmText), /Some codes order a service or cost money/);
      await page.click("#confirmOk");
      await page.waitUntil(`document.querySelector('[data-ussd-answer="answered"]') !== null`, "the operator's answer");
      assert.match(await page.evaluate<string>(`document.querySelector('[data-ussd-answer]').textContent`), /^Carrier-Lab: your balance is/);
      const kept = JSON.stringify([demo.stack.scheduler.genericWrites, demo.stack.scheduler.getStatus()]);
      assert.ok(!kept.includes("*100#") && !kept.includes("your balance"), "neither the code nor the answer is in a record");
      assert.deepEqual(page.exceptions, []);
      await closeDialogs(page);
      await signIn(page, demo, PHONE);
      await openCellular("ussd");
      assert.equal(await sidewaysOverflow(page), 0, "the cellular settings fit a phone screen");
      await closeDialogs(page);
    } finally {
      await demo.close();
    }
  });

  it("says before airplane mode goes on that only FengSui turns it off again, and offers no PIN without an attempts count", async () => {
    const demo = await brand("openwrt");
    try {
      await signIn(page, demo);
      await openCellular("airplaneSwitch");
      const rows = await page.evaluate<string[]>(cellularRows);
      assert.ok(rows.includes("networkMode") && rows.includes("operatorSelect") && rows.includes("apn") && !rows.includes("ussd"), rows.join(","));
      await page.click('[data-cellular="airplaneSwitch"] input[type="checkbox"]');
      await page.waitUntil(isOpen("confirmDialog"), "the airplane mode confirmation");
      const text = await page.evaluate<string>(confirmText);
      assert.match(text, /disconnects from the mobile network until you come back to FengSui and turn it off/);
      assert.match(text, /only turn airplane mode off from the local network/);
      await page.click("#confirmOk");
      await until(() => demo.stack.scheduler.genericWrites.some((w) => w.feature === "airplaneSwitch"), "the airplane mode write");
      assert.deepEqual(demo.stack.scheduler.genericWrites.find((w) => w.feature === "airplaneSwitch")?.endpoints, ["openwrt:AT+CFUN"]);
      // An access point on OpenWrt takes a name and a type: no user name or password field
      await page.click('[data-cellular="apn"] [data-apn-mode="manual"]');
      await page.waitUntil(`document.querySelector('[data-cellular="apn"] input[type="text"]') !== null`, "the access point form");
      assert.equal(await page.evaluate<number>(`document.querySelectorAll('[data-cellular="apn"] input[type="password"]').length`), 0);
      assert.deepEqual(page.exceptions, []);
      await closeDialogs(page);
    } finally {
      await demo.close();
    }
  });

  it("marks a device whose link the router does not say (a DHCP lease) as such, not as wired", async () => {
    const demo = await brand("openwrt");
    try {
      await signIn(page, demo);
      await page.waitUntil("document.getElementById('topologyCard').textContent.includes('printer')", "the device list");
      assert.match(await page.evaluate<string>("document.getElementById('topologyCard').textContent"), /Link not reported/);
      assert.deepEqual(page.exceptions, []);
    } finally {
      await demo.close();
    }
  });
});
