import { loadConfig } from "../src/config.ts";
import { HuaweiCpeClient } from "../src/protocols/hilink/client.ts";
import { extractVerificationCode } from "../src/sms/otp.ts";
import { parseSenderInfo } from "../src/sms/phone.ts";
import { checkSmsNotifications, fetchAllMessages } from "../src/drivers/huawei/sms.ts";
import type { SenderCategory } from "../src/sms/types.ts";

/**
 * Read-only SMS capability probe for the H168-383. It never sends, marks read or deletes, and it
 * prints aggregate counts only: no phone numbers, message text, dates or verification codes.
 */
async function main(): Promise<void> {
  console.log("=== [FengSui Probe #9] SMS Counters, Listing Path & Full-Sync Cost (read-only) ===");

  const cfg = loadConfig();
  const client = new HuaweiCpeClient({
    cpeUrl: cfg.cpeUrl,
    cpeUsername: cfg.cpeUsername,
    cpePassword: cfg.cpePassword,
    requestTimeoutMs: cfg.requestTimeoutMs,
    respectBrowserSession: cfg.respectBrowserSession,
  });
  client.rememberLoginScheme("scram");

  const preState = await client.getLoginState();
  console.log(`Pre-check /api/user/state-login -> State=${preState.state}, isLoggedInElsewhere=${preState.isLoggedInElsewhere}`);

  const probe = await checkSmsNotifications({ probePublic: (apiPath) => client.getPublic(apiPath) });
  console.log(`Unauthenticated check-notifications -> unread=${probe.unreadMessages}, storageFull=${probe.storageFull}`);

  const startedAt = performance.now();
  const result = await client.withSession((session) => fetchAllMessages(session));
  if (!result) {
    console.log(`[Yielded] Active human admin session detected (State=${preState.state}); probe yielded peacefully.`);
    return;
  }
  const elapsedMs = Math.round(performance.now() - startedAt);

  const { counters, messages, via } = result;
  const stored = counters.localInbox + counters.localOutbox + counters.localDraft;
  console.log(`Ephemeral Session Hold Time : ${client.getTelemetry().lastSessionHoldMs} ms (full fetch ${elapsedMs} ms, logged out in finally)`);
  console.log(
    `sms-count                   : unread=${counters.localUnread}, inbox=${counters.localInbox}, outbox=${counters.localOutbox}, draft=${counters.localDraft}, capacity=${counters.localMax} (${counters.localMax > 0 ? Math.round((stored / counters.localMax) * 100) : 0}% used)`
  );
  console.log(`Listing path                : ${via === "sms-list" ? "plain /api/sms/sms-list" : "encrypted sms-list-contact + sms-list-phone fallback"}`);

  const inbound = messages.filter((m) => m.direction === "in");
  const categories = new Map<SenderCategory, number>();
  for (const m of inbound) {
    const type = parseSenderInfo(m.phone, m.content, cfg.defaultCountryCode).type;
    categories.set(type, (categories.get(type) ?? 0) + 1);
  }
  console.log(
    `Fetched messages            : ${messages.length} (in=${inbound.length}, out=${messages.length - inbound.length}, unread=${messages.filter((m) => m.isUnread).length}) vs counters inbox+outbox=${counters.localInbox + counters.localOutbox}`
  );
  console.log(`Messages with one-time code : ${messages.filter((m) => extractVerificationCode(m.content) !== null).length}`);
  console.log(
    `Inbound sender categories   : ${[...categories].map(([type, n]) => `${type}=${n}`).join(", ") || "none"}`
  );
  console.log("No SMS was sent, marked read or deleted.");
}

main().catch((err: unknown) => {
  console.error(`[Probe failed] ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
