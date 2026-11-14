import type { TokenPermission } from "./console-policy.ts";
import type { McpInputSchema } from "./mcp-schema.ts";

/**
 * The contract between the MCP protocol engine (`FengSuiMcpServer`) and the domain tool modules
 * plugged into it. Providers never see JSON-RPC: they offer tools and resources, execute calls and
 * throw `McpToolError` for tool-level failures; the server enforces the token permission, the
 * mutation switch, the write gate, the confirmation and the input schemas (from the operation
 * registry), and maps errors to tool results.
 */

export interface McpToolDefinition {
  name: string;
  title: string;
  description: string;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
  };
  inputSchema: McpInputSchema;
}

/** Tool-level failure surfaced to agents as `{ ok: false, errorCode, message, ...details }` (`isError: true`). */
export class McpToolError extends Error {
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "McpToolError";
    this.code = code;
    this.details = details;
  }
}

export interface McpResourceDescriptor {
  uri: string;
  name: string;
  mimeType: "application/json";
}

/**
 * Domain tool module plugged into the MCP server (`CoreMcpTools`, `SmsMcpTools`…). What a tool is (its
 * definition, whether it changes anything, the token permission, the router writes the gate checks,
 * the read section it needs) is its operation's record in the operation registry, which the server
 * reads; a provider says which of its tools it offers now and runs them.
 */
export interface McpToolProvider {
  /** The tools it offers now: its operations' definitions, some only while a switch of its own is on. */
  getToolDefinitions(): ReadonlyArray<McpToolDefinition>;
  handles(toolName: string): boolean;
  /** Whether this router has what the tool needs beyond its read section (e.g. a setting FengSui implements here); default `true`. */
  isAvailable?(toolName: string): boolean;
  execute(toolName: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  listResources?(): ReadonlyArray<McpResourceDescriptor>;
  readResource?(uri: string): unknown;
  /** The token permission a resource needs (`null`: none); default none. */
  resourcePermission?(uri: string): TokenPermission | null;
  instructions?(): string;
}
