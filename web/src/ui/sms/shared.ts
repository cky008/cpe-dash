import type { ContactRecord, CountryDialInfo, SenderInfo } from "../../../../src/api-contract.ts";
import { maskValue } from "../../core/privacy.ts";
import { type TextSegment, initialsOf, linkifySegments } from "../../core/sms.ts";
import type { AppContext } from "../context.ts";
import { h, icon } from "../dom.ts";

/** Privacy scope shared by every SMS view (the header switch and the list's eye button). */
export const SMS_SCOPE = "sms";

/** A send outcome the user must see next to the conversation (amber "unconfirmed" is never "failed"). */
export interface SendNotice {
  threadKey: string;
  tone: "pending" | "danger";
  title: string;
  body: string;
}

export interface SendReport {
  /** The router has the message (sent, partial, or accepted-but-unconfirmed): clear the composer. */
  submitted: boolean;
  /** Thread of the first resolved recipient, when the daemon resolved one. */
  threadKey: string | null;
  notice: SendNotice | null;
}

/** State the SMS views share (one instance per page). */
export interface SmsShared {
  contacts: ContactRecord[];
  countries: ReadonlyArray<CountryDialInfo>;
  defaultCountryCode: string;
  /** Reload threads and the open conversation (after a send, delete, read, contact edit). */
  reload(): Promise<void>;
  openThread(key: string): Promise<void>;
  /** Show a send notice in its conversation. */
  setNotice(notice: SendNotice | null): void;
  openCompose(prefill?: { phone?: string; content?: string }): void;
  openContacts(prefill?: { phone: string; name: string; note: string }): void;
}

export function isBrandSender(sender: Pick<SenderInfo, "type">): boolean {
  return sender.type === "alphanumeric" || sender.type === "shortcode" || sender.type === "gateway";
}

export function avatar(name: string, opts: { brand: boolean; known: boolean; size: string; accent?: boolean }): HTMLElement {
  return h(
    "div",
    { class: `avatar-ph ${opts.brand ? "is-brand" : ""} ${opts.accent ? "is-accent" : ""} ${opts.size}` },
    opts.known || opts.brand ? initialsOf(name) : icon("user", "text-[1.1em]")
  );
}

/** A phone number as shown under the current privacy state (names and brands are never masked). */
export function shownNumber(ctx: AppContext, number: string): string {
  return ctx.privacy.isMasked(SMS_SCOPE) ? maskValue("phone", number) : number;
}

/** Thread / sender title: contact name, else brand name, else the (maskable) number. */
export function senderTitle(ctx: AppContext, sender: SenderInfo, contact: { name: string } | null, phone: string): string {
  if (contact) return contact.name;
  if (sender.type === "alphanumeric") return sender.displayNumber || phone;
  const number = shownNumber(ctx, sender.e164 ?? sender.displayNumber ?? phone);
  return sender.brandHint ? `${number} (${sender.brandHint})` : number;
}

/** Message text with links as anchors and, in privacy mode, the verification code hidden. */
export function messageBody(ctx: AppContext, content: string, code: string | null): Node[] {
  let text = content;
  if (code && ctx.privacy.isMasked(SMS_SCOPE)) text = text.split(code).join("•".repeat(code.length));
  return linkifySegments(text).map((segment: TextSegment) =>
    segment.href
      ? h("a", { attrs: { href: segment.href, target: "_blank", rel: "noopener noreferrer nofollow" }, class: "break-all" }, segment.text)
      : document.createTextNode(segment.text)
  );
}

export function otpChip(ctx: AppContext, code: string, withHint: boolean): HTMLButtonElement {
  const masked = ctx.privacy.isMasked(SMS_SCOPE);
  const hint = withHint ? h("span", { class: "faint", data: { copyHint: "1" } }, ctx.t("chat.copy_code")) : null;
  const chip = h(
    "button",
    { class: "otp-chip", title: ctx.t("chat.copy_otp"), attrs: { type: "button" }, data: { copyOtp: code } },
    icon("key", "text-[0.95em]"),
    h("span", { class: "code" }, masked ? maskValue("otp", code) : code),
    hint
  );
  return chip;
}

export async function copyOtp(ctx: AppContext, chip: HTMLElement): Promise<void> {
  const code = chip.dataset["copyOtp"] ?? "";
  try {
    await navigator.clipboard.writeText(code);
    ctx.toast(ctx.t("toast.otp_copied"), "success");
    chip.classList.add("is-copied");
    const hint = chip.querySelector<HTMLElement>("[data-copy-hint]");
    const previous = hint?.textContent ?? "";
    if (hint) hint.textContent = ctx.t("chat.copied");
    setTimeout(() => {
      chip.classList.remove("is-copied");
      if (hint) hint.textContent = previous;
    }, 1600);
  } catch {
    ctx.toast(ctx.t("toast.copy_failed"), "warning");
  }
}

/** Localized country name from a sender / recipient (`countryZh`) or a dial-code entry (`nameZh`). */
export function countryName(ctx: AppContext, info: { countryZh: string; countryEn: string } | { nameZh: string; nameEn: string }): string {
  const [zh, en] = "countryZh" in info ? [info.countryZh, info.countryEn] : [info.nameZh, info.nameEn];
  return ctx.tr.locale === "en" ? en || zh : zh || en;
}
