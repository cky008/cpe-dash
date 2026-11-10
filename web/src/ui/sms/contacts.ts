import type { ContactRecord } from "../../../../src/api-contract.ts";
import { canWrite } from "../../core/device-access-view.ts";
import type { AppContext } from "../context.ts";
import { byId, debounce, h, icon, modalBackdrop, mount, replay } from "../dom.ts";
import { emptyState } from "../widgets.ts";
import { type SmsShared, avatar, shownNumber } from "./shared.ts";

/** Contact book (cpe-sms layout): search, add / edit with note, delete, iPhone vCard import. */
export function openContacts(ctx: AppContext, shared: SmsShared, prefill?: { phone: string; name: string; note: string }): void {
  const dialog = byId<HTMLDialogElement>("contactsDialog");
  let contacts: ReadonlyArray<ContactRecord> = shared.contacts;
  let query = "";

  const name = h("input", { class: "input input-sm w-full rounded-lg", attrs: { type: "text", required: "", maxlength: "64", placeholder: ctx.t("contacts.name") } });
  const phone = h("input", { class: "input input-sm w-full rounded-lg num", attrs: { type: "text", required: "", maxlength: "64", placeholder: ctx.t("contacts.phone") } });
  const note = h("input", { class: "input input-sm flex-1 min-w-0 rounded-lg", attrs: { type: "text", maxlength: "200", placeholder: ctx.t("contacts.note") } });
  const form = h(
    "form",
    { class: "hidden mx-5 mb-3 p-3 rounded-xl bg-base-200/70 space-y-2" },
    h("div", { class: "grid grid-cols-1 sm:grid-cols-2 gap-2" }, name, phone),
    h("div", { class: "flex gap-2" }, note, h("button", { class: "btn btn-primary btn-sm rounded-lg", attrs: { type: "submit" } }, ctx.t("contacts.save")))
  );
  const list = h("div", { class: "flex-1 min-h-40 overflow-y-auto px-3 pb-3" });
  const count = h("span", { class: "text-sm muted num" });
  const searchInput = h("input", { attrs: { type: "search", autocomplete: "off", placeholder: ctx.t("contacts.search") } });
  const fileInput = h("input", { class: "hidden", attrs: { type: "file", accept: ".vcf,text/vcard,text/x-vcard" } });

  const showForm = (values?: { phone: string; name: string; note: string }): void => {
    form.classList.remove("hidden");
    replay(form, "anim-pop-in");
    if (values) {
      name.value = values.name;
      phone.value = values.phone;
      note.value = values.note;
    }
    setTimeout(() => (name.value ? note : name).focus(), 40);
  };

  const refresh = async (): Promise<void> => {
    try {
      const res = await ctx.api.smsContacts(query);
      contacts = res.contacts;
      if (!query) shared.contacts = res.contacts;
      count.textContent = res.total > 0 ? String(res.total) : "";
      render();
    } catch (err) {
      ctx.toast(ctx.describeError(err), "error");
    }
  };

  const render = (): void => {
    if (contacts.length === 0) {
      mount(list, emptyState("contacts", ctx.t("contacts.empty"), ctx.t("contacts.empty_hint")));
      return;
    }
    mount(
      list,
      ...contacts.map((c, i) => {
        const message = h("button", { class: "btn btn-ghost btn-xs btn-square rounded-lg", title: ctx.t("contacts.send"), attrs: { type: "button", "aria-label": ctx.t("contacts.send") } }, icon("message", "text-sm"));
        message.addEventListener("click", () => {
          dialog.close();
          shared.openCompose({ phone: c.phones[0] ?? "" });
        });
        const edit = h("button", { class: "btn btn-ghost btn-xs btn-square rounded-lg", title: ctx.t("contacts.edit"), attrs: { type: "button", "aria-label": ctx.t("contacts.edit") } }, icon("pencil", "text-sm"));
        edit.addEventListener("click", () => showForm({ phone: c.phones[0] ?? "", name: c.name, note: c.note ?? "" }));
        const remove = h("button", { class: "btn btn-ghost btn-xs btn-square rounded-lg hover:text-error", title: ctx.t("contacts.delete"), attrs: { type: "button", "aria-label": ctx.t("contacts.delete") } }, icon("trash", "text-sm"));
        remove.addEventListener("click", () => {
          void ctx.confirm({ title: ctx.t("contacts.delete"), body: [ctx.t("contacts.confirm_delete", { name: c.name })], confirmLabel: ctx.t("contacts.delete"), tone: "error" }).then(async (ok) => {
            if (!ok) return;
            try {
              await ctx.api.contactDelete(c.id);
              await Promise.all([refresh(), shared.reload()]);
            } catch (err) {
              ctx.toast(ctx.describeError(err), "error");
            }
            if (!dialog.open) dialog.showModal();
          });
        });
        return h(
          "div",
          { class: "group flex items-center gap-3 px-2 py-2 rounded-xl hover:bg-base-200/70 anim-rise", style: `--i:${i}` },
          avatar(c.name, { brand: false, known: true, size: "size-9 text-xs" }),
          h(
            "div",
            { class: "min-w-0 flex-1" },
            h("div", { class: "text-sm font-medium truncate" }, c.name, c.note ? h("span", { class: "ml-1.5 font-normal faint" }, c.note) : null),
            h("div", { class: "text-xs num muted truncate" }, c.phones.map((p) => shownNumber(ctx, p)).join(" · "))
          ),
          // Where the gate refuses SMS writes (not implemented for this model, or turned off), nothing is sent: no message button
          h("div", { class: "flex items-center gap-0.5 shrink-0 reveal-on-hover" }, canWrite(ctx.store.state.scheduler, "smsWrite") ? message : null, edit, remove)
        );
      })
    );
  };

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const values = { phone: phone.value.trim(), name: name.value.trim(), note: note.value.trim() };
    if (!values.phone || !values.name) return;
    ctx.api
      .contactUpsert({ phone: values.phone, name: values.name, ...(values.note ? { note: values.note } : {}) })
      .then(async () => {
        form.reset();
        form.classList.add("hidden");
        ctx.toast(ctx.t("contacts.saved", { name: values.name }), "success");
        await Promise.all([refresh(), shared.reload()]);
      })
      .catch((err: unknown) => ctx.toast(ctx.describeError(err), "error"));
  });

  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    void file
      .text()
      .then((vcf) => ctx.api.importVcf(vcf))
      .then(async (res) => {
        ctx.toast(ctx.t("contacts.imported", { ...res.summary }), "success");
        await Promise.all([refresh(), shared.reload()]);
      })
      .catch((err: unknown) => ctx.toast(ctx.describeError(err), "error"))
      .finally(() => {
        fileInput.value = "";
      });
  });

  searchInput.addEventListener(
    "input",
    debounce(() => {
      query = searchInput.value;
      void refresh();
    }, 150)
  );

  const addBtn = h("button", { class: "btn btn-ghost btn-sm btn-square rounded-lg", title: ctx.t("contacts.new"), attrs: { type: "button", "aria-label": ctx.t("contacts.new") } }, icon("plus", "text-base"));
  addBtn.addEventListener("click", () => {
    if (form.classList.contains("hidden")) {
      form.reset();
      showForm();
    } else {
      form.classList.add("hidden");
    }
  });

  mount(
    dialog,
    h(
      "div",
      { class: "modal-box p-0 sm:max-w-xl flex flex-col max-h-[85vh] overflow-hidden" },
      h(
        "div",
        { class: "px-5 pt-5 pb-3 flex items-center gap-2" },
        h("h3", { class: "text-lg font-bold serif" }, ctx.t("contacts.title")),
        count,
        h(
          "div",
          { class: "ml-auto flex items-center gap-0.5" },
          h("label", { class: "btn btn-ghost btn-sm rounded-lg gap-1.5 font-normal cursor-pointer", title: ctx.t("contacts.import_hint") }, icon("upload"), ctx.t("contacts.import"), fileInput),
          addBtn,
          h("form", { attrs: { method: "dialog" } }, h("button", { class: "btn btn-ghost btn-sm btn-circle", attrs: { "aria-label": ctx.t("common.close") } }, icon("x", "text-base")))
        )
      ),
      form,
      h("div", { class: "px-5 pb-2" }, h("label", { class: "field-soft" }, icon("search"), searchInput)),
      list,
      h("p", { class: "px-5 py-3 text-[11px] faint border-t border-base-content/[0.06] flex items-start gap-1.5" }, icon("lock", "mt-px"), ctx.t("contacts.privacy"))
    ),
    modalBackdrop(ctx.t("common.close"))
  );
  if (prefill) showForm(prefill);
  count.textContent = contacts.length > 0 ? String(contacts.length) : "";
  render();
  dialog.showModal();
  void refresh();
}
