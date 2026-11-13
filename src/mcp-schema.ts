/**
 * The JSON Schema subset FengSui's MCP tools declare, and a validator that enforces it at run time.
 * Clients only use `inputSchema` as a hint, so without enforcement a misspelt key (silently ignored)
 * or a wrongly typed value could turn into a partial router change.
 */

export interface JsonSchemaProperty {
  type?: "string" | "number" | "integer" | "boolean" | "array" | "object";
  enum?: ReadonlyArray<string | number | boolean>;
  oneOf?: ReadonlyArray<JsonSchemaProperty>;
  items?: JsonSchemaProperty;
  minimum?: number;
  maximum?: number;
  maxItems?: number;
  maxLength?: number;
  description?: string;
  /** An object's own keys (`type: "object"`), the ones it must have, and whether others are refused. */
  properties?: Readonly<Record<string, JsonSchemaProperty>>;
  required?: ReadonlyArray<string>;
  additionalProperties?: boolean;
}

export interface McpInputSchema {
  type: "object";
  properties: Readonly<Record<string, JsonSchemaProperty>>;
  required?: ReadonlyArray<string>;
  additionalProperties?: boolean;
}

function jsonType(value: unknown): string {
  return Array.isArray(value) ? "array" : typeof value;
}

function checkValue(schema: JsonSchemaProperty, value: unknown, at: string): string | null {
  if (schema.oneOf) {
    const failures = schema.oneOf.map((option) => checkValue(option, value, at));
    if (failures.every((failure) => failure !== null)) {
      // Report the branch that matches the value's JSON type; it explains the failure best
      const kind = jsonType(value);
      const index = schema.oneOf.findIndex((o) => o.type === kind || (kind === "number" && o.type === "integer"));
      return failures[index >= 0 ? index : 0] ?? `${at} has an invalid value`;
    }
  }
  switch (schema.type) {
    case "string":
      if (typeof value !== "string") return `${at} must be a string`;
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        return `${at} exceeds ${schema.maxLength} characters`;
      }
      break;
    case "boolean":
      if (typeof value !== "boolean") return `${at} must be a boolean`;
      break;
    case "number":
    case "integer":
      if (typeof value !== "number" || !Number.isFinite(value)) return `${at} must be a finite number`;
      if (schema.type === "integer" && !Number.isInteger(value)) return `${at} must be an integer`;
      if (schema.minimum !== undefined && value < schema.minimum) return `${at} must be >= ${schema.minimum}`;
      if (schema.maximum !== undefined && value > schema.maximum) return `${at} must be <= ${schema.maximum}`;
      break;
    case "array": {
      if (!Array.isArray(value)) return `${at} must be an array`;
      if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        return `${at} accepts at most ${schema.maxItems} items`;
      }
      if (schema.items) {
        for (const [index, item] of value.entries()) {
          const failure = checkValue(schema.items, item, `${at}[${index}]`);
          if (failure) return failure;
        }
      }
      break;
    }
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return `${at} must be an object`;
      const fields = value as Record<string, unknown>;
      for (const key of schema.required ?? []) if (fields[key] === undefined) return `${at}.${key} is required`;
      for (const [key, field] of Object.entries(fields)) {
        const property = schema.properties && Object.hasOwn(schema.properties, key) ? schema.properties[key] : undefined;
        if (property === undefined) {
          if (schema.additionalProperties === false) return `${at}.${key} is not a known field`;
          continue;
        }
        const failure = checkValue(property, field, `${at}.${key}`);
        if (failure) return failure;
      }
      break;
    }
    default:
      break;
  }
  if (schema.enum && !schema.enum.some((allowed) => allowed === value)) {
    return `${at} must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(", ")}`;
  }
  return null;
}

/** Return the first violation of `schema` by `args` (unknown keys, missing keys, types), or `null`. */
export function validateToolArguments(schema: McpInputSchema, args: Readonly<Record<string, unknown>>): string | null {
  for (const key of schema.required ?? []) {
    if (args[key] === undefined) return `missing required parameter "${key}"`;
  }
  for (const [key, value] of Object.entries(args)) {
    // An own property only: names every object inherits (toString, constructor…) are no declared parameter
    const property = Object.hasOwn(schema.properties, key) ? schema.properties[key] : undefined;
    if (property === undefined) {
      if (schema.additionalProperties === false) {
        const known = Object.keys(schema.properties);
        return `unknown parameter "${key}"${known.length > 0 ? ` (expected ${known.map((k) => `"${k}"`).join(", ")})` : " (this tool takes no parameters)"}`;
      }
      continue;
    }
    if (value === undefined) continue;
    const failure = checkValue(property, value, `"${key}"`);
    if (failure) return failure;
  }
  return null;
}
