import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { createFengSuiRuntime } from "../src/cli.ts";
import { loadConfig } from "../src/config.ts";
import { AtomicFileWriter, onStorageWriteFailure } from "../src/encrypted-file.ts";
import { createStrictCpe } from "./helpers/strict-cpe.ts";
import { tempDir } from "./helpers/temp-dir.ts";

const codeOf = (err: unknown): string => String(err && typeof err === "object" && "code" in err ? err.code : "");

describe("failed background saves", () => {
  it("tell every listener which file failed and why, and still reject", async () => {
    const dir = tempDir("fengsui-storage-");
    // A file where the store's directory should be: every save fails before it writes anything
    fs.writeFileSync(path.join(dir, "blocker"), "x");
    const writer = new AtomicFileWriter(path.join(dir, "blocker", "state.json"));
    const seen: string[] = [];
    const off = onStorageWriteFailure((file, err) => seen.push(`${path.basename(file)}:${codeOf(err) !== ""}`));
    const broken = onStorageWriteFailure(() => {
      throw new Error("a listener bug");
    });
    await assert.rejects(writer.write(() => "{}"), (err: unknown) => codeOf(err) !== "", "the caller still sees the file system's error");
    assert.deepEqual(seen, ["state.json:true"]);
    off();
    broken();
    await assert.rejects(writer.write(() => "{}"));
    assert.deepEqual(seen, ["state.json:true"], "unsubscribed");

    const ok = new AtomicFileWriter(path.join(dir, "fine.json"));
    const quiet = onStorageWriteFailure(() => seen.push("unexpected"));
    await ok.write(() => "{}");
    quiet();
    assert.deepEqual(seen, ["state.json:true"], "a save that works says nothing");
  });

  it("raise one critical alert per file and cause while the data volume refuses writes", { skip: process.getuid?.() === 0 ? "root ignores directory permissions" : false }, async () => {
    const cpe = createStrictCpe();
    const dir = tempDir("fengsui-storage-rt-");
    const envPath = path.join(dir, ".env");
    fs.writeFileSync(
      envPath,
      [
        "CPE_URL=http://192.168.8.1",
        `CPE_PASSWORD=${cpe.password}`,
        "DATA_ENCRYPTION_KEY=storage_data_key",
        "API_TOKEN=storage_api_token",
        "WEB_HOST=127.0.0.1",
        "WEB_PORT=0",
        `STATE_FILE=${path.join(dir, "data", "state.json")}`,
        "POLL_INTERVAL_MS=600000",
        "NEIGHBOR_SCAN_INTERVAL_MS=600000",
        "SMS_ENABLED=false",
      ].join("\n")
    );
    const logs: string[] = [];
    const stack = createFengSuiRuntime({ config: loadConfig({ envPath, ignoreProcessEnv: true }), envPath, fetchImpl: cpe.fetchImpl, log: (line) => logs.push(line) });
    const dataDir = path.join(dir, "data");
    try {
      await stack.start();
      await stack.settings.flush();
      fs.chmodSync(dataDir, 0o500);
      stack.settings.createToken({ name: "Phone", permissions: ["sms-read"], lifetimeDays: 7 });
      await assert.rejects(stack.settings.flush(), (err: unknown) => codeOf(err) === "EACCES");
      stack.settings.createToken({ name: "Tablet", permissions: ["sms-read"], lifetimeDays: 7 });
      await assert.rejects(stack.settings.flush());
      const alerts = stack.core.scheduler.getRecentAlerts().filter((a) => a.code === "STORAGE_WRITE_FAILED");
      const forSettings = alerts.filter((a) => a.messageEn.includes("settings.json"));
      assert.equal(forSettings.length, 1, "once per file and cause, not per save");
      assert.equal(forSettings[0]?.severity, "critical");
      assert.match(forSettings[0]?.messageEn ?? "", /EACCES/);
      assert.match(forSettings[0]?.messageZh ?? "", /settings\.json/);
      assert.ok(logs.some((l) => l.includes("could not save settings.json (EACCES)")), logs.join("\n"));
      assert.equal(JSON.stringify(alerts).includes(dataDir), false, "no host path in the alert");
    } finally {
      fs.chmodSync(dataDir, 0o700);
      await stack.close();
    }
  });
});
