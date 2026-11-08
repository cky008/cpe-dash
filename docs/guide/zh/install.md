---
title: 安装与升级
description: 在群晖、其他 Docker 主机或直接用 Node.js 安装烽燧，以及怎样升级、停止和卸载。
section: 开始使用
order: 3
---

烽燧以一个容器运行，镜像发布在 GitHub Container Registry（`ghcr.io/cky008/cpe-dash`），支持 `amd64` 和 `arm64`。选一种适合你的方式即可。

> [!NOTE]
> 一台路由器只能由**一个**烽燧管理：它独占路由器的管理员会话和 Telegram 机器人。装第二个之前，先停掉第一个。

## 群晖 Container Manager

适用于 DSM 7.2 及以上。

1. **准备目录**。在「File Station」里建 `docker/cpe-dash/data`，或者 SSH 登录 NAS：

   ```bash
   mkdir -p /volume1/docker/cpe-dash/data && cd /volume1/docker/cpe-dash
   curl -fsSLO https://raw.githubusercontent.com/cky008/cpe-dash/main/docker-compose.yml
   curl -fsSL -o .env https://raw.githubusercontent.com/cky008/cpe-dash/main/.env.example
   chmod 600 .env && chmod 700 data
   id -u && id -g      # 例如 1026 和 100，填进 .env 的 PUID / PGID
   ```

2. **编辑 `.env`**：填 `DATA_ENCRYPTION_KEY`（`openssl rand -hex 32` 生成的随机字符）、`TZ`（如 `Asia/Shanghai`）、`PUID` / `PGID`。路由器和控制台的密码之后在网页里设置。
3. **创建项目**：打开「Container Manager → 项目 → 新增」，路径选 `/volume1/docker/cpe-dash`，来源选「使用现有 docker-compose.yml」，然后启动。
4. **找到设置码**：容器状态变成「健康」后，在「容器 → cpe-dash → 日志」里找 `setup code`，然后按[快速开始](quick-start.md#4-打开控制台)的第 4 步完成设置。

## 其他 Docker 主机

Linux、macOS（Docker Desktop 或 OrbStack）和 Windows 都可以。步骤和[快速开始](quick-start.md)一样：

```bash
docker compose pull
docker compose up -d
```

常用命令：

```bash
docker compose logs -f cpe-dash    # 查看日志
docker compose restart cpe-dash    # 重启
docker compose down                # 停止：先登出路由器、保存数据，10 秒内退出
```

## 用 Node.js 直接运行

适合想看源码或参与开发的人。需要 Node.js 22.6 或更高版本。

```bash
git clone https://github.com/cky008/cpe-dash.git && cd cpe-dash
npm ci
cp .env.example .env && chmod 600 .env    # 填 DATA_ENCRYPTION_KEY
npm run build
npm start                                  # http://<本机 IP>:18384
```

不想连真路由器、只想看看界面，可以运行 `npm run demo`：它在同一个进程里模拟一台路由器，不读 `.env`、不联网，打开 `http://127.0.0.1:18484`，登录口令 `fengsui-demo`。

## 升级

升级前先备份（见[备份与恢复](backup.md)），再拉取新镜像重建容器：

```bash
docker compose pull
docker compose up -d
```

群晖图形界面里：「项目 → cpe-dash → 操作 → 构建」或先停止再启动项目。

每个版本的变化和需要手动做的事写在 [GitHub Releases](https://github.com/cky008/cpe-dash/releases) 的「Before you upgrade」里，升级前看一眼。

## 卸载

```bash
docker compose down
rm -rf ~/cpe-dash     # 会删除 data/ 里的全部数据，先确认已经不需要
```

烽燧不会在路由器上留下任何东西。如果你设置过锁频、Wi-Fi 黑名单或上网时段，卸载前先在控制台里解除，或者之后在路由器官方网页里改回。

## 端口和网络

| 用途 | 端口 | 说明 |
| :--- | :--- | :--- |
| 网页控制台、API、MCP | `18384` | 在 `.env` 的 `WEB_PORT` 修改宿主机端口 |
| 局域网信标 | `18385`（UDP） | 只在打开 `PEER_DISCOVERY_ENABLED` 时使用，默认关闭 |

默认的 Docker 网络（bridge）就够用。只有你需要「多台机器上的烽燧互相发现」时，才要把 compose 改成 `network_mode: host`，代价是容器不再有独立的网络隔离。
