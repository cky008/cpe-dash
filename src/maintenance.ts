import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { StorageCipher, readPlaintextStore, tryAcquireFileLock } from "./encrypted-file.ts";
import type { AppConfig } from "./types.ts";
import { FENGSUI_VERSION } from "./version.ts";

/**
 * Offline maintenance for the data directory: `cpe-dash doctor`, `backup`, `restore` and `rekey`.
 * None of them talks to the CPE. `restore` and `rekey` take the daemon's data-directory lock, so
 * they refuse to run next to a live daemon; `doctor` and `backup` only read.
 */

type DataConfig = Pick<AppConfig, "stateFile" | "smsFile" | "contactsFile" | "telegramStateFile" | "settingsFile" | "auditFile" | "dataEncryptionKey">;

export interface DataFileReport {
  name: string;
  path: string;
  status: "missing" | "ok" | "plaintext" | "undecryptable" | "too-new";
  /** The stored format number (`schemaVersion` of state.json, `format` of settings / audit, `version` elsewhere). */
  format: number | null;
  /** Copies moved aside after a failed decryption (`<name>.unreadable-<ms>`), newest first. */
  quarantined: string[];
  /** Those of them stored without encryption (moved aside for that, not for a key mismatch). */
  quarantinedPlaintext: string[];
}

export interface DoctorCheck {
  level: "ok" | "info" | "warn" | "error";
  label: string;
  hint?: string;
}

export class DataDirectoryBusyError extends Error {
  constructor(lockPath: string, pid: number | null) {
    super(`The FengSui daemon (pid ${pid ?? "unknown"}) holds ${lockPath}: stop it first (docker compose stop), then run this command`);
    this.name = "DataDirectoryBusyError";
  }
}

/** The encrypted stores of a data directory and the format each currently writes. */
function dataFiles(config: DataConfig): Array<{ path: string; formatKey: "schemaVersion" | "version" | "format"; supported: number }> {
  return [
    { path: config.stateFile, formatKey: "schemaVersion", supported: 1 },
    { path: config.smsFile, formatKey: "version", supported: 1 },
    { path: config.contactsFile, formatKey: "version", supported: 1 },
    { path: config.telegramStateFile, formatKey: "version", supported: 1 },
    { path: config.settingsFile, formatKey: "format", supported: 1 },
    { path: config.auditFile, formatKey: "format", supported: 1 },
  ];
}

function quarantinedCopies(filePath: string): string[] {
  const dir = path.dirname(filePath);
  const prefix = `${path.basename(filePath)}.unreadable-`;
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => name.startsWith(prefix) && /^\d+$/.test(name.slice(prefix.length)))
      .sort((a, b) => Number(b.slice(prefix.length)) - Number(a.slice(prefix.length)));
  } catch {
    return [];
  }
}

function tryRead(cipher: StorageCipher, filePath: string): { ok: true; data: unknown } | { ok: false } {
  try {
    return { ok: true, data: cipher.readJsonFile<unknown>(filePath) };
  } catch {
    return { ok: false };
  }
}

function formatOf(data: unknown, key: string): number | null {
  if (!data || typeof data !== "object") return null;
  const value = (data as Record<string, unknown>)[key];
  return typeof value === "number" ? value : null;
}

export function inspectDataFiles(config: DataConfig): DataFileReport[] {
  const cipher = new StorageCipher(config.dataEncryptionKey);
  return dataFiles(config).map((file) => {
    const quarantined = quarantinedCopies(file.path);
    const dir = path.dirname(file.path);
    const quarantinedPlaintext = quarantined.filter((copy) => readPlaintextStore(path.join(dir, copy)) !== null);
    const base = { name: path.basename(file.path), path: file.path, quarantined, quarantinedPlaintext };
    if (!fs.existsSync(file.path)) return { ...base, status: "missing", format: null };
    const plain = readPlaintextStore(file.path);
    if (plain) return { ...base, status: "plaintext", format: formatOf(plain.data, file.formatKey) };
    const read = tryRead(cipher, file.path);
    if (!read.ok) return { ...base, status: "undecryptable", format: null };
    const format = formatOf(read.data, file.formatKey);
    if (format !== null && format > file.supported) return { ...base, status: "too-new", format };
    return { ...base, status: "ok", format };
  });
}

/** The live process holding the daemon lock, or `null` (no lock, a stale one, or our own pid). */
function lockHolder(lockPath: string): number | null {
  let pid: number;
  try {
    pid = Number(fs.readFileSync(lockPath, "utf8").trim());
  } catch {
    return null;
  }
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch (err) {
    // EPERM: the process exists but belongs to another user
    return err && typeof err === "object" && "code" in err && err.code === "EPERM" ? pid : null;
  }
}

async function portFree(host: string, port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, host, () => probe.close(() => resolve(true)));
  });
}

export interface DoctorOptions {
  /** Startup notices (secrets that fall back to CPE_PASSWORD), reported as warnings. */
  notices: ReadonlyArray<string>;
  fetchImpl?: typeof fetch;
}

/** Offline health report: configuration, data directory, stores and the running daemon. Never logs in. */
export async function runDoctor(config: AppConfig, opts: DoctorOptions): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [{ level: "ok", label: `configuration loaded (FengSui ${FENGSUI_VERSION}, router ${new URL(config.cpeUrl).host})` }];
  for (const notice of opts.notices) checks.push({ level: "warn", label: notice });

  const dataDir = path.dirname(config.stateFile);
  if (!fs.existsSync(dataDir)) {
    checks.push({ level: "info", label: `data directory ${dataDir} does not exist yet (created on first start)` });
  } else {
    try {
      fs.accessSync(dataDir, fs.constants.R_OK | fs.constants.W_OK);
      const mode = fs.statSync(dataDir).mode & 0o777;
      checks.push(
        mode & 0o077
          ? { level: "warn", label: `data directory ${dataDir} is readable by others (mode ${mode.toString(8)})`, hint: `chmod 700 ${dataDir}` }
          : { level: "ok", label: `data directory ${dataDir} is private and writable` }
      );
    } catch {
      checks.push({ level: "error", label: `data directory ${dataDir} is not readable and writable by uid ${process.getuid?.() ?? "?"}`, hint: "set PUID / PGID to the owner of ./data" });
    }
  }

  const pid = lockHolder(`${config.stateFile}.lock`);
  if (pid !== null) {
    checks.push({ level: "info", label: `daemon running (pid ${pid})` });
    if (config.webEnabled) {
      try {
        const res = await (opts.fetchImpl ?? fetch)(`http://127.0.0.1:${config.webPort}/api/health`, { redirect: "error", signal: AbortSignal.timeout(3000) });
        const body = (await res.json()) as { version?: unknown; uptimeSec?: unknown };
        checks.push({ level: "ok", label: `daemon answers on port ${config.webPort} (version ${String(body.version)}, up ${String(body.uptimeSec)} s)` });
      } catch {
        checks.push({ level: "warn", label: `daemon holds the data directory but does not answer on 127.0.0.1:${config.webPort}`, hint: "check its logs" });
      }
    }
  } else {
    checks.push({ level: "info", label: "daemon not running" });
    if (config.webEnabled && !(await portFree(config.webHost, config.webPort))) {
      checks.push({ level: "error", label: `port ${config.webPort} is taken by another program`, hint: "set WEB_PORT or stop that program" });
    }
  }

  const files = config.dataEncryptionKey.trim() ? inspectDataFiles(config) : [];
  if (files.length === 0) {
    checks.push({ level: "error", label: "CPE_PASSWORD / DATA_ENCRYPTION_KEY is empty: no store can be decrypted", hint: "set DATA_ENCRYPTION_KEY in .env" });
  }
  for (const file of files) {
    if (file.status === "missing") checks.push({ level: "info", label: `${file.name}: not created yet` });
    else if (file.status === "ok") checks.push({ level: "ok", label: `${file.name}: decrypts with the current key (format ${file.format ?? "?"})` });
    else if (file.status === "plaintext") checks.push({ level: "error", label: `${file.name}: stored without encryption: FengSui moves it aside at its next start`, hint: PLAINTEXT_HINT });
    else if (file.status === "too-new") checks.push({ level: "error", label: `${file.name}: written by a newer FengSui (format ${file.format})`, hint: "run the newer version, or restore a backup" });
    else checks.push({ level: "error", label: `${file.name}: cannot be decrypted with the current DATA_ENCRYPTION_KEY`, hint: "put the old key in FENGSUI_OLD_DATA_KEY and run: cpe-dash rekey" });
    const keyMismatch = file.quarantined.filter((copy) => !file.quarantinedPlaintext.includes(copy));
    if (keyMismatch.length > 0) {
      checks.push({ level: "warn", label: `${file.name}: ${keyMismatch.length} copy(ies) moved aside after a key mismatch (${keyMismatch[0]})`, hint: "recover with the old key: cpe-dash rekey" });
    }
    if (file.quarantinedPlaintext.length > 0) {
      checks.push({ level: "warn", label: `${file.name}: ${file.quarantinedPlaintext.length} copy(ies) moved aside for being stored without encryption (${file.quarantinedPlaintext[0]})`, hint: PLAINTEXT_HINT });
    }
  }

  if (config.trustedProxies.some((p) => p === "0.0.0.0/0" || p === "::/0")) {
    checks.push({ level: "warn", label: "TRUSTED_PROXIES trusts every address: anyone can forge X-Forwarded-For and dodge the login rate limit" });
  }
  checks.push({
    level: "info",
    label: `MCP: ${config.mcpHttpEnabled ? "on" : "off"}, writes ${config.mcpAllowMutations ? "allowed" : "off"}, access control ${config.mcpAllowAccessControl ? "allowed" : "off"}, SMS ${config.mcpSmsAccess}`,
  });
  checks.push({
    level: "info",
    label: `self-healing: lock rollback ${config.lockRollbackAfterMs > 0 ? `${config.lockRollbackAfterMs / 60_000} min` : "off"}, WAN redial ${config.wanReconnectAfterMs > 0 ? `${config.wanReconnectAfterMs / 60_000} min` : "off"}`,
  });
  return checks;
}

/** A store written without encryption is the owner's own only if they say so: nothing adopts one on its own. */
const PLAINTEXT_HINT = "if it is yours, stop FengSui and run: cpe-dash rekey --plaintext";

export function formatDoctorReport(checks: ReadonlyArray<DoctorCheck>): string {
  const mark = { ok: "✓", info: "·", warn: "!", error: "✗" } as const;
  return checks.map((c) => `${mark[c.level]} ${c.label}${c.hint ? `\n    → ${c.hint}` : ""}`).join("\n");
}

function sha256(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function stamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

export interface BackupManifest {
  format: 1;
  createdAtIso: string;
  fengsuiVersion: string;
  files: Array<{ name: string; bytes: number; sha256: string }>;
}

/**
 * Copy the encrypted stores (still encrypted) into `<outDir>/fengsui-backup-<time>/` with a manifest
 * of sizes and SHA-256 sums. Safe next to a running daemon: every store is replaced atomically.
 */
export function backupDataDir(config: DataConfig, opts: { outDir?: string; now?: () => number } = {}): { dir: string; manifest: BackupManifest } {
  const now = (opts.now ?? Date.now)();
  const outDir = opts.outDir ?? path.join(path.dirname(config.stateFile), "backups");
  const dir = path.join(outDir, `fengsui-backup-${stamp(now)}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const files: BackupManifest["files"] = [];
  for (const file of dataFiles(config)) {
    if (!fs.existsSync(file.path)) continue;
    const name = path.basename(file.path);
    const target = path.join(dir, name);
    fs.copyFileSync(file.path, target);
    fs.chmodSync(target, 0o600);
    files.push({ name, bytes: fs.statSync(target).size, sha256: sha256(target) });
  }
  const manifest: BackupManifest = { format: 1, createdAtIso: new Date(now).toISOString(), fengsuiVersion: FENGSUI_VERSION, files };
  fs.writeFileSync(path.join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return { dir, manifest };
}

function withDataDirectoryLock<T>(config: DataConfig, work: () => T): T {
  const lockPath = `${config.stateFile}.lock`;
  const acquired = tryAcquireFileLock(lockPath);
  if (!acquired.ok) throw new DataDirectoryBusyError(lockPath, acquired.heldByPid);
  try {
    return work();
  } finally {
    acquired.lock.release();
  }
}

/**
 * Write `data` encrypted under `cipher` to `filePath`, keeping what was there as `<file>.<label>-<time>`. The old
 * store is copied aside and the new one written over it atomically, so a crash or a failed write never leaves
 * `filePath` missing (a missing store would make the daemon start as a fresh install).
 */
export function replaceFile(filePath: string, cipher: StorageCipher, data: unknown, label: string, now: number): string | null {
  let keptAside: string | null = null;
  if (fs.existsSync(filePath)) {
    keptAside = `${filePath}.${label}-${now}`;
    fs.copyFileSync(filePath, keptAside, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(keptAside, 0o600);
  }
  try {
    cipher.writeJsonFile(filePath, data);
  } catch (err) {
    // Nothing was replaced: the copy would only be a duplicate
    if (keptAside) fs.rmSync(keptAside, { force: true });
    throw err;
  }
  return keptAside;
}

/**
 * Put a backup back. The daemon must be stopped. Every file must match its manifest checksum,
 * decrypt with the current key and be in a format this version reads before anything is touched;
 * the files it replaces are kept as `<name>.before-restore-<time>`.
 */
export function restoreDataDir(config: DataConfig, backupDir: string, opts: { now?: () => number } = {}): { restored: string[]; movedAside: string[] } {
  const now = (opts.now ?? Date.now)();
  const manifest = JSON.parse(fs.readFileSync(path.join(backupDir, "manifest.json"), "utf8")) as Partial<BackupManifest>;
  if (manifest.format !== 1 || !Array.isArray(manifest.files)) throw new Error(`${backupDir} has no FengSui backup manifest`);
  const cipher = new StorageCipher(config.dataEncryptionKey);
  const targets = new Map(dataFiles(config).map((file) => [path.basename(file.path), file]));
  const plan = manifest.files.map((entry) => {
    const file = targets.get(entry.name);
    if (!file) throw new Error(`${entry.name} is not a FengSui data file`);
    const source = path.join(backupDir, entry.name);
    if (sha256(source) !== entry.sha256) throw new Error(`${entry.name} does not match its checksum in the manifest`);
    if (readPlaintextStore(source)) {
      throw new Error(`${entry.name} is stored without encryption, which FengSui does not read; if it is yours, copy it into the data directory and run cpe-dash rekey --plaintext`);
    }
    const read = tryRead(cipher, source);
    if (!read.ok) throw new Error(`${entry.name} does not decrypt with the current DATA_ENCRYPTION_KEY; set the key the backup was made with`);
    // This version would refuse to start on it: restore it with the version that wrote it
    const format = formatOf(read.data, file.formatKey);
    if (format !== null && format > file.supported) throw new Error(`${entry.name} was written by a newer FengSui (format ${format}); restore this backup with that version`);
    return { target: file.path, data: read.data };
  });
  return withDataDirectoryLock(config, () => {
    const restored: string[] = [];
    const movedAside: string[] = [];
    for (const step of plan) {
      const aside = replaceFile(step.target, cipher, step.data, "before-restore", now);
      if (aside) movedAside.push(path.basename(aside));
      restored.push(path.basename(step.target));
    }
    return { restored, movedAside };
  });
}

export interface RekeyResult {
  name: string;
  /** `plaintext`: stored without encryption and left as it is (only `--plaintext` encrypts it). */
  action: "missing" | "already-current" | "encrypted" | "rekeyed" | "recovered" | "plaintext" | "not-decryptable";
  /** For `recovered`: the moved-aside copy that was brought back. */
  source?: string;
}

/**
 * Re-encrypt the stores under the current `DATA_ENCRYPTION_KEY`. The daemon must be stopped. For
 * each store, a copy moved aside after a key mismatch that opens with the old key is brought back
 * (the file the daemon started afresh is kept as `<name>.replaced-<time>`); otherwise a store still
 * under the old key is re-encrypted in place. A store written without encryption, or a copy moved
 * aside for that, is encrypted under the current key only with `plaintext` (the owner says it is
 * theirs: a key change never vouches for one), and no unencrypted copy is kept.
 */
export function rekeyDataDir(config: DataConfig, oldKey: string | null, opts: { plaintext?: boolean; now?: () => number } = {}): RekeyResult[] {
  const now = (opts.now ?? Date.now)();
  const current = new StorageCipher(config.dataEncryptionKey);
  const old = oldKey ? new StorageCipher(oldKey) : null;
  return withDataDirectoryLock(config, () =>
    dataFiles(config).map((file): RekeyResult => {
      const name = path.basename(file.path);
      for (const copy of quarantinedCopies(file.path)) {
        const copyPath = path.join(path.dirname(file.path), copy);
        const plain = readPlaintextStore(copyPath);
        if (plain) {
          if (!opts.plaintext) continue;
          replaceFile(file.path, current, plain.data, "replaced", now);
          // Its content is in place, encrypted (a failed write threw above and kept it): no plain copy stays behind
          fs.rmSync(copyPath);
          return { name, action: "recovered", source: copy };
        }
        if (!old) continue;
        const read = tryRead(old, copyPath);
        if (!read.ok) continue;
        replaceFile(file.path, current, read.data, "replaced", now);
        fs.renameSync(copyPath, `${file.path}.recovered-${now}`);
        return { name, action: "recovered", source: copy };
      }
      if (!fs.existsSync(file.path)) return { name, action: "missing" };
      const plain = readPlaintextStore(file.path);
      if (plain) {
        if (!opts.plaintext) return { name, action: "plaintext" };
        // Replaced in one atomic step: the plain file is gone the moment the encrypted one is in place
        current.writeJsonFile(file.path, plain.data);
        return { name, action: "encrypted" };
      }
      if (tryRead(current, file.path).ok) return { name, action: "already-current" };
      const read = old ? tryRead(old, file.path) : null;
      if (!read?.ok) return { name, action: "not-decryptable" };
      current.writeJsonFile(file.path, read.data);
      return { name, action: "rekeyed" };
    })
  );
}
