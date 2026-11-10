import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { describe, it } from "node:test";
import { parseCliCommand, runCli, runMaintenance } from "../src/cli.ts";
import { loadConfig } from "../src/config.ts";
import { ConsoleSettings } from "../src/console-settings.ts";
import { PlaintextStoreError, StorageCipher, quarantinedSince } from "../src/encrypted-file.ts";
import { DataDirectoryBusyError, backupDataDir, formatDoctorReport, inspectDataFiles, rekeyDataDir, replaceFile, restoreDataDir, runDoctor } from "../src/maintenance.ts";
import { removeTempDir, tempDir } from "./helpers/temp-dir.ts";

function setup(extraEnv = "") {
  const dir = tempDir("fengsui-maint-");
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
  return { dir, dataDir, envPath, config, files, cleanup: () => removeTempDir(dir) };
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
      fs.writeFileSync(`${fx.files.contacts}.unreadable-1700000000000`, new StorageCipher("old_key").serializeJson({ version: 1, contacts: [] }));
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

  it("refuses a backup that a newer FengSui wrote, before touching anything", () => {
    const fx = setup();
    try {
      const cipher = new StorageCipher("new_key");
      cipher.writeJsonFile(fx.files.contacts, { version: 1, contacts: [] });
      cipher.writeJsonFile(fx.files.state, { schemaVersion: 2 });
      const { dir } = backupDataDir(fx.config);
      cipher.writeJsonFile(fx.files.state, { schemaVersion: 1 });
      assert.throws(() => restoreDataDir(fx.config, dir), /state\.json was written by a newer FengSui \(format 2\)/);
      assert.equal(cipher.readJsonFile<{ schemaVersion: number }>(fx.files.state)?.schemaVersion, 1, "nothing was replaced");
      assert.deepEqual(fs.readdirSync(fx.dataDir).filter((name) => name.includes("before-restore")), []);
    } finally {
      fx.cleanup();
    }
  });

  // Kept last in this group: on Node 26 a synchronous test that follows this one (it awaits a store's
  // own save) in the same group runs but is left out of the report
  it("checks, backs up and restores settings.json as an earlier version wrote it and as this one does: the writes turned off survive, old consents turn nothing off", async () => {
    const fx = setup();
    try {
      const cipher = new StorageCipher("new_key");
      const at = "2026-11-10T08:00:00.000Z";
      // 1.8.3: the experimental writes its owner had consented to (they are on by default now)
      const old = { format: 1, cpe: { url: "http://192.168.8.1", username: "admin", password: "maint_pw" }, experimental: [{ model: "B535-232", feature: "bandLock", grantedAtIso: at }] };
      cipher.writeJsonFile(fx.config.settingsFile, old);
      const report = formatDoctorReport(await runDoctor(fx.config, { notices: [] }));
      assert.match(report, /✓ settings\.json: decrypts with the current key \(format 1\)/);
      const before = backupDataDir(fx.config, { outDir: path.join(fx.dir, "old-backup") });
      assert.deepEqual(before.manifest.files.map((f) => f.name), ["settings.json"]);

      // This version reads it, and its owner turns one write off
      const settings = new ConsoleSettings({ filePath: fx.config.settingsFile, cipher });
      assert.equal(settings.load(), true);
      assert.deepEqual(settings.disabledWrites, [], "a consent of an earlier version turns nothing off");
      settings.disableWrite("B535-232", "reboot");
      await settings.flush();
      assert.match(formatDoctorReport(await runDoctor(fx.config, { notices: [] })), /✓ settings\.json: decrypts with the current key \(format 1\)/);
      const after = backupDataDir(fx.config, { outDir: path.join(fx.dir, "new-backup") });

      // Either backup restores, and the daemon reads what comes back
      const reload = (): ConsoleSettings => {
        const store = new ConsoleSettings({ filePath: fx.config.settingsFile, cipher });
        assert.equal(store.load(), true);
        return store;
      };
      assert.deepEqual(restoreDataDir(fx.config, before.dir, { now: () => 1 }).restored, ["settings.json"]);
      assert.deepEqual([reload().disabledWrites.length, reload().cpe?.username], [0, "admin"], "the old file: every implemented write on");
      assert.deepEqual(restoreDataDir(fx.config, after.dir, { now: () => 2 }).restored, ["settings.json"]);
      assert.deepEqual(reload().disabledWrites.map((d) => [d.model, d.feature]), [["B535-232", "reboot"]], "the new file: what was off stays off");
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

describe("stores written without encryption", () => {
  it("moves a store written without encryption aside once a key is set; without a key it still reads it", () => {
    const dir = tempDir("fengsui-plain-");
    try {
      const file = path.join(dir, "settings.json");
      // Anyone who can write the data directory could plant one, with a console password of their own
      fs.writeFileSync(file, JSON.stringify({ format: 1, login: "planted" }), { mode: 0o600 });
      const keyed = new StorageCipher("new_key");
      assert.throws(() => keyed.readJsonFile(file), PlaintextStoreError);
      assert.equal(keyed.readJsonFileOrQuarantine(file), null);
      assert.equal(fs.existsSync(file), false);
      assert.equal(quarantinedSince(file, 0).length, 1, "moved aside, not deleted");
      const other = path.join(dir, "sms.json");
      fs.writeFileSync(other, JSON.stringify({ version: 1, messages: [] }), { mode: 0o600 });
      assert.deepEqual(StorageCipher.fromSecret("").readJsonFile(other), { version: 1, messages: [] });
    } finally {
      removeTempDir(dir);
    }
  });

  it("reports a plain store, leaves it alone on a key change and encrypts it in place with rekey --plaintext", async () => {
    const fx = setup();
    try {
      const key = new StorageCipher("new_key");
      key.writeJsonFile(fx.files.telegram, { version: 1, authorizedChatIds: [] });
      fs.writeFileSync(fx.files.sms, JSON.stringify({ version: 1, messages: [] }), { mode: 0o600 });
      const statuses = (): string[] => inspectDataFiles(fx.config).map((f) => `${f.name}:${f.status}`);
      assert.ok(statuses().includes("sms.json:plaintext"));
      assert.ok(statuses().includes("telegram.json:ok"));
      const report = formatDoctorReport(await runDoctor(fx.config, { notices: [] }));
      assert.match(report, /✗ sms\.json: stored without encryption: FengSui moves it aside at its next start\n {4}→ if it is yours, stop FengSui and run: cpe-dash rekey --plaintext/);
      // A key change never vouches for a plain store
      const rotated = rekeyDataDir(fx.config, "old_key");
      assert.ok(rotated.some((r) => r.name === "sms.json" && r.action === "plaintext"), JSON.stringify(rotated));
      assert.doesNotMatch(fs.readFileSync(fx.files.sms, "utf8"), /"__encrypted"/);
      const results = rekeyDataDir(fx.config, null, { plaintext: true });
      assert.ok(results.some((r) => r.name === "sms.json" && r.action === "encrypted"), JSON.stringify(results));
      assert.ok(statuses().includes("sms.json:ok"));
      assert.deepEqual(key.readJsonFile(fx.files.sms), { version: 1, messages: [] });
      assert.deepEqual(fs.readdirSync(fx.dataDir).filter((f) => f.startsWith("sms.json.")), [], "no unencrypted copy is left beside it");
    } finally {
      fx.cleanup();
    }
  });

  it("brings back a store moved aside for being unencrypted only with rekey --plaintext, keeping no plain copy", async () => {
    const fx = setup();
    try {
      const key = new StorageCipher("new_key");
      // What the daemon left: the plain contacts moved aside at startup, and the empty store it started instead
      const copy = `${fx.files.contacts}.unreadable-1700000000000`;
      fs.writeFileSync(copy, JSON.stringify({ version: 1, contacts: [{ name: "Kept" }] }), { mode: 0o600 });
      key.writeJsonFile(fx.files.contacts, { version: 1, contacts: [] });
      const report = formatDoctorReport(await runDoctor(fx.config, { notices: [] }));
      assert.match(report, /! contacts\.json: 1 copy\(ies\) moved aside for being stored without encryption \(contacts\.json\.unreadable-1700000000000\)\n {4}→ if it is yours, stop FengSui and run: cpe-dash rekey --plaintext/);
      assert.ok(rekeyDataDir(fx.config, "old_key").some((r) => r.name === "contacts.json" && r.action === "already-current"));
      assert.ok(fs.existsSync(copy), "a key change leaves it where it is");
      const results = rekeyDataDir(fx.config, null, { plaintext: true, now: () => 1800000000000 });
      assert.ok(results.some((r) => r.name === "contacts.json" && r.action === "recovered" && r.source === "contacts.json.unreadable-1700000000000"), JSON.stringify(results));
      assert.deepEqual(key.readJsonFile(fx.files.contacts), { version: 1, contacts: [{ name: "Kept" }] });
      assert.equal(fs.existsSync(copy), false);
      assert.deepEqual(fs.readdirSync(fx.dataDir).filter((f) => f.startsWith("contacts.json.")), ["contacts.json.replaced-1800000000000"]);
      assert.match(fs.readFileSync(`${fx.files.contacts}.replaced-1800000000000`, "utf8"), /"__encrypted"/);
    } finally {
      fx.cleanup();
    }
  });

  it("refuses to restore a backup file stored without encryption, saying so", () => {
    const fx = setup();
    try {
      fs.writeFileSync(fx.files.sms, JSON.stringify({ version: 1, messages: [] }), { mode: 0o600 });
      const { dir } = backupDataDir(fx.config, { outDir: path.join(fx.dir, "out") });
      assert.throws(() => restoreDataDir(fx.config, dir), /sms\.json is stored without encryption/);
    } finally {
      fx.cleanup();
    }
  });
});

describe("maintenance commands on the CLI", () => {
  it("parses rekey --plaintext and runs it without an old key", async () => {
    assert.deepEqual(parseCliCommand(["node", "cli", "rekey", "--plaintext"]), { mode: "rekey", envPath: undefined, warnings: [], plaintext: true });
    const fx = setup();
    const lines: string[] = [];
    const saved = process.env["FENGSUI_OLD_DATA_KEY"];
    try {
      fs.writeFileSync(fx.files.sms, JSON.stringify({ version: 1, messages: [] }), { mode: 0o600 });
      // A key change leaves it and says so, with a non-zero exit for scripts
      process.env["FENGSUI_OLD_DATA_KEY"] = "old_key";
      assert.equal(await runMaintenance({ mode: "rekey", envPath: fx.envPath, warnings: [] }, (line) => lines.push(line)), 1);
      assert.ok(lines.some((line) => line.startsWith("! sms.json: plaintext (stored without encryption, left as it is")), lines.join("\n"));
      delete process.env["FENGSUI_OLD_DATA_KEY"];
      assert.equal(await runMaintenance({ mode: "rekey", envPath: fx.envPath, warnings: [], plaintext: true }, (line) => lines.push(line)), 0);
      assert.ok(lines.includes("✓ sms.json: encrypted"), lines.join("\n"));
    } finally {
      if (saved === undefined) delete process.env["FENGSUI_OLD_DATA_KEY"];
      else process.env["FENGSUI_OLD_DATA_KEY"] = saved;
      fx.cleanup();
    }
  });

  it("puts a replacement store on disk (fsync) before it takes the old one's place (restore, rekey)", (t) => {
    const dir = tempDir("fengsui-fsync-");
    try {
      const order: string[] = [];
      const fsync = fs.fsyncSync.bind(fs);
      const rename = fs.renameSync.bind(fs);
      t.mock.method(fs, "fsyncSync", (fd: number) => {
        order.push("fsync");
        fsync(fd);
      });
      t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
        order.push("rename");
        rename(from, to);
      });
      new StorageCipher("new_key").writeJsonFile(path.join(dir, "settings.json"), { format: 1 });
      assert.deepEqual(order, ["fsync", "rename"]);
    } finally {
      removeTempDir(dir);
    }
  });

  it("keeps a store where the daemon looks for it when writing its replacement fails (restore, rekey)", () => {
    const dir = tempDir("fengsui-replace-");
    try {
      const file = path.join(dir, "settings.json");
      StorageCipher.fromSecret("replace_key").writeJsonFile(file, { version: 1, kept: true });
      const before = fs.readFileSync(file, "utf8");
      const failing = StorageCipher.fromSecret("replace_key");
      failing.writeJsonFile = () => {
        throw new Error("disk full");
      };
      assert.throws(() => replaceFile(file, failing, { version: 1, kept: false }, "replaced", 1), /disk full/);
      assert.equal(fs.readFileSync(file, "utf8"), before, "the old store is still in place");
      assert.deepEqual(fs.readdirSync(dir), ["settings.json"], "no copy left behind");
      // And when it works: the new store in place, the old one kept beside it, both 0600
      const aside = replaceFile(file, StorageCipher.fromSecret("replace_key"), { version: 1, kept: false }, "replaced", 2);
      assert.equal(aside, `${file}.replaced-2`);
      assert.equal(fs.readFileSync(aside ?? "", "utf8"), before);
      assert.equal(fs.statSync(aside ?? "").mode & 0o777, 0o600);
      assert.deepEqual(StorageCipher.fromSecret("replace_key").readJsonFile(file), { version: 1, kept: false });
    } finally {
      removeTempDir(dir);
    }
  });

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
