---
title: Troubleshooting
description: What to do when the console does not open, the router cannot be reached, the router rejects the password, someone is using its admin page, or Telegram notifications do not arrive.
section: Help
order: 20
---

Start by checking two places: the **session state** in the console header, and the container logs via `docker compose logs --tail 100 cpe-dash`. Most issues are explained in these two locations.

## Cannot open the console

- **Is the container running?**: `docker compose ps` should report `healthy`. If it shows `restarting`, inspect the logs; the most frequent cause is a missing `DATA_ENCRYPTION_KEY` in `.env`.
- **Is the port correct?**: The default port is `18384`. Verify `WEB_PORT` in `.env`.
- **Domain returns HTTP 421**: Add your domain name to `ALLOWED_HOSTS`. Local network IP addresses, `*.local`, `*.lan`, and `*.ts.net` do not need to be added.
- **Data directory permissions**: If logs show `EACCES`, ensure `PUID` / `PGID` in `.env` matches the owner of `data/`.

## Cannot find the setup code

```bash
docker compose logs cpe-dash 2>&1 | grep "setup code"
```

Setup codes remain valid for 24 hours. Restarting the container generates a new code.

## Cannot connect to the router

Under "Settings → Router", click "Test connection" to see the reason:

| Message | What to do |
| :--- | :--- |
| Cannot tell the router's brand | FengSui got no answer it knows from this address, and sent no password. Check that it is the router's own address (its login page opens in a browser on this machine) and, under Docker, that the container can access the local network; if both hold, choose the brand yourself under "Router brand". FengSui cannot connect to a router whose brand is not in that list yet |
| Address unreachable | Confirm this machine can reach the router's address (usually `http://192.168.8.1` on Huawei); under Docker, check whether the container can access the local network |
| The router's answer does not fit the chosen brand | The brand is wrong, or this model uses another interface. Set "Router brand" back to "Detect automatically" and try again |
| Incorrect password, N attempts remaining | Verify your password in a browser first, then return and save. When only 1 attempt remains, FengSui asks you to check a confirmation box before trying again |
| Router locked | Too many incorrect password attempts caused the router to lock temporarily. Wait until the lockout expires before saving the correct password |
| Someone is logged in to the router's web page | Log out from the router's own web page, then test again |
| Password must be changed first | The router requires changing the default password on the router's own web page first |

<a id="breaker"></a>

## Header shows "Router rejected the password · logins stopped"

The router rejected the password, and FengSui stopped at once so the router does not lock its admin account (several wrong passwords in a row lock it; three on Huawei). Go to Settings → Router, enter the correct password and save: FengSui tests it first and carries on once the test succeeds.

<a id="yielding"></a>

## Header shows "Someone is using the router's admin page · paused"

Someone logged in to the router's own web page (this could be you on another device, or a family member). FengSui checks periodically and resumes automatically once they log out. In the meantime, metrics stay at their last polled values, and actions that modify the router return "Someone is using the router".

## Not receiving Telegram notifications

1. Check whether logs show `telegram=on`. If not, `TELEGRAM_BOT_TOKEN` is incorrect.
2. Is your chat listed under "Settings → Telegram"? If not, generate a new pairing code and message `/auth <pairing code>` to the bot.
3. Is the alert severity high enough? By default, FengSui only pushes `warning` and higher severity levels (`ALERT_NOTIFY_MIN_SEVERITY`).
4. Notifications generated while offline are stored temporarily and sent after connectivity recovers.
5. A single bot token can be used by only one application at a time. If another program uses it, both will encounter errors.

<a id="write-refused"></a>

## A write is refused (a router that was not verified)

On a router other than the H168-383, FengSui makes only the writes it implements for that router. When one is refused, the router received no request:

| Message or error code | Cause and what to do |
| :--- | :--- |
| "This write is turned off for this router", `DEVICE_WRITE_DISABLED` | The write was turned off. Turn it back on under Experimental writes in Settings → Device |
| "FengSui cannot make this change on this router", `DEVICE_UNVERIFIED_READ_ONLY` | FengSui has no implementation of this write for the model yet, or the router lacks what the write needs (Settings → Device shows "not on this router"). Use the router's own web page instead, and consider [posting a device report](other-routers.md#report) |
| The alert `WRITE_READBACK_MISMATCH` | The write was sent, but reading it back shows another value, so the router may not have applied it. Check on the router's own web page; if the write is unreliable, turn it off and post a report |

See [Other models and brands](other-routers.md#writes).

## Sending SMS fails

- **Error "No default country is known"**: FengSui does not know your country yet (the router did not report SIM card information). Enter the full number with `+`, select a country in the compose dialog, or fix the default country under Settings → General → SMS.
- **Shows "Submitted to the router, status unconfirmed"**: The message was likely sent. Do not resend; check the thread shortly.
- **Router rejects sending**: Check your SIM card balance and confirm that SMS service is active.

## Incorrect timestamps

Timestamps for sent SMS messages and historical series follow `TZ` in `.env`. Set it to your local time zone (such as `Asia/Shanghai`) and restart the container.

## Cannot open data (DATA_QUARANTINED alert)

The key does not match the encrypted files. Files have not been deleted; they are renamed to `*.unreadable-<time>`. Locate your original key, then recover your data using `rekey` as explained in [Backup and restore](backup.md#change-the-encryption-key).

## Still unresolved

- Run diagnostics: `docker exec cpe-dash node dist/cli.js doctor`
- Ask questions on [GitHub Issues](https://github.com/cky008/cpe-dash/issues), including your version number, installation method, and relevant logs. **Remove passwords, tokens, phone numbers, SMS messages, and public IP addresses before sharing logs.**
