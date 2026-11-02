import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { describe, it } from "node:test";
import { parseCliCommand, runCli, runMaintenance } from "../src/cli.ts";
import { loadConfig } from "../src/config.ts";
import { StorageCipher } from "../src/encrypted-file.ts";
import { DataDirectoryBusyError, backupDataDir, formatDoctorReport, inspectDataFiles, rekeyDataDir, restoreDataDir, runDoctor } from "../src/maintenance.ts";

function setup(extraEnv = "") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fengsui-maint-"));
  const dataDir = path.join(dir, "data");
  fs.mkdirSync(dataDir, { mode: 0o700 });
  const envPath = path.join(dir, ".env");
  fs.writeFileSync(
    envPath,
    `CPE_URL=http://192.168.8.1\nCPE_PASSWORD=maint_pw\nAPI_TOKEN=maint_token\nDATA_ENCRYPTION_KEY=new_key\nWEB_PORT=0\nWEB_HOST=127.0.0.1\nSTATE_FILE=${path.join(dataDir, "state.json")}\n${extraEnv}`
  );
  const config = loadConfig({ envPath, ignoreProcessEnv: true });
  const files = {
    state: config.stateFile,
    sms: config.smsFile,
    contacts: config.contactsFile,
    telegram: config.telegramStateFile,
  };
  return { dir, dataDir, envPath, config, files, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

describe("cpe-dash doctor", () => {
  it("reports a healthy directory, a stopped daemon and the exposure settings without errors", async () => {
    const fx = setup("LOCK_ROLLBACK_AFTER_MIN=10\n");
    try {
      new StorageCipher("new_key").writeJsonFile(fx.files.contacts, { version: 1, contacts: [] });
      const checks = await runDoctor(fx.config, { notices: [] });
      const report = formatDoctorReport(checks);
      assert.equal(checks.some((c) => c.level === "error"), false, report);
      assert.match(report, /✓ configuration loaded \(FengSui \d+\.\d+\.\d+, router 192\.168\.8\.1\)/);
      assert.match(report, /✓ data directory .* is private and writable/);
      assert.match(report, /· daemon not running/);
      assert.match(report, /✓ contacts\.json: decrypts with the current key \(format 1\)/);
      assert.match(report, /· state\.json: not created yet/);
      assert.match(report, /self-healing: lock rollback 10 min, WAN redial off/);
    } finally {
      fx.cleanup();
    }
  });

  it("flags undecryptable, newer and quarantined stores, open permissions, broad proxies and notices", async () => {
    const fx = setup("TRUSTED_PROXIES=0.0.0.0/0\n");
    try {
      new StorageCipher("old_key").writeJsonFile(fx.files.sms, { version: 1, messages: [] });
      new StorageCipher("new_key").writeJsonFile(fx.files.state, { schemaVersion: 2 });
      fs.writeFileSync(`${fx.files.contacts}.unreadable-1700000000000`, "{}");
      fs.chmodSync(fx.dataDir, 0o755);
      const checks = await runDoctor(fx.config, { notices: ["API_TOKEN falls back to CPE_PASSWORD"] });
      const report = formatDoctorReport(checks);
      assert.match(report, /✗ sms\.json: cannot be decrypted with the current DATA_ENCRYPTION_KEY\n {4}→ put the old key in FENGSUI_OLD_DATA_KEY and run: cpe-dash rekey/);
      assert.match(report, /✗ state\.json: written by a newer FengSui \(format 2\)/);
      assert.match(report, /! contacts\.json: 1 copy\(ies\) moved aside after a key mismatch \(contacts\.json\.unreadable-1700000000000\)/);
      assert.match(report, /! data directory .* is readable by others \(mode 755\)/);
      assert.match(report, /! TRUSTED_PROXIES trusts every address/);
      assert.match(report, /! API_TOKEN falls back to CPE_PASSWORD/);
    } finally {
      fx.cleanup();
    }
  });

  it("asks a running daemon for its health instead of probing the port", async () => {
    const fx = setup("WEB_PORT=18384\n");
    try {
      // pid 1 always exists (and belongs to root, so kill(1, 0) is EPERM: still a live holder)
      fs.writeFileSync(`${fx.files.state}.lock`, "1\n");
      const seen: string[] = [];
      const fetchImpl: typeof fetch = async (input) => {
        seen.push(String(input));
        return new Response(JSON.stringify({ ok: true, version: "9.9.9", uptimeSec: 42 }), { status: 200 });
      };
      const report = formatDoctorReport(await runDoctor(loadConfig({ envPath: fx.envPath, ignoreProcessEnv: true }), { notices: [], fetchImpl }));
      assert.match(report, /· daemon running \(pid 1\)/);
      assert.match(report, /✓ daemon answers on port 18384 \(version 9\.9\.9, up 42 s\)/);
      assert.deepEqual(seen, ["http://127.0.0.1:18384/api/health"]);
      const silent = formatDoctorReport(
        await runDoctor(loadConfig({ envPath: fx.envPath, ignoreProcessEnv: true }), {
          notices: [],
          fetchImpl: async () => {
            throw new TypeError("fetch failed");
          },
        })
      );
      assert.match(silent, /! daemon holds the data directory but does not answer on 127\.0\.0\.1:18384/);
    } finally {
      fx.cleanup();
    }
  });
});

describe("cpe-dash backup / restore", () => {
  it("copies the encrypted stores with checksums and puts them back, keeping what it replaces", () => {
    const fx = setup();
    try {
      const cipher = new StorageCipher("new_key");
      cipher.writeJsonFile(fx.files.contacts, { version: 1, contacts: [{ phone: "+353830000001", name: "Aoife" }] });
      cipher.writeJsonFile(fx.files.telegram, { version: 1, authorizedChatIds: ["1001"] });
      const { dir, manifest } = backupDataDir(fx.config, { now: () => Date.parse("2026-11-02T09:00:00.000Z") });
      assert.equal(path.basename(dir), "fengsui-backup-20261102T090000Z");
      assert.deepEqual(manifest.files.map((f) => f.name).sort(), ["contacts.json", "telegram.json"]);
      assert.match(fs.readFileSync(path.join(dir, "contacts.json"), "utf8"), /"__encrypted"/, "still encrypted");
      assert.doesNotMatch(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"), /Aoife|353830000001/);

      cipher.writeJsonFile(fx.files.contacts, { version: 1, contacts: [] });
      const result = restoreDataDir(fx.config, dir, { now: () => 1234 });
      assert.deepEqual(result.restored.sort(), ["contacts.json", "telegram.json"]);
      assert.deepEqual(result.movedAside.sort(), ["contacts.json.before-restore-1234", "telegram.json.before-restore-1234"]);
      assert.equal((cipher.readJsonFile<{ contacts: unknown[] }>(fx.files.contacts)?.contacts ?? []).length, 1);

      // Refused: a running daemon, a tampered file, a backup under another key
      fs.writeFileSync(`${fx.files.state}.lock`, "1\n");
      assert.throws(() => restoreDataDir(fx.config, dir), DataDirectoryBusyError);
      fs.rmSync(`${fx.files.state}.lock`);
      fs.appendFileSync(path.join(dir, "telegram.json"), " ");
      assert.throws(() => restoreDataDir(fx.config, dir), /does not match its checksum/);
      const other = backupDataDir({ ...fx.config, dataEncryptionKey: "new_key" }, { outDir: path.join(fx.dir, "b2") });
      assert.throws(() => restoreDataDir({ ...fx.config, dataEncryptionKey: "another_key" }, other.dir), /does not decrypt with the current DATA_ENCRYPTION_KEY/);
      fs.writeFileSync(path.join(fx.dir, "b2", "manifest.json"), "{}");
      assert.throws(() => restoreDataDir(fx.config, path.join(fx.dir, "b2")), /no FengSui backup manifest|ENOENT/);
    } finally {
      fx.cleanup();
    }
  });
});

describe("cpe-dash rekey", () => {
  it("re-encrypts stores under the new key and brings back copies moved aside after a key change", () => {
    const fx = setup();
    try {
      const oldCipher = new StorageCipher("old_key");
      const newCipher = new StorageCipher("new_key");
      oldCipher.writeJsonFile(fx.files.sms, { version: 1, messages: [{ uid: "u1" }] });
      newCipher.writeJsonFile(fx.files.telegram, { version: 1, authorizedChatIds: ["1001"] });
      // contacts.json: quarantined at startup under the old key, then started empty under the new one
      oldCipher.writeJsonFile(`${fx.files.contacts}.unreadable-1700000000000`, { version: 1, contacts: [{ phone: "+353830000001" }] });
      newCipher.writeJsonFile(fx.files.contacts, { version: 1, contacts: [] });
      new StorageCipher("unrelated").writeJsonFile(fx.files.state, { schemaVersion: 1 });

      const results = rekeyDataDir(fx.config, "old_key", { now: () => 77 });
      assert.deepEqual(results, [
        { name: "state.json", action: "not-decryptable" },
        { name: "sms.json", action: "rekeyed" },
        { name: "contacts.json", action: "recovered", source: "contacts.json.unreadable-1700000000000" },
        { name: "telegram.json", action: "already-current" },
        { name: "settings.json", action: "missing" },
        { name: "audit.json", action: "missing" },
      ]);
      assert.deepEqual(newCipher.readJsonFile<{ messages: unknown[] }>(fx.files.sms)?.messages, [{ uid: "u1" }]);
      assert.equal((newCipher.readJsonFile<{ contacts: unknown[] }>(fx.files.contacts)?.contacts ?? []).length, 1);
      assert.ok(fs.existsSync(`${fx.files.contacts}.replaced-77`), "the store that started afresh is kept");
      assert.ok(fs.existsSync(`${fx.files.contacts}.recovered-77`));
      assert.deepEqual(inspectDataFiles(fx.config).map((f) => f.status), ["undecryptable", "ok", "ok", "ok", "missing", "missing"]);
    } finally {
      fx.cleanup();
    }
  });
});

describe("maintenance commands on the CLI", () => {
  it("parses the commands and runs them with exit codes", async () => {
    assert.deepEqual(parseCliCommand(["node", "cli", "doctor", "--env", "/x/.env"]), { mode: "doctor", envPath: "/x/.env", warnings: [] });
    assert.deepEqual(parseCliCommand(["node", "cli", "backup", "--out", "/b"]), { mode: "backup", envPath: undefined, warnings: [], outDir: "/b" });
    assert.deepEqual(parseCliCommand(["node", "cli", "restore", "/b/x"]), { mode: "restore", envPath: undefined, warnings: [], target: "/b/x" });
    assert.deepEqual(parseCliCommand(["node", "cli", "rekey", "--old-key-stdin"]), { mode: "rekey", envPath: undefined, warnings: [], oldKeyStdin: true });
    assert.throws(() => parseCliCommand(["node", "cli", "restore"]), /needs the backup directory/);
    assert.throws(() => parseCliCommand(["node", "cli", "serve", "--out", "/b"]), /Unknown CLI argument "--out"/);

    const fx = setup();
    const lines: string[] = [];
    const write = (line: string): void => {
      lines.push(line);
    };
    const saved = process.env["FENGSUI_OLD_DATA_KEY"];
    try {
      new StorageCipher("new_key").writeJsonFile(fx.files.contacts, { version: 1, contacts: [] });
      assert.equal(await runMaintenance({ mode: "doctor", envPath: fx.envPath, warnings: [] }, write), 0);
      assert.equal(await runMaintenance({ mode: "backup", envPath: fx.envPath, warnings: [], outDir: path.join(fx.dir, "out") }, write), 0);
      assert.match(lines.at(-1) ?? "", /^Backed up contacts\.json to .*fengsui-backup-/);
      const backup = path.join(fx.dir, "out", fs.readdirSync(path.join(fx.dir, "out"))[0] ?? "");
      assert.equal(await runMaintenance({ mode: "restore", envPath: fx.envPath, warnings: [], target: backup }, write), 0);
      assert.match(lines.at(-1) ?? "", /^Restored contacts\.json; previous files kept as contacts\.json\.before-restore-/);
      delete process.env["FENGSUI_OLD_DATA_KEY"];
      assert.equal(await runMaintenance({ mode: "rekey", envPath: fx.envPath, warnings: [] }, write), 1);
      assert.match(lines.at(-1) ?? "", /rekey needs the previous DATA_ENCRYPTION_KEY/);
      process.env["FENGSUI_OLD_DATA_KEY"] = "old_key";
      assert.equal(await runMaintenance({ mode: "rekey", envPath: fx.envPath, warnings: [] }, write), 0);
      assert.ok(lines.includes("✓ contacts.json: already-current"));
      // The old key piped in (first line only), not taken from the environment
      new StorageCipher("piped_key").writeJsonFile(fx.files.sms, { version: 1, messages: [] });
      assert.equal(await runMaintenance({ mode: "rekey", envPath: fx.envPath, warnings: [], oldKeyStdin: true }, write, Readable.from(["piped_k", Buffer.from("ey\nignored\n")])), 0);
      assert.ok(lines.includes("✓ sms.json: rekeyed"));
      // A config the loader rejects, a store that cannot be found, a daemon still holding the directory
      const bad = path.join(fx.dir, "bad.env");
      fs.writeFileSync(bad, "CPE_PASSWORD=maint_pw\nAPI_TOKEN=same\nAPI_TOKEN_READONLY=same\n");
      assert.equal(await runMaintenance({ mode: "doctor", envPath: bad, warnings: [] }, write), 1);
      assert.match(lines.at(-1) ?? "", /^✗ configuration: API_TOKEN_READONLY must differ/);
      assert.equal(await runMaintenance({ mode: "restore", envPath: fx.envPath, warnings: [], target: path.join(fx.dir, "nowhere") }, write), 1);
      assert.match(lines.at(-1) ?? "", /^✗ ENOENT/);
      // Through the real entry point: the report goes to stdout and the exit code to process.exitCode
      const printed: string[] = [];
      const realWrite = process.stdout.write.bind(process.stdout);
      const savedExit = process.exitCode;
      process.stdout.write = ((chunk: string | Uint8Array) => {
        printed.push(String(chunk));
        return true;
      }) as typeof process.stdout.write;
      try {
        await runCli(["node", "cli", "doctor", "--env", fx.envPath]);
      } finally {
        process.stdout.write = realWrite;
      }
      assert.equal(process.exitCode, 0);
      process.exitCode = savedExit;
      assert.match(printed.join(""), /✓ configuration loaded/);
      const empty = await runDoctor({ ...fx.config, dataEncryptionKey: "" }, { notices: [] });
      assert.match(formatDoctorReport(empty), /✗ CPE_PASSWORD \/ DATA_ENCRYPTION_KEY is empty: no store can be decrypted/);
    } finally {
      if (saved === undefined) delete process.env["FENGSUI_OLD_DATA_KEY"];
      else process.env["FENGSUI_OLD_DATA_KEY"] = saved;
      fx.cleanup();
    }
  });
});
