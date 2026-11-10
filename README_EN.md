<p align="center">
  <img src="web/brand/logo.svg" width="72" height="72" alt="" />
</p>

<h1 align="center">FengSui 烽燧</h1>

<p align="center">
  A self-hosted console for 5G routers. See your signal, run your router, and get SMS and alerts in one place.
</p>

<p align="center">
  <a href="https://github.com/cky008/cpe-dash/releases"><img src="https://img.shields.io/github/v/release/cky008/cpe-dash?style=flat-square&label=release" alt="Latest release" /></a>
  <a href="https://github.com/cky008/cpe-dash/actions/workflows/ci-docker.yml"><img src="https://github.com/cky008/cpe-dash/actions/workflows/ci-docker.yml/badge.svg" alt="CI" /></a>
  <img src="https://img.shields.io/badge/Docker-amd64_|_arm64-2496ED?style=flat-square&logo=docker&logoColor=white" alt="Docker amd64 and arm64" />
  <img src="https://img.shields.io/badge/runtime_deps-0-black?style=flat-square" alt="No runtime dependencies" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-PolyForm_NC_1.0.0-orange?style=flat-square" alt="PolyForm Noncommercial 1.0.0" /></a>
</p>

<p align="center">
  <a href="docs/guide/en/quick-start.md"><b>Quick start</b></a> ·
  <a href="https://fengsui.iocky.com/en/">Documentation</a> ·
  <a href="https://cky008.github.io/fengsui-demo/">Live demo</a> ·
  <a href="README.md">简体中文</a>
</p>

<p align="center">
  <img src="docs/screenshots/dashboard-sujian.webp" alt="The FengSui dashboard" width="100%" />
</p>

FengSui is a web console that runs on your own NAS or computer and lets you see and manage a 5G router: verified on the Huawei H168-383, and able to connect to other brands. It brings what the router's own web page scatters across many screens onto one dashboard, and adds what that page lacks: history charts, alerts, Telegram notifications, SMS threads and an interface for AI agents. Your data stays at home.

## What it does

- **Shows your signal**: RSRP, SINR, modulation, transmit power, and the band and bandwidth of every 4G and 5G carrier, refreshed every 5 seconds, with 7 days of history.
- **Band and cell locks you can undo**: preview a lock before you apply it. If a lock cuts the internet, FengSui can undo it after a few minutes.
- **SMS**: threads, one-click copy for verification codes, contact import. Messages are stored encrypted on your disk.
- **Devices and internet access**: see who is connected and how; pause a device's internet access or give it a schedule.
- **Alerts and Telegram**: get told when the WAN drops, the signal weakens, the router restarts or the SMS box fills up. Read and answer SMS in Telegram.
- **Works with AI agents**: a built-in MCP server lets Claude, Cursor and others read the signal and its history. Actions that change the router are off by default, and you choose what each token may do.

It is also built not to get in the way: it steps aside when you sign in to the router's own page, it stops after one wrong password instead of locking the router, and it uses only what ships with Node.js, with no third-party runtime dependencies.

## Quick start

You need a NAS or computer that runs Docker, on the same network as the router.

```bash
mkdir -p ~/cpe-dash/data && cd ~/cpe-dash
curl -fsSLO https://raw.githubusercontent.com/cky008/cpe-dash/main/docker-compose.yml
curl -fsSL -o .env https://raw.githubusercontent.com/cky008/cpe-dash/main/.env.example
# Edit .env: set DATA_ENCRYPTION_KEY (generate one with openssl rand -hex 32) and TZ
docker compose pull && docker compose up -d
docker compose logs cpe-dash | grep "setup code"
```

Open `http://<this machine's IP>:18384`, enter the setup code from the log and follow the steps to connect your router. The full walkthrough, including Synology's Container Manager, is in the [quick start](docs/guide/en/quick-start.md).

> [!CAUTION]
> Do not forward port `18384` to the internet. To reach the console from outside, use a VPN such as Tailscale or an HTTPS reverse proxy; see [Security and privacy](docs/guide/en/security.md).

## Screenshots

| SMS | Controls |
| :---: | :---: |
| <img src="docs/screenshots/sms-ziming-en.webp" alt="SMS threads" /> | <img src="docs/screenshots/controls-chenxi.webp" alt="Controls drawer: locks, self-healing and switches" /> |
| **Devices and access** | **On a phone** |
| <img src="docs/screenshots/topology-access.webp" alt="Connected devices and access control" /> | <img src="docs/screenshots/mobile.webp" alt="The dashboard on a phone" width="60%" /> |

You can try the rest in the [live demo](https://cky008.github.io/fengsui-demo/): every value is made up, and a reload resets it.

## Compatibility

FengSui is verified on the H168-383 (firmware 4.4.0.1) only. Other Huawei HiLink routers connect too, and so do routers from ZTE, Pinsu, Tozed (ZLT), FiberHome and NRadio, and OpenWrt routers with a Quectel or Fibocom module; FengSui tells the brand itself. None of them has been verified on a real device, so they run read-only and writes to them are locked by default; you can turn on experimental writes one feature at a time in the console, at your own risk. Device reports from the console help get more routers verified, and you can hand the console's ready-made prompt to an AI agent to run the tests and draft the report. Where each brand and model stands is under [Supported devices](docs/guide/en/supported-devices.md), the notes on each brand's models are in the [device reference](SUPPORTED_DEVICES_DOCS.md), and how FengSui works on these routers is under [Other models and brands](docs/guide/en/other-routers.md); or see it first in the [live demo's other-model mode](https://cky008.github.io/fengsui-demo/?router=other).

## Documentation

- **Get started**: [What FengSui is](docs/guide/en/overview.md) · [Supported devices](docs/guide/en/supported-devices.md) · [Quick start](docs/guide/en/quick-start.md) · [Install and upgrade](docs/guide/en/install.md)
- **Use FengSui**: [Dashboard](docs/guide/en/dashboard.md) · [Band and cell locks](docs/guide/en/locking.md) · [SMS](docs/guide/en/sms.md) · [Devices and internet access](docs/guide/en/devices.md) · [Alerts and notifications](docs/guide/en/notifications.md) · [AI agents (MCP)](docs/guide/en/agents.md)
- **Manage**: [Docker Compose file](docs/guide/en/docker-compose.md) · [Configuration](docs/guide/en/configuration.md) · [Security and privacy](docs/guide/en/security.md) · [Backup and restore](docs/guide/en/backup.md) · [Other models and brands](docs/guide/en/other-routers.md)
- **Help**: [Troubleshooting](docs/guide/en/troubleshooting.md) · [FAQ](docs/guide/en/faq.md)
- **Technical docs (Chinese)**: [Protocol spec](docs/PHASE1_PROTOCOL_SPEC.md) · [Architecture report](docs/PHASE2_ARCHITECTURE_REPORT.md) · [Backend contract (REST / SSE / MCP)](docs/PHASE2_BACKEND_CONTRACT.md) · [Changelog](CHANGELOG.md)

The same pages, with search, are on the [documentation site](https://fengsui.iocky.com/en/).

## Contributing

- Questions and ideas: [GitHub Issues](https://github.com/cky008/cpe-dash/issues)
- Development: [CONTRIBUTING.md](CONTRIBUTING.md) (no router needed: `npm run demo` simulates one)
- Security problems: report privately as described in [SECURITY.md](SECURITY.md)
- Code of conduct: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
- Sponsoring: [GitHub Sponsors](https://github.com/sponsors/cky008) · [Buy Me a Coffee](https://buymeacoffee.com/iocky)

## Licence and disclaimers

- **Licence**: Source-available under the [PolyForm Noncommercial License 1.0.0](LICENSE) (free for personal and non-commercial use). Commercial use needs separate permission from the author. Third-party components in the build are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
- **Unofficial**: FengSui is an independent project, not affiliated with or endorsed by Huawei, Synology or any carrier. All trademarks belong to their owners.
- **As is**: no warranty of any kind. Band and cell locks, reboots and blocking can leave you without internet for a while; SMS is billed by your carrier and you are responsible for what you send. Use it only on equipment and networks you are allowed to manage, and follow local law and your carrier's terms.

## Acknowledgements

Thanks to [Salamek/huawei-lte-api](https://github.com/Salamek/huawei-lte-api): FengSui consulted the endpoints and model notes it collects when adding support for other Huawei models. FengSui contains none of its code and does not depend on it.
