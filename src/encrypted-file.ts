import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const ENVELOPE_MAGIC = "cpe-dash-aes-256-gcm-v1";
const AAD_BYTES = Buffer.from(ENVELOPE_MAGIC, "utf8");
const MASTER_KDF_SALT = Buffer.from("cpe-dash-kdf-master-v1", "utf8");
const HKDF_INFO = Buffer.from("cpe-dash-at-rest-subkey-v1", "utf8");

export interface EncryptedFileEnvelope {
  __encrypted: typeof ENVELOPE_MAGIC;
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

const masterKeyCache = new Map<string, Buffer>();

function deriveMasterKey(secret: string): Buffer {
  const cached = masterKeyCache.get(secret);
  if (cached) return cached;
  const derived = crypto.scryptSync(Buffer.from(secret, "utf8"), MASTER_KDF_SALT, 32, {
    N: 16384,
    r: 8,
    p: 1,
  });
  masterKeyCache.set(secret, derived);
  return derived;
}

function isEncryptedEnvelope(val: unknown): val is EncryptedFileEnvelope {
  if (!val || typeof val !== "object") return false;
  const obj = val as Record<string, unknown>;
  return (
    obj.__encrypted === ENVELOPE_MAGIC &&
    typeof obj.salt === "string" &&
    typeof obj.iv === "string" &&
    typeof obj.tag === "string" &&
    typeof obj.ciphertext === "string"
  );
}

/**
 * Authenticated AES-256-GCM at-rest JSON storage cipher for `cpe-dash`.
 *
 * - Stretches the master secret via `scrypt` (`N=16384, r=8, p=1`).
 * - Derives a unique per-write 256-bit subkey via `HKDF-SHA256` with a fresh 16-byte salt.
 * - Encrypts with `aes-256-gcm` using a fresh 12-byte random IV and envelope magic AAD.
 * - Atomically writes `0o600` files via temp-file rename.
 */
/**
 * A data file written by a newer FengSui. Loading it would keep only what this version knows and the
 * next save would overwrite the rest, so the daemon refuses to start instead (e.g. after a downgrade).
 */
export class DataFormatTooNewError extends Error {
  readonly filePath: string;
  readonly found: number;
  readonly supported: number;

  constructor(filePath: string, found: number, supported: number) {
    super(
      `${path.basename(filePath)} was written by a newer FengSui (data format ${found}; this version reads up to ${supported}). ` +
        "Refusing to start rather than overwrite it: run the newer version again, or restore a backup made with this one."
    );
    this.name = "DataFormatTooNewError";
    this.filePath = filePath;
    this.found = found;
    this.supported = supported;
  }
}

/** Throw `DataFormatTooNewError` when a stored format number is above the one this version reads. */
export function assertKnownDataFormat(filePath: string, found: unknown, supported: number): void {
  if (typeof found === "number" && Number.isInteger(found) && found > supported) {
    throw new DataFormatTooNewError(filePath, found, supported);
  }
}

export class StorageCipher {
  readonly enabled: boolean;
  readonly #masterKey: Buffer | null;

  constructor(secret: string, allowDisabled = false) {
    if (!secret || !secret.trim()) {
      if (allowDisabled) {
        this.enabled = false;
        this.#masterKey = null;
        return;
      }
      throw new Error("StorageCipher requires a non-empty secret key");
    }
    this.enabled = true;
    this.#masterKey = deriveMasterKey(secret);
  }

  static fromSecret(secret?: string): StorageCipher {
    return new StorageCipher(secret ?? "", true);
  }

  encryptObject(data: unknown): EncryptedFileEnvelope {
    if (!this.enabled || !this.#masterKey) {
      throw new Error("StorageCipher is not enabled");
    }
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const subKey = Buffer.from(crypto.hkdfSync("sha256", this.#masterKey, salt, HKDF_INFO, 32));

    const plainBytes = Buffer.from(JSON.stringify(data), "utf8");
    const cipher = crypto.createCipheriv("aes-256-gcm", subKey, iv);
    cipher.setAAD(AAD_BYTES);
    const ciphertext = Buffer.concat([cipher.update(plainBytes), cipher.final()]);
    const tag = cipher.getAuthTag();

    return {
      __encrypted: ENVELOPE_MAGIC,
      salt: salt.toString("hex"),
      iv: iv.toString("hex"),
      tag: tag.toString("hex"),
      ciphertext: ciphertext.toString("base64"),
    };
  }

  decryptEnvelope<T = unknown>(envelope: EncryptedFileEnvelope): T {
    if (!this.enabled || !this.#masterKey) {
      throw new Error(
        "Cannot decrypt encrypted storage file without DATA_ENCRYPTION_KEY / CPE_PASSWORD"
      );
    }
    const salt = Buffer.from(envelope.salt, "hex");
    const iv = Buffer.from(envelope.iv, "hex");
    const tag = Buffer.from(envelope.tag, "hex");
    const ciphertext = Buffer.from(envelope.ciphertext, "base64");

    const subKey = Buffer.from(crypto.hkdfSync("sha256", this.#masterKey, salt, HKDF_INFO, 32));
    const decipher = crypto.createDecipheriv("aes-256-gcm", subKey, iv);
    decipher.setAAD(AAD_BYTES);
    decipher.setAuthTag(tag);
    const plainBytes = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plainBytes.toString("utf8")) as T;
  }

  readJsonFile<T = unknown>(filePath: string): T | null {
    if (!fs.existsSync(filePath)) return null;
    return this.#parseDocument<T>(fs.readFileSync(filePath, "utf8"));
  }

  #parseDocument<T>(rawText: string): T {
    const parsed: unknown = JSON.parse(rawText);
    if (isEncryptedEnvelope(parsed)) {
      return this.decryptEnvelope<T>(parsed);
    }
    return parsed as T;
  }

  /**
   * Read a JSON document; if its content cannot be decrypted or parsed (e.g. `DATA_ENCRYPTION_KEY`
   * rotated), rename it to `<file>.unreadable-<ts>` instead of crash-looping and return `null`.
   * A failure to read the file at all (`EACCES` after a container UID change, `EISDIR`, `EIO`) says
   * nothing about its content and is thrown: moving it aside would silently start the store empty.
   */
  readJsonFileOrQuarantine<T = unknown>(filePath: string): T | null {
    if (!fs.existsSync(filePath)) return null;
    const rawText = fs.readFileSync(filePath, "utf8");
    try {
      return this.#parseDocument<T>(rawText);
    } catch {
      try {
        fs.renameSync(filePath, `${filePath}.unreadable-${Date.now()}`);
      } catch {
        // Ignore rename failure on read-only/missing file
      }
      return null;
    }
  }

  /** Serialize `data` as the on-disk document (encrypted envelope when the cipher is enabled). */
  serializeJson(data: unknown): string {
    return this.enabled ? JSON.stringify(this.encryptObject(data), null, 2) : JSON.stringify(data, null, 2);
  }

  writeJsonFile(filePath: string, data: unknown): void {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const suffix = crypto.randomBytes(4).toString("hex");
    const tmpFile = `${filePath}.${process.pid}.${suffix}.tmp`;
    fs.writeFileSync(tmpFile, this.serializeJson(data), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmpFile, filePath);
  }
}

/**
 * Files `readJsonFileOrQuarantine` moved aside (`<file>.unreadable-<ms>`) at or after `sinceMs`, as
 * file names. Lets the daemon report a quarantine instead of silently starting a store empty.
 */
export function quarantinedSince(filePath: string, sinceMs: number): string[] {
  const prefix = `${path.basename(filePath)}.unreadable-`;
  let names: string[];
  try {
    names = fs.readdirSync(path.dirname(filePath));
  } catch {
    return [];
  }
  return names.filter((name) => name.startsWith(prefix) && Number(name.slice(prefix.length)) >= sinceMs).sort();
}

const writeFailureListeners = new Set<(filePath: string, err: unknown) => void>();

/**
 * Hear about saves that failed (a full or read-only data volume, a UID change). The stores keep the
 * change in memory and most callers save in the background and ignore the rejection, so this is
 * where a failure gets said. Returns the function that stops listening.
 */
export function onStorageWriteFailure(listener: (filePath: string, err: unknown) => void): () => void {
  writeFailureListeners.add(listener);
  return () => {
    writeFailureListeners.delete(listener);
  };
}

/**
 * Crash-safe async writer for one file (`0600` temp file + `fsync` + atomic `rename`).
 * Writes are chained so concurrent calls land in call order; `serialize` runs when the write
 * actually starts, so a queued write always uses the cipher that is current at that moment.
 */
export class AtomicFileWriter {
  readonly filePath: string;
  #chain: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  write(serialize: () => string): Promise<void> {
    const doWrite = async (): Promise<void> => {
      try {
        await this.#writeOnce(serialize);
      } catch (err) {
        for (const listener of writeFailureListeners) {
          try {
            listener(this.filePath, err);
          } catch {
            // A listener never changes the outcome of the save
          }
        }
        throw err;
      }
    };
    const next = this.#chain.then(doWrite, doWrite);
    this.#chain = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  async #writeOnce(serialize: () => string): Promise<void> {
    const serialized = serialize();
    await fsp.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const tmpFile = `${this.filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    try {
      const handle = await fsp.open(tmpFile, "w", 0o600);
      try {
        await handle.writeFile(serialized, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fsp.rename(tmpFile, this.filePath);
    } catch (err) {
      await fsp.rm(tmpFile, { force: true }).catch(() => undefined);
      throw err;
    }
  }
}

export interface FileLockHandle {
  readonly path: string;
  release(): void;
}

export type FileLockResult = { ok: true; lock: FileLockHandle } | { ok: false; heldByPid: number | null };

function errnoCode(err: unknown): string | undefined {
  return err && typeof err === "object" && "code" in err && typeof err.code === "string" ? err.code : undefined;
}

function readLockPid(lockPath: string): number | null {
  try {
    const pid = Number(fs.readFileSync(lockPath, "utf8").trim());
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return errnoCode(err) === "EPERM";
  }
}

/**
 * Advisory single-owner lock (`<file>.lock` holding the owner PID, mode 0600) so two FengSui
 * processes never write the same encrypted store. A lock whose PID is dead, unreadable or equal
 * to our own (a restarted container reusing its PID) is stale and taken over.
 */
export function tryAcquireFileLock(lockPath: string): FileLockResult {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockPath, "wx", 0o600);
      try {
        fs.writeSync(fd, `${process.pid}\n`);
      } finally {
        fs.closeSync(fd);
      }
      let released = false;
      return {
        ok: true,
        lock: {
          path: lockPath,
          release: () => {
            if (released) return;
            released = true;
            if (readLockPid(lockPath) === process.pid) fs.rmSync(lockPath, { force: true });
          },
        },
      };
    } catch (err) {
      if (errnoCode(err) !== "EEXIST") throw err;
      const pid = readLockPid(lockPath);
      if (pid !== null && pid !== process.pid && isProcessAlive(pid)) return { ok: false, heldByPid: pid };
      fs.rmSync(lockPath, { force: true });
    }
  }
  return { ok: false, heldByPid: readLockPid(lockPath) };
}
