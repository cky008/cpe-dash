import { AsyncLocalStorage } from "node:async_hooks";
import { AtomicFileWriter, type StorageCipher, assertKnownDataFormat } from "./encrypted-file.ts";
import { sanitizeFreeText } from "./sanitize.ts";

/**
 * Who changed what, kept encrypted in `audit.json`: every write that reaches the router queue
 * (controls, access control, SMS send / read / delete, automatic repairs), console logins and every
 * settings change. The caller is carried by `AsyncLocalStorage` from the adapter that took the
 * request (web console, a named token, MCP, Telegram, self-healing) down to the scheduler, so no
 * signature in between had to change. Entries hold masked summaries only, never SMS text.
 */

const FORMAT = 1;
export const AUDIT_MAX_ENTRIES = 500;
const FLUSH_DELAY_MS = 30_000;

export type AuditChannel = "web" | "token" | "mcp" | "telegram" | "self-heal" | "system";
export type AuditOutcome = "applied" | "refused" | "failed";

export interface AuditActor {
  channel: AuditChannel;
  /** A token's name or a masked chat; never a secret. */
  label?: string;
}

export interface AuditEntry {
  tsIso: string;
  channel: AuditChannel;
  label: string | null;
  action: string;
  outcome: AuditOutcome;
  /** Masked summary or the reason it was refused / failed. */
  detail: string | null;
}

const actors = new AsyncLocalStorage<AuditActor>();

/** Run `fn` (and everything it awaits) on behalf of `actor`. */
export function runAsActor<T>(actor: AuditActor, fn: () => T): T {
  return actors.run(actor, fn);
}

export function currentActor(): AuditActor {
  return actors.getStore() ?? { channel: "system" };
}

export class AuditLog {
  readonly filePath: string;
  #cipher: StorageCipher;
  readonly #writer: AtomicFileWriter;
  readonly #now: () => number;
  #entries: AuditEntry[] = [];
  #flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: { filePath: string; cipher: StorageCipher; now?: () => number }) {
    this.filePath = opts.filePath;
    this.#cipher = opts.cipher;
    this.#writer = new AtomicFileWriter(opts.filePath);
    this.#now = opts.now ?? Date.now;
  }

  load(): void {
    const parsed = this.#cipher.readJsonFileOrQuarantine<{ format?: unknown; entries?: unknown }>(this.filePath);
    assertKnownDataFormat(this.filePath, parsed?.format, FORMAT);
    this.#entries = Array.isArray(parsed?.entries)
      ? (parsed.entries as AuditEntry[]).filter((e) => e && typeof e.action === "string").slice(-AUDIT_MAX_ENTRIES)
      : [];
  }

  /** Append an entry for the current actor (or `actor`). */
  record(input: { action: string; outcome: AuditOutcome; detail?: string | null; actor?: AuditActor }): AuditEntry {
    const actor = input.actor ?? currentActor();
    const entry: AuditEntry = {
      tsIso: new Date(this.#now()).toISOString(),
      channel: actor.channel,
      label: actor.label ? sanitizeFreeText(actor.label).slice(0, 64) : null,
      action: input.action.slice(0, 64),
      outcome: input.outcome,
      detail: input.detail ? sanitizeFreeText(input.detail).slice(0, 240) : null,
    };
    this.#entries.push(entry);
    if (this.#entries.length > AUDIT_MAX_ENTRIES) this.#entries.splice(0, this.#entries.length - AUDIT_MAX_ENTRIES);
    if (!this.#flushTimer) {
      this.#flushTimer = setTimeout(() => {
        this.#flushTimer = null;
        void this.flush().catch(() => undefined);
      }, FLUSH_DELAY_MS);
      this.#flushTimer.unref?.();
    }
    return entry;
  }

  /** Newest first. */
  list(limit = 200): AuditEntry[] {
    return this.#entries.slice(-Math.max(1, Math.min(limit, AUDIT_MAX_ENTRIES))).reverse();
  }

  rotateEncryptionKey(cipher: StorageCipher): void {
    this.#cipher = cipher;
  }

  async flush(): Promise<void> {
    if (this.#flushTimer) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = null;
    }
    await this.#writer.write(() => this.#cipher.serializeJson({ format: FORMAT, entries: this.#entries }));
  }
}
