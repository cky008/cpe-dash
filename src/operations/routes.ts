import { REST_OPERATIONS, type RestOperation, operationRecord, restBinding } from "./registry.ts";

/**
 * Each REST route of the operation registry as a client calls it: its method, its path, and whether it
 * changes anything (a write is sent with `confirm: true`). The console's REST client imports this
 * module and nothing else of the registry; the console's build serves it as the constant it evaluates
 * to (`scripts/operation-routes.ts`), so none of the registry's words (MCP descriptions, the API
 * reference's lines) reach the console.
 */

export interface RestRoute {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly write: boolean;
}

export const REST_ROUTES = Object.fromEntries(
  REST_OPERATIONS.map((op) => {
    const { method, path } = restBinding(op);
    return [op, { method, path, write: operationRecord(op).access === "write" }];
  })
) as unknown as Readonly<Record<RestOperation, RestRoute>>;
