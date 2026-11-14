import { restOperation } from "../../src/operations/registry.ts";
import { REST_ROUTES } from "../../src/operations/routes.ts";

/**
 * A request body as a client sends it: a write (an operation of the registry that changes anything)
 * carries `confirm: true`, as REST asks of every write and the console's client always adds. A body
 * that names `confirm` itself, or is no object, is sent as it is: tests of the refusal say so.
 */
export function asSent(method: string, path: string, body: unknown): unknown {
  const op = restOperation(method, path.split("?")[0] ?? path);
  if (op === null || !REST_ROUTES[op].write) return body;
  if (typeof body !== "object" || body === null || Array.isArray(body) || Object.hasOwn(body, "confirm")) return body;
  return { ...body, confirm: true };
}
