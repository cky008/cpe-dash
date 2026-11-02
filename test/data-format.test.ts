import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { DataFormatTooNewError, StorageCipher } from "../src/encrypted-file.ts";
import { TelegramStateStore } from "../src/notify/telegram-bot.ts";
import { ContactBook } from "../src/sms/contacts.ts";
import { SmsMirrorStore } from "../src/sms/mirror.ts";
import { EncryptedStateStore } from "../src/state-store.ts";

describe("data written by a newer FengSui", () => {
  it("refuses to load (and so to overwrite) every store whose format is newer, and leaves the file alone", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fengsui-format-"));
    try {
      const cipher = StorageCipher.fromSecret("format_key");
      const write = (name: string, data: unknown): string => {
        const file = path.join(dir, name);
        cipher.writeJsonFile(file, data);
        return file;
      };
      const stateFile = write("state.json", { schemaVersion: 2, savedAtIso: "2027-01-01T00:00:00.000Z" });
      const smsFile = write("sms.json", { version: 3, messages: [] });
      const contactsFile = write("contacts.json", { version: 2, contacts: [] });
      const telegramFile = write("telegram.json", { version: 2, authorizedChatIds: ["1001"] });
      const before = new Map([stateFile, smsFile, contactsFile, telegramFile].map((f) => [f, fs.readFileSync(f, "utf8")]));

      const loaders: Array<[string, () => void]> = [
        ["state.json", () => new EncryptedStateStore({ filePath: stateFile, encryptionKey: "format_key" }).load()],
        ["sms.json", () => new SmsMirrorStore({ filePath: smsFile, cipher, defaultCountryCode: "+353", contacts: new ContactBook({ filePath: path.join(dir, "none.json"), cipher, defaultCountryCode: "+353" }) }).load()],
        ["contacts.json", () => new ContactBook({ filePath: contactsFile, cipher, defaultCountryCode: "+353" }).load()],
        ["telegram.json", () => new TelegramStateStore({ filePath: telegramFile, cipher }).load()],
      ];
      for (const [name, load] of loaders) {
        assert.throws(load, (err: unknown) => {
          assert.ok(err instanceof DataFormatTooNewError, name);
          assert.match(err.message, new RegExp(`${name.replace(".", "\\.")} was written by a newer FengSui`));
          return true;
        });
      }
      for (const [file, content] of before) {
        assert.equal(fs.readFileSync(file, "utf8"), content, "untouched");
      }
      assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes("unreadable")), [], "nothing quarantined");

      // The current format still loads
      write("ok.json", { version: 1, contacts: [] });
      new ContactBook({ filePath: path.join(dir, "ok.json"), cipher, defaultCountryCode: "+353" }).load();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
