---
title: Alerts and notifications
description: Get notified when the internet drops, signal degrades, or a new message arrives: Telegram bots, webhooks, and alert rules.
section: Use FengSui
order: 10
---

FengSui alerts you when problems happen and pushes new SMS messages. You can send notifications to a Telegram bot or to your own webhook URL.

## Alerts

Alerts appear under the bell icon in the console and can also be pushed to you. By default, FengSui only pushes `warning` and higher severity levels; change it under Settings → General → Alerts (`ALERT_NOTIFY_MIN_SEVERITY` in `.env`), where the signal alert thresholds are too.

| Alert | When it appears |
| :--- | :--- |
| `CPE_UNREACHABLE` | Cannot connect to the router |
| `WAN_DOWN` | The router's cellular network disconnects |
| `SIGNAL_DEGRADED` | RSRP stays below `ALERT_RSRP_THRESHOLD_DBM` or SINR stays below `ALERT_SINR_THRESHOLD_DB` for 5 minutes |
| `CA_DROPPED` | Carrier aggregation lost one or more component carriers |
| `REBOOT_DETECTED` | The router restarted |
| `SMS_STORAGE_HIGH` / `SMS_STORAGE_FULL` | The router's SMS storage is nearly full or full |
| `DATA_THRESHOLD` | Monthly data usage exceeds your configured cap |
| `LOCK_ROLLED_BACK` and others | Self-healing released a lock or reconnected (see [Band and cell locking](locking.md)) |
| `FIRMWARE_UNVERIFIED` / `MODEL_UNVERIFIED` | Router firmware was updated, or the model is unverified |
| `AGENT_TEST_STILL_ON` | What the AI agent test turned on is still on: 3 hours after the test, then once a day, until its writes all pass, you have read a reminder or you end the test; also a system notification while the console is in a background tab (see [Test with an AI agent](other-routers.md#ai)) |
| `STORAGE_WRITE_FAILED` | Saving data failed (disk full, read-only, or incorrect permissions) |

When an issue resolves, FengSui sends a recovery message (such as `WAN_UP`). Brief fluctuations do not trigger alerts immediately: every alert type has a minimum duration requirement and a recovery buffer.

## Set up a Telegram bot

1. Find `@BotFather` on Telegram, create a bot, and copy the token it gives you.
2. Add the token to `TELEGRAM_BOT_TOKEN` in `.env`, then restart the container. When `telegram=on` appears in the logs, setup succeeded.
3. In the console, go to "Settings → Telegram" and click "Create pairing code" (valid for 10 minutes). Then send `/auth <pairing code>` in a direct message to your bot.

After pairing, FengSui pushes new messages and alerts to you.

> [!NOTE]
> Pushed content travels through Telegram servers. If you do not want SMS content to leave your home network, do not configure Telegram.

### Receive messages in a group

If you want to receive notifications in a group (for example, a group with only you and your bot), generate a **group pairing code** under "Settings → Telegram". Send the command shown in the console to the group under your own account (do not send anonymously). All group members can view notifications, but only the person who sent the pairing command can run actions in the group. (A group listed in `TELEGRAM_CHAT_IDS` instead lets every member run them.) If you send the command inside a topic, notifications go to that topic; if the topic is deleted, notifications fall back to the general topic automatically.

### Actions in Telegram

| Command / Action | Description |
| :--- | :--- |
| Reply to an SMS card | Reply to that number directly |
| Buttons on the card | Mark as read, view thread, delete (asks for confirmation; the message goes to the console's [Recently deleted](sms.md#trash)) |
| `/new` | Send a new message step by step |
| `/send <number> <content>` | Send quickly (also requires confirmation) |
| `/inbox`, `/unread`, `/chat <number>` | Thread list, unread messages, and a specific thread |
| `/contacts`, `/contact <number> <name>` | Search and add contacts; send a `.vcf` file to batch import |
| `/status`, `/alerts`, `/sync` | Router status, recent alerts, and sync SMS immediately |
| `/mute 30m`, `/mute off` | Pause or resume alert notifications |

### Manage paired chats

"Settings → Telegram" lists every chat that can receive notifications: direct message or group, how it was paired, and when. You can unpair unfamiliar chats individually. When you revoke a token, chats paired with that token are also unpaired.

Telegram notifications that cannot be sent during an outage are stored temporarily (up to 50 messages, 24 hours) and delivered in order after recovery. Chats unpaired during the outage will not receive them.

## Webhook

When you set `WEBHOOK_URL`, FengSui sends new messages (`sms.received`) and alerts (`alert`) as JSON `POST` requests to this URL. You can connect it to tools like Home Assistant and n8n. URLs outside your local network must use `https`.

When you set `WEBHOOK_SECRET`, each request includes a signature. Verify it on the receiving end like this:

```ts
import crypto from "node:crypto";
const expected = "sha256=" + crypto.createHmac("sha256", secret).update(`${req.headers["x-fengsui-timestamp"]}.${rawBody}`).digest("hex");
// Compare expected and req.headers["x-fengsui-signature"] in constant time, and reject requests with a large timestamp drift
```
