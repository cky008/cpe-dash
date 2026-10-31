/**
 * vCard (.vcf) contact parsing, shared by the daemon's contact book and the browser demo. Zero
 * runtime dependencies (no Node built-in), so the web bundle can import it.
 */

export interface ParsedVcardEntry {
  name: string;
  phones: string[];
  org?: string;
}

/** Same cap as the contact book (`MAX_CONTACTS`). */
export const MAX_VCARD_ENTRIES = 5000;

const encoder = new TextEncoder();

function decodeQuotedPrintableUtf8(input: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < input.length; i++) {
    const hex = input.slice(i + 1, i + 3);
    if (input[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(Number.parseInt(hex, 16));
      i += 2;
    } else {
      bytes.push(...encoder.encode(input[i] ?? ""));
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

function unescapeVcardValue(val: string): string {
  return val
    .replace(/\\[nN]/g, " ")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\")
    .trim();
}

/**
 * Parse an iPhone / macOS / Android `.vcf` export (vCard 2.1 / 3.0 / 4.0): line folding,
 * quoted-printable UTF-8, `FN` / `N` (CJK family-first ordering) / `ORG` names and `TEL` numbers.
 * Cards without a name or a phone are skipped; at most `maxEntries` cards are returned.
 */
export function parseVcardContacts(vcfText: string, maxEntries = MAX_VCARD_ENTRIES): ParsedVcardEntry[] {
  const lines: string[] = [];
  for (const line of vcfText.replace(/\r\n?/g, "\n").split("\n")) {
    const last = lines.length - 1;
    if ((line.startsWith(" ") || line.startsWith("\t")) && last >= 0) {
      lines[last] = `${lines[last] ?? ""}${line.slice(1)}`;
    } else if (last >= 0 && /ENCODING=QUOTED-PRINTABLE/i.test(lines[last]!) && lines[last]!.endsWith("=")) {
      lines[last] = lines[last]!.slice(0, -1) + line;
    } else {
      lines.push(line);
    }
  }

  const results: ParsedVcardEntry[] = [];
  let inCard = false;
  let fn = "";
  let structuredName = "";
  let org = "";
  let phones: string[] = [];

  for (const rawLine of lines) {
    if (results.length >= maxEntries) break;
    const line = rawLine.trim();
    if (/^BEGIN:VCARD$/i.test(line)) {
      inCard = true;
      fn = "";
      structuredName = "";
      org = "";
      phones = [];
      continue;
    }
    if (/^END:VCARD$/i.test(line)) {
      const name = (fn || structuredName || org).trim();
      const uniquePhones = [...new Set(phones)];
      if (inCard && name && uniquePhones.length > 0) {
        results.push(org ? { name, phones: uniquePhones, org } : { name, phones: uniquePhones });
      }
      inCard = false;
      continue;
    }
    const colonIdx = line.indexOf(":");
    if (!inCard || colonIdx <= 0) continue;

    const propParts = line.slice(0, colonIdx).replace(/^[A-Za-z0-9_-]+\./, "").split(";");
    const propName = (propParts[0] ?? "").toUpperCase();
    const rawVal = propParts.some((p) => /QUOTED-PRINTABLE/i.test(p))
      ? decodeQuotedPrintableUtf8(line.slice(colonIdx + 1))
      : line.slice(colonIdx + 1);

    if (propName === "FN") {
      fn = unescapeVcardValue(rawVal);
    } else if (propName === "N") {
      const [family = "", given = "", middle = "", prefix = "", suffix = ""] = rawVal.split(";").map(unescapeVcardValue);
      structuredName = /[一-龥]/.test(family + given)
        ? `${family}${middle}${given}`.trim()
        : [prefix, given, middle, family, suffix].filter(Boolean).join(" ").trim();
    } else if (propName === "ORG") {
      org = unescapeVcardValue(rawVal.split(";")[0] ?? "");
    } else if (propName === "TEL") {
      const tel = rawVal.replace(/^tel:/i, "").replace(/[^\d+]/g, "");
      if (tel.length >= 3) phones.push(tel);
    }
  }
  return results;
}
