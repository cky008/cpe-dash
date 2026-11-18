/**
 * Checks a value against a JSON Schema (draft-07) with no dependency, for the Claude Desktop extension's manifest:
 * the official MCP Bundle schema (mcpb/mcpb-manifest-v0.3.schema.json) is validated as it is, not restated by hand.
 *
 * Only the keywords that schema uses are implemented, and a schema with any other keyword is refused rather than
 * half-checked, so a newer schema dropped into mcpb/ cannot pass a manifest by accident.
 */

export type JsonSchema = boolean | { readonly [keyword: string]: unknown };

const KEYWORDS = new Set(["$ref", "$schema", "additionalProperties", "anyOf", "const", "description", "enum", "format", "items", "minLength", "pattern", "properties", "required", "type"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function matchesType(value: unknown, type: string): boolean {
  const actual = typeOf(value);
  return actual === type || (type === "number" && actual === "integer");
}

function equal(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The formats the schema names, as the official validator (zod's email and url) reads them. */
function matchesFormat(value: string, format: string): boolean {
  if (format === "email") return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  if (format === "uri") {
    try {
      return new URL(value).protocol.length > 1;
    } catch {
      return false;
    }
  }
  throw new Error(`the schema names format "${format}", which this checker does not know`);
}

/** Where `#/a/b` points in `root`. */
function resolveRef(root: JsonSchema, ref: string): JsonSchema {
  if (!ref.startsWith("#/")) throw new Error(`only local $ref are supported, got "${ref}"`);
  let node: unknown = root;
  for (const part of ref.slice(2).split("/")) {
    node = isRecord(node) ? node[part.replaceAll("~1", "/").replaceAll("~0", "~")] : undefined;
  }
  if (typeof node !== "boolean" && !isRecord(node)) throw new Error(`$ref "${ref}" points at nothing`);
  return node;
}

function check(root: JsonSchema, schema: JsonSchema, value: unknown, at: string, errors: string[]): void {
  if (schema === true) return;
  if (schema === false) {
    errors.push(`${at}: not allowed`);
    return;
  }
  for (const keyword of Object.keys(schema)) {
    if (!KEYWORDS.has(keyword)) throw new Error(`the schema uses "${keyword}" at ${at}, which this checker does not implement`);
  }
  const ref = schema["$ref"];
  if (typeof ref === "string") check(root, resolveRef(root, ref), value, at, errors);
  const type = schema["type"];
  if (typeof type === "string" && !matchesType(value, type)) {
    errors.push(`${at}: expected ${type}, got ${typeOf(value)}`);
    return;
  }
  if ("const" in schema && !equal(value, schema["const"])) errors.push(`${at}: must be ${JSON.stringify(schema["const"])}`);
  const allowed = schema["enum"];
  if (Array.isArray(allowed) && !allowed.some((option) => equal(option, value))) errors.push(`${at}: must be one of ${allowed.map((o) => JSON.stringify(o)).join(", ")}`);
  if (typeof value === "string") {
    const minLength = schema["minLength"];
    if (typeof minLength === "number" && [...value].length < minLength) errors.push(`${at}: shorter than ${minLength}`);
    const pattern = schema["pattern"];
    if (typeof pattern === "string" && !new RegExp(pattern, "u").test(value)) errors.push(`${at}: does not match ${pattern}`);
    const format = schema["format"];
    if (typeof format === "string" && !matchesFormat(value, format)) errors.push(`${at}: not a valid ${format}`);
  }
  const anyOf = schema["anyOf"];
  if (Array.isArray(anyOf)) {
    const passes = anyOf.some((option) => {
      const sub: string[] = [];
      check(root, option as JsonSchema, value, at, sub);
      return sub.length === 0;
    });
    if (!passes) errors.push(`${at}: matches none of the allowed shapes`);
  }
  if (Array.isArray(value)) {
    const items = schema["items"];
    if (typeof items === "boolean" || isRecord(items)) value.forEach((item, i) => check(root, items, item, `${at}[${i}]`, errors));
  }
  if (isRecord(value)) {
    const required = schema["required"];
    if (Array.isArray(required)) {
      for (const key of required) if (typeof key === "string" && !(key in value)) errors.push(`${at}: missing "${key}"`);
    }
    const properties = isRecord(schema["properties"]) ? schema["properties"] : {};
    const additional = schema["additionalProperties"];
    for (const [key, child] of Object.entries(value)) {
      const where = at === "$" ? key : `${at}.${key}`;
      const declared = properties[key];
      if (typeof declared === "boolean" || isRecord(declared)) check(root, declared, child, where, errors);
      else if (additional === false) errors.push(`${where}: not a field of this schema`);
      else if (typeof additional === "boolean" || isRecord(additional)) check(root, additional, child, where, errors);
    }
  }
}

/** Everything wrong with `value` under `schema` (empty when it is valid), each with where it is. */
export function validateJsonSchema(schema: JsonSchema, value: unknown): string[] {
  const errors: string[] = [];
  check(schema, schema, value, "$", errors);
  return errors;
}
