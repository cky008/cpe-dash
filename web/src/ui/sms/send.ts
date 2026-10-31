import { ApiError } from "../../core/api.ts";
import { classifySendError, classifySendResult } from "../../core/sms.ts";
import type { AppContext } from "../context.ts";
import { type SendNotice, type SendReport, shownNumber } from "./shared.ts";

/**
 * Send and turn the outcome into the right feedback. `submitted` is true when the router has the
 * message (sent, partial, or accepted-but-unconfirmed) so the composer clears; an unconfirmed or
 * unknown outcome returns the amber notice that warns against resending (duplicate delivery).
 */
export async function sendAndReport(ctx: AppContext, body: { phone: string; content: string; countryCode: string }): Promise<SendReport> {
  const pending = (key: string | null, title: string, text: string): SendNotice => ({ threadKey: key ?? "", tone: "pending", title, body: text });
  try {
    const res = await ctx.api.smsSend(body);
    const threadKey = res.messages[0]?.threadKey ?? res.resolvedPhones[0] ?? null;
    const target = shownNumber(ctx, res.resolvedPhones[0] ?? body.phone);
    switch (classifySendResult(res.result)) {
      case "sent":
        ctx.toast(ctx.t("send.sent", { target, segments: res.result.segments }), "success");
        return { submitted: true, threadKey, notice: null };
      case "partial":
        ctx.toast(ctx.t("send.partial", { phones: res.result.failedPhones.map((p) => shownNumber(ctx, p)).join(", ") }), "warning");
        return { submitted: true, threadKey, notice: null };
      case "unconfirmed":
        ctx.toast(ctx.t("send.unconfirmed_title"), "warning");
        return { submitted: true, threadKey, notice: pending(threadKey, ctx.t("send.unconfirmed_title"), ctx.t("send.unconfirmed_body")) };
      case "failed":
        return { submitted: false, threadKey, notice: { threadKey: threadKey ?? "", tone: "danger", title: ctx.t("send.failed", { code: res.result.failCode ?? "?" }), body: "" } };
    }
  } catch (err) {
    const kind = err instanceof ApiError ? classifySendError(err) : "unknown";
    if (kind === "failed" && err instanceof ApiError) {
      const key = err.envelope?.resolvedPhones?.[0] ?? null;
      return { submitted: false, threadKey: key, notice: { threadKey: key ?? "", tone: "danger", title: ctx.t("send.failed", { code: err.envelope?.result?.failCode ?? "?" }), body: "" } };
    }
    if (kind === "not_sent") {
      ctx.toast(ctx.t("send.not_sent", { reason: ctx.describeError(err) }), "error");
      return { submitted: false, threadKey: null, notice: null };
    }
    return { submitted: false, threadKey: null, notice: pending(null, ctx.t("send.unknown_title"), ctx.t("send.unknown_body", { message: ctx.describeError(err) })) };
  }
}
