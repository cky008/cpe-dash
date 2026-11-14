import type { TokenPermission } from "./console-policy.ts";
import type { ControlAction, WriteFeature } from "./features.ts";
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
  /**
   * The tool writes to the router, so on a router of an unverified model it goes by the write gate
   * (hidden and refused where the gate refuses it); default `isMutating`. `upsert_contact` mutates
   * FengSui's own contact book only.
   */
  isRouterWrite?(toolName: string): boolean;
  /**
   * The token permission a tool needs (`null`: none, any token may use it); default: `control` for a
   * mutating tool, none otherwise. A token sees and calls only what its permissions allow.
   */
  requiredPermission?(toolName: string): TokenPermission | null;
  /** The token permission a resource needs (`null`: none); default none. */
  resourcePermission?(uri: string): TokenPermission | null;
  /** Whether this router provides what the tool reads (an unverified model may lack a section); default `true`. */
  isAvailable?(toolName: string): boolean;
  /**
   * The write features a router-write tool needs: on a model nobody verified the tool shows only
   * while every one is open there (implemented for the router and not turned off, or verified on
   * that model). A router write that names neither a feature nor an action stays hidden on such a model.
   */
  routerWriteFeatures?(toolName: string): ReadonlyArray<WriteFeature>;
  /**
   * The scheduler actions a router-write tool runs, where the gate decides by the action and not by
   * its feature alone (taking locks off is open wherever either lock is); default none.
   */
  routerWriteActions?(toolName: string): ReadonlyArray<ControlAction>;
  /** The tool as it applies to a model nobody verified (e.g. the band lock's LTE-only form); default unchanged. */
  adaptForGenericWrite?(tool: McpToolDefinition, context: { lteBands: ReadonlyArray<number> | null }): McpToolDefinition;
  execute(toolName: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  listResources?(): ReadonlyArray<McpResourceDescriptor>;
  readResource?(uri: string): unknown;
  instructions?(): string;
}
