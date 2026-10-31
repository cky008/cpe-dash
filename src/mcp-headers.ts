/**
 * MCP 2026-07-28 Streamable HTTP routing headers, shared by the server and the stdio bridge.
 * `Mcp-Method` mirrors the JSON-RPC `method`; `Mcp-Name` mirrors `params.name` / `params.uri` for
 * the methods below. Values that are not plain printable ASCII travel in the Base64 sentinel form
 * `=?base64?<value>?=` (also used for ASCII values that would otherwise look like a sentinel).
 */

export const MCP_META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion";
export const MCP_META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";
export const MCP_NAME_METHODS: ReadonlySet<string> = new Set(["tools/call", "resources/read", "prompts/get"]);

const SENTINEL_PREFIX = "=?base64?";
const SENTINEL_SUFFIX = "?=";

export function encodeMcpHeaderValue(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value) && !value.startsWith(SENTINEL_PREFIX)) return value;
  return `${SENTINEL_PREFIX}${Buffer.from(value, "utf8").toString("base64")}${SENTINEL_SUFFIX}`;
}

/** Decode a sentinel-encoded value; returns `null` when the sentinel is malformed. */
export function decodeMcpHeaderValue(value: string): string | null {
  if (!value.startsWith(SENTINEL_PREFIX)) return value;
  if (!value.endsWith(SENTINEL_SUFFIX)) return null;
  const encoded = value.slice(SENTINEL_PREFIX.length, -SENTINEL_SUFFIX.length);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return null;
  return Buffer.from(encoded, "base64").toString("utf8");
}

/** The body value `Mcp-Name` must mirror (`params.name` or `params.uri`), if the method has one. */
export function mcpNameOf(method: string, params: Readonly<Record<string, unknown>>): string | null {
  if (!MCP_NAME_METHODS.has(method)) return null;
  const value = method === "resources/read" ? params["uri"] : params["name"];
  return typeof value === "string" ? value : null;
}
