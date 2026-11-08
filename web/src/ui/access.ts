import {
  AccessPlanError,
  type MacFilterEntry,
  type TimeRule,
  type TimeRuleInput,
  type WifiAccessChange,
  type WifiFilterMode,
  findTimeRuleConflicts,
  isDeviceBlocked,
  normalizeMac,
  normalizeTimeRuleInput,
  planWifiAccessChange,
  wifiFilterMode,
} from "../../../src/access-plan.ts";
import type { AccessControlChangeResponse, TerminalHostEntry } from "../../../src/api-contract.ts";
import { QUARTER_TIMES, dayNames, formatWeekMask, isOvernight, previewGuard, rulesByDevice } from "../core/access-view.ts";
import { type MessageParams, interpolate } from "../core/i18n.ts";
import { maskValue } from "../core/privacy.ts";
import { ACCESS_ERRORS, ACCESS_TEXT, type AccessTextKey } from "../i18n/access.ts";
import type { AppContext } from "./context.ts";
import { byId, h, icon, modalBackdrop, mount } from "./dom.ts";
import { sensitive } from "./sensitive.ts";
import { runBusy } from "./widgets.ts";

/**
 * Access-control panel (lazy chunk): the Wi-Fi MAC filter (mode, lists, add / remove) and the
 * internet time windows. Every change is previewed with src/access-plan.ts — the planner the daemon
 * enforces — confirmed, then sent with `confirm: true`; the daemon re-plans it against live router
 * state and refuses anything that would cut off FengSui's host or this device.
 */

type T = (key: AccessTextKey, params?: MessageParams) => string;

function texts(ctx: AppContext): T {
  return (key, params) => interpolate(ACCESS_TEXT[ctx.tr.locale][key], params);
}

function hosts(ctx: AppContext): ReadonlyArray<TerminalHostEntry> {
  return ctx.store.state.topology?.hosts ?? [];
}

function labelFor(ctx: AppContext, mac: string, fallback = ""): string {
  const normalized = normalizeMac(mac);
  const host = hosts(ctx).find((x) => normalizeMac(x.macAddress) === normalized);
  return host?.displayName || fallback || (ctx.privacy.isMasked("topology") ? maskValue("mac", mac) : mac);
}

function describe(ctx: AppContext, err: unknown): string {
  return err instanceof AccessPlanError ? ACCESS_ERRORS[ctx.tr.locale][err.code] : ctx.describeError(err);
}

function applied(ctx: AppContext, res: AccessControlChangeResponse): void {
  if (res.accessControl) ctx.store.update({ accessControl: res.accessControl }, ["accessControl"]);
  ctx.toast(texts(ctx)(res.changed ? "done" : "nothing"), res.changed ? "success" : "info");
}

/**
 * Preview, confirm and send one Wi-Fi change. Resolves `true` when the router accepted it.
 */
async function runWifiChange(ctx: AppContext, change: WifiAccessChange, title: string, body: ReadonlyArray<string>, confirmLabel: string): Promise<boolean> {
  const t = texts(ctx);
  const state = ctx.store.state.accessControl?.wifiMacFilter;
  if (!state) return false;
  let alsoBlocked: string[];
  try {
    const plan = planWifiAccessChange(state, change, previewGuard(ctx.store.state.accessGuard, hosts(ctx)));
    if (!plan.write) {
      ctx.toast(t("nothing"), "info");
      return false;
    }
    alsoBlocked = plan.alsoBlocked;
  } catch (err) {
    ctx.toast(describe(ctx, err), "error");
    return false;
  }
  const lines = alsoBlocked.length > 0 ? [...body, t("also_blocked", { list: alsoBlocked.map((m) => labelFor(ctx, m)).join(t("list_joiner")) })] : body;
  if (!(await ctx.confirm({ title, body: lines, confirmLabel, tone: "warning" }))) return false;
  try {
    const res =
      change.kind === "block" || change.kind === "unblock"
        ? await ctx.api.wifiAccess({ action: change.kind, macAddress: change.macAddress, name: change.name ?? "", confirm: true })
        : change.kind === "mode"
          ? await ctx.api.wifiMacFilter({ mode: change.mode, ...(change.entries ? { entries: [...change.entries] } : {}), confirm: true })
          : await ctx.api.wifiMacFilter({ add: [...(change.add ?? [])], remove: [...(change.remove ?? [])], confirm: true });
    applied(ctx, res);
    return true;
  } catch (err) {
    ctx.toast(describe(ctx, err), "error");
    return false;
  }
}

/** The topology row's "Block" / "Restore" button. */
export async function confirmDeviceAccess(ctx: AppContext, host: TerminalHostEntry, action: "block" | "unblock"): Promise<void> {
  const t = texts(ctx);
  const name = host.displayName || labelFor(ctx, host.macAddress);
  await (action === "block"
    ? runWifiChange(ctx, { kind: "block", macAddress: host.macAddress, name: host.displayName }, t("block_title", { name }), [t("block_body")], t("block"))
    : runWifiChange(ctx, { kind: "unblock", macAddress: host.macAddress, name: host.displayName }, t("unblock_title", { name }), [t("unblock_body")], t("unblock")));
}

/**
 * The topology table's access column and "Blocked" badge. Loaded with this chunk right after the
 * first paint (the table shows a dash until then), so the first-paint bundle stays small.
 */
export const topologyAccess = {
  isBlocked(ctx: AppContext, host: TerminalHostEntry): boolean {
    const filter = ctx.store.state.accessControl?.wifiMacFilter;
    return host.medium.startsWith("WIFI") && filter !== undefined && isDeviceBlocked(filter, host.macAddress);
  },

  badge(ctx: AppContext): HTMLElement {
    return h("span", { class: "fs-badge ml-1 text-error" }, texts(ctx)("blocked"));
  },

  cell(ctx: AppContext, host: TerminalHostEntry): HTMLElement {
    const t = texts(ctx);
    if (!host.medium.startsWith("WIFI") || !ctx.store.state.accessControl) return h("td", { class: "text-right faint" }, "—");
    const blocked = topologyAccess.isBlocked(ctx, host);
    const guard = ctx.store.state.accessGuard;
    const mac = normalizeMac(host.macAddress);
    const reason = mac && mac === normalizeMac(guard?.daemonHostMac ?? "") ? t("protected_daemon") : mac && mac === normalizeMac(guard?.requesterMac ?? "") ? t("protected_self") : null;
    const button = h(
      "button",
      { class: `btn btn-ghost btn-xs rounded-lg whitespace-nowrap ${blocked ? "text-success" : "text-error"}`, attrs: { type: "button" }, title: reason ?? "" },
      icon(blocked ? "unlock" : "lock"),
      t(blocked ? "unblock" : "block")
    );
    button.disabled = reason !== null && !blocked;
    button.addEventListener("click", () => runBusy(button, () => confirmDeviceAccess(ctx, host, blocked ? "unblock" : "block")));
    return h("td", { class: "text-right" }, button);
  },
};

interface RuleDraft {
  id: string | null;
  macAddress: string;
  weekMask: string;
  startTime: string;
  endTime: string;
  enabled: boolean;
}

export function mountAccessPanel(ctx: AppContext): { open(): void } {
  const dialog = byId<HTMLDialogElement>("accessDialog");
  let allowDraft: Set<string> | null = null;
  let addMac = "";
  let addName = "";
  let draft: RuleDraft | null = null;

  const refresh = (button: HTMLButtonElement): void =>
    runBusy(button, async () => {
      try {
        const res = await ctx.api.refreshAccessControl();
        ctx.store.update({ accessControl: res.accessControl, accessGuard: res.guard }, ["accessControl"]);
      } catch (err) {
        ctx.toast(describe(ctx, err), "error");
      }
    });

  const deviceTag = (mac: string): HTMLElement | null => {
    const t = texts(ctx);
    const guard = ctx.store.state.accessGuard;
    const normalized = normalizeMac(mac);
    if (normalized && normalized === normalizeMac(guard?.requesterMac ?? "")) return h("span", { class: "fs-badge ml-1" }, t("you"));
    if (normalized && normalized === normalizeMac(guard?.daemonHostMac ?? "")) return h("span", { class: "fs-badge ml-1" }, t("daemon"));
    return null;
  };

  const entryRow = (entry: MacFilterEntry, removable: boolean, listName: string): HTMLElement => {
    const t = texts(ctx);
    const name = labelFor(ctx, entry.macAddress, entry.name);
    const remove = h("button", { class: "btn btn-ghost btn-xs rounded-lg text-error", attrs: { type: "button" } }, icon("trash"), t("remove"));
    remove.addEventListener("click", () =>
      runBusy(remove, async () => {
        await runWifiChange(ctx, { kind: "entries", remove: [entry.macAddress] }, t("remove_entry_title", { name, list: listName }), [], t("remove"));
      })
    );
    return h(
      "li",
      { class: "flex items-center gap-2 py-1.5" },
      h("div", { class: "min-w-0 flex-1" }, h("div", { class: "text-sm truncate" }, name, deviceTag(entry.macAddress)), h("div", { class: "text-[0.6875rem] faint" }, sensitive(ctx, "mac", entry.macAddress, "topology"))),
      removable ? remove : null
    );
  };

  const wifiSection = (): HTMLElement => {
    const t = texts(ctx);
    const ac = ctx.store.state.accessControl;
    if (!ac) return h("div", { class: "text-sm muted" }, t("loading"));
    const f = ac.wifiMacFilter;
    const mode = wifiFilterMode(f);
    const listPolicy = f.policy;
    const list = listPolicy === "deny" ? f.denyList : f.allowList;
    const listName = t(listPolicy === "deny" ? "list_name_deny" : "list_name_allow");

    const modeButton = (target: WifiFilterMode, key: AccessTextKey): HTMLButtonElement => {
      const btn = h("button", { class: `btn btn-sm join-item ${mode === target ? "btn-primary" : "btn-ghost"}`, attrs: { type: "button", "aria-pressed": String(mode === target) } }, t(key));
      btn.addEventListener("click", () => {
        if (mode === target) return;
        if (target === "allow") {
          const guard = previewGuard(ctx.store.state.accessGuard, hosts(ctx));
          allowDraft = new Set([...f.allowList.map((e) => e.macAddress), ...guard.protectedDevices.filter((d) => d.wireless).map((d) => d.macAddress)]);
          render();
          return;
        }
        runBusy(btn, async () => {
          await runWifiChange(
            ctx,
            { kind: "mode", mode: target },
            t(target === "off" ? "mode_off_title" : "mode_deny_title"),
            [target === "off" ? t("mode_off_body") : t("mode_deny_body", { count: f.denyList.length })],
            t(target === "off" ? "mode_off" : "mode_deny")
          );
        });
      });
      return btn;
    };

    const allowPicker = (): HTMLElement | null => {
      if (!allowDraft) return null;
      const picked = allowDraft;
      const guard = previewGuard(ctx.store.state.accessGuard, hosts(ctx));
      const locked = new Set(guard.protectedDevices.filter((d) => d.wireless).map((d) => d.macAddress));
      const candidates = hosts(ctx).filter((x) => x.medium.startsWith("WIFI") || picked.has(normalizeMac(x.macAddress) ?? ""));
      const rows = candidates.map((x) => {
        const mac = normalizeMac(x.macAddress) ?? x.macAddress;
        const box = h("input", { class: "checkbox checkbox-xs checkbox-primary", attrs: { type: "checkbox" } });
        box.checked = picked.has(mac);
        box.disabled = locked.has(mac);
        box.addEventListener("change", () => {
          if (box.checked) picked.add(mac);
          else picked.delete(mac);
        });
        return h(
          "label",
          { class: "flex items-center gap-2 py-1 cursor-pointer" },
          box,
          h("span", { class: `text-sm truncate ${x.active ? "" : "opacity-60"}` }, labelFor(ctx, mac, x.displayName)),
          deviceTag(mac),
          locked.has(mac) ? h("span", { class: "text-[0.6875rem] faint" }, t("allow_locked")) : null
        );
      });
      const online = h("button", { class: "btn btn-ghost btn-xs rounded-lg", attrs: { type: "button" } }, t("allow_online"));
      online.addEventListener("click", () => {
        for (const mac of guard.onlineWifiMacs) picked.add(mac);
        render();
      });
      const apply = h("button", { class: "btn btn-warning btn-sm rounded-lg", attrs: { type: "button" } }, t("allow_apply"));
      apply.addEventListener("click", () =>
        runBusy(apply, async () => {
          const entries = [...picked].map((mac) => ({ macAddress: mac, name: labelFor(ctx, mac) }));
          const ok = await runWifiChange(ctx, { kind: "mode", mode: "allow", entries }, t("mode_allow_title"), [t("mode_allow_body", { count: entries.length })], t("allow_apply"));
          if (ok) {
            allowDraft = null;
            render();
          }
        })
      );
      const cancel = h("button", { class: "btn btn-ghost btn-sm rounded-lg", attrs: { type: "button" } }, ctx.t("common.cancel"));
      cancel.addEventListener("click", () => {
        allowDraft = null;
        render();
      });
      return h(
        "div",
        { class: "rounded-xl border border-base-content/10 p-3 space-y-2" },
        h("div", { class: "flex items-center gap-2" }, h("span", { class: "text-sm font-medium" }, t("allow_pick")), h("span", { class: "ml-auto" }, online)),
        h("div", { class: "max-h-[26rem] overflow-y-auto" }, ...rows),
        h("div", { class: "flex justify-end gap-2" }, cancel, apply)
      );
    };

    const addForm = (): HTMLElement | null => {
      if (mode === "off") return null;
      const select = h("select", { class: "select select-sm w-full" }, h("option", { attrs: { value: "" } }, t("add_pick")));
      for (const x of hosts(ctx)) {
        const mac = normalizeMac(x.macAddress);
        if (!mac || list.some((e) => e.macAddress === mac)) continue;
        select.appendChild(h("option", { attrs: { value: mac } }, `${labelFor(ctx, mac, x.displayName)}${x.medium.startsWith("WIFI") ? "" : t("lan_marker")}`));
      }
      select.addEventListener("change", () => {
        addMac = select.value;
        addName = select.value ? labelFor(ctx, select.value) : "";
        render();
      });
      const macInput = h("input", { class: "input input-sm w-full", attrs: { type: "text", placeholder: t("mac_placeholder"), autocomplete: "off", spellcheck: "false" } });
      macInput.value = addMac;
      macInput.addEventListener("input", () => (addMac = macInput.value));
      const nameInput = h("input", { class: "input input-sm w-full", attrs: { type: "text", placeholder: t("name_placeholder"), maxlength: "32" } });
      nameInput.value = addName;
      nameInput.addEventListener("input", () => (addName = nameInput.value));
      const add = h("button", { class: "btn btn-primary btn-sm rounded-lg gap-1", attrs: { type: "button" } }, icon("plus"), t("add"));
      add.addEventListener("click", () =>
        runBusy(add, async () => {
          const name = addName.trim() || labelFor(ctx, addMac);
          const ok = await runWifiChange(ctx, { kind: "entries", add: [{ macAddress: addMac, name }] }, t("add_entry_title", { name, list: listName }), [], t("add"));
          if (ok) {
            addMac = "";
            addName = "";
            render();
          }
        })
      );
      return h("div", { class: "space-y-2 pt-2" }, h("div", { class: "text-xs muted" }, t("add_title")), select, macInput, h("div", { class: "flex gap-2" }, nameInput, add));
    };

    return h(
      "section",
      { class: "space-y-3" },
      h("div", { class: "flex items-center gap-2" }, icon("wifi", "text-primary"), h("h4", { class: "font-semibold" }, t("wifi_title"))),
      h("p", { class: "text-xs muted" }, t("wifi_desc")),
      h("div", { class: "join" }, modeButton("off", "mode_off"), modeButton("deny", "mode_deny"), modeButton("allow", "mode_allow")),
      h("p", { class: "text-xs faint" }, t(mode === "off" ? "hint_off" : mode === "deny" ? "hint_deny" : "hint_allow")),
      allowPicker(),
      h(
        "div",
        null,
        h("div", { class: "text-xs muted mb-1" }, t(listPolicy === "deny" ? "list_deny" : "list_allow", { count: list.length, max: f.maxEntries }), mode === "off" ? h("span", { class: "faint" }, ` · ${t("stored_inactive")}`) : null),
        list.length === 0
          ? h("div", { class: "text-sm faint py-2" }, t("list_empty"))
          : h("ul", { class: "space-y-1" }, ...list.map((e) => entryRow(e, mode !== "off", listName)))
      ),
      addForm()
    );
  };

  const ruleRange = (rule: { startTime: string; endTime: string }): string =>
    `${rule.startTime}–${rule.endTime}${isOvernight(rule.startTime, rule.endTime) ? texts(ctx)("overnight_marker") : ""}`;

  const sendRule = async (body: Parameters<AppContext["api"]["timeRule"]>[0], title: string, lines: ReadonlyArray<string>, label: string): Promise<boolean> => {
    if (!(await ctx.confirm({ title, body: lines, confirmLabel: label, tone: "warning" }))) return false;
    try {
      applied(ctx, await ctx.api.timeRule(body));
      return true;
    } catch (err) {
      ctx.toast(describe(ctx, err), "error");
      return false;
    }
  };

  const ruleEditor = (rules: ReadonlyArray<TimeRule>): HTMLElement | null => {
    if (!draft) return null;
    const t = texts(ctx);
    const current = draft;
    const select = h("select", { class: "select select-sm w-full" }, h("option", { attrs: { value: "" } }, t("pick_device")));
    for (const x of hosts(ctx)) {
      const mac = normalizeMac(x.macAddress);
      if (mac) select.appendChild(h("option", { attrs: { value: mac } }, labelFor(ctx, mac, x.displayName)));
    }
    select.value = current.macAddress;
    select.disabled = current.id !== null;
    select.addEventListener("change", () => {
      current.macAddress = select.value;
      render();
    });
    const days = dayNames(ctx.tr.locale).map((day, i) => {
      const on = current.weekMask[i] === "1";
      const chip = h("button", { class: `btn btn-xs rounded-full ${on ? "btn-primary" : "btn-ghost border border-base-content/10"}`, attrs: { type: "button", "aria-pressed": String(on) } }, day);
      chip.addEventListener("click", () => {
        current.weekMask = current.weekMask.slice(0, i) + (on ? "0" : "1") + current.weekMask.slice(i + 1);
        render();
      });
      return chip;
    });
    const timeSelect = (value: string, onPick: (v: string) => void, skipMidnight: boolean): HTMLSelectElement => {
      const el = h("select", { class: "select select-sm" }, ...QUARTER_TIMES.filter((q) => !(skipMidnight && q === "00:00")).map((q) => h("option", { attrs: { value: q } }, q)));
      el.value = value;
      el.addEventListener("change", () => {
        onPick(el.value);
        render();
      });
      return el;
    };
    const input: TimeRuleInput = { macAddress: current.macAddress, name: labelFor(ctx, current.macAddress), weekMask: current.weekMask, startTime: current.startTime, endTime: current.endTime, enabled: current.enabled };
    let problem: string | null = null;
    if (current.macAddress) {
      try {
        normalizeTimeRuleInput(input);
        const clashes = findTimeRuleConflicts(rules, input, current.id ?? undefined);
        if (clashes.length > 0) problem = t("conflict", { list: clashes.map((r) => `${formatWeekMask(r.weekMask, ctx.tr.locale)} ${ruleRange(r)}`).join(t("conflict_separator")) });
      } catch (err) {
        problem = describe(ctx, err);
      }
    }
    const save = h("button", { class: "btn btn-warning btn-sm rounded-lg", attrs: { type: "button" } }, t("save"));
    save.disabled = !current.macAddress || problem !== null;
    save.addEventListener("click", () =>
      runBusy(save, async () => {
        const ok = await sendRule(
          current.id === null ? { action: "create", rule: input, confirm: true } : { action: "update", id: current.id, rule: input, confirm: true },
          t("rule_save_title"),
          [t("rule_save_body", { name: input.name, days: formatWeekMask(input.weekMask, ctx.tr.locale), range: ruleRange(input) })],
          t("save")
        );
        if (ok) {
          draft = null;
          render();
        }
      })
    );
    const cancel = h("button", { class: "btn btn-ghost btn-sm rounded-lg", attrs: { type: "button" } }, ctx.t("common.cancel"));
    cancel.addEventListener("click", () => {
      draft = null;
      render();
    });
    return h(
      "div",
      { class: "rounded-xl border border-base-content/10 p-3 space-y-3" },
      h("label", { class: "block space-y-1" }, h("span", { class: "text-xs muted" }, t("device")), select),
      h("div", { class: "space-y-1" }, h("span", { class: "text-xs muted" }, t("days")), h("div", { class: "flex flex-wrap gap-1" }, ...days)),
      h(
        "div",
        { class: "flex items-end gap-2" },
        h("label", { class: "space-y-1" }, h("span", { class: "block text-xs muted" }, t("start")), timeSelect(current.startTime, (v) => (current.startTime = v), false)),
        h("label", { class: "space-y-1" }, h("span", { class: "block text-xs muted" }, t("end")), timeSelect(current.endTime, (v) => (current.endTime = v), true)),
        isOvernight(current.startTime, current.endTime) ? h("span", { class: "text-xs text-warning pb-2" }, t("overnight")) : null
      ),
      problem ? h("div", { class: "fs-notice", data: { tone: "pending" } }, icon("alert", "text-warning mt-0.5"), h("span", { class: "text-xs" }, problem)) : null,
      h("div", { class: "flex justify-end gap-2" }, cancel, save)
    );
  };

  const rulesSection = (): HTMLElement => {
    const t = texts(ctx);
    const ac = ctx.store.state.accessControl;
    const tr = ac?.timeRules;
    const head = h("div", { class: "flex items-center gap-2" }, icon("history", "text-primary"), h("h4", { class: "font-semibold" }, t("rules_title")), tr?.supported ? h("span", { class: "text-xs faint" }, t("rules_count", { count: tr.rules.length, max: tr.maxRules })) : null);
    if (!ac || !tr) return h("section", { class: "space-y-3" }, head, h("div", { class: "text-sm muted" }, t("loading")));
    if (!tr.supported) return h("section", { class: "space-y-3" }, head, h("div", { class: "text-sm muted" }, t("rules_unsupported")));
    const addBtn = h("button", { class: "btn btn-ghost btn-xs rounded-lg gap-1 ml-auto", attrs: { type: "button" } }, icon("plus"), t("add_rule"));
    addBtn.disabled = tr.rules.length >= tr.maxRules || draft !== null;
    addBtn.addEventListener("click", () => {
      draft = { id: null, macAddress: "", weekMask: "1111100", startTime: "07:00", endTime: "21:00", enabled: true };
      render();
    });
    head.appendChild(addBtn);
    const groups = [...rulesByDevice(tr.rules).entries()].map(([mac, rules]) =>
      h(
        "div",
        { class: "py-2" },
        h("div", { class: "text-sm font-medium" }, labelFor(ctx, mac, rules[0]?.devices[0]?.name ?? ""), deviceTag(mac)),
        h(
          "ul",
          { class: "mt-1 space-y-1" },
          ...rules.map((rule) => {
            const toggle = h("input", { class: "toggle toggle-xs toggle-primary", attrs: { type: "checkbox", "aria-label": t("enabled") } });
            toggle.checked = rule.enabled;
            toggle.addEventListener("change", () => {
              const enabled = toggle.checked;
              toggle.checked = !enabled;
              const device = rule.devices[0] ?? { macAddress: mac, name: "" };
              void sendRule(
                { action: "update", id: rule.id, rule: { macAddress: device.macAddress, name: device.name, weekMask: rule.weekMask, startTime: rule.startTime, endTime: rule.endTime, enabled }, confirm: true },
                t("rule_toggle_title", { action: t(enabled ? "rule_enable" : "rule_disable") }),
                [`${labelFor(ctx, mac, device.name)} · ${formatWeekMask(rule.weekMask, ctx.tr.locale)} ${ruleRange(rule)}`],
                t(enabled ? "rule_enable" : "rule_disable")
              );
            });
            const edit = h("button", { class: "btn btn-ghost btn-xs btn-square rounded-lg", attrs: { type: "button", "aria-label": t("edit") } }, icon("pencil"));
            edit.addEventListener("click", () => {
              draft = { id: rule.id, macAddress: normalizeMac(rule.devices[0]?.macAddress ?? "") ?? "", weekMask: rule.weekMask, startTime: rule.startTime, endTime: rule.endTime, enabled: rule.enabled };
              render();
            });
            const del = h("button", { class: "btn btn-ghost btn-xs btn-square rounded-lg text-error", attrs: { type: "button", "aria-label": t("delete") } }, icon("trash"));
            del.addEventListener("click", () =>
              runBusy(del, async () => {
                await sendRule({ action: "delete", id: rule.id, confirm: true }, t("rule_delete_title"), [`${labelFor(ctx, mac)} · ${formatWeekMask(rule.weekMask, ctx.tr.locale)} ${ruleRange(rule)}`], t("delete"));
              })
            );
            return h(
              "li",
              { class: `flex items-center gap-2 text-sm ${rule.enabled ? "" : "opacity-60"}` },
              toggle,
              h("span", { class: "num" }, ruleRange(rule)),
              h("span", { class: "muted" }, formatWeekMask(rule.weekMask, ctx.tr.locale)),
              rule.enabled ? null : h("span", { class: "fs-badge" }, t("disabled")),
              h("span", { class: "ml-auto flex" }, edit, del)
            );
          })
        )
      )
    );
    return h(
      "section",
      { class: "space-y-2" },
      head,
      h("p", { class: "text-xs muted" }, t("rules_desc")),
      ruleEditor(tr.rules),
      groups.length === 0 && !draft ? h("div", { class: "text-sm faint py-2" }, t("rules_empty")) : h("div", { class: "space-y-1" }, ...groups)
    );
  };

  const render = (): void => {
    const t = texts(ctx);
    const refreshBtn = h("button", { class: "btn btn-ghost btn-xs rounded-lg gap-1", attrs: { type: "button" } }, icon("refresh"), t("refresh"));
    refreshBtn.addEventListener("click", () => refresh(refreshBtn));
    const captured = ctx.store.state.accessControl?.capturedAtIso;
    mount(
      dialog,
      h(
        "div",
        { class: "modal-box h-full max-h-dvh w-full sm:max-w-md rounded-none sm:rounded-l-2xl p-0 flex flex-col" },
        h(
          "div",
          { class: "flex items-center gap-2 px-5 pt-5 pb-3 border-b border-base-content/[0.06]" },
          icon("shield", "text-primary text-lg"),
          h("h3", { class: "text-lg font-bold serif" }, t("title")),
          h("span", { class: "ml-auto" }, refreshBtn),
          h("form", { attrs: { method: "dialog" } }, h("button", { class: "btn btn-ghost btn-sm btn-circle", attrs: { "aria-label": ctx.t("common.close") } }, icon("x", "text-base")))
        ),
        h(
          "div",
          { class: "flex-1 overflow-y-auto px-5 py-4 space-y-6" },
          captured ? h("div", { class: "text-[0.6875rem] faint" }, t("updated", { time: new Date(captured).toLocaleTimeString(ctx.tr.locale) })) : null,
          wifiSection(),
          rulesSection()
        )
      ),
      modalBackdrop(ctx.t("common.close"))
    );
  };

  ctx.store.subscribe(["accessControl", "topology"], () => {
    if (dialog.open) render();
  });
  ctx.privacy.onChange(() => {
    if (dialog.open) render();
  });
  ctx.tr.onChange(() => {
    if (dialog.open) render();
  });
  dialog.addEventListener("close", () => {
    allowDraft = null;
    draft = null;
  });
  return {
    open: () => {
      render();
      dialog.showModal();
      if (!ctx.store.state.accessControl) {
        void ctx.api
          .accessControl()
          .then((res) => ctx.store.update({ accessControl: res.accessControl, accessGuard: res.guard }, ["accessControl"]))
          .catch((err: unknown) => ctx.toast(describe(ctx, err), "error"));
      }
    },
  };
}
