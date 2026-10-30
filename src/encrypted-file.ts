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
    const rawText = fs.readFileSync(filePath, "utf8");
    const parsed: unknown = JSON.parse(rawText);
    if (isEncryptedEnvelope(parsed)) {
      return this.decryptEnvelope<T>(parsed);
    }
    return parsed as T;
  }

  /**
   * Read a JSON document; if it cannot be decrypted or parsed (e.g. `DATA_ENCRYPTION_KEY` rotated),
   * rename it to `<file>.unreadable-<ts>` instead of crash-looping and return `null`.
   */
  readJsonFileOrQuarantine<T = unknown>(filePath: string): T | null {
    try {
      return this.readJsonFile<T>(filePath);
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
    };
    const next = this.#chain.then(doWrite, doWrite);
    this.#chain = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }
}
