/**
 * Strip invalid ASCII control chars except `\t`, `\n`, `\r`. Dependency-free, so the web
 * dashboard shares it with the daemon (SMS segment counting must agree on both sides).
 */
export function stripInvalidControlChars(text: string): string {
  if (!text) return "";
  return text.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F]/g, "");
}
