import type { McpInputSchema } from "./mcp-schema.ts";

/**
 * The contract between the MCP protocol engine (`FengSuiMcpServer`) and the domain tool modules
 * plugged into it. Providers never see JSON-RPC: they declare tools and resources, execute calls
 * and throw `McpToolError` for tool-level failures; the server enforces the confirmation gate,
 * the input schemas and the mutation switch, and maps errors to tool results.
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

/** Domain tool module plugged into the MCP server (`CoreMcpTools`, `SmsMcpTools`). */
export interface McpToolProvider {
  getToolDefinitions(): ReadonlyArray<McpToolDefinition>;
  handles(toolName: string): boolean;
  isMutating(toolName: string): boolean;
  execute(toolName: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  listResources?(): ReadonlyArray<McpResourceDescriptor>;
  readResource?(uri: string): unknown;
  instructions?(): string;
}
