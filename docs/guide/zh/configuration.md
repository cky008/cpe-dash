---
title: 配置参考
description: .env 里每一项设置的含义和默认值。大多数人只需要填加密密钥和时区。
section: 管理
order: 14
---

烽燧在启动时读取 `.env`（容器里是 `/app/.env`）和环境变量。完整模板见仓库里的 [`.env.example`](../../../.env.example)。

大多数人只需要设置三项：`DATA_ENCRYPTION_KEY`、`TZ`，以及 Docker 下的 `PUID` / `PGID`。路由器连接、控制台密码和令牌都在网页控制台里管理，加密保存在 `data/settings.json`。

改完 `.env` 后，用 `docker compose up -d --force-recreate` 让它生效（原因见 [Docker Compose 配置](docker-compose.md#apply)）。`docker-compose.yml` 本身每一项的作用也在那一页。

## 基本

| 设置 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `DATA_ENCRYPTION_KEY` | 无（必填） | 加密 `data/` 里所有文件的主密钥。用 `openssl rand -hex 32` 生成，另外保存一份；丢失后数据无法打开。更换请用 `rekey`（见[备份与恢复](backup.md)） |
| `TZ` | `UTC` | 时区，如 `Asia/Shanghai`。发出的短信按这个时区打时间戳，请和路由器所在地一致 |
| `DEFAULT_LOCALE` | `zh-CN` | 界面和通知的默认语言（`zh-CN` 或 `en`） |
| `PUID` / `PGID` | `1000` / `1000` | 只给 Docker Compose 用：容器以哪个用户运行。填 `data/` 和 `.env` 的属主 |

## 路由器

这几项只在**第一次启动**时导入一次，之后以控制台「设置 → 路由器」为准，可以不填。

| 设置 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `CPE_URL` | `http://192.168.8.1` | 路由器管理地址。只接受局域网地址 |
| `CPE_USERNAME` | `admin` | 管理员账号 |
| `CPE_PASSWORD` | 空 | 管理员密码。密码首尾有空格或含有 ` #` 时，用单引号括起来（`CPE_PASSWORD='…'`）：不加引号时，首尾空格会被去掉，` #` 之后会被当作注释。在控制台里填写的密码原样保存，不受影响 |
| `CPE_REQUIRE_ECC_SIGNATURE` | `true` | 路由器登录时给出的加密密钥签过名之后，烽燧就要求它一直签名：某次登录的密钥没有签名（应答可能在途中被改过），就结束并登出这次会话，不用这个密钥加密。从没签过名的路由器不受影响；固件更新后路由器确实不再签名时设为 `false` |
| `CPE_ALLOW_LEGACY_LOGIN_AFTER_SCRAM` | `false` | 换成只支持旧式登录的路由器时临时设为 `true`，测试并保存新路由器后改回。推荐的做法是用一个新的空 `data/` 重新部署 |
| `RESPECT_BROWSER_SESSION` | `true` | 有人登录官方网页时自动让开。强烈建议保持开启 |
| `REQUEST_TIMEOUT_MS` | `15000` | 单次请求路由器的超时（毫秒） |
| `POLL_INTERVAL_MS` | `5000` | 读取信号和速率的间隔 |
| `NEIGHBOR_SCAN_INTERVAL_MS` | `60000` | 扫描邻区的间隔 |

## 网页、登录与令牌

| 设置 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `WEB_ENABLED` | `true` | 是否启动网页控制台、API 和 MCP。设为 `false` 时只做采集、短信同步和通知 |
| `WEB_HOST` / `WEB_PORT` | `0.0.0.0` / `18384` | 监听地址和端口。Docker 下 `WEB_PORT` 决定宿主机端口 |
| `ALLOWED_HOSTS` | 空 | 额外允许的访问域名，如 `cpe.example.com`。局域网 IP、`localhost`、`*.local`、`*.lan`、`*.internal`、`*.ts.net` 总是允许 |
| `TRUSTED_PROXIES` | `127.0.0.1,::1` | 反向代理的 IP 或网段。只有来自这里的请求，烽燧才相信 `X-Forwarded-For` / `X-Forwarded-Proto`（见[安全与隐私](security.md#经反向代理访问)） |
| `SESSION_TTL_MS` | `86400000` | 控制台登录有效期（24 小时） |
| `RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX_AUTH_FAILURES` | `60000` / `8` | 登录失败限流：每分钟最多 8 次失败 |
| `API_TOKEN` | 空 | 只在第一次启动时导入：成为控制台登录密码，也成为一个完全控制的令牌。之后在控制台管理，不必填写 |
| `API_TOKEN_READONLY` | 空 | 只在第一次启动时导入为一个只读令牌。新令牌请在「设置 → 令牌」生成 |
| `STATIC_DIR` | 构建产物 | 控制台静态文件目录，一般不用改 |
| `SSE_HEARTBEAT_MS` / `SSE_MAX_CLIENTS` | `15000` / `32` | 实时事件流的心跳间隔和最大连接数 |
| `METRICS_ENABLED` | `false` | 打开 `GET /metrics`（Prometheus 格式，需要任意令牌）。控制台「设置 → 安全」里的开关优先 |

## AI 智能体（MCP）

| 设置 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `MCP_HTTP_ENABLED` | `true` | 是否提供 `POST /mcp` |
| `MCP_ALLOW_MUTATIONS` | `false` | 是否允许智能体调用会改动路由器的工具。默认只能读取 |
| `MCP_ALLOW_ACCESS_CONTROL` | `false` | 是否允许智能体断网、改 Wi-Fi 黑白名单和上网时段（还需要上一项为 `true`） |
| `MCP_SMS_ACCESS` | `read` | 智能体的短信权限：`none`、`read` 或 `full` |
| `MCP_SMS_SEND_POLICY` | `known` | `known`：只能发给你保存的联系人或发过短信的号码；`any`：不限制 |
| `MCP_SMS_SEND_LIMIT_PER_HOUR` | `10` | 智能体每小时最多发几条（`0` 表示禁止） |
| `MCP_DAEMON_URL` | 自动推导 | stdio 桥接转发的 `/mcp` 地址，只接受局域网地址 |
| `REDACT_SENSITIVE_IN_API` | `true` | 给令牌访问的 API、实时事件和 MCP 的数据打码（IMEI、IMSI、号码、MAC、WAN 地址、小区标识）。网页控制台不受影响 |

## 短信

| 设置 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `SMS_ENABLED` | `true` | 是否启用短信 |
| `DEFAULT_COUNTRY_CODE` | 空（按 SIM 卡） | 不带 `+` 的本地号码按哪个国家区号补全，如 `+86`。留空时按路由器 SIM 卡的国家推断；推断不出时要求输入完整号码或选择国家 |
| `SMS_AUTO_MARK_READ` | `false` | 推送新短信后自动在路由器上标为已读 |
| `SMS_SEED_EXISTING_ON_START` | `true` | 第一次同步时，把路由器上已有的短信当作历史，不推送 |
| `SMS_FULL_SYNC_INTERVAL_MS` | `1800000` | 完整核对一次的间隔（30 分钟） |
| `SMS_SEND_STATUS_TIMEOUT_MS` | `45000` | 发送后等待路由器报告结果的最长时间 |
| `SMS_FILE` / `CONTACTS_FILE` | `data/` 下 | 加密的短信镜像和通讯录文件 |

## 通知与告警

| 设置 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `TELEGRAM_BOT_TOKEN` | 空 | Telegram 机器人令牌（找 `@BotFather` 创建） |
| `TELEGRAM_CHAT_IDS` | 空 | 预先授权的聊天 ID（逗号分隔）。一般用绑定码，不需要填 |
| `TELEGRAM_API_BASE` | `https://api.telegram.org` | 自建 Bot API 时改成你的地址 |
| `TELEGRAM_STATE_FILE` | `data/telegram.json` | 加密的 Telegram 状态文件 |
| `WEBHOOK_URL` / `WEBHOOK_SECRET` | 空 | 新短信和告警的推送地址，以及签名密钥 |
| `ALERTS_ENABLED` | `true` | 是否启用告警 |
| `ALERT_NOTIFY_MIN_SEVERITY` | `warning` | 推送的最低级别：`info`、`warning` 或 `critical` |
| `ALERT_RSRP_THRESHOLD_DBM` / `ALERT_SINR_THRESHOLD_DB` | `-110` / `0` | 信号变差告警的阈值 |

## 自愈（默认关闭）

| 设置 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `LOCK_ROLLBACK_AFTER_MIN` | `0`（关闭） | 锁定后 WAN 仍断开多少分钟就自动解除全部锁定（`3` 到 `1440`） |
| `WAN_AUTO_RECONNECT_AFTER_MIN` | `0`（关闭） | WAN 断开多少分钟后自动重拨（`1` 到 `1440`），24 小时最多 4 次，从不重启路由器 |

详见[锁频与锁小区](locking.md#rollback)。

## 数据与存储

| 设置 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `STATE_FILE` | `./data/state.json` | 加密的运行状态（缓存、历史曲线、告警）。容器里是 `/app/data/state.json` |
| `HISTORY_RETENTION_HOURS` | `168` | 历史曲线保留多久（7 天） |
| `STATE_FLUSH_INTERVAL_MS` | `1800000` | 多久把状态写一次硬盘（30 分钟；停止时总会写）。NAS 开了硬盘休眠、又没有别的写入时，可以调大到几小时，避免反复唤醒硬盘 |

## 多机与开发

| 设置 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `PEER_DISCOVERY_ENABLED` / `PEER_DISCOVERY_PORT` | `false` / `18385` | 多台机器上运行烽燧时互相发现，避免两个同时管理一台路由器。需要 host 网络；信标密钥由路由器密码派生，局域网里的设备可以拿它离线猜弱密码，所以默认关闭 |
| `CPE_HAR_PATH` | 空 | 只给开发用的只读探针脚本使用，不要提交到仓库 |
