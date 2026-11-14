import type { ApnView, CellularSettingsSnapshot, NetworkMode, OperatorChoice, SimSlotRef, UssdAnswer } from "../../../src/api-contract.ts";
import type { WriteFeature, CellularWriteFeature } from "../../../src/features.ts";
import { type LimitUnit, MODE_KEYS, alertPercent, apnForm, apnTakesCredentials, apnUsesProfile, isPin, isUssdCode, limitBytes, limitFields, modeChoices, operatorLine, pinOffer, slotChoices } from "../core/cellular-view.ts";
import { type MessageParams, interpolate } from "../core/i18n.ts";
import { driverFamilyOf } from "../core/lock-form.ts";
import { CELLULAR_TEXT, type CellularTextKey } from "../i18n/cellular.ts";
import type { AppContext, ConfirmOptions } from "./context.ts";
import { type Child, h, icon } from "./dom.ts";
import { withHelp } from "./help.ts";
import { runBusy } from "./widgets.ts";

/**
 * The cellular settings in the control drawer (lazy chunk): network mode, operator, SIM slot and
 * PIN, airplane mode, data roaming, access point, the router's own data limit and traffic counters,
 * and USSD. Only the settings open on this router are drawn; each write has its own confirmation and
 * is sent with `confirm: true`. What is typed (a PIN, an access point's credentials, a USSD code)
 * lives in this section's fields and nowhere else.
 */

type Confirm = (features: ReadonlyArray<WriteFeature>, options: ConfirmOptions) => Promise<boolean>;

const row = (label: Child, ...children: Child[]): HTMLElement => h("div", { class: "space-y-1.5 py-2 border-b border-dashed border-base-content/10" }, h("div", { class: "text-sm font-semibold" }, label), ...children);
const note = (text: string): HTMLElement => h("p", { class: "text-[0.6875rem] faint" }, text);
const button = (label: string, tone = "btn-ghost"): HTMLButtonElement => h("button", { class: `btn ${tone} btn-sm rounded-lg`, attrs: { type: "button" } }, label);
const field = (attrs: Record<string, string>, value = ""): HTMLInputElement => {
  const input = h("input", { class: "input input-sm rounded-lg w-full num", attrs: { autocomplete: "off", spellcheck: "false", ...attrs } });
  input.value = value;
  return input;
};
const choice = <V extends string>(options: ReadonlyArray<readonly [V, string]>, value: V, label: string): HTMLSelectElement => {
  const select = h("select", { class: "select select-sm rounded-lg", attrs: { "aria-label": label } }, ...options.map(([key, text]) => h("option", { attrs: { value: key } }, text)));
  select.value = value;
  return select;
};

export function mountCellular(ctx: AppContext, host: HTMLElement, confirm: Confirm): { render(open: ReadonlyArray<CellularWriteFeature>): void } {
  const t = (key: CellularTextKey, params?: MessageParams): string => interpolate(CELLULAR_TEXT[ctx.tr.locale][key], params);
  let cellular: CellularSettingsSnapshot | null = null;
  let asked = false;
  let scan: OperatorChoice[] | null = null;
  let answer: UssdAnswer | null = null;
  let shown: ReadonlyArray<CellularWriteFeature> = [];
  // What is typed survives a redraw (a poll or another write redraws the section)
  const typed = { apnMode: null as "auto" | "manual" | null, apn: "", ipType: "ipv4v6", auth: "none", limitOn: null as boolean | null, amount: "", unit: "GB" as LimitUnit, percent: "" };

  const fail = (err: unknown): void => ctx.toast(ctx.describeError(err), "error");
  /** The fields whose text is held nowhere but in the field itself. */
  const keptFields = (): NodeListOf<HTMLInputElement> => host.querySelectorAll<HTMLInputElement>("input[data-keep]");
  /** Empty one of them once what it held was sent. */
  const forget = (key: string): void => {
    for (const input of keptFields()) if (input.dataset["keep"] === key) input.value = "";
  };
  const took = (next: CellularSettingsSnapshot | null | undefined): void => {
    if (next) cellular = next;
    ctx.toast(t("done"), "success");
    draw();
  };
  /** One confirmed write: asked, sent once, and the section redrawn with what the router reports afterwards. */
  const write = (feature: CellularWriteFeature, trigger: HTMLButtonElement, options: ConfirmOptions, send: () => Promise<{ cellular?: CellularSettingsSnapshot | null } | void>, undo?: () => void): void => {
    void confirm([feature], options).then((ok) => {
      if (!ok) return undo?.();
      runBusy(trigger, () =>
        send().then(
          (res) => took(res ? res.cellular : null),
          (err: unknown) => {
            undo?.();
            fail(err);
          }
        )
      );
    });
  };
  const read = (trigger?: HTMLButtonElement): void => {
    // The first time the daemon's last read will do; with none yet (it reads these when asked), read now
    const run = (): Promise<void> =>
      (asked ? ctx.api.refreshCellular() : ctx.api.cellular().then((res) => (res.cellular === null ? ctx.api.refreshCellular() : res)))
        .then((res) => {
          cellular = res.cellular ?? cellular;
        }, fail)
        .finally(() => {
          asked = true;
          draw();
        });
    if (trigger) runBusy(trigger, run);
    else void run();
  };
  const modeName = (mode: NetworkMode): string => t(MODE_KEYS[mode]);
  const slotName = (slot: SimSlotRef): string => t(slot.kind === "physical" ? "slot_physical" : "slot_embedded", { index: slot.index });
  const toggle = (checked: boolean, label: string, onChange: (next: boolean, input: HTMLInputElement) => void): HTMLElement => {
    const input = h("input", { class: "toggle toggle-sm toggle-primary", attrs: { type: "checkbox", "aria-label": label } });
    input.checked = checked;
    input.addEventListener("change", () => onChange(input.checked, input));
    return input;
  };
  /** A switch asks first; saying no, or the router refusing, puts it back where it was. */
  const switchRow = (feature: CellularWriteFeature, label: Child, name: string, on: boolean, copy: (next: boolean) => ConfirmOptions, send: (next: boolean) => Promise<unknown>): HTMLElement => {
    const proxy = h("button", { class: "hidden", attrs: { type: "button" } });
    return h(
      "label",
      { class: "flex items-center justify-between gap-3 py-2 border-b border-dashed border-base-content/10 cursor-pointer", data: { cellular: feature } },
      h("span", { class: "text-sm font-semibold" }, label),
      proxy,
      toggle(on, name, (next, input) =>
        write(
          feature,
          proxy,
          copy(next),
          () => send(next).then(() => undefined),
          () => {
            input.checked = !next;
          }
        )
      )
    );
  };

  const modeRow = (): HTMLElement | null => {
    const { current, options } = modeChoices(cellular);
    if (options.length === 0) return null;
    const select = choice(
      options.map((mode) => [mode, modeName(mode)] as const),
      current && options.includes(current) ? current : (options[0] ?? "auto"),
      t("mode")
    );
    const apply = button(t("mode_apply"), "btn-warning");
    apply.addEventListener("click", () => {
      const mode = select.value as NetworkMode;
      write("networkMode", apply, { title: t("mode_title"), body: [t("mode_body", { mode: modeName(mode) }), t("rollback")], confirmLabel: t("mode_apply"), tone: "warning" }, () => ctx.api.networkMode(mode));
    });
    return row(withHelp(ctx, t("mode"), "network-mode"), note(current ? t("mode_now", { mode: modeName(current) }) : t("mode_unknown")), h("div", { class: "flex gap-2", data: { cellular: "networkMode" } }, select, apply));
  };

  const operatorRow = (): HTMLElement => {
    const selection = cellular?.operator?.selection ?? null;
    const search = button(t("operator_scan"));
    search.addEventListener("click", () => {
      void confirm(["operatorSelect"], { title: t("operator_scan_title"), body: [t("operator_scan_body")], confirmLabel: t("operator_scan"), tone: "warning" }).then((ok) => {
        if (!ok) return;
        runBusy(search, () =>
          ctx.api.operatorScan().then((res) => {
            scan = res.operators;
            draw();
          }, fail)
        );
      });
    });
    const auto = button(t("operator_use_auto"));
    auto.addEventListener("click", () => write("operatorSelect", auto, { title: t("operator_auto_title"), body: [t("operator_auto_body")], confirmLabel: t("operator_use_auto") }, () => ctx.api.operator({ mode: "auto" })));
    const found = (scan ?? []).map((operator) => {
      const line = operatorLine(operator);
      const use = button(t(line.selectable ? "operator_use" : "operator_forbidden"));
      use.disabled = !line.selectable;
      use.addEventListener("click", () =>
        write("operatorSelect", use, { title: t("operator_select_title"), body: [t("operator_select_body", { name: line.name }), t("rollback")], confirmLabel: t("operator_use"), tone: "warning" }, () => ctx.api.operator({ mode: "manual", plmn: operator.plmn, rat: operator.rat }))
      );
      return h(
        "div",
        { class: "flex items-center justify-between gap-2 text-sm", data: { operator: operator.plmn } },
        h("span", {}, line.name, h("span", { class: "block text-[0.6875rem] faint num" }, [line.detail, operator.state === "current" ? t("operator_current") : null].filter(Boolean).join(" · "))),
        use
      );
    });
    return row(
      withHelp(ctx, t("operator"), "operator-select"),
      selection ? note(t(selection === "manual" ? "operator_manual" : "operator_auto")) : null,
      h("div", { class: "flex flex-wrap gap-2", data: { cellular: "operatorSelect" } }, search, auto),
      scan ? (found.length > 0 ? h("div", { class: "space-y-1.5" }, ...found) : note(t("operator_none"))) : null
    );
  };

  const slotRow = (): HTMLElement | null => {
    const slots = slotChoices(cellular, ctx.store.state.telemetry?.status ?? null);
    if (slots.length === 0) return null;
    return row(
      withHelp(ctx, t("slot"), "esim"),
      h(
        "div",
        { class: "flex flex-wrap gap-2", data: { cellular: "simSlot" } },
        ...slots.map(({ slot, current }) => {
          const pick = button(slotName(slot), current ? "btn-primary" : "btn-ghost");
          pick.disabled = current;
          pick.addEventListener("click", () => write("simSlot", pick, { title: t("slot_title"), body: [t("slot_body", { slot: slotName(slot) }), t("rollback")], confirmLabel: slotName(slot), tone: "warning" }, () => ctx.api.simSlot(slot)));
          return pick;
        })
      )
    );
  };

  const pinRow = (): HTMLElement => {
    const offer = pinOffer(ctx.store.state.telemetry?.status ?? null);
    if (offer.kind === "none") return row(withHelp(ctx, t("pin"), "sim-pin"), note(t(`pin_none_${offer.reason}`)));
    const pin = field({ type: "password", inputmode: "numeric", maxlength: "8", placeholder: t("pin_placeholder"), "aria-label": t("pin"), "data-keep": "pin" });
    const send = (action: "enter" | "lock" | "unlock", label: string): HTMLButtonElement => {
      const trigger = button(label, "btn-warning");
      trigger.addEventListener("click", () => {
        const value = pin.value;
        if (!isPin(value)) return ctx.toast(t("pin_invalid"), "warning");
        void confirm(["simPin"], { title: t(action === "enter" ? "pin_enter_title" : "pin_lock_title"), body: [t("pin_body", { left: offer.attemptsLeft })], confirmLabel: label, tone: "error" }).then((ok) => {
          if (!ok) return;
          runBusy(trigger, () =>
            ctx.api.simPin(action, value).then((res) => {
              forget("pin");
              if (res.accepted) ctx.toast(t("pin_accepted"), "success");
              else ctx.toast(res.attemptsLeft === null ? t("pin_refused_unknown") : t("pin_refused", { left: res.attemptsLeft }), "error");
            }, fail)
          );
        });
      });
      return trigger;
    };
    const actions = offer.kind === "enter" ? [send("enter", t("pin_enter"))] : [...(offer.lockEnabled !== true ? [send("lock", t("pin_lock_on"))] : []), ...(offer.lockEnabled !== false ? [send("unlock", t("pin_lock_off"))] : [])];
    return row(withHelp(ctx, t("pin"), "sim-pin"), h("div", { class: "flex flex-wrap gap-2", data: { cellular: "simPin" } }, pin, ...actions));
  };

  const apnRow = (): HTMLElement => {
    const family = driverFamilyOf(ctx.store.state.scheduler);
    const view: ApnView | null = cellular?.apn ?? null;
    const mode = typed.apnMode ?? view?.mode ?? "auto";
    const modes = h(
      "div",
      { class: "join" },
      ...(["auto", "manual"] as const).map((key) => {
        const pick = h("button", { class: `btn btn-sm join-item ${mode === key ? "btn-primary" : "btn-ghost"}`, attrs: { type: "button" }, data: { apnMode: key } }, t(key === "auto" ? "apn_auto" : "apn_manual"));
        pick.addEventListener("click", () => {
          typed.apnMode = key;
          draw();
        });
        return pick;
      })
    );
    const name = field({ type: "text", placeholder: "internet", "aria-label": t("apn_name") }, typed.apn);
    name.addEventListener("input", () => (typed.apn = name.value));
    const ipType = choice(
      [
        ["ipv4v6", "IPv4 + IPv6"],
        ["ipv4", "IPv4"],
        ["ipv6", "IPv6"],
      ],
      typed.ipType,
      t("apn_type")
    );
    ipType.addEventListener("change", () => (typed.ipType = ipType.value));
    const auth = choice(
      [
        ["none", t("apn_auth_none")],
        ["pap", "PAP"],
        ["chap", "CHAP"],
      ],
      typed.auth,
      t("apn_auth")
    );
    auth.addEventListener("change", () => (typed.auth = auth.value));
    const user = field({ type: "text", placeholder: t("apn_user"), "aria-label": t("apn_user"), "data-keep": "apn-user" });
    const password = field({ type: "password", placeholder: t("apn_password"), "aria-label": t("apn_password"), "data-keep": "apn-password" });
    const credentials = apnTakesCredentials(family);
    const apply = button(t("apn_apply"), "btn-warning");
    apply.addEventListener("click", () => {
      if (mode === "auto") return write("apn", apply, { title: t("apn_title"), body: [t("apn_body_auto"), t("rollback")], confirmLabel: t("apn_apply"), tone: "warning" }, () => ctx.api.apn({ mode: "auto" }));
      const fields = { apn: name.value.trim(), auth: (credentials ? auth.value : "none") as "none" | "pap" | "chap", username: credentials ? user.value : "", password: credentials ? password.value : "" };
      const verdict = apnForm(fields);
      if (verdict !== "ok") return ctx.toast(t(verdict === "apn" ? "apn_invalid" : "apn_credentials_invalid"), "warning");
      write("apn", apply, { title: t("apn_title"), body: [t("apn_body_manual"), ...(apnUsesProfile(family) ? [t("apn_profile")] : []), t("rollback")], confirmLabel: t("apn_apply"), tone: "warning" }, () =>
        ctx.api.apn({ mode: "manual", ...fields, ipType: ipType.value as "ipv4" | "ipv6" | "ipv4v6" }).then((res) => {
          forget("apn-password");
          return res;
        })
      );
    });
    return row(
      withHelp(ctx, t("apn"), "apn"),
      view ? note(view.mode === "manual" && view.apn ? t("apn_now_manual", { apn: view.apn }) : t("apn_now_auto")) : null,
      h("div", { class: "space-y-2", data: { cellular: "apn" } }, modes, ...(mode === "manual" ? [name, h("div", { class: "flex gap-2" }, ipType, ...(credentials ? [auth] : [])), ...(credentials ? [h("div", { class: "flex gap-2" }, user, password)] : [])] : []), h("div", { class: "flex justify-end" }, apply))
    );
  };

  const limitRow = (): HTMLElement => {
    const current = cellular?.dataLimit ?? null;
    if (typed.limitOn === null && current) {
      const fields = limitFields(current.bytes);
      Object.assign(typed, { limitOn: current.enabled === true, amount: fields.amount, unit: fields.unit, percent: current.alertPercent === null ? "" : String(current.alertPercent) });
    }
    const on = h("input", { class: "toggle toggle-sm toggle-primary", attrs: { type: "checkbox", "aria-label": t("limit") } });
    on.checked = typed.limitOn === true;
    on.addEventListener("change", () => (typed.limitOn = on.checked));
    const amount = field({ type: "text", inputmode: "decimal", placeholder: "20", "aria-label": t("limit_size") }, typed.amount);
    amount.addEventListener("input", () => (typed.amount = amount.value));
    const unit = choice(
      [
        ["GB", "GB"],
        ["MB", "MB"],
      ],
      typed.unit,
      t("limit_size")
    );
    unit.addEventListener("change", () => (typed.unit = unit.value as LimitUnit));
    const percent = field({ type: "text", inputmode: "numeric", placeholder: t("limit_alert"), "aria-label": t("limit_alert") }, typed.percent);
    percent.addEventListener("input", () => (typed.percent = percent.value));
    const save = button(t("limit_apply"), "btn-warning");
    save.addEventListener("click", () => {
      if (!on.checked) return write("dataLimit", save, { title: t("limit_title"), body: [t("limit_body_off")], confirmLabel: t("limit_apply") }, () => ctx.api.dataLimit({ enabled: false }));
      const bytes = limitBytes(amount.value, unit.value as LimitUnit);
      const share = alertPercent(percent.value);
      if (bytes === null) return ctx.toast(t("limit_invalid"), "warning");
      if (share === undefined) return ctx.toast(t("limit_alert_invalid"), "warning");
      write("dataLimit", save, { title: t("limit_title"), body: [t("limit_body_on", { size: `${amount.value.trim()} ${unit.value}` })], confirmLabel: t("limit_apply") }, () => ctx.api.dataLimit({ enabled: true, bytes, alertPercent: share }));
    });
    return row(withHelp(ctx, t("limit"), "data-limit"), h("div", { class: "flex items-center gap-2", data: { cellular: "dataLimit" } }, on, amount, unit, percent, save));
  };

  const ussdRow = (): HTMLElement => {
    const code = field({ type: "text", inputmode: "tel", maxlength: "40", placeholder: t("ussd_placeholder"), "aria-label": t("ussd"), "data-keep": "ussd" });
    const waiting = answer?.awaitsReply === true;
    const send = button(t(waiting ? "ussd_reply" : "ussd_send"), "btn-warning");
    const ask = (body: Parameters<AppContext["api"]["ussd"]>[0], trigger: HTMLButtonElement): void =>
      runBusy(trigger, () =>
        ctx.api.ussd(body).then((res) => {
          answer = res.ussd;
          forget("ussd");
          draw();
        }, fail)
      );
    send.addEventListener("click", () => {
      const value = code.value.trim();
      if (!isUssdCode(value)) return ctx.toast(t("ussd_invalid"), "warning");
      void confirm(["ussd"], { title: t("ussd_title"), body: [t("ussd_body")], confirmLabel: t("ussd_send"), tone: "warning" }).then((ok) => {
        if (ok) ask({ action: waiting ? "reply" : "send", code: value }, send);
      });
    });
    const end = button(t("ussd_cancel"));
    end.addEventListener("click", () => ask({ action: "cancel" }, end));
    // The operator's words go in as text, never as markup
    const said = answer ? h("div", { class: "rounded-lg bg-base-content/[0.04] p-2 text-sm whitespace-pre-wrap break-words", data: { ussdAnswer: answer.state } }) : null;
    if (said && answer) said.textContent = answer.state === "answered" ? (answer.text ?? "") : t(answer.state === "cancelled" ? "ussd_cancelled" : "ussd_no_answer");
    return row(withHelp(ctx, t("ussd"), "ussd"), h("div", { class: "flex gap-2", data: { cellular: "ussd" } }, code, send, ...(waiting ? [end] : [])), answer?.state === "answered" ? note(t(waiting ? "ussd_awaits" : "ussd_answer")) : null, said);
  };

  const draw = (): void => {
    const status = ctx.store.state.telemetry?.status ?? null;
    const has = (feature: CellularWriteFeature): boolean => shown.includes(feature);
    const refresh = h("button", { class: "btn btn-ghost btn-xs rounded-lg gap-1", attrs: { type: "button" }, data: { action: "read-cellular" } }, icon("refresh"), t("read"));
    refresh.addEventListener("click", () => read(refresh));
    const reset = button(t("reset"));
    reset.addEventListener("click", () => write("trafficReset", reset, { title: t("reset_title"), body: [t("reset_body")], confirmLabel: t("reset"), tone: "warning" }, () => ctx.api.trafficReset().then(() => undefined)));
    const rows: Array<HTMLElement | null> = [
      h("h4", { class: "fs-card-title text-[0.9rem] flex items-center gap-2" }, t("title"), h("span", { class: "ml-auto" }, refresh)),
      !asked ? note(t("loading")) : cellular === null && shown.some((f) => f === "networkMode" || f === "simSlot") ? note(t("unread")) : null,
      ...[
        has("networkMode") ? modeRow() : null,
        has("operatorSelect") ? operatorRow() : null,
        has("simSlot") ? slotRow() : null,
        has("simPin") ? pinRow() : null,
        has("airplaneSwitch")
          ? switchRow(
              "airplaneSwitch",
              withHelp(ctx, t("airplane"), "airplane-mode"),
              t("airplane"),
              status?.airplaneMode === true,
              (next) => (next ? { title: t("airplane_on_title"), body: [t("airplane_on_body"), t("airplane_on_remote")], confirmLabel: t("airplane"), tone: "error" } : { title: t("airplane_off_title"), body: [t("airplane_off_body")], confirmLabel: t("airplane") }),
              (next) => ctx.api.airplaneMode(next)
            )
          : null,
        has("roaming")
          ? switchRow(
              "roaming",
              withHelp(ctx, t("roaming"), "roaming"),
              t("roaming"),
              (status?.roaming?.dataAllowed ?? cellular?.dataRoaming) === true,
              (next) => (next ? { title: t("roaming_on_title"), body: [t("roaming_on_body")], confirmLabel: t("roaming"), tone: "warning" } : { title: t("roaming_off_title"), body: [t("roaming_off_body")], confirmLabel: t("roaming"), tone: "warning" }),
              (next) => ctx.api.roaming(next)
            )
          : null,
        has("apn") ? apnRow() : null,
        has("dataLimit") ? limitRow() : null,
        has("trafficReset") ? h("div", { class: "flex justify-end py-2 border-b border-dashed border-base-content/10", data: { cellular: "trafficReset" } }, reset) : null,
        has("ussd") ? ussdRow() : null,
      ],
    ];
    // Whether the settings were read: a row that depends on them is drawn once they are
    host.dataset["loaded"] = asked ? "1" : "0";
    // What is being typed (a PIN, a USSD code, an access point's credentials) moves to the fields drawn in its place
    const typing = new Map([...keptFields()].map((input) => [input.dataset["keep"], input.value]));
    host.replaceChildren(...rows.filter((node): node is HTMLElement => node !== null));
    for (const input of keptFields()) input.value = typing.get(input.dataset["keep"]) ?? "";
  };

  /** What the section was last drawn for: the settings shown, in which language. */
  let drawnFor = "";
  let reading = false;
  return {
    render: (open) => {
      // The drawer redraws on every poll that touches the locks. Drawing this section again then would
      // empty a PIN or a USSD code being typed, so it is drawn again only for other settings or another language
      const key = `${ctx.tr.locale}|${open.join(",")}`;
      shown = open;
      if (key !== drawnFor) {
        drawnFor = key;
        draw();
      }
      if (!asked && !reading) {
        reading = true;
        read();
      }
    },
  };
}
