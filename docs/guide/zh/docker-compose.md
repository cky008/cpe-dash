---
title: Docker Compose 配置
description: 示例 docker-compose.yml 的完整内容：每一项做什么、哪些可以改、怎么改，以及它和 .env 的关系。
section: 管理
order: 14
---

烽燧以 Docker Compose 项目的形式运行。仓库里的 [`docker-compose.yml`](../../../docker-compose.yml) 就是推荐配置，[快速开始](quick-start.md)和[安装与升级](install.md)下载的都是它，大多数人不需要改动。本页逐项解释它的内容。烽燧自己的设置（加密密钥、短信、通知等）写在 `.env` 里，见[配置参考](configuration.md)。

## 示例文件

下面是完整内容，和仓库里的文件一致：

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

## 和 .env 的关系

`docker-compose.yml` 旁边的 `.env` 有两个用途：

1. **给 Compose 填变量**。Compose 启动项目时读取项目目录里的 `.env`，替换文件里的 `${…}` [[Docker：在 Compose 文件中使用变量插值](https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/)]。这个文件只用到四个变量：`TZ`、`WEB_PORT`、`PUID`、`PGID`。`${TZ:-UTC}` 的意思是：`.env` 里的 `TZ` 有值就用它，否则用 `UTC`。
2. **给烽燧读设置**。同一个文件以只读方式挂进容器，成为 `/app/.env`，烽燧启动时从这里读取设置。

`environment:` 下的几项以环境变量的形式传进容器。同一个设置在 `.env` 和环境变量里都有时，烽燧以环境变量为准。所以 `.env` 里的 `WEB_HOST`、`WEB_PORT`、`STATE_FILE` 在容器里不起作用；`.env` 的 `WEB_PORT` 只决定宿主机上的端口（见下文 `ports`）。

## 逐项说明

### 镜像与容器

| 项 | 作用 |
| :--- | :--- |
| `image` | 使用的镜像。`ghcr.io/cky008/cpe-dash` 同时提供 amd64 和 arm64 两种架构。`latest` 指向最新发布的版本；想自己决定什么时候升级，可以写成具体版本，如 `ghcr.io/cky008/cpe-dash:1.7.1`（也有 `1.7`、`1` 这样只固定大版本的标签） |
| `build` | 目录里有源码时，用来在本地构建镜像。只下载了 compose 文件也没关系：Compose 会先拉取 `image`，拉不到才尝试构建 [[Docker：Compose 构建规范](https://docs.docker.com/reference/compose-file/build/)]。从源码构建见下文「常见修改」 |
| `container_name` | 容器名固定为 `cpe-dash`，日志和命令里都用这个名字。同一台主机上不会再建出第二个同名容器 |
| `restart: unless-stopped` | 进程退出或 NAS 重启后自动启动；你手动停止以后不再自动启动 [[Docker：定义服务](https://docs.docker.com/reference/compose-file/services/#restart)] |
| `init: true` | 在容器里运行一个很小的初始化进程（PID 1），负责转发停止信号、回收子进程 [[Docker：定义服务](https://docs.docker.com/reference/compose-file/services/#init)]，让烽燧收到停止信号后能按下文 `stop_grace_period` 说的步骤退出 |
| `user` | 运行烽燧的用户和组（UID:GID），默认 `1000:1000`。要和 `data/`、`.env` 的属主一致，否则容器读不到 `.env`、写不了 `data/`。群晖上用 SSH 执行 `id -u` 和 `id -g` 查看（常见是 `1026` 和 `100`），填进 `.env` 的 `PUID` / `PGID` |

### 环境变量（`environment`）

| 项 | 作用 |
| :--- | :--- |
| `TZ=${TZ:-UTC}` | 时区，取自 `.env` 的 `TZ`。影响日志时间和发出短信的时间戳，应该和路由器所在地一致 |
| `WEB_HOST=0.0.0.0` | 在容器的所有网络接口上监听，端口映射才能生效。不要改 |
| `WEB_PORT=18384` | 容器里的监听端口，保持不变即可，宿主机上的端口由 `ports` 决定。使用主机网络时，它就是宿主机上的端口：要换端口就改这一行，而不是 `.env` 里的 `WEB_PORT`。镜像自带的健康检查也访问这个端口 |
| `STATE_FILE=/app/data/state.json` | 把运行状态放进挂载的 `data/` 目录。短信、通讯录、设置等其他数据文件默认都在它旁边，所以 `data/` 目录就是烽燧的全部数据 |

### 数据与设置文件（`volumes`）

| 项 | 作用 |
| :--- | :--- |
| `./data:/app/data` | 烽燧的全部数据，都已加密。备份时连同加密密钥一起保存，见[备份与恢复](backup.md) |
| `./.env:/app/.env:ro` | 设置文件。`ro` 表示只读挂载：容器只能读、不能改 [[Docker：绑定挂载](https://docs.docker.com/engine/storage/bind-mounts/)]。改完以后怎样生效，见[修改后怎样生效](#apply) |

### 端口与网络

| 项 | 作用 |
| :--- | :--- |
| `ports` | 「宿主机端口:容器端口」。宿主机端口取自 `.env` 的 `WEB_PORT`，默认 `18384`，改它就能换端口，容器里不用动。没写 IP 时，Docker 在宿主机的所有网络接口上开放这个端口，而且不经过宿主机的防火墙规则 [[Docker：定义服务](https://docs.docker.com/reference/compose-file/services/#ports)]，所以不要把它转发到公网 |
| `network_mode: host` | 默认注释掉。只有打开 `PEER_DISCOVERY_ENABLED`（多台机器上的烽燧互相发现）时才需要，因为 Docker 的默认网络不转发局域网广播。做法见下文「常见修改」 |

### 安全限制

这几项让容器只拿到运行烽燧必需的权限。烽燧本身不需要其中任何一项被放宽。

| 项 | 作用 |
| :--- | :--- |
| `read_only: true` | 容器的文件系统只读 [[Docker：定义服务](https://docs.docker.com/reference/compose-file/services/#read_only)]，只有 `data/` 和 `/tmp` 可写。即使进程出了问题，也改不了镜像里的程序 |
| `tmpfs` | 在内存里挂一个临时目录 `/tmp`，容器重建后清空 |
| `cap_drop: ALL` | 去掉全部 Linux 内核能力（capabilities）。烽燧监听的是高位端口，不需要任何特权；Docker 也建议只保留进程确实需要的能力 [[Docker Engine 安全：Linux 内核能力](https://docs.docker.com/engine/security/#linux-kernel-capabilities)] |
| `security_opt: no-new-privileges:true` | 禁止进程借 setuid 之类的程序获得更多权限 [[Linux 内核文档：No New Privileges Flag](https://docs.kernel.org/userspace-api/no_new_privs.html)] |

### 资源、停止与日志

| 项 | 作用 |
| :--- | :--- |
| `mem_limit: 1g` | 内存上限 1 GB，远高于正常用量（长期运行约 55 MB，见[常见问题](faq.md)），只为防止异常时拖垮 NAS |
| `pids_limit` | 进程数上限，默认注释掉：群晖 DSM 的内核不支持这项限制，Docker 每次启动都会警告并忽略它。在其他 Linux 主机上可以取消注释 |
| `stop_grace_period: 15s` | 停止时 Docker 先发停止信号，最多等 15 秒再强制结束 [[Docker：定义服务](https://docs.docker.com/reference/compose-file/services/#stop_grace_period)]。烽燧在 10 秒内退出：新请求一律回绝，正在进行的路由器会话先退出登录，加密数据写回磁盘 |
| `logging` | 日志用 `json-file` 驱动，单个文件到 10 MB 就轮换，最多保留 3 个 [[Docker：JSON File 日志驱动](https://docs.docker.com/engine/logging/drivers/json-file/)]，加起来不超过约 30 MB |

<a id="apply"></a>

## 修改后怎样生效

- **改了 `docker-compose.yml`，或 `.env` 里的 `TZ`、`WEB_PORT`、`PUID`、`PGID`**：运行 `docker compose up -d`。Compose 发现配置变了，会重建容器，`data/` 不受影响 [[Docker：docker compose up](https://docs.docker.com/reference/cli/docker/compose/up/)]。
- **只改了 `.env` 里的其他设置**：运行 `docker compose up -d --force-recreate`。这时 Compose 的配置没变，普通的 `up -d` 不会重建容器；`docker compose restart` 则沿用原来的挂载，如果编辑器保存时用新文件替换了 `.env`，容器看到的仍是旧文件 [[moby/moby#15793：File mount does not update with changes from host](https://github.com/moby/moby/issues/15793)]。

```bash
docker compose up -d --force-recreate
```

群晖上同样用 SSH 进入项目目录运行。

## 常见修改

### 换一个端口

把 `.env` 里的 `WEB_PORT` 改成想用的端口（例如 `8443`），再运行 `docker compose up -d`。控制台就在 `http://<NAS 的 IP>:8443`。

### 只允许本机访问

在同一台主机上用反向代理提供 HTTPS 时，可以让端口只在本机开放：

```yaml
    ports:
      - "127.0.0.1:${WEB_PORT:-18384}:18384"
```

这时烽燧看到的请求来自 Docker 网络的网关地址，而不是 `127.0.0.1`。按[经反向代理访问](security.md#reverse-proxy)设置 `ALLOWED_HOSTS`，并把这个网关地址写进 `TRUSTED_PROXIES`。网关地址可以这样查（网络名是「项目目录名_default」）：

```bash
docker network inspect cpe-dash_default --format '{{(index .IPAM.Config 0).Gateway}}'
```

### 固定版本

```yaml
    image: ghcr.io/cky008/cpe-dash:1.7.1
```

升级时改成新的版本号，再运行 `docker compose pull && docker compose up -d`。

### 从源码构建

```bash
git clone https://github.com/cky008/cpe-dash.git && cd cpe-dash
cp .env.example .env && chmod 600 .env    # 填 DATA_ENCRYPTION_KEY 和 TZ
mkdir -p data && chmod 700 data
docker compose up -d --build
```

`--build` 用目录里的源码构建镜像，而不是拉取。

### 使用主机网络

需要 `PEER_DISCOVERY_ENABLED` 时：取消 `network_mode: host` 一行的注释，删掉 `ports:` 和它下面的一行，再运行 `docker compose up -d`。控制台在宿主机的 `18384` 端口；要换端口，改 `environment:` 下的 `WEB_PORT=18384`。主机网络下容器和宿主机共用网络，少了一层隔离。

### 在群晖以外的 Linux 上限制进程数

取消 `# pids_limit: 256` 的注释，再运行 `docker compose up -d`。
