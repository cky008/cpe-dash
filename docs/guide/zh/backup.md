---
title: 备份与恢复
description: 自检、备份、恢复数据，以及更换加密密钥。这些命令都不会连接路由器。
section: 管理
order: 15
---

烽燧的数据都在 `data/` 里，用 `DATA_ENCRYPTION_KEY` 加密。最重要的两样东西是 **`data/` 目录**和**加密密钥**：有了这两样，就能在另一台机器上原样恢复。

下面的命令都不会登录路由器。示例以 Docker Compose 为例，容器名是 `cpe-dash`。

## 自检

检查配置、数据目录权限、守护进程是否在运行，以及每个加密文件能否用当前密钥打开。运行中也可以执行：

```bash
docker exec cpe-dash node dist/cli.js doctor
```

## 备份

把所有加密文件连同一份 SHA-256 校验清单复制到 `data/backups/fengsui-backup-<时间>/`。运行中也可以执行：

```bash
docker exec cpe-dash node dist/cli.js backup
```

备份文件仍然是加密的。把它复制到另一块硬盘或另一台机器上，**密钥另外单独保存**。

## 恢复

恢复要先停止守护进程：

```bash
docker compose stop cpe-dash
docker compose run --rm cpe-dash node dist/cli.js restore /app/data/backups/fengsui-backup-<时间>
docker compose start cpe-dash
```

恢复前会核对校验清单、当前密钥和数据格式；被替换的文件保留为 `*.before-restore-<时间>`。新版本写出的备份要用那个版本来恢复。

## 更换加密密钥

1. 停止守护进程：`docker compose stop cpe-dash`
2. 把 `.env` 里的 `DATA_ENCRYPTION_KEY` 改成新值。
3. 输入旧密钥（不会留在命令历史里），把所有文件改用新密钥加密：

   ```bash
   read -rs OLD && printf '%s' "$OLD" | docker compose run --rm -T cpe-dash node dist/cli.js rekey --old-key-stdin
   ```

4. 启动：`docker compose start cpe-dash`

启动时因为密钥不对而被移到一边的 `*.unreadable-*` 文件，也会在这一步用旧密钥解开并放回原处。

## 数据打不开了

烽燧启动时如果某个文件解不开（密钥改错了、文件损坏），会把它改名为 `*.unreadable-<时间>` 放在原处，然后发出 `DATA_QUARANTINED` 告警，**不会删除**。找回旧密钥后用上面的 `rekey` 恢复即可。
