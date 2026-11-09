import { MAX_SMS_SEGMENTS, detectSmsTextMode } from "../../../../src/sms/text-mode.ts";
import { isLikelyContactNameQuery } from "../../core/sms.ts";
import type { AppContext } from "../context.ts";
import { byId, debounce, h, icon, modalBackdrop, mount } from "../dom.ts";
import { sendAndReport } from "./send.ts";
import { type SmsShared, avatar, countryName, shownNumber } from "./shared.ts";

/**
 * "New message" sheet (cpe-sms layout): country code, number or contact search with suggestions,
 * server-side recipient preview, and exact GSM-7 / UCS-2 segment counting from the shared codec.
 */
export function openCompose(ctx: AppContext, shared: SmsShared, prefill?: { phone?: string; content?: string }): void {
  const dialog = byId<HTMLDialogElement>("newSmsDialog");
  const country = h("select", { class: "select select-sm rounded-lg w-auto max-w-[9.5rem]", attrs: { "aria-label": ctx.t("new.country") } });
  // No default country yet (none in .env, the SIM not read): ask rather than preselect one
  if (!shared.defaultCountryCode) country.appendChild(h("option", { attrs: { value: "", disabled: "", selected: "" } }, ctx.t("new.country_pick")));
  for (const c of shared.countries) {
    const option = h("option", { attrs: { value: c.code } }, `${c.flag} ${countryName(ctx, c)} ${c.code}`);
    if (c.code === shared.defaultCountryCode) option.selected = true;
    country.appendChild(option);
  }
  if (shared.countries.length === 0) country.appendChild(h("option", { attrs: { value: shared.defaultCountryCode } }, shared.defaultCountryCode));
  const phone = h("input", { class: "flex-1 min-w-0 bg-transparent outline-none text-[15px] py-1.5", attrs: { type: "text", autocomplete: "off", placeholder: ctx.t("new.phone_placeholder") } });
  phone.value = prefill?.phone ?? "";
  const suggestions = h("div", { class: "hidden mt-2 space-y-0.5" });
  const preview = h("div", { class: "mt-2 min-h-5 text-xs muted flex items-center gap-1.5" });
  const content = h("textarea", { class: "block w-full resize-none bg-transparent px-5 py-4 text-[15px] leading-relaxed outline-none", attrs: { rows: "5", placeholder: ctx.t("new.content_placeholder") } });
  content.value = prefill?.content ?? "";
  const mode = h("span", { class: "text-xs muted num" });
  const noticeSlot = h("div", { class: "px-5" });
  const send = h("button", { class: "btn btn-primary btn-sm rounded-lg gap-1.5", attrs: { type: "submit" } }, icon("send"), ctx.t("new.send"));

  /** A message on its way: another press, a key repeat or typing must not post it again. */
  let sending = false;
  const updateMode = (): void => {
    const info = detectSmsTextMode(content.value);
    const enc = info.encoding === "7BIT" ? "GSM-7" : "UCS-2";
    const tooLong = info.segments > MAX_SMS_SEGMENTS;
    mode.textContent = content.value
      ? `${ctx.t("new.mode", { encoding: enc, units: info.charUnits, segments: info.segments })}${tooLong ? ` · ${ctx.t("new.too_long", { max: MAX_SMS_SEGMENTS })}` : ""}`
      : ctx.t("new.mode_empty", { encoding: enc });
    mode.classList.toggle("text-error", tooLong);
    send.disabled = sending || !content.value.trim() || !phone.value.trim() || tooLong;
  };

  const pick = (number: string): void => {
    phone.value = number;
    suggestions.classList.add("hidden");
    updatePreview();
    content.focus();
  };

  const remotePreview = debounce((raw: string, code: string) => {
    ctx.api
      .smsPreview({ phone: raw, content: content.value, countryCode: code })
      .then((res) => {
        if (phone.value.trim() !== raw) return;
        const r = res.preview.recipient;
        if (r?.ok) {
          mount(preview, icon("check", "text-success"), h("span", null, ctx.t("new.preview_target", { country: `${r.flag} ${countryName(ctx, r)}`, phone: shownNumber(ctx, r.phone) })));
        } else {
          mount(preview, icon("alert", "text-warning"), h("span", { class: "text-warning" }, r?.error ?? ctx.t("new.invalid_phone")));
        }
      })
      .catch(() => undefined);
  }, 180);

  const updatePreview = (): void => {
    const raw = phone.value.trim();
    updateMode();
    if (!raw) {
      suggestions.classList.add("hidden");
      mount(preview, icon("info"), h("span", null, ctx.t("new.preview_default", { code: country.value })));
      return;
    }
    const q = raw.toLowerCase();
    const hits = shared.contacts.filter((c) => c.name.toLowerCase().includes(q) || c.phones.some((p) => p.toLowerCase().includes(q))).slice(0, 5);
    const exact = hits.some((c) => c.phones.includes(raw));
    if (hits.length > 0 && !exact) {
      mount(
        suggestions,
        ...hits.flatMap((c, ci) =>
          c.phones.slice(0, 2).map((number, pi) =>
            h(
              "button",
              {
                class: `w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-xl text-left ${ci === 0 && pi === 0 ? "bg-primary/10 hover:bg-primary/15" : "hover:bg-base-200"}`,
                attrs: { type: "button" },
                on: { click: () => pick(number) },
              },
              avatar(c.name, { brand: false, known: true, size: "size-7 text-[11px]", accent: ci === 0 && pi === 0 }),
              h("span", { class: "text-sm font-medium truncate" }, c.name),
              h("span", { class: "ml-auto text-xs num muted" }, shownNumber(ctx, number))
            )
          )
        )
      );
      suggestions.classList.remove("hidden");
    } else {
      suggestions.classList.add("hidden");
    }
    if (isLikelyContactNameQuery(raw)) {
      const first = hits[0];
      mount(preview, icon(first ? "check" : "info", first ? "text-primary" : ""), h("span", null, first ? ctx.t("new.hit_hint", { name: first.name }) : ctx.t("new.no_contact")));
      return;
    }
    remotePreview(raw, country.value);
  };

  phone.addEventListener("input", updatePreview);
  country.addEventListener("change", updatePreview);
  content.addEventListener("input", updateMode);
  phone.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== "Tab") return;
    const first = suggestions.querySelector<HTMLButtonElement>("button");
    if (first && !suggestions.classList.contains("hidden") && isLikelyContactNameQuery(phone.value)) {
      event.preventDefault();
      first.click();
    }
  });
  content.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      if (!event.repeat) form.requestSubmit();
    }
  });

  const form = h(
    "form",
    null,
    h(
      "div",
      { class: "flex items-center justify-between px-5 pt-5 pb-3" },
      h("h3", { class: "text-lg font-bold serif" }, ctx.t("new.title")),
      h("button", { class: "btn btn-ghost btn-sm btn-circle", attrs: { type: "button", "aria-label": ctx.t("common.close") }, on: { click: () => dialog.close() } }, icon("x", "text-base"))
    ),
    h(
      "div",
      { class: "px-5 pb-3 border-b border-base-content/[0.08]" },
      h("div", { class: "flex items-center gap-2.5" }, h("span", { class: "text-sm muted shrink-0" }, ctx.t("new.recipient")), country, phone),
      suggestions,
      preview
    ),
    content,
    noticeSlot,
    h(
      "div",
      { class: "flex items-center justify-between gap-2 px-5 py-3 bg-base-200/50 border-t border-base-content/[0.06]" },
      mode,
      h("div", { class: "flex gap-2" }, h("button", { class: "btn btn-ghost btn-sm rounded-lg", attrs: { type: "button" }, on: { click: () => dialog.close() } }, ctx.t("common.cancel")), send)
    )
  );

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const number = phone.value.trim();
    const text = content.value.trim();
    // requestSubmit() does not look at the disabled button, so the flag is what keeps it to one send
    if (sending || !number || !text) return;
    sending = true;
    send.disabled = true;
    send.replaceChildren(h("span", { class: "loading loading-spinner loading-xs" }), ctx.t("new.sending"));
    mount(noticeSlot);
    void sendAndReport(ctx, { phone: number, content: text, countryCode: country.value })
      .then(async (report) => {
        if (report.submitted) {
          dialog.close();
          if (report.threadKey) {
            await shared.reload();
            await shared.openThread(report.threadKey);
            if (report.notice) shared.setNotice({ ...report.notice, threadKey: report.threadKey });
          }
          return;
        }
        if (report.notice) {
          mount(
            noticeSlot,
            h(
              "div",
              { class: "fs-notice my-3", data: { tone: report.notice.tone }, attrs: { role: "alert" } },
              icon(report.notice.tone === "pending" ? "history" : "alert", report.notice.tone === "pending" ? "text-warning mt-0.5" : "text-error mt-0.5"),
              h("div", null, h("div", { class: "font-semibold" }, report.notice.title), report.notice.body ? h("div", { class: "text-xs muted mt-0.5" }, report.notice.body) : null)
            )
          );
        }
      })
      .finally(() => {
        sending = false;
        send.replaceChildren(icon("send"), ctx.t("new.send"));
        updateMode();
      });
  });

  mount(dialog, h("div", { class: "modal-box p-0 sm:max-w-lg overflow-hidden" }, form), modalBackdrop(ctx.t("common.close")));
  updatePreview();
  dialog.showModal();
  setTimeout(() => (phone.value ? content : phone).focus(), 50);
}
