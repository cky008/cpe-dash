import type { AntennaModeName, BandLockRequest, RouterSettingsSnapshot } from "../../../src/api-contract.ts";
import { H168_383_LTE_BANDS, H168_383_NR_BANDS, bandsToHexMask } from "../../../src/rf-bounds.ts";
import { VERIFIED_FIRMWARE } from "../../../src/firmware.ts";
import { ApiError } from "../core/api.ts";
import type { DriverFamily } from "../../../src/router-family.ts";
import type { WriteFeature } from "../../../src/features.ts";
import { cellularOpen } from "../core/cellular-view.ts";
import { experimentalWrites, reportVerified, unconfirmedWrite, unverifiedModel } from "../core/device-access-view.ts";
import { bandText, driverFamilyOf, locksNrBands, parseBandText } from "../core/lock-form.ts";
import { formatAgo, formatClock } from "../core/format.ts";
import { bandLabel } from "../core/rf.ts";
import { lockRollbackNote, selfHealRows } from "../core/self-heal-view.ts";
import type { MessageKey } from "../i18n/zh-CN.ts";
import type { AppContext } from "./context.ts";
import { type Child, byId, h, icon, modalBackdrop, mount } from "./dom.ts";
import { describeLock } from "./health-card.ts";
import { runBusy } from "./widgets.ts";
import type { HelpTopicId } from "../core/help.ts";
import { withHelp } from "./help.ts";

type FirewallKey = keyof RouterSettingsSnapshot["firewall"];

const FIREWALL_SWITCHES: ReadonlyArray<[FirewallKey, MessageKey, HelpTopicId]> = [
  ["mainSwitch", "ctl.firewall", "firewall"],
  ["ipFilterSwitch", "ctl.fw_ip", "firewall"],
  ["wanPortPingSwitch", "ctl.fw_ping", "wan-ping"],
  ["macFilterSwitch", "ctl.fw_mac", "fw-mac"],
  ["urlFilterSwitch", "ctl.fw_url", "firewall"],
];

interface FirewallConfirmCopy {
  onTitle: MessageKey;
  onBody: MessageKey;
  offTitle: MessageKey;
  offBody: MessageKey;
}

const FIREWALL_CONFIRM: Readonly<Record<FirewallKey, FirewallConfirmCopy>> = {
  mainSwitch: {
    onTitle: "ctl.fw_main_on_title",
    onBody: "ctl.fw_main_on_body",
    offTitle: "ctl.fw_main_off_title",
    offBody: "ctl.fw_main_off_body",
  },
  ipFilterSwitch: {
    onTitle: "ctl.fw_ip_on_title",
    onBody: "ctl.fw_ip_on_body",
    offTitle: "ctl.fw_ip_off_title",
    offBody: "ctl.fw_ip_off_body",
  },
  wanPortPingSwitch: {
    onTitle: "ctl.fw_ping_on_title",
    onBody: "ctl.fw_ping_on_body",
    offTitle: "ctl.fw_ping_off_title",
    offBody: "ctl.fw_ping_off_body",
  },
  macFilterSwitch: {
    onTitle: "ctl.fw_mac_on_title",
    onBody: "ctl.fw_mac_on_body",
    offTitle: "ctl.fw_mac_off_title",
    offBody: "ctl.fw_mac_off_body",
  },
  urlFilterSwitch: {
    onTitle: "ctl.fw_url_on_title",
    onBody: "ctl.fw_url_on_body",
    offTitle: "ctl.fw_url_off_title",
    offBody: "ctl.fw_url_off_body",
  },
};

const ANTENNA_MODES: ReadonlyArray<[AntennaModeName, MessageKey]> = [
  ["auto", "ctl.antenna_auto"],
  ["internal", "ctl.antenna_internal"],
  ["external", "ctl.antenna_external"],
];

const ANTENNA_CONFIRM: Readonly<Record<AntennaModeName, { title: MessageKey; body: MessageKey }>> = {
  auto: {
    title: "ctl.antenna_auto_title",
    body: "ctl.antenna_auto_body",
  },
  internal: {
    title: "ctl.antenna_internal_title",
    body: "ctl.antenna_internal_body",
  },
  external: {
    title: "ctl.antenna_external_title",
    body: "ctl.antenna_external_body",
  },
  hybrid: {
    title: "ctl.antenna_hybrid_title",
    body: "ctl.antenna_hybrid_body",
  },
};

/** A router of another brand may also use both at once (the H168-383 has the three above). */
const DRIVER_ANTENNA_MODES: ReadonlyArray<[AntennaModeName, MessageKey]> = [...ANTENNA_MODES, ["hybrid", "ctl.antenna_hybrid"]];

const IPV4_RE = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

function section(title: Child, ...children: Child[]): HTMLElement {
  return h("section", { class: "space-y-2.5" }, h("h4", { class: "fs-card-title text-[0.9rem]" }, title), ...children);
}

/** Right-hand drawer with every router write the contract offers, each confirmed and re-validated server-side. */
export function mountControls(ctx: AppContext): { open(): void } {
  const dialog = byId<HTMLDialogElement>("controlsDialog");
  const lteSelected = new Set<number>(H168_383_LTE_BANDS);
  const nrSelected = new Set<number>(H168_383_NR_BANDS);
  /** An experimental band lock (a model nobody verified): LTE only, among the bands the router advertises. */
  const genericSelected = new Set<number>();
  /** A band lock on another brand's router: the bands as typed (kept across re-renders). */
  const typedBands = { lte: "", nr: "" };

  const syncSelectionFromLock = (): void => {
    const lock = ctx.store.state.lockState;
    lteSelected.clear();
    nrSelected.clear();
    for (const b of !lock || lock.lteBands === "all" ? H168_383_LTE_BANDS : lock.lteBands) lteSelected.add(b);
    for (const b of !lock || lock.nrBands.length === 0 ? H168_383_NR_BANDS : lock.nrBands) nrSelected.add(b);
    const advertised = ctx.store.state.scheduler?.device.lteBands ?? [];
    const locked = lock && lock.lteBands !== "all" ? lock.lteBands.filter((b) => advertised.includes(b)) : [];
    genericSelected.clear();
    for (const b of locked.length > 0 ? locked : advertised) genericSelected.add(b);
    typedBands.lte = bandText(lock && lock.mode !== "unlocked" && lock.lteBands !== "all" ? lock.lteBands : null);
    typedBands.nr = bandText(lock && lock.mode !== "unlocked" ? lock.nrBands : null);
  };

  // What self-healing will do next: updated in place, because the "scheduler" topic it comes with is
  // polled every 10 s and a full render would reset a half-typed DMZ address
  const selfHealList = h("div");
  const renderSelfHeal = (): void => {
    selfHealList.replaceChildren(
      ...selfHealRows(ctx.store.state.selfHeal, ctx.t, (ms) => formatClock(ms, false)).map((row) =>
        h(
          "div",
          { class: "flex items-start justify-between gap-3 py-1.5 border-b border-dashed border-base-content/10" },
          h("span", { class: "text-sm shrink-0" }, row.label),
          h("span", { class: `text-xs text-right ${row.tone === "pending" ? "text-warning" : row.tone === "muted" ? "faint" : "muted"}` }, row.value)
        )
      )
    );
  };

  const patchSettings = (patch: Partial<RouterSettingsSnapshot>): void => {
    const current = ctx.store.state.settings;
    if (current) ctx.store.update({ settings: { ...current, ...patch } }, ["settings"]);
  };

  /**
   * A security write is read back in a second session: a 502 may mean the write applied but the
   * read-back failed (contract §2.4), so ask for a re-read instead of claiming failure.
   */
  const fail = (err: unknown, mayHaveApplied = false): void => {
    if (mayHaveApplied && err instanceof ApiError && err.kind === "upstream") {
      ctx.toast(ctx.t("ctl.write_partial"), "warning");
      return;
    }
    ctx.toast(ctx.describeError(err), "error");
  };

  const bandGrid = (rat: "LTE" | "NR", bands: ReadonlyArray<number>, selected: Set<number>, onChange: () => void): HTMLElement =>
    h(
      "div",
      { class: "grid grid-cols-4 sm:grid-cols-5 gap-1.5" },
      ...bands.map((band) => {
        const box = h("input", { class: "checkbox checkbox-xs checkbox-primary", attrs: { type: "checkbox" } });
        box.checked = selected.has(band);
        box.addEventListener("change", () => {
          if (box.checked) selected.add(band);
          else selected.delete(band);
          onChange();
        });
        return h("label", { class: "flex items-center gap-1.5 rounded-lg px-2 py-1 bg-base-content/[0.04] cursor-pointer num text-xs" }, box, bandLabel(rat, band));
      })
    );

  const selection = (bands: ReadonlyArray<number>, selected: Set<number>): Array<number> | "all" | undefined => {
    if (selected.size === 0) return undefined;
    if (selected.size === bands.length) return "all";
    return bands.filter((b) => selected.has(b));
  };

  const maskText = (bands: ReadonlyArray<number>, selected: Set<number>): string =>
    selected.size === 0 ? ctx.t("ctl.mask_none") : ctx.t("ctl.mask", { mask: bandsToHexMask([...selected]) }) + (selected.size === bands.length ? ctx.t("ctl.all_bands_suffix") : "");

  const applyBands = (button: HTMLButtonElement): void => {
    const body: BandLockRequest = {};
    const lte = selection(H168_383_LTE_BANDS, lteSelected);
    const nr = selection(H168_383_NR_BANDS, nrSelected);
    if (lte !== undefined) body.lteBands = lte;
    if (nr !== undefined) body.nrBands = nr;
    if (lte === undefined && nr === undefined) {
      ctx.toast(ctx.t("ctl.nothing_selected"), "warning");
      return;
    }
    const describe = (rat: "LTE" | "NR", value: Array<number> | "all" | undefined): string =>
      value === undefined ? "" : value === "all" ? ctx.t("ctl.all_bands", { rat }) : value.map((b) => bandLabel(rat, b)).join("+");
    const summary = [describe("LTE", lte), describe("NR", nr)].filter(Boolean).join(" · ");
    // Whether a lock that cuts the WAN is rolled back on its own, said before it is applied
    const rollback = lockRollbackNote(ctx.store.state.selfHeal, ctx.t);
    void ctx
      .confirm({ title: ctx.t("ctl.lock_bands_title"), body: [ctx.t("ctl.lock_bands_body", { summary }), ...(rollback ? [rollback] : [])], confirmLabel: ctx.t("ctl.apply_bands"), tone: "warning" })
      .then((ok) => {
        if (!ok) return;
        runBusy(button, async () => {
          try {
            const res = await ctx.api.bandLock(body);
            ctx.store.update({ lockState: res.lockState }, ["locks"]);
          } catch (err) {
            fail(err);
          }
        });
      });
  };

  const toggle = (checked: boolean, disabled: boolean, onChange: (next: boolean, input: HTMLInputElement) => void): HTMLInputElement => {
    const input = h("input", { class: "toggle toggle-sm toggle-primary", attrs: { type: "checkbox" } });
    input.checked = checked;
    input.disabled = disabled;
    input.addEventListener("change", () => onChange(input.checked, input));
    return input;
  };

  const switchRow = (label: Child, control: HTMLElement, hint?: string): HTMLElement =>
    h(
      "label",
      { class: "flex items-center justify-between gap-3 py-1.5 border-b border-dashed border-base-content/10 cursor-pointer" },
      h("span", { class: "text-sm" }, label, hint ? h("span", { class: "block text-[0.6875rem] faint" }, hint) : null),
      control
    );

  /** Optimistic toggle: revert the switch when the router refuses. */
  const write = (input: HTMLInputElement, task: () => Promise<void>, mayHaveApplied = false): void => {
    input.disabled = true;
    task()
      .catch((err: unknown) => {
        if (mayHaveApplied && err instanceof ApiError && err.kind === "upstream") {
          fail(err, true);
          void ctx.api
            .refreshSettings()
            .then((res) => ctx.store.update({ settings: res.settings, scheduler: res.schedulerStatus }, ["settings", "scheduler"]))
            .catch(() => undefined);
          return;
        }
        input.checked = !input.checked;
        fail(err, mayHaveApplied);
      })
      .finally(() => {
        input.disabled = false;
      });
  };

  /**
   * The confirm dialog of a write on a model nobody verified: its own text, then that it was never checked
   * on a real router, unless someone verified it on this model (an unlock: either lock).
   */
  const confirmExperimental = (features: ReadonlyArray<WriteFeature>, options: Parameters<AppContext["confirm"]>[0]): Promise<boolean> =>
    ctx.confirm(unconfirmedWrite(ctx.store.state.scheduler, features) ? { ...options, body: [...options.body, ctx.t("ctl.experimental_note")] } : options);

  /** LTE band lock on a model nobody verified: the bands it advertises, no NR band or cell lock. */
  const experimentalBandSection = (bands: ReadonlyArray<number>): HTMLElement => {
    const mask = h("span", { class: "num text-[0.6875rem] faint" }, maskText(bands, genericSelected));
    const refreshMask = (): void => {
      mask.textContent = maskText(bands, genericSelected);
    };
    const applyBtn = h("button", { class: "btn btn-warning btn-sm rounded-lg gap-1.5", attrs: { type: "button" } }, icon("lock"), ctx.t("ctl.apply_bands"));
    applyBtn.addEventListener("click", () => {
      const lte = selection(bands, genericSelected);
      if (lte === undefined) {
        ctx.toast(ctx.t("ctl.nothing_selected"), "warning");
        return;
      }
      const summary = lte === "all" ? ctx.t("ctl.all_bands", { rat: "LTE" }) : lte.map((b) => bandLabel("LTE", b)).join("+");
      void confirmExperimental(["bandLock"], { title: ctx.t("ctl.lock_bands_title"), body: [ctx.t("ctl.lock_bands_body", { summary })], confirmLabel: ctx.t("ctl.apply_bands"), tone: "warning" }).then((ok) => {
        if (!ok) return;
        runBusy(applyBtn, async () => {
          try {
            const res = await ctx.api.bandLock({ lteBands: lte });
            ctx.store.update({ lockState: res.lockState }, ["locks"]);
          } catch (err) {
            fail(err);
          }
        });
      });
    });
    const unlockBtn = experimentalUnlockButton();
    const quickAll = (all: boolean): void => {
      genericSelected.clear();
      if (all) for (const b of bands) genericSelected.add(b);
      render();
    };
    return section(
      withHelp(ctx, ctx.t("ctl.band_lock"), "lock-band"),
      h("p", { class: "text-xs muted" }, ctx.t("ctl.current", { summary: describeLock(ctx, ctx.store.state.lockState) })),
      h(
        "div",
        { class: "flex items-center gap-2 text-xs font-semibold" },
        ctx.t("ctl.lte_bands"),
        mask,
        h(
          "span",
          { class: "ml-auto inline-flex gap-1" },
          h("button", { class: "btn btn-ghost btn-xs", attrs: { type: "button" }, on: { click: () => quickAll(true) } }, ctx.t("ctl.select_all")),
          h("button", { class: "btn btn-ghost btn-xs", attrs: { type: "button" }, on: { click: () => quickAll(false) } }, ctx.t("ctl.select_none"))
        )
      ),
      bandGrid("LTE", bands, genericSelected, refreshMask),
      h("p", { class: "text-[0.6875rem] faint" }, ctx.t("dev.experimental_lte_only")),
      h("div", { class: "flex gap-2 justify-end" }, unlockBtn, applyBtn)
    );
  };

  /** Take every lock off, on a model nobody verified (asked first, like every experimental write). */
  const experimentalUnlockButton = (): HTMLButtonElement => {
    const unlockBtn = h("button", { class: "btn btn-ghost btn-sm rounded-lg gap-1.5", attrs: { type: "button" } }, icon("unlock"), ctx.t("ctl.unlock_all"));
    unlockBtn.addEventListener("click", () => {
      void confirmExperimental(["bandLock", "cellLock"], { title: ctx.t("ctl.unlock_title"), body: [ctx.t("ctl.unlock_body")], confirmLabel: ctx.t("ctl.unlock_all") }).then((ok) => {
        if (!ok) return;
        runBusy(unlockBtn, async () => {
          try {
            const res = await ctx.api.unlock();
            ctx.store.update({ lockState: res.lockState }, ["locks"]);
            syncSelectionFromLock();
            render();
          } catch (err) {
            fail(err);
          }
        });
      });
    });
    return unlockBtn;
  };

  /**
   * Locks on another brand's router: its driver takes any 3GPP band, so the bands are typed, 5G ones
   * where the brand locks them; a field left empty keeps what the router has. With the cell lock
   * alone turned on there is no band to lock, only the way back.
   */
  const driverLockSection = (family: DriverFamily, bandLockOpen: boolean): HTMLElement => {
    const current = h("p", { class: "text-xs muted" }, ctx.t("ctl.current", { summary: describeLock(ctx, ctx.store.state.lockState) }));
    if (!bandLockOpen) return section(withHelp(ctx, ctx.t("ctl.band_lock"), "lock-band"), current, h("div", { class: "flex gap-2 justify-end" }, experimentalUnlockButton()));
    const field = (rat: "LTE" | "NR", key: "lte" | "nr", placeholder: string): HTMLElement => {
      const input = h("input", { class: "input input-sm rounded-lg w-full num", attrs: { type: "text", spellcheck: "false", autocomplete: "off", placeholder }, data: { bands: key } });
      input.value = typedBands[key];
      input.addEventListener("input", () => {
        typedBands[key] = input.value;
        input.classList.toggle("input-error", parseBandText(rat, input.value) === null);
      });
      return h("label", { class: "block space-y-1" }, h("span", { class: "text-xs font-semibold" }, ctx.t(rat === "LTE" ? "ctl.lte_bands" : "ctl.nr_bands")), input);
    };
    const nrShown = locksNrBands(family);
    const applyBtn = h("button", { class: "btn btn-warning btn-sm rounded-lg gap-1.5", attrs: { type: "button" } }, icon("lock"), ctx.t("ctl.apply_bands"));
    applyBtn.addEventListener("click", () => {
      const lte = parseBandText("LTE", typedBands.lte);
      const nr = nrShown ? parseBandText("NR", typedBands.nr) : undefined;
      if (lte === null || nr === null) {
        ctx.toast(ctx.t("ctl.bands_invalid", { rat: lte === null ? "4G" : "5G" }), "warning");
        return;
      }
      if (lte === undefined && nr === undefined) {
        ctx.toast(ctx.t("ctl.bands_nothing"), "warning");
        return;
      }
      const describe = (rat: "LTE" | "NR", value: Array<number> | "all" | undefined): string =>
        value === undefined ? "" : value === "all" ? ctx.t("ctl.all_bands", { rat }) : value.map((b) => bandLabel(rat, b)).join("+");
      const summary = [describe("LTE", lte), describe("NR", nr)].filter(Boolean).join(" · ");
      const body: BandLockRequest = { ...(lte !== undefined ? { lteBands: lte } : {}), ...(nr !== undefined ? { nrBands: nr } : {}) };
      void confirmExperimental(["bandLock"], { title: ctx.t("ctl.lock_bands_title"), body: [ctx.t("ctl.lock_bands_body", { summary })], confirmLabel: ctx.t("ctl.apply_bands"), tone: "warning" }).then((ok) => {
        if (!ok) return;
        runBusy(applyBtn, async () => {
          try {
            const res = await ctx.api.bandLock(body);
            ctx.store.update({ lockState: res.lockState }, ["locks"]);
          } catch (err) {
            fail(err);
          }
        });
      });
    });
    return section(
      withHelp(ctx, ctx.t("ctl.band_lock"), "lock-band"),
      current,
      field("LTE", "lte", "1, 3, 41"),
      nrShown ? field("NR", "nr", "41, 78") : null,
      h("p", { class: "text-[0.6875rem] faint" }, ctx.t("ctl.bands_typed", { example: "1, 3, 41" })),
      h("div", { class: "flex gap-2 justify-end" }, experimentalUnlockButton(), applyBtn)
    );
  };

  /**
   * The antenna on a router of another brand, written with its own notes' codes. The mode is not read
   * here, so no button shows as the current one.
   */
  const experimentalAntennaSection = (): HTMLElement =>
    section(
      withHelp(ctx, ctx.t("ctl.antenna"), "antenna"),
      h(
        "div",
        { class: "join w-full" },
        ...DRIVER_ANTENNA_MODES.map(([mode, label]) => {
          const button = h("button", { class: "btn btn-sm join-item flex-1 btn-ghost", attrs: { type: "button" }, data: { antenna: mode } }, ctx.t(label));
          button.addEventListener("click", () => {
            const conf = ANTENNA_CONFIRM[mode];
            void confirmExperimental(["antenna"], { title: ctx.t(conf.title), body: [ctx.t(conf.body)], confirmLabel: ctx.t(label) }).then((ok) => {
              if (ok) runBusy(button, () => ctx.api.antenna(mode).then(() => undefined, fail));
            });
          });
          return button;
        })
      )
    );

  /** Mobile data, redial and reboot on a model nobody verified: only those turned on. */
  const experimentalSystemSection = (open: ReadonlyArray<string>): HTMLElement => {
    const buttons: HTMLElement[] = [];
    if (open.includes("mobileData")) {
      const on = h("button", { class: "btn btn-ghost btn-sm rounded-lg gap-1.5", attrs: { type: "button" } }, icon("signal"), ctx.t("ctl.mobile_data_on"));
      const off = h("button", { class: "btn btn-ghost btn-sm rounded-lg gap-1.5", attrs: { type: "button" } }, icon("x"), ctx.t("ctl.mobile_data_off"));
      on.addEventListener("click", () => {
        void confirmExperimental(["mobileData"], { title: ctx.t("ctl.mobile_data_on"), body: [], confirmLabel: ctx.t("common.on") }).then((ok) => {
          if (ok) runBusy(on, () => ctx.api.mobileData(true).then(() => undefined, fail));
        });
      });
      off.addEventListener("click", () => {
        void confirmExperimental(["mobileData"], { title: ctx.t("ctl.mobile_off_title"), body: [ctx.t("ctl.mobile_off_body")], confirmLabel: ctx.t("common.off"), tone: "warning" }).then((ok) => {
          if (ok) runBusy(off, () => ctx.api.mobileData(false).then(() => undefined, fail));
        });
      });
      buttons.push(on, off);
    }
    if (open.includes("reconnect")) {
      const redial = h("button", { class: "btn btn-ghost btn-sm rounded-lg gap-1.5", attrs: { type: "button" } }, icon("zap"), ctx.t("ctl.reconnect"));
      redial.addEventListener("click", () => {
        void confirmExperimental(["reconnect"], { title: ctx.t("ctl.reconnect_title"), body: [ctx.t("ctl.reconnect_body")], confirmLabel: ctx.t("ctl.reconnect"), tone: "warning" }).then((ok) => {
          if (ok) runBusy(redial, () => ctx.api.reconnect().then(() => undefined, fail));
        });
      });
      buttons.push(redial);
    }
    if (open.includes("reboot")) {
      const reboot = h("button", { class: "btn btn-error btn-outline btn-sm rounded-lg gap-1.5", attrs: { type: "button" } }, icon("power"), ctx.t("ctl.reboot"));
      reboot.addEventListener("click", () => {
        void confirmExperimental(["reboot"], {
          title: ctx.t("ctl.reboot_title"),
          body: [ctx.t("ctl.reboot_body"), ctx.t("common.type_to_confirm", { word: ctx.t("ctl.reboot_word") })],
          confirmLabel: ctx.t("ctl.reboot"),
          tone: "error",
          typeToConfirm: ctx.t("ctl.reboot_word"),
        }).then((ok) => {
          if (ok) runBusy(reboot, () => ctx.api.reboot().then(() => undefined, fail));
        });
      });
      buttons.push(reboot);
    }
    return section(ctx.t("ctl.system"), h("div", { class: "flex flex-wrap gap-2 justify-end" }, ...buttons));
  };

  // The cellular settings are a section of their own, loaded when a router has one of them open
  const cellularHost = h("section", { class: "space-y-1", data: { section: "cellular" } });
  let cellularView: ReturnType<(typeof import("./cellular.ts"))["mountCellular"]> | null = null;
  const cellularSection = (open: ReadonlyArray<WriteFeature>): HTMLElement[] => {
    const settings = cellularOpen(open);
    if (settings.length === 0) return [];
    if (cellularView) cellularView.render(settings);
    else
      void import("./cellular.ts").then((m) => {
        cellularView ??= m.mountCellular(ctx, cellularHost, confirmExperimental);
        cellularView.render(settings);
      });
    return [cellularHost];
  };

  const render = (): void => {
    const { settings, lockState, lockVerification, avoidance, scheduler } = ctx.store.state;
    const noSettings = settings === null;

    const lteMask = h("span", { class: "num text-[0.6875rem] faint" }, maskText(H168_383_LTE_BANDS, lteSelected));
    const nrMask = h("span", { class: "num text-[0.6875rem] faint" }, maskText(H168_383_NR_BANDS, nrSelected));
    const refreshMasks = (): void => {
      lteMask.textContent = maskText(H168_383_LTE_BANDS, lteSelected);
      nrMask.textContent = maskText(H168_383_NR_BANDS, nrSelected);
    };
    const quickSelect = (bands: ReadonlyArray<number>, selected: Set<number>, all: boolean): void => {
      selected.clear();
      if (all) for (const b of bands) selected.add(b);
      render();
    };
    const applyBtn = h("button", { class: "btn btn-warning btn-sm rounded-lg gap-1.5", attrs: { type: "button" } }, icon("lock"), ctx.t("ctl.apply_bands"));
    applyBtn.addEventListener("click", () => applyBands(applyBtn));
    const unlockBtn = h("button", { class: "btn btn-ghost btn-sm rounded-lg gap-1.5", attrs: { type: "button" } }, icon("unlock"), ctx.t("ctl.unlock_all"));
    unlockBtn.addEventListener("click", () => {
      void ctx.confirm({ title: ctx.t("ctl.unlock_title"), body: [ctx.t("ctl.unlock_body")], confirmLabel: ctx.t("ctl.unlock_all") }).then((ok) => {
        if (!ok) return;
        runBusy(unlockBtn, async () => {
          try {
            const res = await ctx.api.unlock();
            ctx.store.update({ lockState: res.lockState }, ["locks"]);
            syncSelectionFromLock();
            render();
          } catch (err) {
            fail(err);
          }
        });
      });
    });
    const quick = (bands: ReadonlyArray<number>, selected: Set<number>): HTMLElement =>
      h(
        "span",
        { class: "ml-auto inline-flex gap-1" },
        h("button", { class: "btn btn-ghost btn-xs", attrs: { type: "button" }, on: { click: () => quickSelect(bands, selected, true) } }, ctx.t("ctl.select_all")),
        h("button", { class: "btn btn-ghost btn-xs", attrs: { type: "button" }, on: { click: () => quickSelect(bands, selected, false) } }, ctx.t("ctl.select_none"))
      );

    const bandSection = section(
      withHelp(ctx, ctx.t("ctl.band_lock"), "lock-band"),
      h("p", { class: "text-xs muted" }, ctx.t("ctl.current", { summary: describeLock(ctx, lockState) }), lockVerification?.status === "drift" ? h("span", { class: "text-warning" }, ` · ${lockVerification.issues.join("; ")}`) : null),
      h("div", { class: "flex items-center gap-2 text-xs font-semibold" }, ctx.t("ctl.lte_bands"), lteMask, quick(H168_383_LTE_BANDS, lteSelected)),
      bandGrid("LTE", H168_383_LTE_BANDS, lteSelected, refreshMasks),
      h("div", { class: "flex items-center gap-2 text-xs font-semibold pt-1" }, ctx.t("ctl.nr_bands"), nrMask, quick(H168_383_NR_BANDS, nrSelected)),
      bandGrid("NR", H168_383_NR_BANDS, nrSelected, refreshMasks),
      h("p", { class: "text-[0.6875rem] faint" }, ctx.t("ctl.band_hint")),
      h("p", { class: "text-[0.6875rem] faint" }, ctx.t("ctl.sa_note")),
      h("div", { class: "flex gap-2 justify-end" }, unlockBtn, applyBtn)
    );

    const readBtn = h("button", { class: "btn btn-ghost btn-xs rounded-lg gap-1", attrs: { type: "button" } }, icon("refresh"), ctx.t("ctl.settings_read"));
    readBtn.addEventListener("click", () =>
      runBusy(readBtn, async () => {
        try {
          const res = await ctx.api.refreshSettings();
          ctx.store.update({ settings: res.settings, scheduler: res.schedulerStatus }, ["settings", "scheduler"]);
        } catch (err) {
          fail(err);
        }
      })
    );

    const dmzInput = h("input", { class: "input input-sm rounded-lg num w-36", attrs: { type: "text", inputmode: "decimal", placeholder: "192.168.8.10", "aria-label": ctx.t("ctl.dmz_ip") } });
    dmzInput.value = settings?.dmzIpAddress ?? "";
    dmzInput.disabled = noSettings;
    const dmzToggle = toggle(settings?.dmzEnabled ?? false, noSettings, (next, input) => {
      const ip = dmzInput.value.trim();
      if (next && (!ip || !IPV4_RE.test(ip))) {
        input.checked = false;
        ctx.toast(ctx.t("ctl.dmz_invalid"), "warning");
        return;
      }
      void ctx
        .confirm({
          title: ctx.t(next ? "ctl.dmz_on_title" : "ctl.dmz_off_title"),
          body: [ctx.t(next ? "ctl.dmz_on_body" : "ctl.dmz_off_body", { ip })],
          confirmLabel: ctx.t(next ? "common.on" : "common.off"),
          ...(next ? { tone: "warning" as const } : {}),
        })
        .then((ok) => {
          if (!ok) {
            input.checked = !next;
            return;
          }
          write(
            input,
            async () => {
              const res = await ctx.api.security({ dmz: { enabled: next, ...(ip ? { ipAddress: ip } : {}) } });
              if (res.settings) ctx.store.update({ settings: res.settings }, ["settings"]);
            },
            true
          );
        });
    });
    dmzToggle.setAttribute("aria-label", ctx.t("ctl.dmz"));

    const securitySection = section(
      ctx.t("ctl.security"),
      noSettings
        ? h("p", { class: "text-xs muted" }, ctx.t("ctl.settings_waiting"))
        : h("p", { class: "text-[0.6875rem] faint" }, ctx.t("ctl.settings_captured", { ago: formatAgo(settings.capturedAtMs, ctx.now(), ctx.tr.locale) })),
      readBtn,
      switchRow(
        withHelp(ctx, ctx.t("ctl.upnp"), "upnp"),
        toggle(settings?.upnpEnabled ?? false, noSettings, (next, input) => {
          void ctx
            .confirm({
              title: ctx.t(next ? "ctl.upnp_on_title" : "ctl.upnp_off_title"),
              body: [ctx.t(next ? "ctl.upnp_on_body" : "ctl.upnp_off_body")],
              confirmLabel: ctx.t(next ? "common.on" : "common.off"),
              ...(next ? { tone: "warning" as const } : {}),
            })
            .then((ok) => {
              if (!ok) {
                input.checked = !next;
                return;
              }
              write(
                input,
                async () => {
                  const res = await ctx.api.security({ upnpEnabled: next });
                  if (res.settings) ctx.store.update({ settings: res.settings }, ["settings"]);
                },
                true
              );
            });
        })
      ),
      h("div", { class: "flex items-center gap-2 py-1.5 border-b border-dashed border-base-content/10" }, h("span", { class: "text-sm flex-1" }, withHelp(ctx, ctx.t("ctl.dmz"), "dmz")), dmzInput, dmzToggle),
      ...FIREWALL_SWITCHES.map(([key, label, help]) => {
        const conf = FIREWALL_CONFIRM[key];
        return switchRow(
          withHelp(ctx, ctx.t(label), help),
          toggle(settings?.firewall[key] ?? false, noSettings, (next, input) => {
            // Switching protection off weakens it; the firewall MAC list can cut devices off (even this host) when on
            const tone = (!next && key !== "wanPortPingSwitch") || (next && key === "macFilterSwitch") ? ("warning" as const) : undefined;
            void ctx
              .confirm({
                title: ctx.t(next ? conf.onTitle : conf.offTitle),
                body: [ctx.t(next ? conf.onBody : conf.offBody)],
                confirmLabel: ctx.t(next ? "common.on" : "common.off"),
                ...(tone ? { tone } : {}),
              })
              .then((ok) => {
                if (!ok) {
                  input.checked = !next;
                  return;
                }
                write(
                  input,
                  async () => {
                    const res = await ctx.api.security({ firewall: { [key]: next } });
                    if (res.settings) ctx.store.update({ settings: res.settings }, ["settings"]);
                  },
                  true
                );
              });
          })
        );
      }),
      h("div", { class: "fs-notice", data: { tone: "pending" } }, icon("info", "text-warning mt-0.5"), h("span", { class: "text-xs" }, ctx.t("ctl.ddos_note")))
    );

    const wifiSection = section(
      ctx.t("ctl.wifi7"),
      switchRow(
        withHelp(ctx, ctx.t("ctl.mlo"), "mlo"),
        toggle(settings?.wifi7.mloEnable ?? false, noSettings, (next, input) => {
          void ctx
            .confirm({
              title: ctx.t(next ? "ctl.mlo_on_title" : "ctl.mlo_off_title"),
              body: [ctx.t(next ? "ctl.mlo_on_body" : "ctl.mlo_off_body")],
              confirmLabel: ctx.t(next ? "common.on" : "common.off"),
            })
            .then((ok) => {
              if (!ok) {
                input.checked = !next;
                return;
              }
              write(input, async () => {
                const res = await ctx.api.wifi7({ mloEnable: next });
                patchSettings({ wifi7: res.wifi7 });
              });
            });
        })
      ),
      switchRow(
        withHelp(ctx, ctx.t("ctl.dbho"), "dbho"),
        toggle(settings?.wifi7.dbhoEnable ?? false, noSettings, (next, input) => {
          void ctx
            .confirm({
              title: ctx.t(next ? "ctl.dbho_on_title" : "ctl.dbho_off_title"),
              body: [ctx.t(next ? "ctl.dbho_on_body" : "ctl.dbho_off_body")],
              confirmLabel: ctx.t(next ? "common.on" : "common.off"),
            })
            .then((ok) => {
              if (!ok) {
                input.checked = !next;
                return;
              }
              write(input, async () => {
                const res = await ctx.api.wifi7({ dbhoEnable: next });
                patchSettings({ wifi7: res.wifi7 });
              });
            });
        })
      )
    );

    const antennaSection = section(
      withHelp(ctx, ctx.t("ctl.antenna"), "antenna"),
      h(
        "div",
        { class: "join w-full" },
        ...ANTENNA_MODES.map(([mode, label]) => {
          const button = h("button", { class: `btn btn-sm join-item flex-1 ${settings?.antenna.mode === mode ? "btn-primary" : "btn-ghost"}`, attrs: { type: "button" } }, ctx.t(label));
          button.disabled = noSettings;
          button.addEventListener("click", () => {
            if (settings?.antenna.mode === mode) return;
            const a1 = Boolean(settings?.antenna.antenna1Inserted);
            const a2 = Boolean(settings?.antenna.antenna2Inserted);
            const tone =
              mode === "external" && !a1 && !a2
                ? ("warning" as const)
                : mode === "internal" && (a1 || a2)
                  ? ("warning" as const)
                  : undefined;
            const conf = ANTENNA_CONFIRM[mode];
            void ctx
              .confirm({
                title: ctx.t(conf.title),
                body: [ctx.t(conf.body)],
                confirmLabel: ctx.t(label),
                ...(tone ? { tone } : {}),
              })
              .then((ok) => {
                if (!ok) return;
                runBusy(button, async () => {
                  try {
                    const res = await ctx.api.antenna(mode);
                    if (settings) patchSettings({ antenna: { ...settings.antenna, mode: res.antenna.mode, rawCode: String(res.antenna.rawCode) } });
                  } catch (err) {
                    fail(err);
                  }
                });
              });
          });
          return button;
        })
      ),
      settings
        ? h(
            "p",
            { class: "text-[0.6875rem] faint" },
            ctx.t("ctl.antenna_inserted", {
              a1: ctx.t(settings.antenna.antenna1Inserted ? "ctl.inserted" : "ctl.not_inserted"),
              a2: ctx.t(settings.antenna.antenna2Inserted ? "ctl.inserted" : "ctl.not_inserted"),
            })
          )
        : null
    );

    const reconnectBtn = h("button", { class: "btn btn-ghost btn-sm rounded-lg gap-1.5", attrs: { type: "button" } }, icon("zap"), ctx.t("ctl.reconnect"));
    reconnectBtn.addEventListener("click", () => {
      void ctx.confirm({ title: ctx.t("ctl.reconnect_title"), body: [ctx.t("ctl.reconnect_body")], confirmLabel: ctx.t("ctl.reconnect"), tone: "warning" }).then((ok) => {
        if (ok) runBusy(reconnectBtn, () => ctx.api.reconnect().then(() => undefined, fail));
      });
    });
    const rebootBtn = h("button", { class: "btn btn-error btn-outline btn-sm rounded-lg gap-1.5", attrs: { type: "button" } }, icon("power"), ctx.t("ctl.reboot"));
    rebootBtn.addEventListener("click", () => {
      void ctx
        .confirm({
          title: ctx.t("ctl.reboot_title"),
          body: [ctx.t("ctl.reboot_body"), ctx.t("common.type_to_confirm", { word: ctx.t("ctl.reboot_word") })],
          confirmLabel: ctx.t("ctl.reboot"),
          tone: "error",
          typeToConfirm: ctx.t("ctl.reboot_word"),
        })
        .then((ok) => {
          if (ok) runBusy(rebootBtn, () => ctx.api.reboot().then(() => undefined, fail));
        });
    });

    const systemSection = section(
      ctx.t("ctl.system"),
      switchRow(
        withHelp(ctx, ctx.t("ctl.mobile_data"), "mobile-data"),
        toggle(settings?.mobileDataEnabled ?? true, noSettings, (next, input) => {
          const run = (): void =>
            write(input, async () => {
              const res = await ctx.api.mobileData(next);
              patchSettings({ mobileDataEnabled: res.mobileDataEnabled });
            });
          if (next) {
            run();
            return;
          }
          void ctx.confirm({ title: ctx.t("ctl.mobile_off_title"), body: [ctx.t("ctl.mobile_off_body")], confirmLabel: ctx.t("common.off"), tone: "warning" }).then((ok) => {
            if (ok) run();
            else input.checked = true;
          });
        })
      ),
      h("div", { class: "flex flex-wrap gap-2 justify-end pt-1" }, reconnectBtn, rebootBtn)
    );

    const blocked = avoidance?.active || scheduler?.circuitBreaker.tripped || scheduler?.peerStandby.active;
    // A model FengSui was not verified on: say so instead of offering the H168-383's controls, and
    // offer the experimental writes open there (those FengSui implements for it, unless turned off)
    const lockedModel = unverifiedModel(scheduler);
    const open = experimentalWrites(scheduler);
    const otherBrand = driverFamilyOf(scheduler);
    const deviceBtn = h("button", { class: "btn btn-sm btn-primary rounded-lg gap-1.5", attrs: { type: "button" }, data: { action: "open-device" } }, icon("cpu"), ctx.t("dev.open_device"));
    deviceBtn.addEventListener("click", () => dialog.close());
    renderSelfHeal();
    const selfHealSection = section(withHelp(ctx, ctx.t("ctl.self_heal"), "self-heal"), selfHealList, h("p", { class: "text-[0.6875rem] faint" }, ctx.t("heal.hint")));
    let sections: HTMLElement[];
    if (lockedModel === null) {
      sections = [bandSection, selfHealSection, securitySection, wifiSection, antennaSection, systemSection];
    } else if (open.length === 0) {
      sections = [
        h(
          "div",
          { class: "space-y-3" },
          h("div", { class: "fs-notice", data: { tone: "pending" } }, icon("lock", "mt-0.5"), h("span", { class: "text-sm" }, ctx.t("dev.no_writes_controls", { model: lockedModel, verified: [...new Set(VERIFIED_FIRMWARE.map((entry) => entry.model))].join(", ") }))),
          h("div", { class: "flex justify-end" }, deviceBtn)
        ),
      ];
    } else {
      sections = [
        h(
          "div",
          { class: "space-y-3" },
          reportVerified(scheduler)
            ? h("div", { class: "fs-notice", data: { tone: "success" } }, icon("check", "text-success mt-0.5"), h("span", { class: "text-sm" }, ctx.t("dev.report_verified_controls", { model: lockedModel })))
            : h("div", { class: "fs-notice", data: { tone: "pending" } }, icon("alert", "text-warning mt-0.5"), h("span", { class: "text-sm" }, ctx.t("dev.experimental_controls", { model: lockedModel }))),
          h("div", { class: "flex justify-end" }, deviceBtn)
        ),
        // Another brand's driver locks what is typed; a HiLink model the LTE bands it advertises
        ...(otherBrand !== null && (open.includes("bandLock") || open.includes("cellLock")) ? [driverLockSection(otherBrand, open.includes("bandLock"))] : []),
        ...(otherBrand === null && open.includes("bandLock") ? [experimentalBandSection(scheduler?.device.lteBands ?? [])] : []),
        ...(open.includes("antenna") ? [experimentalAntennaSection()] : []),
        ...cellularSection(open),
        ...(open.some((f) => f === "mobileData" || f === "reconnect" || f === "reboot") ? [experimentalSystemSection(open)] : []),
      ];
    }
    // A redraw (a poll, a write elsewhere) builds the drawer anew: keep the place its reader had scrolled to
    const scrolledTo = dialog.querySelector<HTMLElement>("[data-scroll]")?.scrollTop ?? 0;
    mount(
      dialog,
      h(
        "div",
        { class: "modal-box h-full max-h-dvh w-full sm:max-w-md rounded-none sm:rounded-l-2xl p-0 flex flex-col" },
        h(
          "div",
          { class: "flex items-center gap-2 px-5 pt-5 pb-3 border-b border-base-content/[0.06]" },
          icon("sliders", "text-primary text-lg"),
          h("h3", { class: "text-lg font-bold serif" }, ctx.t("ctl.title")),
          h("form", { class: "ml-auto", attrs: { method: "dialog" } }, h("button", { class: "btn btn-ghost btn-sm btn-circle", attrs: { "aria-label": ctx.t("common.close") } }, icon("x", "text-base")))
        ),
        h(
          "div",
          { class: "flex-1 overflow-y-auto px-5 py-4 space-y-6", data: { scroll: "controls" } },
          blocked
            ? h("div", { class: "fs-notice", data: { tone: "danger" } }, icon("alert", "text-error mt-0.5"), h("span", { class: "text-xs" }, ctx.t(scheduler?.circuitBreaker.tripped ? "err.breaker" : scheduler?.peerStandby.active ? "err.peer_standby" : "err.yielded")))
            : null,
          ...sections
        )
      ),
      modalBackdrop(ctx.t("common.close"))
    );
    const scroller = dialog.querySelector<HTMLElement>("[data-scroll]");
    if (scroller && scrolledTo > 0) scroller.scrollTop = scrolledTo;
  };

  // Not on "scheduler": its 10 s poll would reset a half-typed DMZ address
  ctx.store.subscribe(["settings", "locks"], () => {
    if (dialog.open) render();
  });
  ctx.store.subscribe(["scheduler"], () => {
    if (dialog.open) renderSelfHeal();
  });
  ctx.tr.onChange(() => {
    if (dialog.open) render();
  });
  return {
    open: () => {
      syncSelectionFromLock();
      render();
      dialog.showModal();
    },
  };
}
