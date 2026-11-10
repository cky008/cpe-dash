---
title: 告警与通知
description: 断网、信号变差、新短信时通知你：Telegram 机器人、Webhook 和告警规则。
section: 使用烽燧
order: 9
---

烽燧会在出问题时提醒你，并把新短信推送出去。通知可以发往 Telegram 机器人，或你自己的 Webhook 地址。

## 告警

告警出现在控制台的告警铃里，也可以推送。默认只推送 `warning` 及以上级别，可以在「设置 → 常规」的「告警」里改（`.env` 的 `ALERT_NOTIFY_MIN_SEVERITY`），信号告警的阈值也在那里。

| 告警 | 什么时候出现 |
| :--- | :--- |
| `CPE_UNREACHABLE` | 连不上路由器 |
| `WAN_DOWN` | 路由器的移动网络断开 |
| `SIGNAL_DEGRADED` | RSRP 低于 `ALERT_RSRP_THRESHOLD_DBM` 或 SINR 低于 `ALERT_SINR_THRESHOLD_DB`，持续 5 分钟 |
| `CA_DROPPED` | 载波聚合少了载波 |
| `REBOOT_DETECTED` | 路由器重启过 |
| `SMS_STORAGE_HIGH` / `SMS_STORAGE_FULL` | 路由器的短信存储快满或已满 |
| `DATA_THRESHOLD` | 本月流量超过你设的阈值 |
| `LOCK_ROLLED_BACK` 等 | 自愈解锁或重拨了（见[锁频与锁小区](locking.md)） |
| `FIRMWARE_UNVERIFIED` / `MODEL_UNVERIFIED` | 路由器固件更新了，或者不是已验证的型号 |
| `AGENT_TEST_STILL_ON` | AI 智能体测试打开的设置还开着：测完 3 小时后提醒，之后每天一次，直到写入全部通过、你看过提醒或测试结束；控制台开在后台标签页时也弹系统通知（见[用 AI 智能体测试](other-routers.md#ai)） |
| `STORAGE_WRITE_FAILED` | 数据保存失败（硬盘满、只读或权限不对） |

故障恢复时会再发一条恢复消息（如 `WAN_UP`）。短暂的波动不会立刻告警：每类告警都有持续时间要求和恢复缓冲。

## 设置 Telegram 机器人

1. 在 Telegram 里找 `@BotFather`，创建一个机器人，复制它给的令牌。
2. 把令牌写进 `.env` 的 `TELEGRAM_BOT_TOKEN`，重启容器。日志里出现 `telegram=on` 就成功了。
3. 在控制台「设置 → Telegram」点「生成绑定码」（10 分钟内有效），然后私聊你的机器人，发送 `/auth 绑定码`。

绑定后，新短信和告警会推送给你。

> [!NOTE]
> 推送的内容会经过 Telegram 的服务器。不想让短信内容离开家里，就不要配置 Telegram。

### 在群组里接收

如果你想在一个群里集中接收（比如只有你和机器人的群），在「设置 → Telegram」生成**群组绑定码**，以你本人的身份（不要匿名）在群里发送控制台给出的那条命令。群里所有成员都能看到推送，但只有发送绑定命令的人能在群里操作。（写在 `TELEGRAM_CHAT_IDS` 里的群则是每个成员都能操作。）在某个话题里发送，推送就进那个话题；话题被删除后自动改发到通用话题。

### 在 Telegram 里操作

| 命令 / 操作 | 作用 |
| :--- | :--- |
| 回复短信卡片 | 直接回复该号码 |
| 卡片上的按钮 | 标为已读、查看会话、删除（会再确认一次；删掉的短信进控制台的[「最近删除」](sms.md#trash)） |
| `/new` | 一步步发一条新短信 |
| `/send 号码 内容` | 快速发送（同样要点确认） |
| `/inbox`、`/unread`、`/chat 号码` | 会话列表、未读和某个会话 |
| `/contacts`、`/contact 号码 名字` | 查找和添加联系人；发送 `.vcf` 文件可批量导入 |
| `/status`、`/alerts`、`/sync` | 路由器状态、最近告警、立即同步短信 |
| `/mute 30m`、`/mute off` | 暂停或恢复告警推送 |

### 管理绑定的聊天

「设置 → Telegram」列出每个能收到推送的聊天：私聊还是群组、怎么绑定的、何时绑定的。不认识的聊天可以单独解绑。撤销某个令牌时，用它绑定的聊天也会一起解绑。

断网期间发不出去的 Telegram 通知会暂存（最多 50 条、24 小时），恢复后按顺序补发；其间解绑的聊天不会收到。

## Webhook

设置 `WEBHOOK_URL` 后，新短信（`sms.received`）和告警（`alert`）会以 JSON `POST` 到这个地址，可以接到 Home Assistant、n8n 等工具里。局域网以外的地址必须用 `https`。

设置 `WEBHOOK_SECRET` 后，每个请求带签名，接收端这样校验：

```ts
import crypto from "node:crypto";
const expected = "sha256=" + crypto.createHmac("sha256", secret).update(`${req.headers["x-fengsui-timestamp"]}.${rawBody}`).digest("hex");
// 用常量时间比较 expected 和 req.headers["x-fengsui-signature"]，并拒绝时间戳偏差过大的请求
```
