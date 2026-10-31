import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import type { ApiErrorCode, SseEventPayloads } from "../src/api-contract.ts";
import type { SseEventName } from "../src/sse-bus.ts";
import { FENGSUI_VERSION } from "../src/version.ts";

/** Compile-time equality: `true` only when A and B are the same type. */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

// The SSE payload map must name exactly the events the bus can emit (checked by `npm run typecheck`)
const sseEventsMatch: Equal<keyof SseEventPayloads, SseEventName> = true;

describe("REST / SSE contract module", () => {
  it("names every SSE event the bus emits", () => {
    assert.equal(sseEventsMatch, true);
  });

  it("documents every error code of the contract", () => {
    const doc = fs.readFileSync("docs/PHASE2_BACKEND_CONTRACT.md", "utf8");
    const documented = new Set([...doc.matchAll(/\| "([A-Z_]+)";?\s+\/\/ \d{3}/g)].map((m) => m[1]));
    const codes: Record<ApiErrorCode, true> = {
      MISDIRECTED_HOST: true,
      BAD_URL: true,
      METHOD_NOT_ALLOWED: true,
      CSRF_REJECTED: true,
      UNAUTHORIZED: true,
      RATE_LIMITED: true,
      NOT_FOUND: true,
      SMS_DISABLED: true,
      LOCALE_NOT_FOUND: true,
      INTERNAL_ERROR: true,
      BAD_PAYLOAD: true,
      VALIDATION_ERROR: true,
      BROWSER_SESSION_YIELDED: true,
      PEER_DAEMON_ACTIVE: true,
      QUEUE_FULL: true,
      CIRCUIT_BREAKER_OPEN: true,
      CPE_UPSTREAM_ERROR: true,
      SMS_SEND_FAILED: true,
      SSE_LIMIT_REACHED: true,
      MCP_DISABLED: true,
      FORBIDDEN_ORIGIN: true,
      UNSUPPORTED_MEDIA_TYPE: true,
      STATIC_ROOT_NOT_FOUND: true,
      ASSET_NOT_FOUND: true,
      BAD_PATH: true,
      PATH_TRAVERSAL_BLOCKED: true,
      SYMLINK_ESCAPE_BLOCKED: true,
    };
    assert.deepEqual([...documented].sort(), Object.keys(codes).sort());
  });

  it("reports the package version from /api/health", () => {
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8")) as { version: string };
    assert.equal(FENGSUI_VERSION, pkg.version);
  });
});
