---
title: Backup and restore
description: Run diagnostics, back up, restore data, and change encryption keys. None of these commands connect to the router.
section: Manage
order: 16
---

FengSui stores all its data in `data/`, encrypted with `DATA_ENCRYPTION_KEY`. The two most critical items are the **`data/` directory** and your **encryption key**: with both, you can restore everything on another machine exactly as it was.

None of the commands below log in to the router. The examples assume Docker Compose and a container named `cpe-dash`.

## Run diagnostics

Check your configuration, data directory permissions, daemon process status, and whether each encrypted file can be opened with the current key. You can run this command while the service is running:

```bash
docker exec cpe-dash node dist/cli.js doctor
```

## Back up data

Copy all encrypted files along with a SHA-256 verification manifest to `data/backups/fengsui-backup-<time>/`. You can run this command while the service is running:

```bash
docker exec cpe-dash node dist/cli.js backup
```

Backup files remain encrypted. Copy the backup directory to another drive or machine, and **store the key separately**.

## Restore data

Stop the daemon before restoring data:

```bash
docker compose stop cpe-dash
docker compose run --rm cpe-dash node dist/cli.js restore /app/data/backups/fengsui-backup-<time>
docker compose start cpe-dash
```

Before restoring, FengSui verifies the manifest, current key, and data format. Replaced files are preserved as `*.before-restore-<time>`. Backups written by newer versions must be restored using that version.

## Change the encryption key

1. Stop the daemon: `docker compose stop cpe-dash`
2. Update `DATA_ENCRYPTION_KEY` in `.env` with the new value.
3. Provide the old key (it will not remain in your command history) to re-encrypt all files with the new key:

   ```bash
   read -rs OLD && printf '%s' "$OLD" | docker compose run --rm -T cpe-dash node dist/cli.js rekey --old-key-stdin
   ```

4. Start the daemon: `docker compose start cpe-dash`

Any `*.unreadable-*` files that were quarantined during startup due to mismatched keys are also decrypted using the old key and restored to their original locations during this step.

## If data cannot be opened

If FengSui cannot decrypt a file at startup (due to a typo in the key or file corruption), it renames the file to `*.unreadable-<time>` in place and triggers a `DATA_QUARANTINED` alert. It **never deletes** your files. Once you locate the original key, restore your data using the `rekey` procedure above.
