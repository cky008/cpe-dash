const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * `JSON.parse` for untrusted input: every object becomes a null-prototype dictionary and the
 * `__proto__` / `constructor` / `prototype` keys are dropped (prototype-pollution guard).
 */
export function parseJsonSafeNullProto(rawJson: string): unknown {
  return JSON.parse(rawJson, (key, value: unknown) => {
    if (FORBIDDEN_KEYS.has(key)) return undefined;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const clean = Object.create(null) as Record<string, unknown>;
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (!FORBIDDEN_KEYS.has(k)) {
          clean[k] = v;
        }
      }
      return clean;
    }
    return value;
  });
}
