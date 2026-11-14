import type { TokenPermission } from "../console-policy.ts";
import { readOptionalBoolean } from "../control-input.ts";
import type { ControlAction, ReadSection } from "../features.ts";
import type { JsonSchemaProperty } from "../mcp-schema.ts";
import type { McpToolDefinition } from "../mcp-tool-provider.ts";

/**
 * The shape of an operation's record in the operation registry (`registry.ts` puts the records
 * together): one thing a caller can ask FengSui to do, with every way to ask for it (a REST route, an
 * MCP tool, a Telegram command). docs/dev/architecture.md 19.9.
 *
 * Zero dependencies: the daemon, the scripts and the static demo share it.
 */

export type DocLocale = "zh-CN" | "en";
/** A line of the API reference, in both languages. */
export type Text = Readonly<Record<DocLocale, string>>;
/** A request's JSON body, its query string, or an MCP tool's arguments. */
export type Fields = Readonly<Record<string, unknown>>;
/**
 * The first layer of an operation's input check: the brand-neutral shape and range, before anything
 * is queued; throws `CpeControlValidationError` (each entry answers `VALIDATION_ERROR`).
 */
export type InputReader<T = unknown> = (fields: Fields) => T;
/** The API reference's tables. */
export type ReferenceGroup = "read" | "refresh" | "control" | "access" | "sms" | "other";

export interface RestBinding {
  readonly method: "GET" | "POST";
  readonly path: string;
  /** Its table in the API reference, its line there, and a request body the reference shows (and a test sends). */
  readonly group: ReferenceGroup;
  readonly summary: Text;
  readonly example?: string;
  /** The example names something that must exist first (a message, a contact, a mode the router offers). */
  readonly needsState?: true;
  /** A signed-in console only: a token gets `403 CONSOLE_ONLY`. */
  readonly consoleOnly?: true;
  /** Served by the HTTP server itself before the API's dispatch: the liveness check (no token), the event stream, the metrics. */
  readonly served?: "open" | "events" | "metrics";
  /** A body this route takes that is larger than the server's default limit. */
  readonly maxBodyBytes?: number;
}

/** How an MCP tool reads on a router of a model nobody verified (the band lock's LTE-only form). */
export interface UnverifiedContext {
  readonly lteBands: ReadonlyArray<number> | null;
}

export interface McpBinding {
  readonly tool: string;
  readonly title: string;
  readonly description: string;
  readonly annotations: NonNullable<McpToolDefinition["annotations"]>;
  /**
   * The tool's parameters. A write tool's schema always gets a required `confirm`: added last with the
   * shared wording, unless the tool names its own here (another wording, or another place).
   */
  readonly properties: Readonly<Record<string, JsonSchemaProperty>>;
  readonly required?: ReadonlyArray<string>;
  /** The agent's form of the input, where it is not the REST one (`ownArguments`: the tool reads its arguments itself). */
  readonly input?: InputReader;
  readonly onUnverified?: (definition: McpToolDefinition, context: UnverifiedContext) => McpToolDefinition;
}

export interface OperationRecord {
  /** `write`: it changes something, on the router or in FengSui's own data. */
  readonly access: "read" | "write";
  /**
   * The router writes it runs (the scheduler's actions). The features they are filed under in the
   * capability registry are the operation's, and the write gate goes by each. A write without actions
   * changes only FengSui's own data (the contacts, a switch, the breaker).
   */
  readonly actions?: ReadonlyArray<ControlAction>;
  /** The part of the router it needs: where the router turned out not to have it, an agent is not offered the tool. */
  readonly section?: ReadSection;
  /** The token permission it takes (`null`: none, every token may). */
  readonly permission: TokenPermission | null;
  /** The first layer of the input check, shared by REST (a POST's body, a GET's query), MCP (unless `mcp.input`), Telegram and the demo. */
  readonly input?: InputReader;
  readonly rest?: RestBinding;
  readonly mcp?: McpBinding;
  /** The Telegram commands that run it (the bot's words are its own; the input check and the gate are this record's). */
  readonly telegram?: ReadonlyArray<string>;
}

export type OperationTable = Readonly<Record<string, OperationRecord>>;

/** An agent's tool that reads its own arguments, after the schema: it checks them against the router's data (the connected devices) or its own rules (an SMS budget). */
export const ownArguments: InputReader<Fields> = (fields) => fields;

/** A tool's switch named `key` (a read tool's "read the router now"), `undefined` when left out. */
export function flag<K extends string>(key: K): InputReader<{ readonly [P in K]: boolean | undefined }> {
  return (fields) => ({ [key]: readOptionalBoolean(fields, key) }) as { readonly [P in K]: boolean | undefined };
}
