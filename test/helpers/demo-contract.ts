import assert from "node:assert/strict";
import type { DemoSession } from "../../scripts/capture-demo-seed.ts";
import type { DemoBackend, DemoEventSource } from "../../web/src/demo/backend.ts";

/**
 * Comparing the static demo's in-page backend with the daemon it imitates (test/demo-backend*.test.ts):
 * the same request to both, then the same status, shape and messages. Placeholders only.
 */

export type Json = Record<string, unknown>;

/** Every key path (arrays collapsed to `[]`) with the JSON types seen there, nulls ignored. */
export function shapeOf(value: unknown): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const visit = (node: unknown, path: string): void => {
    if (node === null || node === undefined) {
      if (!out.has(path)) out.set(path, new Set());
      return;
    }
    if (Array.isArray(node)) {
      if (!out.has(path)) out.set(path, new Set(["array"]));
      for (const item of node) visit(item, `${path}[]`);
      return;
    }
    if (typeof node === "object") {
      out.set(path, new Set([...(out.get(path) ?? []), "object"]));
      for (const [k, v] of Object.entries(node)) visit(v, `${path}.${k}`);
      return;
    }
    out.set(path, new Set([...(out.get(path) ?? []), typeof node]));
  };
  visit(value, "$");
  return out;
}

export function assertSameShape(label: string, daemon: unknown, demo: unknown): void {
  const a = shapeOf(daemon);
  const b = shapeOf(demo);
  assert.deepEqual([...b.keys()].filter((k) => !a.has(k)), [], `${label}: fields only the demo returns`);
  assert.deepEqual([...a.keys()].filter((k) => !b.has(k)), [], `${label}: fields the demo lacks`);
  for (const [path, types] of a) {
    const other = b.get(path) ?? new Set();
    if (types.size === 0 || other.size === 0) continue;
    assert.deepEqual([...other].sort(), [...types].sort(), `${label}: type of ${path}`);
  }
}

export async function demoCall(backend: DemoBackend, method: string, route: string, body?: unknown): Promise<{ status: number; json: Json }> {
  const res = await backend.fetch(route, body === undefined ? { method } : { method, body: JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as Json };
}

export async function daemonCall(session: DemoSession, method: string, route: string, body?: unknown): Promise<{ status: number; json: Json }> {
  try {
    const json = method === "GET" ? await session.get<Json>(route) : await session.post<Json>(route, body ?? {});
    return { status: 200, json };
  } catch (err: unknown) {
    // openDemoSession throws "<METHOD> <route>: HTTP <status> <body>" on non-2xx
    const m = /HTTP (\d{3}) (.*)$/s.exec(err instanceof Error ? err.message : "");
    if (!m) throw err;
    return { status: Number(m[1]), json: JSON.parse(m[2] ?? "{}") as Json };
  }
}

export function listen(source: DemoEventSource): Array<{ name: string; data: Json }> {
  const events: Array<{ name: string; data: Json }> = [];
  for (const name of ["hello", "speed", "telemetry", "neighbors", "topology", "settings", "access-control", "control:applied", "alert", "sms:new", "sms:sent", "sms:updated", "sms:sync", "sms:status", "contacts:updated"]) {
    source.addEventListener(name, (event) => events.push({ name, data: JSON.parse(String(event.data)) as Json }));
  }
  return events;
}

export const settle = (ms = 30): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
