import type { DeletedSmsMessage } from "../../../../src/api-contract.ts";
import { formatShortTime, trashDaysLeft } from "../../core/sms.ts";
import type { AppContext } from "../context.ts";
import { byId, h, icon, modalBackdrop, mount } from "../dom.ts";
import { emptyState } from "../widgets.ts";
import { type SmsShared, avatar, isBrandSender, messageBody, senderTitle } from "./shared.ts";

/**
 * Recently deleted: messages deleted from the router that FengSui still keeps for the days set in
 * Settings → General. Restore one into its conversation (kept only in FengSui from then on), or
 * delete one, or all, for good; only the console may do the latter.
 */
export function openTrash(ctx: AppContext, shared: SmsShared): void {
  const dialog = byId<HTMLDialogElement>("smsTrashDialog");
  let messages: ReadonlyArray<DeletedSmsMessage> = [];
  let days = ctx.store.state.sms?.trashDays ?? 30;

  const list = h("div", { class: "flex-1 min-h-40 overflow-y-auto px-3 pb-3" });
  const count = h("span", { class: "text-sm muted num" });
  const note = h("p", { class: "px-5 pb-2 text-xs muted" });
  const purgeAll = h("button", { class: "btn btn-ghost btn-sm rounded-lg gap-1.5 font-normal hover:text-error", attrs: { type: "button" }, data: { trash: "purge-all" } }, icon("trash"), ctx.t("trash.purge_all"));

  const refresh = async (): Promise<void> => {
    try {
      const res = await ctx.api.smsTrash();
      messages = res.messages;
      days = res.trashDays;
      render();
    } catch (err) {
      ctx.toast(ctx.describeError(err), "error");
    }
  };

  /** Run a change, then show both lists as they are now; a confirmation may have closed this dialog. */
  const act = async (work: () => Promise<void>): Promise<void> => {
    try {
      await work();
      await Promise.all([refresh(), shared.reload()]);
    } catch (err) {
      ctx.toast(ctx.describeError(err), "error");
    }
    if (!dialog.open) dialog.showModal();
  };

  const restore = (message: DeletedSmsMessage): void => {
    void act(async () => {
      const res = await ctx.api.smsRestore([message.uid]);
      ctx.toast(ctx.t("toast.restored", { count: res.restored }), "success");
    });
  };

  const purge = async (title: string, body: { uids: string[] } | { all: true }): Promise<void> => {
    const ok = await ctx.confirm({ title, body: [ctx.t("trash.purge_body")], confirmLabel: ctx.t("trash.purge"), tone: "error" });
    if (!ok) {
      if (!dialog.open) dialog.showModal();
      return;
    }
    await act(async () => {
      const res = await ctx.api.smsPurge(body);
      ctx.toast(ctx.t("toast.purged", { count: res.purged }), "success");
    });
  };

  const render = (): void => {
    count.textContent = messages.length > 0 ? String(messages.length) : "";
    note.textContent = days > 0 ? ctx.t("trash.note", { days }) : ctx.t("trash.off");
    purgeAll.disabled = messages.length === 0;
    if (messages.length === 0) {
      mount(list, emptyState("trash", ctx.t("trash.empty")));
      return;
    }
    const now = ctx.now();
    mount(
      list,
      ...messages.map((m, i) => {
        const title = senderTitle(ctx, m.sender, m.contact, m.phone);
        const left = trashDaysLeft(m.purgeAtIso, now);
        const back = h("button", { class: "btn btn-ghost btn-xs rounded-lg gap-1 font-normal", attrs: { type: "button" }, data: { trash: "restore" } }, icon("history", "text-sm"), ctx.t("trash.restore"));
        back.addEventListener("click", () => restore(m));
        const gone = h("button", { class: "btn btn-ghost btn-xs btn-square rounded-lg hover:text-error", title: ctx.t("trash.purge"), attrs: { type: "button", "aria-label": ctx.t("trash.purge") }, data: { trash: "purge" } }, icon("trash", "text-sm"));
        gone.addEventListener("click", () => void purge(ctx.t("trash.purge_title"), { uids: [m.uid] }));
        return h(
          "div",
          { class: "flex items-start gap-3 px-2 py-2 rounded-xl hover:bg-base-200/70 anim-rise", style: `--i:${i}`, data: { uid: m.uid } },
          avatar(m.contact?.name ?? title, { brand: isBrandSender(m.sender), known: Boolean(m.contact), size: "size-9 text-xs" }),
          h(
            "div",
            { class: "min-w-0 flex-1 space-y-0.5" },
            h("div", { class: "flex items-center gap-2" }, h("span", { class: "text-sm font-medium truncate" }, title), h("span", { class: "ml-auto shrink-0 text-[11px] faint num" }, formatShortTime(m.date, ctx.tr.locale))),
            // As in the conversations: the verification code stays hidden while SMS are masked
            h("p", { class: "text-xs muted line-clamp-2 break-words" }, ...messageBody(ctx, m.content, m.verificationCode)),
            h("p", { class: `text-[11px] ${left === 0 ? "text-warning" : "faint"}` }, left > 0 ? ctx.t("trash.days_left", { days: left }) : ctx.t("trash.last_day"))
          ),
          h("div", { class: "flex items-center gap-0.5 shrink-0" }, back, gone)
        );
      })
    );
  };

  purgeAll.addEventListener("click", () => void purge(ctx.t("trash.purge_all_title", { count: messages.length }), { all: true }));

  mount(
    dialog,
    h(
      "div",
      { class: "modal-box p-0 sm:max-w-xl flex flex-col max-h-[85vh] overflow-hidden" },
      h(
        "div",
        { class: "px-5 pt-5 pb-2 flex items-center gap-2" },
        h("h3", { class: "text-lg font-bold serif" }, ctx.t("trash.title")),
        count,
        h(
          "div",
          { class: "ml-auto flex items-center gap-0.5" },
          purgeAll,
          h("form", { attrs: { method: "dialog" } }, h("button", { class: "btn btn-ghost btn-sm btn-circle", attrs: { "aria-label": ctx.t("common.close") } }, icon("x", "text-base")))
        )
      ),
      note,
      list
    ),
    modalBackdrop(ctx.t("common.close"))
  );
  render();
  dialog.showModal();
  void refresh();
}
