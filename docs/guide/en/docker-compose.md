---
title: Docker Compose file
description: The example docker-compose.yml in full, what each line does, what you can change and how, and how it works with .env.
section: Manage
order: 13
---

FengSui runs as a Docker Compose project. The [`docker-compose.yml`](../../../docker-compose.yml) in the repository is the recommended setup; [Quick start](quick-start.md) and [Installation and upgrade](install.md) download it, and most people never change it. This page explains it line by line. FengSui's own settings (the encryption key, SMS, notifications and so on) live in `.env`; see [Configuration reference](configuration.md).

## The example file

This is the whole file, as it is in the repository:

```yaml
# 烽燧 FengSui (cpe-dash) — Synology DS923+ / any Docker host, also `container-compose` on macOS.
#
#   mkdir -p data && cp .env.example .env    # then set DATA_ENCRYPTION_KEY and TZ
#   docker compose up -d                       # Web console: http://<nas-ip>:18384
#
# Every line is explained in the guide: https://fengsui.iocky.com/en/docs/docker-compose/
#
# Run exactly ONE daemon per router: it owns the router's single admin slot and the Telegram bot
# token. Stop any other cpe-dash / cpe-sms instance (NAS or laptop) before starting this one.

services:
  cpe-dash:
    image: ghcr.io/cky008/cpe-dash:latest
    build: .
    container_name: cpe-dash
    restart: unless-stopped
    init: true
    # Unprivileged user; set PUID/PGID to the owner of ./data and ./.env (`id -u` / `id -g` on the NAS)
    user: "${PUID:-1000}:${PGID:-1000}"
    environment:
      # Container networking: listen on every interface of the container, store state in the volume.
      # Everything else (encryption key, SMS / Telegram / alert settings) comes from the mounted .env;
      # the router connection, the console password and the tokens are set in the console.
      - TZ=${TZ:-UTC}
      - WEB_HOST=0.0.0.0
      - WEB_PORT=18384
      - STATE_FILE=/app/data/state.json
    # After editing .env: `docker compose up -d --force-recreate` (`restart` may keep the old file)
    volumes:
      - ./data:/app/data
      - ./.env:/app/.env:ro
    ports:
      - "${WEB_PORT:-18384}:18384"
    # The cross-host duplicate-daemon guard (PEER_DISCOVERY_ENABLED=true, UDP 18385 broadcast beacons,
    # off by default) needs the host network: Docker's bridge does not forward LAN broadcasts. To use
    # it, uncomment the next line and remove `ports:` above (the console is then served on port 18384
    # of the host: WEB_PORT under `environment:`, not the one in .env).
    # network_mode: host
    read_only: true
    tmpfs:
      - /tmp
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    # Bounds for a runaway process, far above normal use, so it cannot starve the NAS
    mem_limit: 1g
    # Synology DSM kernels have no pids cgroup, so Docker would drop this with a warning on every
    # start; on other Linux hosts, uncomment it as a second bound
    # pids_limit: 256
    # SIGTERM → queued requests 503, in-flight CPE session logs out, encrypted stores flush (< 10 s)
    stop_grace_period: 15s
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
```

## How it works with .env

The `.env` next to `docker-compose.yml` is used twice:

1. **Compose fills in variables from it.** When it starts the project, Compose reads the `.env` in the project directory and substitutes the `${…}` in the file [[Docker: Set, use, and manage variables in a Compose file with interpolation](https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/)]. The file uses four: `TZ`, `WEB_PORT`, `PUID` and `PGID`. `${TZ:-UTC}` means: the `TZ` from `.env` if it has a value, otherwise `UTC`.
2. **FengSui reads its settings from it.** The same file is mounted read-only into the container as `/app/.env`, and FengSui reads it at startup.

The entries under `environment:` reach the container as environment variables. When a setting is in both `.env` and the environment, FengSui uses the environment. So `WEB_HOST`, `WEB_PORT` and `STATE_FILE` in `.env` have no effect inside the container; the `WEB_PORT` in `.env` only sets the port on the host (see `ports` below).

## Line by line

### Image and container

| Entry | What it does |
| :--- | :--- |
| `image` | The image to run. `ghcr.io/cky008/cpe-dash` is built for amd64 and arm64. `latest` is the newest release; to decide when you upgrade, name a version instead, such as `ghcr.io/cky008/cpe-dash:1.7.1` (tags such as `1.7` and `1` pin only the major version) |
| `build` | Builds the image locally when the source code is in the directory. With only the compose file downloaded this does no harm: Compose pulls `image` first and builds only if it cannot [[Docker: Compose Build Specification](https://docs.docker.com/reference/compose-file/build/)]. To build from source, see "Common changes" below |
| `container_name` | Names the container `cpe-dash`, the name logs and commands use. A second container with the same name cannot be created on the same host |
| `restart: unless-stopped` | Starts the container again after it exits or the NAS restarts, but not after you stop it yourself [[Docker: Define services](https://docs.docker.com/reference/compose-file/services/#restart)] |
| `init: true` | Runs a tiny init process (PID 1) in the container that forwards stop signals and reaps child processes [[Docker: Define services](https://docs.docker.com/reference/compose-file/services/#init)], so FengSui gets the stop signal and shuts down as described under `stop_grace_period` |
| `user` | The user and group (UID:GID) FengSui runs as, `1000:1000` by default. It must own `data/` and `.env`, or the container cannot read `.env` or write `data/`. On Synology, run `id -u` and `id -g` over SSH (often `1026` and `100`) and put the numbers in `PUID` / `PGID` in `.env` |

### Environment variables (`environment`)

| Entry | What it does |
| :--- | :--- |
| `TZ=${TZ:-UTC}` | The time zone, from `TZ` in `.env`. It sets the time in the logs and on sent SMS, so match where the router is |
| `WEB_HOST=0.0.0.0` | Listens on every network interface of the container, which the port mapping needs. Leave it as is |
| `WEB_PORT=18384` | The port inside the container. Leave it; `ports` sets the port on the host. With host networking it is the port on the host: to change it, change this line, not the `WEB_PORT` in `.env`. The image's health check uses this port too |
| `STATE_FILE=/app/data/state.json` | Keeps the runtime state in the mounted `data/` directory. SMS, contacts, settings and the other data files sit next to it by default, so `data/` holds all of FengSui's data |

### Data and settings file (`volumes`)

| Entry | What it does |
| :--- | :--- |
| `./data:/app/data` | All of FengSui's data, encrypted. Back it up together with the encryption key; see [Backup and restore](backup.md) |
| `./.env:/app/.env:ro` | The settings file. `ro` mounts it read-only: the container can read it but not change it [[Docker: Bind mounts](https://docs.docker.com/engine/storage/bind-mounts/)]. To apply your edits, see [Applying changes](#apply) |

### Ports and network

| Entry | What it does |
| :--- | :--- |
| `ports` | `host port:container port`. The host port comes from `WEB_PORT` in `.env`, `18384` by default; change it to move the console, nothing changes inside the container. Without an IP, Docker opens the port on every interface of the host and bypasses the host's firewall rules [[Docker: Define services](https://docs.docker.com/reference/compose-file/services/#ports)], so never forward it to the internet |
| `network_mode: host` | Commented out. Needed only for `PEER_DISCOVERY_ENABLED` (FengSui instances on several machines finding each other), because Docker's default network does not forward LAN broadcasts. See "Common changes" below |

### Security limits

These entries give the container only what FengSui needs to run. FengSui needs none of them relaxed.

| Entry | What it does |
| :--- | :--- |
| `read_only: true` | Makes the container's file system read-only [[Docker: Define services](https://docs.docker.com/reference/compose-file/services/#read_only)]; only `data/` and `/tmp` are writable. Even a misbehaving process cannot change the programs in the image |
| `tmpfs` | Mounts a temporary `/tmp` in memory, emptied when the container is recreated |
| `cap_drop: ALL` | Drops every Linux kernel capability. FengSui listens on a high port and needs no privileges; Docker recommends keeping only the capabilities a process needs [[Docker Engine security: Linux kernel capabilities](https://docs.docker.com/engine/security/#linux-kernel-capabilities)] |
| `security_opt: no-new-privileges:true` | Stops the process from gaining privileges through setuid programs and the like [[Linux kernel documentation: No New Privileges Flag](https://docs.kernel.org/userspace-api/no_new_privs.html)] |

### Resources, stopping and logs

| Entry | What it does |
| :--- | :--- |
| `mem_limit: 1g` | Caps memory at 1 GB, far above normal use (about 55 MB over the long run, see [FAQ](faq.md)), so a fault cannot starve the NAS |
| `pids_limit` | Caps the number of processes. Commented out: Synology DSM's kernel does not support this limit, and Docker warns about it and ignores it on every start. On other Linux hosts you can uncomment it |
| `stop_grace_period: 15s` | On stop, Docker sends a stop signal and waits up to 15 seconds before killing the container [[Docker: Define services](https://docs.docker.com/reference/compose-file/services/#stop_grace_period)]. FengSui exits within 10: it turns new requests away, signs out of a router session in progress and writes its encrypted data to disk |
| `logging` | Logs go to the `json-file` driver, rotated at 10 MB with at most 3 files kept [[Docker: JSON File logging driver](https://docs.docker.com/engine/logging/drivers/json-file/)], about 30 MB in all |

<a id="apply"></a>

## Applying changes

- **You changed `docker-compose.yml`, or `TZ`, `WEB_PORT`, `PUID` or `PGID` in `.env`**: run `docker compose up -d`. Compose sees the changed configuration and recreates the container; `data/` is kept [[Docker: docker compose up](https://docs.docker.com/reference/cli/docker/compose/up/)].
- **You changed only other settings in `.env`**: run `docker compose up -d --force-recreate`. The Compose configuration is the same, so a plain `up -d` does not recreate the container, and `docker compose restart` keeps the old mount: if your editor saved `.env` by replacing it with a new file, the container still sees the old one [[moby/moby#15793: File mount does not update with changes from host](https://github.com/moby/moby/issues/15793)].

```bash
docker compose up -d --force-recreate
```

On Synology, run it the same way over SSH in the project directory.

## Common changes

### Use another port

Set `WEB_PORT` in `.env` to the port you want (for example `8443`) and run `docker compose up -d`. The console is then at `http://<NAS IP>:8443`.

### Allow access from this machine only

With a reverse proxy providing HTTPS on the same host, you can open the port on the host itself only:

```yaml
    ports:
      - "127.0.0.1:${WEB_PORT:-18384}:18384"
```

FengSui then sees requests coming from the Docker network's gateway, not from `127.0.0.1`. Set `ALLOWED_HOSTS` as in [Access behind a reverse proxy](security.md#reverse-proxy) and put the gateway address in `TRUSTED_PROXIES`. To find it (the network is named after the project directory, plus `_default`):

```bash
docker network inspect cpe-dash_default --format '{{(index .IPAM.Config 0).Gateway}}'
```

### Pin a version

```yaml
    image: ghcr.io/cky008/cpe-dash:1.7.1
```

To upgrade, change the version and run `docker compose pull && docker compose up -d`.

### Build from source

```bash
git clone https://github.com/cky008/cpe-dash.git && cd cpe-dash
cp .env.example .env && chmod 600 .env    # set DATA_ENCRYPTION_KEY and TZ
mkdir -p data && chmod 700 data
docker compose up -d --build
```

`--build` builds the image from the source in the directory instead of pulling it.

### Use host networking

When you need `PEER_DISCOVERY_ENABLED`: uncomment the `network_mode: host` line, delete `ports:` and the line under it, and run `docker compose up -d`. The console is on port `18384` of the host; to change it, change `WEB_PORT=18384` under `environment:`. With host networking the container shares the host's network, so you lose a layer of isolation.

### Limit processes on Linux other than Synology

Uncomment `# pids_limit: 256` and run `docker compose up -d`.
