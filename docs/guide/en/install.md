---
title: Installation and upgrade
description: Install FengSui on Synology, other Docker hosts, or directly with Node.js, and how to upgrade, stop, and uninstall.
section: Get started
order: 4
---

FengSui runs as a single container, published on GitHub Container Registry (`ghcr.io/cky008/cpe-dash`), supporting `amd64` and `arm64`. Choose the method that fits your setup.

> [!NOTE]
> One router can be managed by only **one** FengSui instance: it exclusively holds the router administrator session and Telegram bot. Stop the first instance before installing a second.

## Synology Container Manager

Applies to DSM 7.2 and above.

1. **Prepare the directory**. Create `docker/cpe-dash/data` in File Station, or log in to the NAS via SSH:

   ```bash
   mkdir -p /volume1/docker/cpe-dash/data && cd /volume1/docker/cpe-dash
   curl -fsSLO https://raw.githubusercontent.com/cky008/cpe-dash/main/docker-compose.yml
   curl -fsSL -o .env https://raw.githubusercontent.com/cky008/cpe-dash/main/.env.example
   chmod 600 .env && chmod 700 data
   id -u && id -g      # For example 1026 and 100; fill these into PUID / PGID in .env
   ```

2. **Edit `.env`**: Fill in `DATA_ENCRYPTION_KEY` (a random string generated with `openssl rand -hex 32`), `TZ` (such as `Asia/Shanghai`), and `PUID` / `PGID`. You will configure router and console passwords later in the web interface.
3. **Create the project**: Open "Container Manager → Project → Create", select `/volume1/docker/cpe-dash` as the path, choose "Use existing docker-compose.yml" as the source, and start the project.
4. **Find the setup code**: Once the container status changes to "Healthy", look for `setup code` in "Container → cpe-dash → Log", then follow step 4 of [Quick start](quick-start.md#4-open-the-console) to complete setup.

## Other Docker hosts

Linux, macOS (Docker Desktop or OrbStack), and Windows are all supported. The steps are the same as [Quick start](quick-start.md):

```bash
docker compose pull
docker compose up -d
```

Common commands:

```bash
docker compose logs -f cpe-dash    # View logs
docker compose restart cpe-dash    # Restart
docker compose down                # Stop: logs out of the router, saves data, exits within 10 seconds
```

## Run directly with Node.js

Suitable for anyone who wants to inspect the source code or contribute. Requires Node.js 22.6 or later.

```bash
git clone https://github.com/cky008/cpe-dash.git && cd cpe-dash
npm ci
cp .env.example .env && chmod 600 .env    # Fill in DATA_ENCRYPTION_KEY
npm run build
npm start                                  # http://<local IP>:18384
```

If you do not want to connect to a real router and only want to inspect the interface, run `npm run demo`: it simulates a router in the same process, does not read `.env`, requires no internet access, and opens `http://127.0.0.1:18484` with the login password `fengsui-demo`.

## Upgrade

Back up before upgrading (see [Backup and restore](backup.md)), then pull the new image and recreate the container:

```bash
docker compose pull
docker compose up -d
```

In the Synology web UI: "Project → cpe-dash → Action → Build", or stop and start the project.

Changes and manual steps for each release are documented under "Before you upgrade" in [GitHub Releases](https://github.com/cky008/cpe-dash/releases). Review them before upgrading.

## Uninstall

```bash
docker compose down
rm -rf ~/cpe-dash     # Deletes all data in data/; make sure you no longer need it first
```

FengSui leaves nothing on the router. If you configured band locking, Wi-Fi blocklists, or internet access schedules, remove them in the console before uninstalling, or revert them later in the router's own web page.

## Ports and networking

| Purpose | Port | Description |
| :--- | :--- | :--- |
| Web console, API, MCP | `18384` | Change host port using `WEB_PORT` in `.env` |
| LAN beacon | `18385` (UDP) | Used only when `PEER_DISCOVERY_ENABLED` is enabled; disabled by default |

The default Docker network (bridge) is sufficient. Change compose to `network_mode: host` only if you need FengSui instances on multiple machines to discover each other, at the cost of losing container network isolation. What each entry in `docker-compose.yml` does, and common changes, are in [Docker Compose file](docker-compose.md).
