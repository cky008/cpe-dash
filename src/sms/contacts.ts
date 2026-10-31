import crypto from "node:crypto";
import { CpeControlValidationError } from "../cpe-domain.ts";
import { AtomicFileWriter, StorageCipher } from "../encrypted-file.ts";
import { buildPhoneLookupKeys, resolveRecipientPhone } from "./phone.ts";
import type { ContactRecord } from "./types.ts";
import { type ParsedVcardEntry, parseVcardContacts } from "./vcard.ts";

export { type ParsedVcardEntry, parseVcardContacts };

export interface VcardImportSummary {
  parsed: number;
  added: number;
  updated: number;
  total: number;
}

export const MAX_CONTACTS = 5000;
const MAX_NAME_LENGTH = 64;
const MAX_NOTE_LENGTH = 200;
const MAX_SEARCH_QUERY = 100;

interface PersistedContactBook {
  version: 1;
  contacts: ContactRecord[];
}

function copyContact(c: ContactRecord): ContactRecord {
  return { ...c, phones: [...c.phones] };
}

/**
 * Local contact book (manual entries + vCard imports), encrypted at rest and indexed by every
 * spelling of each number (raw, E.164, bare digits, last 9 digits) for sender resolution.
 */
export class ContactBook {
  readonly filePath: string;
  readonly defaultCountryCode: string;
  #cipher: StorageCipher;
  #writer: AtomicFileWriter;
  #contacts: ContactRecord[] = [];
  #lookup = new Map<string, ContactRecord>();

  constructor(opts: { filePath: string; cipher: StorageCipher; defaultCountryCode: string }) {
    this.filePath = opts.filePath;
    this.defaultCountryCode = opts.defaultCountryCode;
    this.#cipher = opts.cipher;
    this.#writer = new AtomicFileWriter(opts.filePath);
  }

  load(): void {
    const parsed = this.#cipher.readJsonFileOrQuarantine<Partial<PersistedContactBook>>(this.filePath);
    this.#contacts = Array.isArray(parsed?.contacts) ? parsed.contacts.slice(0, MAX_CONTACTS) : [];
    this.#rebuildIndex();
  }

  async flush(): Promise<void> {
    const payload: PersistedContactBook = { version: 1, contacts: this.#contacts };
    await this.#writer.write(() => this.#cipher.serializeJson(payload));
  }

  rotateEncryptionKey(secret: string): void {
    this.#cipher = StorageCipher.fromSecret(secret);
  }

  get size(): number {
    return this.#contacts.length;
  }

  get(id: string): ContactRecord | undefined {
    const hit = this.#contacts.find((c) => c.id === id);
    return hit ? copyContact(hit) : undefined;
  }

  search(query = "", limit = 50): ContactRecord[] {
    const q = query.trim().toLowerCase().slice(0, MAX_SEARCH_QUERY);
    const matches = q
      ? this.#contacts.filter(
          (c) =>
            c.name.toLowerCase().includes(q) ||
            Boolean(c.note?.toLowerCase().includes(q)) ||
            c.phones.some((p) => p.toLowerCase().includes(q))
        )
      : this.#contacts;
    return matches.slice(0, Math.max(1, limit)).map(copyContact);
  }

  resolvePhone(rawPhone: string): ContactRecord | null {
    for (const key of buildPhoneLookupKeys(rawPhone, this.defaultCountryCode)) {
      const hit = this.#lookup.get(key);
      if (hit) return copyContact(hit);
    }
    return null;
  }

  knowsNumber(rawPhone: string): boolean {
    return this.resolvePhone(rawPhone) !== null;
  }

  upsert(input: { phone: string; name: string; note?: string }): ContactRecord {
    const name = input.name.trim();
    if (!name) throw new CpeControlValidationError("Contact name is required");
    if (name.length > MAX_NAME_LENGTH) {
      throw new CpeControlValidationError(`Contact name must be at most ${MAX_NAME_LENGTH} characters`);
    }
    const note = input.note?.trim();
    if (note !== undefined && note.length > MAX_NOTE_LENGTH) {
      throw new CpeControlValidationError(`Contact note must be at most ${MAX_NOTE_LENGTH} characters`);
    }
    const resolved = resolveRecipientPhone(input.phone, this.defaultCountryCode);
    if (!resolved.ok) throw new CpeControlValidationError(resolved.error);

    const now = new Date().toISOString();
    const existing = this.#findInternal(resolved.phone);
    if (existing) {
      existing.name = name;
      if (note !== undefined) existing.note = note || undefined;
      if (!existing.phones.includes(resolved.phone)) existing.phones.unshift(resolved.phone);
      existing.source = "manual";
      existing.updatedAt = now;
      this.#commit();
      return copyContact(existing);
    }
    if (this.#contacts.length >= MAX_CONTACTS) {
      throw new CpeControlValidationError(`Contact book is full (${MAX_CONTACTS} entries)`);
    }
    const created: ContactRecord = {
      id: crypto.randomUUID(),
      name,
      phones: [resolved.phone],
      ...(note ? { note } : {}),
      source: "manual",
      updatedAt: now,
    };
    this.#contacts.unshift(created);
    this.#commit();
    return copyContact(created);
  }

  remove(id: string): boolean {
    const before = this.#contacts.length;
    this.#contacts = this.#contacts.filter((c) => c.id !== id);
    if (this.#contacts.length === before) return false;
    this.#commit();
    return true;
  }

  /**
   * Merge a vCard export: numbers already known extend the matching contact (manual names win),
   * unknown cards are added as `source: "vcard"`.
   */
  importVcard(vcfText: string): VcardImportSummary {
    const parsed = parseVcardContacts(vcfText, MAX_CONTACTS);
    let added = 0;
    let updated = 0;
    const now = new Date().toISOString();
    for (const entry of parsed) {
      const phones = [
        ...new Set(
          entry.phones.map((p) => {
            const r = resolveRecipientPhone(p, this.defaultCountryCode);
            return r.ok ? r.phone : p;
          })
        ),
      ];
      const matched = phones.map((p) => this.#findInternal(p)).find(Boolean) ?? null;
      if (matched) {
        if (matched.source !== "manual") matched.name = entry.name;
        for (const p of phones) if (!matched.phones.includes(p)) matched.phones.push(p);
        matched.updatedAt = now;
        updated += 1;
      } else if (this.#contacts.length < MAX_CONTACTS) {
        this.#contacts.push({
          id: crypto.randomUUID(),
          name: entry.name.slice(0, MAX_NAME_LENGTH),
          phones,
          ...(entry.org ? { note: entry.org.slice(0, MAX_NOTE_LENGTH) } : {}),
          source: "vcard",
          updatedAt: now,
        });
        added += 1;
      }
      this.#rebuildIndex();
    }
    this.#commit();
    return { parsed: parsed.length, added, updated, total: this.#contacts.length };
  }

  #findInternal(rawPhone: string): ContactRecord | null {
    for (const key of buildPhoneLookupKeys(rawPhone, this.defaultCountryCode)) {
      const hit = this.#lookup.get(key);
      if (hit) return hit;
    }
    return null;
  }

  #rebuildIndex(): void {
    this.#lookup.clear();
    // Manual contacts are indexed last so they win over imported duplicates of the same number
    const ordered = [...this.#contacts].sort((a, b) => (a.source === b.source ? 0 : a.source === "manual" ? 1 : -1));
    for (const c of ordered) {
      for (const p of c.phones) {
        for (const key of buildPhoneLookupKeys(p, this.defaultCountryCode)) this.#lookup.set(key, c);
      }
    }
  }

  #commit(): void {
    this.#rebuildIndex();
    void this.flush().catch(() => undefined);
  }
}
