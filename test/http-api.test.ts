import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import { HttpPayloadError } from "../src/control-error.ts";
import { createFengSuiCore, stopFengSuiCore } from "../src/core.ts";
import { FengSuiApi, type ApiExchange } from "../src/http-api.ts";
import { loadConfig } from "../src/config.ts";
import { FengSuiMcpServer, type JsonRpcSuccessResponse } from "../src/mcp-server.ts";
import { SseEventBus } from "../src/sse-bus.ts";
import { EncryptedStateStore } from "../src/state-store.ts";
import { TimeSeriesRingBuffer } from "../src/timeseries.ts";
import { consoleSettingsFor } from "./helpers/console-settings.ts";
import { mockConnection } from "./helpers/connection.ts";
import { createStrictCpe } from "./helpers/strict-cpe.ts";
import { removeTempDir, tempDir } from "./helpers/temp-dir.ts";
import path from "node:path";

/**
 * The REST API behind the sign-in answers without an HTTP server (src/http-api.ts): the daemon's
 * server calls it once a request is signed in, and the live demo calls it from the page.
 */

function exchange(method: string, route: string, body: Record<string, unknown> | HttpPayloadError = {}): ApiExchange & { answers: Array<{ status: number; body: unknown }> } {
  const url = new URL(route, "http://api.invalid");
  const answers: Array<{ status: number; body: unknown }> = [];
  return {
    method,
    pathname: url.pathname,
    searchParams: url.searchParams,
    readJsonBody: async () => {
      if (body instanceof HttpPayloadError) throw body;
      return body;
    },
    sendJson: (status, payload) => void answers.push({ status, body: payload }),
    answers,
  };
}

describe("the REST API without an HTTP server", () => {
  it("answers a read, refuses a write without confirm, maps a bad body and ends no session it was never given", async () => {
    const dir = tempDir("fengsui-api-");
    const envPath = path.join(dir, ".env");
    fs.writeFileSync(envPath, ["CPE_URL=http://192.168.8.1", "CPE_PASSWORD=unused", "API_TOKEN=api_test_token", `STATE_FILE=${path.join(dir, "state.json")}`, "DATA_ENCRYPTION_KEY=api-test-key"].join("\n"));
    const config = loadConfig({ envPath, ignoreProcessEnv: true });
    const router = createStrictCpe();
    const core = createFengSuiCore({ connection: mockConnection(router), stateStore: new EncryptedStateStore({ filePath: config.stateFile, encryptionKey: config.dataEncryptionKey }), timeseries: new TimeSeriesRingBuffer() });
    const sseBus = new SseEventBus();
    const api = new FengSuiApi({ core, settings: consoleSettingsFor(config), sseBus });
    const caller = { redact: false, clientIp: "192.168.8.20", bucketKey: "192.168.8.20", sessionId: null, checkPassword: async () => ({ ok: false as const, statusCode: 401 as const }), actor: { channel: "web" as const } };
    try {
      const read = exchange("GET", "/api/telemetry");
      await api.dispatch(read, caller);
      assert.equal(read.answers[0]?.status, 200);
      assert.equal((read.answers[0]?.body as { ok: boolean }).ok, true);

      const unconfirmed = exchange("POST", "/api/control/unlock");
      await api.dispatch(unconfirmed, caller);
      assert.deepEqual([unconfirmed.answers[0]?.status, (unconfirmed.answers[0]?.body as { errorCode: string }).errorCode], [400, "VALIDATION_ERROR"]);
      assert.equal(router.stats.requests.length, 0, "nothing reached the router");

      const malformed = exchange("POST", "/api/control/unlock", new HttpPayloadError(400, "Malformed JSON request body"));
      await api.dispatch(malformed, caller);
      assert.deepEqual(malformed.answers[0], { status: 400, body: { ok: false, errorCode: "BAD_PAYLOAD", message: "Malformed JSON request body" } });

      // A token never reaches the console's own routes, and without SMS their routes say so
      const console = exchange("GET", "/api/console");
      await api.dispatch(console, caller);
      assert.equal(console.answers[0]?.status, 404);
      const sms = exchange("GET", "/api/sms/status");
      await api.dispatch(sms, caller);
      assert.equal((sms.answers[0]?.body as { errorCode: string }).errorCode, "SMS_DISABLED");

      api.revokeSessionsExcept(null);
      assert.equal(api.health().codename, "FengSui");
      assert.equal(api.hello(false, true).sms, null);
    } finally {
      await stopFengSuiCore(core);
      removeTempDir(dir);
    }
  });

  it("answers 409 CONNECTION_CHANGED, on REST and to an agent's tool, for a write that waited while another brand's connection took over", async () => {
    const dir = tempDir("fengsui-api-");
    const envPath = path.join(dir, ".env");
    fs.writeFileSync(envPath, ["CPE_URL=http://192.168.8.1", "CPE_PASSWORD=unused", "API_TOKEN=api_test_token", `STATE_FILE=${path.join(dir, "state.json")}`, "DATA_ENCRYPTION_KEY=api-test-key"].join("\n"));
    const config = loadConfig({ envPath, ignoreProcessEnv: true });
    const router = createStrictCpe();
    const core = createFengSuiCore({ connection: mockConnection(router), stateStore: new EncryptedStateStore({ filePath: config.stateFile, encryptionKey: config.dataEncryptionKey }), timeseries: new TimeSeriesRingBuffer() });
    const api = new FengSuiApi({ core, settings: consoleSettingsFor(config), sseBus: new SseEventBus() });
    const caller = { redact: false, clientIp: "192.168.8.20", bucketKey: "192.168.8.20", sessionId: null, checkPassword: async () => ({ ok: false as const, statusCode: 401 as const }), actor: { channel: "web" as const } };
    try {
      let inside = false;
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => (release = resolve));
      const reading = core.scheduler.read(async () => {
        inside = true;
        await held;
        return "read";
      });
      for (let i = 0; i < 200 && !inside; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
      assert.ok(inside, "a session on the Huawei router is running");
      // Behind it: the switch to another brand, then two writes asked while the Huawei connection was the one in use
      const switching = core.scheduler.reloadCredentialsAndResetBreaker(router.password, "admin", "openwrt");
      const rest = exchange("POST", "/api/control/unlock", { confirm: true });
      const dispatching = api.dispatch(rest, caller);
      const calling = new FengSuiMcpServer({ allowMutations: true, core }).handleRawJsonMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "unlock_rf_locks", arguments: { confirm: true } } }));
      await new Promise((resolve) => setTimeout(resolve, 20));
      const sent = router.stats.requests.length;
      release();
      assert.equal(await reading, "read");
      await switching;
      await dispatching;
      const tool = ((await calling) as JsonRpcSuccessResponse).result as { isError: boolean; structuredContent: { errorCode?: string; message?: string; messageZh?: string } };
      const answer = rest.answers[0]?.body as { ok: boolean; errorCode: string; message: string; messageZh: string };
      assert.deepEqual([rest.answers[0]?.status, answer.ok, answer.errorCode], [409, false, "CONNECTION_CHANGED"]);
      assert.match(answer.message, /Nothing was sent/);
      assert.match(answer.messageZh, /什么都没有发送/);
      assert.deepEqual([tool.isError, tool.structuredContent.errorCode, tool.structuredContent.message, tool.structuredContent.messageZh], [true, "CONNECTION_CHANGED", answer.message, answer.messageZh]);
      // The held session's own logout is all that followed: no login for either write, on either brand
      const after = router.stats.requests.slice(sent).map((request) => request.path);
      assert.deepEqual(after.filter((requestPath) => requestPath !== "/api/user/logout"), [], after.join(" "));
    } finally {
      await stopFengSuiCore(core);
      removeTempDir(dir);
    }
  });

  it("reaches no Node built-in itself: the demo runs it in a page", () => {
    const source = fs.readFileSync(new URL("../src/http-api.ts", import.meta.url), "utf8");
    assert.doesNotMatch(source, /from "node:/);
  });
});
