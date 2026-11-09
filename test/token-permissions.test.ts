import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { describe, it } from "node:test";
import { TOKEN_PERMISSIONS, describePermissions, tokenMay } from "../src/console-policy.ts";
import { ConsoleSettings } from "../src/console-settings.ts";
import { StorageCipher } from "../src/encrypted-file.ts";
import { permissionForRoute } from "../src/http-server.ts";
import { SseEventBus } from "../src/sse-bus.ts";
import { removeTempDir, tempDir } from "./helpers/temp-dir.ts";

function fakeStream(): { req: IncomingMessage; res: ServerResponse; chunks: string[] } {
  const chunks: string[] = [];
  const res = Object.assign(new EventEmitter(), {
    writableEnded: false,
    destroyed: false,
    writeHead: () => res,
    flushHeaders: () => undefined,
    write: (chunk: string) => {
      chunks.push(String(chunk));
      return true;
    },
    end: () => undefined,
  });
  return { req: new EventEmitter() as unknown as IncomingMessage, res: res as unknown as ServerResponse, chunks };
}

describe("Token permissions", () => {
  it("names the permission each REST request needs", () => {
    const cases: ReadonlyArray<[string, string, string | null]> = [
      ["GET", "/api/telemetry", null],
      ["POST", "/api/telemetry/refresh", null],
      ["POST", "/api/neighbors/scan", null],
      ["GET", "/api/sms/threads", "sms-read"],
      ["GET", "/api/sms/contacts", "sms-read"],
      ["POST", "/api/sms/preview", "sms-read"],
      ["POST", "/api/sms/sync", "sms-read"],
      ["POST", "/api/sms/send", "sms-write"],
      ["POST", "/api/sms/delete", "sms-write"],
      ["POST", "/api/sms/contacts/upsert", "sms-write"],
      ["POST", "/api/control/band-lock", "control"],
      ["POST", "/api/control/reboot", "control"],
      ["POST", "/api/session/reset-breaker", "control"],
      ["POST", "/api/control/wifi-access", "access"],
      ["POST", "/api/control/wifi-mac-filter", "access"],
      ["DELETE", "/api/control/time-rule/3", "access"],
      ["POST", "/api/console/tokens", "all"],
      ["POST", "/api/something-new", "all"],
    ];
    for (const [method, pathname, needed] of cases) assert.equal(permissionForRoute(method, pathname), needed, `${method} ${pathname}`);
    assert.equal(tokenMay(["control"], "control"), true);
    assert.equal(tokenMay(["control", "access", "sms-read"], "all"), false);
    assert.equal(tokenMay([...TOKEN_PERMISSIONS], "all"), true);
    assert.deepEqual([describePermissions([...TOKEN_PERMISSIONS]), describePermissions(["sms-read"]), describePermissions([]), describePermissions(["control", "sms-read"])], ["full", "read", "read, no SMS", "read + control + sms-read"]);
  });

  it("gives a token from before permissions what its scope allowed, and keeps an edit", async () => {
    const dir = tempDir("fengsui-token-perms-");
    try {
      const cipher = StorageCipher.fromSecret("token_perms_key");
      const filePath = path.join(dir, "settings.json");
      const older = new ConsoleSettings({ filePath, cipher, scryptCost: { N: 1024, r: 8, p: 1 } });
      older.load();
      const reader = older.createToken({ name: "Reader", permissions: ["sms-read"], lifetimeDays: null });
      const admin = older.createToken({ name: "Admin", permissions: [...TOKEN_PERMISSIONS], lifetimeDays: null });
      await older.flush();
      // Strip the permissions as a 1.7.x file would have them: scope only
      const stored = cipher.readJsonFileOrQuarantine<{ tokens: Array<Record<string, unknown>> }>(filePath);
      assert.ok(stored);
      for (const token of stored.tokens) delete token["permissions"];
      fs.writeFileSync(filePath, cipher.serializeJson(stored), { mode: 0o600 });

      const settings = new ConsoleSettings({ filePath, cipher });
      assert.equal(settings.load(), true);
      assert.deepEqual(settings.resolveBearer(reader.token)?.permissions, ["sms-read"], "read: SMS too, as before");
      assert.deepEqual(settings.resolveBearer(admin.token)?.permissions, [...TOKEN_PERMISSIONS], "full: everything, as before");

      const changed = settings.setTokenPermissions(admin.record.id, ["control"]);
      assert.deepEqual([changed?.permissions, changed?.scope], [["control"], "read"], "an older version sees a narrower token");
      assert.equal(settings.setTokenPermissions("no-such-token", ["control"]), null);
      await settings.flush();
      const again = new ConsoleSettings({ filePath, cipher });
      again.load();
      assert.deepEqual(again.resolveBearer(admin.token)?.permissions, ["control"]);
    } finally {
      removeTempDir(dir);
    }
  });

  it("keeps SMS events off the stream of a token without sms-read", () => {
    const bus = new SseEventBus({ heartbeatMs: 60_000, maxClients: 10 });
    const allowed = fakeStream();
    const denied = fakeStream();
    assert.equal(bus.subscribe({ ...allowed, clientIp: "192.168.8.10" }).accepted, true);
    assert.equal(bus.subscribe({ ...denied, clientIp: "192.168.8.11", sms: false }).accepted, true);
    bus.broadcast("sms:new", { body: "Your code is 123456" });
    bus.broadcast("contacts:updated", { count: 1 });
    bus.broadcast("alert", { code: "WAN_DOWN" });
    const events = (chunks: string[]) => chunks.join("").match(/^event: (.+)$/gm) ?? [];
    assert.deepEqual(events(allowed.chunks), ["event: hello", "event: sms:new", "event: contacts:updated", "event: alert"]);
    assert.deepEqual(events(denied.chunks), ["event: hello", "event: alert"]);
    assert.equal(denied.chunks.join("").includes("123456"), false);
  });
});
