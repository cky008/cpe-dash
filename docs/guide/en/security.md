---
title: Security and privacy
description: How to safely access the console remotely, how to use tokens, and what data FengSui stores.
section: Manage
order: 15
---

FengSui can modify your router and read your SMS messages, so treat it with the same care as your router's administration interface.

## Do not expose directly to the public internet

> [!CAUTION]
> Do not forward port `18384` to the public internet on your router, and do not place this machine in a DMZ. The console uses plain HTTP, so login passwords and sessions travel over the network unencrypted.

To access the console remotely, use either of the following approaches:

- **Tailscale or another VPN** (simplest): Connect your phone or laptop to the VPN, then access the local NAS IP address. Hostnames matching `*.ts.net` are allowed by default.
- **HTTPS reverse proxy**: Use tools such as Synology's built-in reverse proxy, Caddy, or Nginx, and configure a strong console password.

<a id="reverse-proxy"></a>

## Access behind a reverse proxy

1. Add your domain name to `ALLOWED_HOSTS`, such as `cpe.example.com`. Otherwise, FengSui rejects requests for unfamiliar hostnames with `421` to defend against DNS rebinding attacks.
2. Set `TRUSTED_PROXIES` to the **exact IP address** of your reverse proxy. FengSui trusts the real client IP address and HTTPS indicators only for requests originating from this address.
   - If the proxy and FengSui run on the same machine and FengSui uses host networking: keep the default `127.0.0.1,::1`.
   - If the proxy runs in a separate Docker container: specify the proxy container's address inside the Docker network, such as `172.18.0.2`.
3. Once configured correctly, login cookies automatically receive the `Secure` flag, and login rate limiting applies to the actual client IP address.

> [!WARNING]
> If `TRUSTED_PROXIES` is configured incorrectly, all visitors appear to arrive from the proxy IP address: failed login rate limits affect all users, and cookies will lack the `Secure` flag.

## Console password and tokens

- **Console password**: Created during initial setup and updated under "Settings → Password". Only its scrypt hash is stored.
- **Tokens**: Generated under "Settings → Tokens". They come in two varieties: "Full control" and "Read-only". You can set an expiration (1 to 365 days or never expire). Tokens are displayed only once and can be revoked at any time. Tokens cannot modify console settings.
- **Agents, dashboards, or scripts**: Always use read-only tokens.
- **Forgot password?**: Run `docker exec cpe-dash node dist/cli.js reset-login` on your NAS to obtain a reset code valid for 15 minutes, or send `/reset` in a direct message with your paired Telegram bot (can be disabled under "Settings → Security"). Then click "Forgot password?" on the login page.

## What FengSui stores

All files reside in `data/`, encrypted with `DATA_ENCRYPTION_KEY` (AES-256-GCM) with file permissions set to `0600`:

| File | Contents |
| :--- | :--- |
| `settings.json` | Router connection (including router password), console password hash, token hashes, and consents for experimental writes |
| `state.json` | Latest metrics cache, 7-day history series, alerts, lock state, and self-healing records |
| `sms.json` / `contacts.json` | SMS messages and contacts |
| `telegram.json` | Paired Telegram chats |
| `audit.json` | Recent 500 audit records |

The **audit log** ("Settings → Audit") records every router change, console login, and setting modification: who (web, which token, MCP, Telegram, self-healing), when, what was done, and the outcome.

FengSui connects to no cloud services and collects no usage telemetry. Only your configured Telegram bot and webhook endpoints receive notification contents.

## Privacy mode

- The eye icon in the header hides IMEI, IMSI, phone numbers, MAC addresses, WAN addresses, and SMS contents, making it safe for screenshots and screen sharing.
- Token-authenticated API requests, real-time events, and MCP receive redacted data by default (`REDACT_SENSITIVE_IN_API=true`).

## Report security issues

Report privately by following [SECURITY.md](../../../SECURITY.md) instead of opening a public issue.
