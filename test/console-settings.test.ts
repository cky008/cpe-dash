import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { ConsoleSettings, PAIRING_CODE_TTL_MS, RESET_CODE_TTL_MS, hashLogin, resetLoginProof, verifyLogin, verifyResetLoginProof } from "../src/console-settings.ts";
import { DataFormatTooNewError, StorageCipher } from "../src/encrypted-file.ts";

const FAST = { N: 2 ** 10, r: 8, p: 1 };
const ENV = {
  cpeUrl: "http://192.168.8.1",
  cpeUsername: "admin",
  cpePassword: "router_pw",
  apiToken: "legacy_api_token_1234",
  apiTokenReadonly: "legacy_read_token_5678",
};

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fengsui-settings-"));
  const cipher = new StorageCipher("settings_key");
  let clock = Date.parse("2026-11-02T10:00:00.000Z");
  const open = () => new ConsoleSettings({ filePath: path.join(dir, "settings.json"), cipher, now: () => clock, scryptCost: FAST });
  return {
    dir,
    open,
    advance: (ms: number) => {
      clock += ms;
    },
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

describe("console settings store", () => {
  it("imports the .env setup once: router, login, and the existing tokens keep working", async () => {
    const fx = fixture();
    try {
      const settings = fx.open();
      assert.equal(settings.load(), false, "first start");
      settings.importFromEnv(ENV);
      assert.deepEqual(settings.cpe, { url: "http://192.168.8.1", username: "admin", password: "router_pw" });
      assert.equal(settings.reviewPending, true);
      assert.equal(settings.loginFromEnv, true);
      assert.equal(await settings.verifyLogin("legacy_api_token_1234"), true, "the old API_TOKEN still signs in");
      assert.equal(await settings.verifyLogin("wrong"), false);
      assert.deepEqual(settings.resolveBearer("legacy_api_token_1234")?.scope, "full");
      assert.deepEqual(settings.resolveBearer("legacy_read_token_5678")?.scope, "read");
      assert.deepEqual(
        settings.listTokens().map((t) => [t.name, t.scope, t.hint, t.imported]),
        [
          ["API_TOKEN (.env)", "full", "1234", true],
          ["API_TOKEN_READONLY (.env)", "read", "5678", true],
        ]
      );
      await settings.flush();

      const raw = fs.readFileSync(settings.filePath, "utf8");
      assert.match(raw, /"__encrypted"/);
      for (const secret of ["router_pw", "legacy_api_token_1234", "legacy_read_token_5678"]) assert.equal(raw.includes(secret), false, secret);

      const reloaded = fx.open();
      assert.equal(reloaded.load(), true);
      assert.equal(await reloaded.verifyLogin("legacy_api_token_1234"), true);
      assert.equal(reloaded.resolveBearer("legacy_read_token_5678")?.name, "API_TOKEN_READONLY (.env)");
    } finally {
      fx.cleanup();
    }
  });

  it("starts empty (setup mode) when .env has neither router password nor API token", () => {
    const fx = fixture();
    try {
      const settings = fx.open();
      settings.importFromEnv({ ...ENV, cpePassword: "", apiToken: "", apiTokenReadonly: "" });
      assert.equal(settings.cpe, null);
      assert.equal(settings.loginConfigured, false);
      assert.equal(settings.reviewPending, false);
      assert.deepEqual(settings.listTokens(), []);
    } finally {
      fx.cleanup();
    }
  });

  it("mints tokens shown once, honours expiry and revocation, and records last use", async () => {
    const fx = fixture();
    try {
      const settings = fx.open();
      settings.importFromEnv({ ...ENV, apiTokenReadonly: "" });
      const { token, record } = settings.createToken({ name: "Claude Code", scope: "read", lifetimeDays: 7 });
      assert.match(token, /^fsk_[A-Za-z0-9_-]{43}$/);
      assert.equal(record.hint, token.slice(-4));
      assert.equal("hash" in record, false, "the hash never leaves the store");
      assert.equal(record.expiresAtIso, "2026-11-09T10:00:00.000Z");
      assert.equal(settings.resolveBearer(token)?.name, "Claude Code");
      assert.equal(settings.listTokens().find((t) => t.id === record.id)?.lastUsedAtIso, "2026-11-02T10:00:00.000Z");

      const forever = settings.createToken({ name: "Grafana", scope: "read", lifetimeDays: null });
      fx.advance(8 * 86_400_000);
      assert.equal(settings.resolveBearer(token), null, "expired");
      assert.equal(settings.resolveBearer(forever.token)?.scope, "read");
      assert.equal(settings.revokeToken(forever.record.id)?.name, "Grafana");
      assert.equal(settings.resolveBearer(forever.token), null, "revoked");
      assert.equal(settings.revokeToken("nope"), null);
      assert.equal(settings.resolveBearer(""), null);
      assert.equal(settings.resolveBearer("fsk_unknown"), null);

      for (let i = settings.listTokens().length; i < 50; i++) settings.createToken({ name: `t${i}`, scope: "read", lifetimeDays: 1 });
      assert.throws(() => settings.createToken({ name: "one too many", scope: "read", lifetimeDays: 1 }), /At most 50 tokens/);
      await settings.flush();
    } finally {
      fx.cleanup();
    }
  });

  it("changes the login, keeps switches, and refuses a store from a newer version", async () => {
    const fx = fixture();
    try {
      const settings = fx.open();
      settings.importFromEnv(ENV);
      await settings.setLogin("a much better passphrase");
      assert.equal(settings.loginFromEnv, false);
      assert.equal(await settings.verifyLogin("legacy_api_token_1234"), false);
      assert.equal(await settings.verifyLogin("a much better passphrase"), true);
      settings.setCpe({ url: "http://192.168.8.1", username: "admin", password: "new_router_pw" });
      settings.markReviewed();
      settings.setTelegramReset(false);
      settings.setMetricsEnabled(true);
      await settings.flush();
      const reloaded = fx.open();
      reloaded.load();
      assert.equal(reloaded.cpe?.password, "new_router_pw");
      assert.equal(reloaded.reviewPending, false);
      assert.equal(reloaded.telegramReset, false);
      assert.equal(reloaded.metricsEnabled, true);
      assert.ok(reloaded.loginChangedAtIso);

      new StorageCipher("settings_key").writeJsonFile(path.join(fx.dir, "settings.json"), { format: 2 });
      assert.throws(() => fx.open().load(), DataFormatTooNewError);
    } finally {
      fx.cleanup();
    }
  });

  it("issues one-time codes that work once, before they expire, for their own purpose only", () => {
    const fx = fixture();
    try {
      const settings = fx.open();
      const reset = settings.issueCode("reset");
      assert.match(reset, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
      assert.equal(settings.consumeCode("pair", reset), false, "a reset code does not pair a chat");
      assert.equal(settings.consumeCode("reset", ` ${reset.toLowerCase().replace("-", " ")} `), true, "typed loosely");
      assert.equal(settings.consumeCode("reset", reset), false, "spent");

      const pair = settings.issueCode("pair");
      fx.advance(PAIRING_CODE_TTL_MS + 1);
      assert.equal(settings.consumeCode("pair", pair), false, "expired");
      const late = settings.issueCode("reset");
      fx.advance(RESET_CODE_TTL_MS - 1);
      assert.equal(settings.consumeCode("reset", late), true);

      const first = settings.issueCode("setup");
      const second = settings.issueCode("setup");
      assert.equal(settings.consumeCode("setup", first), false, "a new setup code replaces the old one");
      assert.equal(settings.consumeCode("setup", second), true);
    } finally {
      fx.cleanup();
    }
  });

  it("links Telegram chats: a group only with a group code, which a private code or a token seen there never is", () => {
    const fx = fixture();
    try {
      const settings = fx.open();
      settings.importFromEnv(ENV);
      const group = settings.issueCode("pair-group");
      assert.equal(settings.consumeCode("pair", group), false, "a group code is its own kind");
      assert.equal(settings.linkTelegramChat(group, "group"), "linked");
      assert.equal(settings.linkTelegramChat(group, "group"), "invalid", "spent");
      assert.equal(settings.linkTelegramChat(settings.issueCode("pair-group"), "private"), "linked", "a group code also links a private chat");

      // A private code shown to a group is spent there: a member who copied it cannot use it in a private chat
      const shown = settings.issueCode("pair");
      assert.equal(settings.linkTelegramChat(shown, "group"), "private-only");
      assert.equal(settings.linkTelegramChat(shown, "private"), "invalid");
      assert.equal(settings.linkTelegramChat(settings.issueCode("pair"), "private"), "linked");

      assert.equal(settings.linkTelegramChat(ENV.apiToken, "group"), "private-only");
      assert.equal(settings.linkTelegramChat(ENV.apiToken, "private"), "linked");
      assert.equal(settings.linkTelegramChat(ENV.apiTokenReadonly, "private"), "invalid", "a read-only token links nothing");
      assert.equal(settings.linkTelegramChat(settings.issueCode("reset"), "private"), "invalid");
      assert.equal(settings.linkTelegramChat("WRNG-CODE", "group"), "invalid");
    } finally {
      fx.cleanup();
    }
  });

  it("hashes logins with scrypt and never matches a malformed hash", async () => {
    const encoded = await hashLogin("pw", FAST);
    assert.match(encoded, /^scrypt\$1024\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
    assert.equal(await verifyLogin("pw", encoded), true);
    assert.equal(await verifyLogin("pw2", encoded), false);
    for (const bad of ["", "bcrypt$1", "scrypt$x$8$1$aaaaaaaaaaaaaaaaaaaaaa$bbbb", `scrypt$${2 ** 21}$8$1$${"a".repeat(22)}$${"b".repeat(43)}`, "scrypt$1024$8$1$c2hvcnQ$" + "b".repeat(43)]) {
      assert.equal(await verifyLogin("pw", bad), false, bad);
    }
  });

  it("accepts a reset-login proof only with the data key, within a minute", () => {
    const now = Date.parse("2026-11-02T10:00:00.000Z");
    const proof = resetLoginProof("data_key", now);
    assert.match(proof, /^\d+\.[0-9a-f]{64}$/);
    assert.equal(verifyResetLoginProof("data_key", proof, now + 59_000), true);
    assert.equal(verifyResetLoginProof("data_key", proof, now + 61_000), false, "stale");
    assert.equal(verifyResetLoginProof("other_key", proof, now), false, "another key");
    assert.equal(verifyResetLoginProof("data_key", proof.replace(/.$/, (c) => (c === "0" ? "1" : "0")), now), false, "tampered");
    for (const bad of ["", "x", "123.zz", `${now}.`, `abc.${"0".repeat(64)}`]) assert.equal(verifyResetLoginProof("data_key", bad, now), false, bad);
  });
});

