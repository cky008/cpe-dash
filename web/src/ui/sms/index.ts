import type { EnrichedSmsMessage, SmsThreadDetail, SmsThreadSummary } from "../../../../src/api-contract.ts";
import { MAX_SMS_SEGMENTS, detectSmsTextMode } from "../../../../src/sms/text-mode.ts";
import { ApiError } from "../../core/api.ts";
import { canWrite, unavailableSection, writeState } from "../../core/device-access-view.ts";
import type { ThreadFilter } from "../../core/endpoints.ts";
import { DASH } from "../../core/format.ts";
import { formatDayLabel, formatShortTime, parseMsgTime, threadGroup } from "../../core/sms.ts";
import type { MessageKey } from "../../i18n/zh-CN.ts";
import type { AppContext } from "../context.ts";
import { byId, debounce, h, icon, mount, replay, show } from "../dom.ts";
import { VIEW_EVENT, type ViewName } from "../header.ts";
import { revealButton } from "../sensitive.ts";
import { emptyState, unavailableState } from "../widgets.ts";
import { openCompose } from "./compose.ts";
import { openContacts } from "./contacts.ts";
import { sendAndReport } from "./send.ts";
import { SMS_SCOPE, type SendNotice, type SmsShared, avatar, copyOtp, countryName, isBrandSender, messageBody, otpChip, senderTitle, shownNumber } from "./shared.ts";

const FILTERS: ReadonlyArray<{ id: ThreadFilter; key: MessageKey; icon: string; cls: string; empty: MessageKey }> = [
  { id: "all", key: "sms.inbox", icon: "inbox", cls: "text-primary", empty: "sms.all_empty" },
  { id: "unread", key: "sms.unread", icon: "unread", cls: "text-warning", empty: "sms.unread_empty" },
  { id: "otp", key: "sms.otp", icon: "key", cls: "text-success", empty: "sms.otp_empty" },
];

const GROUP_KEYS: Readonly<Record<ReturnType<typeof threadGroup>, MessageKey>> = {
  today: "sms.group_today",
  yesterday: "sms.group_yesterday",
  week: "sms.group_week",
  month: "sms.group_month",
  earlier: "sms.group_earlier",
};

/** Messages closer than this (same direction, same day) join into one bubble group. */
const GROUP_GAP_MS = 5 * 60_000;

export function mountSms(ctx: AppContext, initiallyVisible: boolean): void {
  const view = byId("smsView");
  const sidebar = byId("smsSidebar");
  const listPane = byId("smsListPane");
  const chatPane = byId("smsChatPane");

  let filter: ThreadFilter = "all";
  let search = "";
  let threads: SmsThreadSummary[] = [];
  let navCounts = { all: 0, unread: 0, otp: 0 };
  let selectedKey: string | null = null;
  let thread: SmsThreadDetail | null = null;
  let notice: SendNotice | null = null;
  let visible = initiallyVisible;
  let dirty = true;
  let syncing = false;
  const seenLatest = new Map<string, string>();
  const renderedUids = new Set<string>();
  let renderedThreadKey: string | null = null;

  const shared: SmsShared = {
    contacts: [],
    countries: [],
    defaultCountryCode: ctx.store.state.sms?.defaultCountryCode ?? "",
    reload: () => reload(),
    openThread: (key) => openThread(key),
    setNotice: (next) => {
      notice = next;
      renderNotice();
    },
    openCompose: (prefill) => openCompose(ctx, shared, prefill),
    openContacts: (prefill) => openContacts(ctx, shared, prefill),
  };

  // ── Static skeleton ────────────────────────────────────────────────────────
  const searchInput = h("input", { attrs: { type: "search", autocomplete: "off", "aria-label": ctx.t("sms.search") } });
  const listTitle = h("h1", { class: "serif text-2xl font-bold leading-none" });
  const listTitleIcon = h("span", { class: "text-[1.35rem]" });
  const listCount = h("span", { class: "ml-auto text-sm muted num" });
  const privacySlot = h("span");
  const mobileFilters = h("div", { class: "fs-seg md:hidden w-full" });
  const threadList = h("div", { class: "flex-1 overflow-y-auto px-2.5 pb-28" });
  /** A model FengSui was not verified on is read-only: messages are shown, never sent, marked or deleted. */
  // A model nobody verified writes SMS only once its owner turned the experimental SMS writes on
  const locked = (): boolean => !canWrite(ctx.store.state.scheduler, "smsWrite");
  const fab = h("button", { class: "fab-compose btn btn-primary btn-circle size-13 absolute right-5 bottom-6 z-10", attrs: { type: "button" } }, icon("plus", "text-2xl"));
  fab.addEventListener("click", () => shared.openCompose());
  const listHeader = h(
    "header",
    { class: "px-4 pt-5 pb-3 space-y-3 shrink-0" },
    h("div", { class: "flex items-center gap-2.5" }, listTitleIcon, listTitle, listCount, privacySlot),
    h("label", { class: "field-soft" }, icon("search"), searchInput, h("kbd", { class: "kbd kbd-xs hidden md:inline-flex opacity-60" }, "/")),
    mobileFilters
  );

  const messagesList = h("div", { class: "flex-1 overflow-y-auto" });
  const noticeSlot = h("div", { class: "px-4 md:px-6" });
  const replyArea = h("textarea", { attrs: { rows: "1" } });
  const replyHint = h("span", { class: "text-[11px] faint truncate" });
  const replyMode = h("span", { class: "ml-auto text-[11px] faint num whitespace-nowrap" });
  const replySend = h("button", { class: "btn btn-primary btn-circle btn-sm", attrs: { type: "submit" } }, icon("arrow-up", "text-base"));
  const replyForm = h(
    "form",
    { class: "px-4 md:px-6 pb-4 pt-2 shrink-0" },
    h("div", { class: "composer mx-auto max-w-3xl" }, replyArea, h("div", { class: "flex items-center gap-2 pl-4 pr-2 pb-2" }, replyHint, replyMode, replySend))
  );
  const nonDialable = h("div", { class: "px-6 py-4 text-xs muted flex items-center justify-center gap-1.5" });
  const chatHeader = h("header", { class: "px-4 md:px-6 pt-4 pb-3 flex items-center gap-3 shrink-0 border-b border-base-content/[0.06]" });
  const chatEmpty = h("div", { class: "flex-1 flex flex-col items-center justify-center gap-5 p-8 text-center anim-fade" });
  const chatActive = h("div", { class: "hidden flex-1 flex flex-col min-h-0" }, chatHeader, messagesList, noticeSlot, nonDialable, replyForm);
  /** The two panes as built here (again after a router without SMS made way for one that has it). */
  const mountPanes = (): void => {
    mount(listPane, listHeader, threadList, fab);
    mount(chatPane, chatEmpty, chatActive);
  };
  mountPanes();

  // ── Data ───────────────────────────────────────────────────────────────────
  const loadThreads = async (): Promise<void> => {
    const res = await ctx.api.smsThreads(filter, search);
    threads = res.threads;
    ctx.store.update({ sms: res.status, smsEnabled: true }, ["sms"]);
    if (filter === "all" && !search) {
      navCounts = { all: threads.length, unread: res.status.mirror.unreadTotal, otp: threads.filter((t) => t.hasOtp).length };
    }
    renderThreadList();
    renderSidebar();
  };

  const loadActiveThread = async (preserveScroll: boolean): Promise<void> => {
    const key = selectedKey;
    if (!key) return;
    const res = await ctx.api.smsThread(key);
    if (selectedKey !== key) return;
    thread = res.thread;
    renderConversation({ preserveScroll });
  };

  const reload = async (): Promise<void> => {
    if (!ctx.store.state.smsEnabled) return;
    try {
      await loadThreads();
      await loadActiveThread(true);
      dirty = false;
    } catch (err) {
      if (err instanceof ApiError && err.kind === "sms_disabled") {
        ctx.store.update({ smsEnabled: false }, ["sms"]);
        renderDisabled();
        return;
      }
      ctx.toast(ctx.describeError(err), "error");
    }
  };

  const loadReference = async (): Promise<void> => {
    const [countries, contacts] = await Promise.allSettled([ctx.api.smsCountries(), ctx.api.smsContacts()]);
    if (countries.status === "fulfilled") {
      shared.countries = countries.value.countries;
      shared.defaultCountryCode = countries.value.defaultCountryCode;
    }
    if (contacts.status === "fulfilled") shared.contacts = contacts.value.contacts;
    renderSidebar();
  };

  const openThread = async (key: string): Promise<void> => {
    selectedKey = key;
    for (const row of threadList.querySelectorAll<HTMLElement>("[data-thread-key]")) row.classList.toggle("is-active", row.dataset["threadKey"] === key);
    view.dataset["mobileView"] = "chat";
    try {
      await loadActiveThread(false);
    } catch (err) {
      ctx.toast(ctx.describeError(err), "error");
    }
  };

  // ── Sidebar ────────────────────────────────────────────────────────────────
  const renderSidebar = (): void => {
    const status = ctx.store.state.sms;
    const counters = status?.counters;
    const used = counters ? counters.localInbox + counters.localOutbox + counters.localDraft : 0;
    const pct = counters && counters.localMax > 0 ? Math.min(100, (used / counters.localMax) * 100) : 0;
    const syncBtn = h("button", { class: "btn btn-ghost btn-sm rounded-lg justify-start gap-2 font-normal", attrs: { type: "button" } }, icon("refresh", syncing ? "animate-spin" : ""), ctx.t(syncing ? "sms.syncing" : "sms.sync"));
    syncBtn.disabled = syncing;
    syncBtn.addEventListener("click", () => void fullSync());
    mount(
      sidebar,
      ...FILTERS.map((f) => {
        const count = navCounts[f.id];
        return h(
          "button",
          { class: `nav-item ${filter === f.id ? "is-active" : ""}`, attrs: { type: "button" }, on: { click: () => setFilter(f.id) } },
          icon(f.icon, f.cls),
          ctx.t(f.key),
          h("span", { class: "count" }, count > 0 ? String(count) : "")
        );
      }),
      h(
        "button",
        { class: "nav-item mt-4", attrs: { type: "button" }, on: { click: () => shared.openContacts() } },
        icon("contacts", "text-secondary"),
        ctx.t("sms.contacts"),
        h("span", { class: "count" }, shared.contacts.length > 0 ? String(shared.contacts.length) : "")
      ),
      h("div", { class: "flex-1" }),
      h(
        "div",
        { class: "rounded-xl border border-base-content/[0.07] bg-base-100/60 p-3 text-xs space-y-2" },
        h("div", { class: "flex justify-between muted" }, h("span", null, ctx.t("sms.storage")), h("span", { class: "num" }, counters ? `${used} / ${counters.localMax}` : DASH)),
        h("div", { class: `fs-meter ${pct >= 90 ? "text-error" : pct >= 75 ? "text-warning" : "text-primary"}` }, h("span", { style: `width:${pct.toFixed(1)}%` })),
        h("div", { class: "faint flex items-center gap-1.5" }, icon("lock"), ctx.t("sms.mirror", { count: status?.mirror.messagesTotal ?? 0 })),
        status?.syncPending ? h("div", { class: "text-warning flex items-center gap-1.5" }, icon("history"), ctx.t("sms.pending_sync")) : null,
        status?.storageFull ? h("div", { class: "text-error flex items-center gap-1.5" }, icon("alert"), ctx.t("sms.storage_full")) : null
      ),
      syncBtn
    );
    mount(
      mobileFilters,
      ...FILTERS.map((f) =>
        h("button", { class: filter === f.id ? "is-active flex-1 justify-center" : "flex-1 justify-center", attrs: { type: "button" }, on: { click: () => setFilter(f.id) } }, ctx.t(f.key))
      ),
      h("button", { class: "flex-1 justify-center", attrs: { type: "button" }, on: { click: () => shared.openContacts() } }, ctx.t("sms.contacts"))
    );
  };

  const fullSync = async (): Promise<void> => {
    syncing = true;
    renderSidebar();
    try {
      const res = await ctx.api.smsSync("full");
      ctx.store.update({ sms: res.status }, ["sms"]);
      if (res.summary) ctx.toast(ctx.t("toast.sync_done", { added: res.summary.added, updated: res.summary.updated, removed: res.summary.removed }), "success");
      else ctx.toast(ctx.t("toast.sync_yielded"), "warning");
      await reload();
    } catch (err) {
      ctx.toast(ctx.describeError(err), "error");
    } finally {
      syncing = false;
      renderSidebar();
    }
  };

  const setFilter = (next: ThreadFilter): void => {
    filter = next;
    renderListHeader();
    renderSidebar();
    void loadThreads().catch((err: unknown) => ctx.toast(ctx.describeError(err), "error"));
  };

  // ── Thread list ────────────────────────────────────────────────────────────
  const renderListHeader = (): void => {
    const meta = FILTERS.find((f) => f.id === filter) ?? FILTERS[0];
    if (!meta) return;
    listTitle.textContent = ctx.t(meta.key);
    mount(listTitleIcon, icon(meta.icon, `${meta.cls} anim-pop-in`));
    searchInput.placeholder = ctx.t("sms.search");
    searchInput.setAttribute("aria-label", ctx.t("sms.search"));
    mount(privacySlot, revealButton(ctx, SMS_SCOPE));
    fab.title = ctx.t("sms.new");
    fab.setAttribute("aria-label", ctx.t("sms.new"));
  };

  const renderThreadList = (): void => {
    listCount.textContent = threads.length > 0 ? String(threads.length) : "";
    const meta = FILTERS.find((f) => f.id === filter) ?? FILTERS[0];
    if (threads.length === 0 || !meta) {
      mount(threadList, emptyState(meta?.icon ?? "inbox", ctx.t(search ? "sms.no_match" : (meta?.empty ?? "sms.all_empty")), filter === "all" && !search ? ctx.t("sms.all_empty_hint") : undefined));
      return;
    }
    const firstRender = seenLatest.size === 0;
    const nodes: HTMLElement[] = [];
    let lastGroup = "";
    threads.forEach((t, i) => {
      const group = threadGroup(t.latestMessage.date);
      if (group !== lastGroup) {
        nodes.push(h("div", { class: "section-head" }, ctx.t(GROUP_KEYS[group])));
        lastGroup = group;
      }
      const prev = seenLatest.get(t.threadKey);
      seenLatest.set(t.threadKey, t.latestMessage.uid);
      const fresh = !firstRender && prev !== t.latestMessage.uid;
      const unread = t.unreadCount > 0;
      const title = senderTitle(ctx, t.sender, t.contact, t.phone);
      const preview = (t.matchedPreview ?? t.latestMessage.content).replace(/\s+/g, " ");
      nodes.push(
        h(
          "div",
          {
            class: `thread-row ${t.threadKey === selectedKey ? "is-active" : ""} ${fresh ? "anim-flash" : ""}`,
            attrs: { role: "button", tabindex: "0" },
            data: { threadKey: t.threadKey },
            style: `--i:${i}`,
          },
          avatar(t.contact?.name ?? t.displayName, { brand: isBrandSender(t.sender), known: Boolean(t.contact), size: "size-10 text-sm" }),
          h(
            "div",
            { class: "min-w-0 flex-1" },
            h(
              "div",
              { class: "flex items-center gap-2" },
              h("span", { class: `truncate text-[15px] ${unread ? "font-bold" : "font-semibold"}` }, title),
              h("span", { class: `ml-auto shrink-0 text-xs num ${unread ? "text-primary font-medium" : "faint"}` }, formatShortTime(t.latestMessage.date, ctx.tr.locale))
            ),
            h(
              "div",
              { class: "mt-0.5 flex items-start gap-2" },
              h(
                "p",
                { class: `flex-1 text-[13px] leading-snug line-clamp-2 ${unread ? "text-base-content/80" : "text-base-content/50"}` },
                t.latestMessage.direction === "out" ? h("span", { class: "faint" }, ctx.t("chat.me")) : null,
                ...messageBody(ctx, preview, t.latestMessage.verificationCode)
              ),
              unread
                ? t.unreadCount > 1
                  ? h("span", { class: "badge badge-primary badge-sm rounded-full font-semibold num mt-0.5" }, String(t.unreadCount))
                  : h("span", { class: "unread-dot mt-1.5" })
                : null
            ),
            t.latestOtp ? h("div", { class: "mt-1.5" }, otpChip(ctx, t.latestOtp, false)) : null
          )
        )
      );
    });
    mount(threadList, ...nodes);
  };

  threadList.addEventListener("click", (event) => {
    const el = event.target instanceof Element ? event.target : null;
    const chip = el?.closest<HTMLElement>("[data-copy-otp]");
    if (chip) {
      event.stopPropagation();
      void copyOtp(ctx, chip);
      return;
    }
    const key = el?.closest<HTMLElement>("[data-thread-key]")?.dataset["threadKey"];
    if (key) void openThread(key);
  });
  threadList.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    // The code chip is a button of its own: Enter or Space there copies the code (its click), not open the thread
    if (event.target instanceof Element && event.target.closest("[data-copy-otp]")) return;
    const key = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-thread-key]")?.dataset["threadKey"] : undefined;
    if (key) {
      event.preventDefault();
      void openThread(key);
    }
  });
  searchInput.addEventListener(
    "input",
    debounce(() => {
      search = searchInput.value;
      void loadThreads().catch((err: unknown) => ctx.toast(ctx.describeError(err), "error"));
    }, 180)
  );

  // ── Conversation ───────────────────────────────────────────────────────────
  const renderEmptyChat = (): void => {
    show(fab, !locked());
    const newBtn = h("button", { class: "btn btn-primary btn-sm rounded-lg gap-1.5", attrs: { type: "button" } }, icon("plus"), ctx.t("sms.new"));
    newBtn.addEventListener("click", () => shared.openCompose());
    mount(
      chatEmpty,
      h("div", { class: "size-20 rounded-[1.75rem] bg-base-200 grid place-items-center faint" }, icon("message", "text-4xl")),
      h("div", { class: "space-y-1.5" }, h("h2", { class: "text-base font-semibold serif" }, ctx.t("chat.empty_title")), h("p", { class: "text-sm muted max-w-xs" }, ctx.t("chat.empty_desc"))),
      locked() ? h("p", { class: "text-xs muted max-w-xs flex items-center gap-1.5" }, icon("lock"), ctx.t("dev.sms_read_only")) : newBtn,
      locked() ? null : h("p", { class: "text-xs faint hidden md:block" }, h("kbd", { class: "kbd kbd-xs" }, "N"), ` ${ctx.t("sms.new")} · `, h("kbd", { class: "kbd kbd-xs" }, "/"), ` ${ctx.t("sms.search")}`),
      // Turned on as an experimental write on a model nobody verified: say how it differs
      writeState(ctx.store.state.scheduler, "smsWrite") === "consented"
        ? h("p", { class: "text-xs text-warning max-w-xs flex items-start gap-1.5" }, icon("alert", "mt-0.5 shrink-0"), ctx.t("dev.sms_experimental"))
        : null
    );
  };

  const markRead = (button: HTMLButtonElement, key: string): void => {
    button.disabled = true;
    ctx.api
      .smsRead({ threadKey: key })
      .then((res) => {
        ctx.toast(ctx.t("toast.marked_read", { count: res.count }), "success");
        return reload();
      })
      .catch((err: unknown) => ctx.toast(ctx.describeError(err), "error"))
      .finally(() => {
        button.disabled = false;
      });
  };

  const deleteMessage = async (message: EnrichedSmsMessage): Promise<void> => {
    const ok = await ctx.confirm({
      title: ctx.t("chat.delete_title"),
      body: message.isUnread ? [ctx.t("chat.delete_body"), ctx.t("chat.delete_unread")] : [ctx.t("chat.delete_body")],
      confirmLabel: ctx.t("chat.delete"),
      tone: "error",
    });
    if (!ok) return;
    try {
      await ctx.api.smsDelete([message.uid]);
      ctx.toast(ctx.t("toast.deleted"), "success");
      await reload();
    } catch (err) {
      ctx.toast(ctx.describeError(err), "error");
    }
  };

  const renderConversation = (opts: { preserveScroll: boolean }): void => {
    if (!thread) {
      show(chatEmpty, true);
      show(chatActive, false);
      renderEmptyChat();
      return;
    }
    const detail = thread;
    const isSwitch = renderedThreadKey !== detail.threadKey;
    if (isSwitch) {
      renderedThreadKey = detail.threadKey;
      renderedUids.clear();
      if (notice && notice.threadKey !== detail.threadKey) notice = null;
    }
    show(chatEmpty, false);
    show(chatActive, true);
    if (isSwitch) replay(chatActive, "anim-fade");

    // Header
    const s = detail.sender;
    const title = senderTitle(ctx, s, detail.contact, detail.phone);
    const country = s.countryCode ? `${countryName(ctx, s)} ${s.countryCode}` : countryName(ctx, s);
    const number = s.e164 ?? detail.phone;
    const sub = (detail.contact ? [shownNumber(ctx, number), country, detail.contact.note ?? ""] : [s.type === "alphanumeric" ? "" : country]).filter(Boolean);
    sub.push(ctx.t("chat.records", { count: detail.messages.length }));
    const unreadCount = detail.messages.filter((m) => m.isUnread).length;
    const back = h("button", { class: "btn btn-ghost btn-sm btn-square -ml-2 md:hidden", attrs: { type: "button", "aria-label": ctx.t("chat.back") } }, icon("chevron-left", "text-xl"));
    back.addEventListener("click", () => {
      view.dataset["mobileView"] = "list";
    });
    const markBtn = h("button", { class: "btn btn-ghost btn-sm rounded-lg gap-1.5 text-primary", attrs: { type: "button" } }, icon("check-check"), `${ctx.t("chat.mark_read")} · ${unreadCount}`);
    markBtn.addEventListener("click", () => markRead(markBtn, detail.threadKey));
    const editBtn = h("button", { class: "btn btn-ghost btn-sm btn-square rounded-lg", title: ctx.t("chat.edit_contact"), attrs: { type: "button", "aria-label": ctx.t("chat.edit_contact") } }, icon("pencil", "text-base"));
    editBtn.addEventListener("click", () => shared.openContacts({ phone: s.e164 ?? detail.phone, name: detail.contact?.name ?? "", note: detail.contact?.note ?? "" }));
    mount(
      chatHeader,
      back,
      avatar(title, { brand: isBrandSender(s), known: Boolean(detail.contact), size: "size-10 text-sm", accent: true }),
      h("div", { class: "min-w-0 flex-1" }, h("h2", { class: "text-lg font-bold truncate leading-tight" }, title), h("p", { class: "text-xs muted truncate mt-0.5" }, sub.join(" · "))),
      h("div", { class: "flex items-center gap-1 shrink-0" }, unreadCount > 0 && !locked() ? markBtn : null, s.type === "alphanumeric" ? null : editBtn)
    );

    // Bubbles
    const prevScroll = messagesList.scrollTop;
    const nearBottom = messagesList.scrollHeight - messagesList.scrollTop - messagesList.clientHeight < 120;
    const nodes: HTMLElement[] = [];
    let lastDay = "";
    const msgs = detail.messages;
    msgs.forEach((m, idx) => {
      const day = m.date.split(" ")[0] ?? "";
      if (day !== lastDay) {
        nodes.push(h("div", { class: "day-sep" }, formatDayLabel(day, ctx.tr.locale)));
        lastDay = day;
      }
      const prev = msgs[idx - 1];
      const next = msgs[idx + 1];
      const joins = (a: EnrichedSmsMessage | undefined, b: EnrichedSmsMessage): boolean =>
        a !== undefined && a.direction === b.direction && (a.date.split(" ")[0] ?? "") === (b.date.split(" ")[0] ?? "") && Math.abs(parseMsgTime(b.date) - parseMsgTime(a.date)) < GROUP_GAP_MS;
      const sameAsPrev = joins(prev, m);
      const sameAsNext = next !== undefined && joins(m, next);
      const out = m.direction === "out";
      const isNew = !isSwitch && !renderedUids.has(m.uid);
      renderedUids.add(m.uid);
      const meta: Array<string | HTMLElement> = [m.date.split(" ")[1]?.slice(0, 5) ?? ""];
      if (m.isUnread) meta.push(h("span", { class: "text-primary font-medium" }, ctx.t("chat.unread")));
      if (m.pending) meta.push(h("span", { class: "text-warning font-medium" }, ctx.t("chat.pending")));
      const showMeta = !sameAsNext || m.isUnread || Boolean(m.pending) || Boolean(m.verificationCode);
      const del = h(
        "button",
        { class: "reveal-on-hover btn btn-ghost btn-xs btn-circle faint hover:text-error shrink-0", title: ctx.t("chat.delete"), attrs: { type: "button", "aria-label": ctx.t("chat.delete") } },
        icon("trash", "text-sm")
      );
      del.addEventListener("click", () => void deleteMessage(m));
      if (locked()) del.classList.add("hidden");
      nodes.push(
        h(
          "div",
          { class: `group flex flex-col ${out ? "items-end" : "items-start"} ${sameAsPrev ? "mt-0.5" : "mt-3"} ${isNew ? "anim-pop-in" : ""}` },
          h(
            "div",
            { class: `flex items-center gap-1.5 max-w-[85%] sm:max-w-[72%] ${out ? "flex-row-reverse" : ""}` },
            h(
              "div",
              { class: `bubble ${out ? "bubble-out" : "bubble-in"} ${m.pending ? "is-pending" : ""} ${sameAsPrev ? "join-top" : ""} ${sameAsNext ? "join-bottom" : ""}`, title: m.date },
              ...messageBody(ctx, m.content, m.verificationCode)
            ),
            m.pending ? null : del
          ),
          m.verificationCode ? h("div", { class: "mt-1.5" }, otpChip(ctx, m.verificationCode, true)) : null,
          showMeta ? h("div", { class: "mt-1 px-1.5 flex items-center gap-1.5 text-[11px] faint" }, ...meta.flatMap((part, i) => (i === 0 ? [part] : [h("span", null, "·"), part]))) : null
        )
      );
    });
    mount(messagesList, h("div", { class: "mx-auto max-w-3xl px-5 md:px-8 pt-2 pb-6" }, ...nodes));
    if (isSwitch || !opts.preserveScroll) {
      messagesList.scrollTop = messagesList.scrollHeight;
    } else if (nearBottom) {
      messagesList.scrollTo({ top: messagesList.scrollHeight, behavior: "smooth" });
    } else {
      messagesList.scrollTop = prevScroll;
    }

    // Composer / notices
    renderNotice();
    const dialable = detail.dialable && detail.replyPhone !== null;
    show(replyForm, dialable && !locked());
    show(nonDialable, !dialable || locked());
    if (locked()) mount(nonDialable, icon("lock"), ctx.t("dev.sms_read_only"));
    else mount(nonDialable, icon("info"), ctx.t("chat.non_dialable"));
    replyHint.textContent = detail.replyPhone ? ctx.t("chat.reply_to", { phone: shownNumber(ctx, detail.replyPhone) }) : "";
    replyArea.placeholder = ctx.t("chat.reply_placeholder");
    replySend.title = ctx.t("chat.send");
    syncComposer();
  };

  messagesList.addEventListener("click", (event) => {
    const chip = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-copy-otp]") : null;
    if (chip) void copyOtp(ctx, chip);
  });

  const renderNotice = (): void => {
    if (!notice || notice.threadKey !== thread?.threadKey) {
      mount(noticeSlot);
      return;
    }
    const dismiss = h("button", { class: "btn btn-ghost btn-xs btn-circle ml-auto shrink-0", attrs: { type: "button", "aria-label": ctx.t("common.close") } }, icon("x"));
    dismiss.addEventListener("click", () => {
      notice = null;
      renderNotice();
    });
    mount(
      noticeSlot,
      h(
        "div",
        { class: "fs-notice mx-auto max-w-3xl anim-pop-in", data: { tone: notice.tone }, attrs: { role: "alert" } },
        icon(notice.tone === "pending" ? "history" : "alert", `${notice.tone === "pending" ? "text-warning" : "text-error"} mt-0.5 text-base`),
        h("div", { class: "min-w-0" }, h("div", { class: "font-semibold" }, notice.title), h("div", { class: "muted text-xs mt-0.5" }, notice.body)),
        dismiss
      )
    );
  };

  /** A reply on its way: another press, a key repeat or typing must not post it again. */
  let replying = false;
  const syncComposer = (): void => {
    replyArea.style.height = "auto";
    replyArea.style.height = `${Math.min(replyArea.scrollHeight, 160)}px`;
    const text = replyArea.value;
    const mode = detectSmsTextMode(text);
    const enc = mode.encoding === "7BIT" ? "GSM-7" : "UCS-2";
    replyMode.textContent = text ? ctx.t("new.mode", { encoding: enc, units: mode.charUnits, segments: mode.segments }) : "";
    replyMode.classList.toggle("text-error", mode.segments > MAX_SMS_SEGMENTS);
    replySend.disabled = replying || !text.trim() || mode.segments > MAX_SMS_SEGMENTS;
  };
  replyArea.addEventListener("input", syncComposer);
  replyArea.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      if (!event.repeat) replyForm.requestSubmit();
    }
  });

  replyForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const detail = thread;
    const phone = detail?.replyPhone;
    const content = replyArea.value.trim();
    // requestSubmit() does not look at the disabled button, so the flag is what keeps it to one send
    if (replying || !detail || !phone || !content) return;
    replying = true;
    replySend.disabled = true;
    const spinner = h("span", { class: "loading loading-spinner loading-xs" });
    replySend.replaceChildren(spinner);
    notice = null;
    renderNotice();
    void sendAndReport(ctx, { phone, content, countryCode: shared.defaultCountryCode })
      .then((report) => {
        if (report.submitted) replyArea.value = "";
        notice = report.notice ? { ...report.notice, threadKey: detail.threadKey } : null;
        renderNotice();
        return reload();
      })
      .finally(() => {
        replying = false;
        replySend.replaceChildren(icon("arrow-up", "text-base"));
        syncComposer();
      });
  });

  const renderDisabled = (): void => {
    mount(listPane, emptyState("message", ctx.t("sms.disabled_title"), ctx.t("sms.disabled_body")));
    mount(chatPane);
    mount(sidebar);
  };

  /** A model without SMS (or without a listing FengSui reads): nothing to show here. */
  const renderUnavailable = (code: string | null): void => {
    mount(listPane, unavailableState(ctx.t, "message", code));
    mount(chatPane);
    mount(sidebar);
  };

  // ── Wiring ─────────────────────────────────────────────────────────────────
  const renderAll = (): void => {
    renderListHeader();
    renderSidebar();
    renderThreadList();
    renderConversation({ preserveScroll: true });
  };

  document.addEventListener(VIEW_EVENT, (event) => {
    visible = (event as CustomEvent<ViewName>).detail === "sms";
    if (visible && dirty) {
      void loadReference();
      void reload();
    }
  });
  ctx.store.subscribe("smsMessages", () => {
    if (visible) void reload();
    else dirty = true;
  });
  ctx.store.subscribe("sms", () => {
    if (!ctx.store.state.smsEnabled) renderDisabled();
    else renderSidebar();
  });
  // The router's read-only state and its SMS section, redrawn only when they change (the status polls every 10 s)
  let deviceKey = "";
  ctx.store.subscribe("scheduler", () => {
    const missing = unavailableSection(ctx.store.state.scheduler, "sms");
    const next = `${locked()}|${missing ? (missing.code ?? "-") : ""}`;
    if (next === deviceKey) return;
    const wasMissing = deviceKey.split("|")[1] !== "" && deviceKey !== "";
    deviceKey = next;
    if (missing) return renderUnavailable(missing.code);
    if (wasMissing) mountPanes();
    renderAll();
  });
  ctx.store.subscribe("contacts", () => {
    void ctx.api.smsContacts().then((res) => {
      shared.contacts = res.contacts;
      renderSidebar();
    }, () => undefined);
  });
  ctx.privacy.onChange(() => {
    renderListHeader();
    renderThreadList();
    renderConversation({ preserveScroll: true });
  });
  ctx.tr.onChange(renderAll);
  document.addEventListener("keydown", (event) => {
    if (!visible || event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("input, textarea, select, [contenteditable='true']") || document.querySelector("dialog[open]")) return;
    if ((event.key === "n" || event.key === "N") && !locked()) {
      event.preventDefault();
      shared.openCompose();
    } else if (event.key === "/") {
      event.preventDefault();
      view.dataset["mobileView"] = "list";
      searchInput.focus();
    } else if (event.key === "Escape" && view.dataset["mobileView"] === "chat") {
      view.dataset["mobileView"] = "list";
    }
  });
  renderAll();
  if (visible) {
    void loadReference();
    void reload();
  }
}
