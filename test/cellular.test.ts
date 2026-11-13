import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  LINK_CHANGE_KINDS,
  NETWORK_MODES,
  isApnName,
  isLinkChange,
  isNetworkMode,
  isPlmn,
  pinAttemptAllowed,
  readApnChoice,
  readDataLimit,
  readNetworkMode,
  readOperatorSelection,
  readSimPin,
  readSimSlot,
  readUssdRequest,
  sameOperatorSelection,
  sameSimSlot,
} from "../src/cellular.ts";
import { CpeControlValidationError } from "../src/control-error.ts";
import { sameDataLimit, ussdText } from "../src/drivers/cellular.ts";
import { parseZteOperators, zteLimitSize, zteModeOf, zteUssdText } from "../src/drivers/zte/cellular.ts";
import { MAX_SCAN_ROWS, operatorActOf, operatorChoice, operatorName, operatorRatOf } from "../src/protocols/at/common.ts";
import { ucs2Hex } from "../src/drivers/sms.ts";

/**
 * The cellular settings' shared rules: what a REST body, an MCP call or the demo may ask for, checked
 * before any session. Placeholder values only (`0000` / `1234`, `internet`, `*100#`, PLMN `27201`).
 */

const invalid = (fn: () => unknown, pattern: RegExp): void => {
  assert.throws(fn, (err: unknown) => err instanceof CpeControlValidationError && pattern.test(err.message));
};

describe("cellular settings: what may be asked for", () => {
  it("takes the network modes FengSui names and nothing else", () => {
    assert.deepEqual([...NETWORK_MODES], ["auto", "nr_sa", "nr_nsa", "nr_lte", "lte", "lte_tdd", "lte_fdd", "lte_wcdma", "wcdma", "gsm"]);
    for (const mode of NETWORK_MODES) assert.equal(readNetworkMode(mode), mode);
    assert.equal(isNetworkMode("5g"), false);
    invalid(() => readNetworkMode("08"), /"mode" must be one of auto, nr_sa/);
    invalid(() => readNetworkMode(undefined, "networkMode"), /"networkMode" must be one of/);
    // An inherited key is not a mode
    invalid(() => readNetworkMode("constructor"), /must be one of/);
  });

  it("reads a SIM slot as a kind and a number, the first of its kind by default", () => {
    assert.deepEqual(readSimSlot({ kind: "physical" }), { kind: "physical", index: 1 });
    assert.deepEqual(readSimSlot({ kind: "embedded", index: 2 }), { kind: "embedded", index: 2 });
    invalid(() => readSimSlot({ kind: "esim" }), /"kind" must be "physical" or "embedded"/);
    invalid(() => readSimSlot({ kind: "embedded", index: 0 }), /"index" must be a whole number from 1 to 4/);
    invalid(() => readSimSlot({ kind: "embedded", index: "1" }), /"index"/);
    assert.equal(sameSimSlot({ kind: "embedded", index: 1 }, { kind: "embedded", index: 1 }), true);
    assert.equal(sameSimSlot({ kind: "embedded", index: 1 }, { kind: "physical", index: 1 }), false);
    assert.equal(sameSimSlot(null, { kind: "physical", index: 1 }), false, "a slot nobody read is not the one asked for");
  });

  it("reads an operator choice: automatic, or a 5- or 6-digit code with an optional technology", () => {
    assert.deepEqual(readOperatorSelection({ mode: "auto" }), { mode: "auto" });
    assert.deepEqual(readOperatorSelection({ mode: "manual", plmn: "27201" }), { mode: "manual", plmn: "27201", rat: null });
    assert.deepEqual(readOperatorSelection({ mode: "manual", plmn: "310260", rat: "5G" }), { mode: "manual", plmn: "310260", rat: "5G" });
    invalid(() => readOperatorSelection({ mode: "manual", plmn: "2720" }), /5 or 6 digits/);
    invalid(() => readOperatorSelection({ mode: "manual", plmn: '27201",2' }), /5 or 6 digits/);
    invalid(() => readOperatorSelection({ mode: "manual", plmn: "27201", rat: "LTE" }), /"rat" must be one of 2G, 3G, 4G, 5G/);
    invalid(() => readOperatorSelection({ mode: "best" }), /"mode" must be "auto" or "manual"/);
    assert.equal(isPlmn("27201"), true);
    assert.equal(isPlmn(27201), false);
    assert.equal(sameOperatorSelection({ mode: "auto" }, { mode: "auto" }), true);
    assert.equal(sameOperatorSelection({ mode: "auto" }, { mode: "manual", plmn: "27201", rat: null }), false);
    assert.equal(sameOperatorSelection({ mode: "manual", plmn: "27201", rat: "4G" }, { mode: "manual", plmn: "27201", rat: null }), true, "a choice that names no technology is the same operator");
    assert.equal(sameOperatorSelection({ mode: "manual", plmn: "27201", rat: "4G" }, { mode: "manual", plmn: "27201", rat: "5G" }), false);
  });

  it("lets nothing into an APN but what an access point name and its credentials are made of", () => {
    assert.deepEqual(readApnChoice({ mode: "auto" }), { mode: "auto" });
    assert.deepEqual(readApnChoice({ mode: "manual", apn: "internet" }), { mode: "manual", apn: "internet", ipType: "ipv4v6", auth: "none", username: "", password: "" });
    assert.deepEqual(readApnChoice({ mode: "manual", apn: "example.apn", ipType: "ipv4", auth: "chap", username: "user@example", password: "pass-word.1" }), {
      mode: "manual",
      apn: "example.apn",
      ipType: "ipv4",
      auth: "chap",
      username: "user@example",
      password: "pass-word.1",
    });
    // What would end a form field or an AT command's quotes never gets in
    for (const apn of ['internet"', "internet,1", "inter net", "-internet", "internet.", "a..b", "", "x".repeat(101), "互联网"]) {
      assert.equal(isApnName(apn), false, apn);
      invalid(() => readApnChoice({ mode: "manual", apn }), /"apn" must be an access point name/);
    }
    assert.equal(isApnName("x".repeat(100)), true);
    invalid(() => readApnChoice({ mode: "manual", apn: "internet", ipType: "ip" }), /"ipType" must be one of ipv4, ipv6, ipv4v6/);
    invalid(() => readApnChoice({ mode: "manual", apn: "internet", auth: "auto" }), /"auth" must be one of none, pap, chap/);
    invalid(() => readApnChoice({ mode: "manual", apn: "internet", auth: "pap", username: 'a"b' }), /"username" may hold/);
    invalid(() => readApnChoice({ mode: "manual", apn: "internet", auth: "pap", password: "a b" }), /"password" may hold/);
    invalid(() => readApnChoice({ mode: "manual", apn: "internet", username: "user" }), /needs "auth" set to "pap" or "chap"/);
    invalid(() => readApnChoice({ mode: "default" }), /"mode" must be "auto" or "manual"/);
  });

  it("reads a data limit in whole bytes with its warning share", () => {
    assert.deepEqual(readDataLimit({ enabled: false }), { enabled: false, bytes: null, alertPercent: null });
    assert.deepEqual(readDataLimit({ enabled: true, bytes: 20 * 1024 ** 3, alertPercent: 80 }), { enabled: true, bytes: 20 * 1024 ** 3, alertPercent: 80 });
    invalid(() => readDataLimit({ enabled: true }), /needs "bytes"/);
    invalid(() => readDataLimit({ enabled: "yes" }), /"enabled" must be a boolean/);
    invalid(() => readDataLimit({ enabled: true, bytes: 1000 }), /from 1 MB to 100 TB/);
    invalid(() => readDataLimit({ enabled: true, bytes: 1.5 * 1024 ** 3 + 0.5 }), /whole number of bytes/);
    invalid(() => readDataLimit({ enabled: true, bytes: 1024 ** 3, alertPercent: 0 }), /"alertPercent" must be a whole number from 1 to 100/);
  });

  it("takes a PIN of 4 to 8 digits, and sends one only while more than one attempt is left", () => {
    assert.equal(readSimPin("0000"), "0000");
    assert.equal(readSimPin("12345678"), "12345678");
    for (const pin of ["123", "123456789", "12a4", " 1234", 1234, null]) invalid(() => readSimPin(pin), /"pin" must be 4 to 8 digits/);
    assert.deepEqual(pinAttemptAllowed(3), { allowed: true, attemptsLeft: 3 });
    assert.deepEqual(pinAttemptAllowed(2), { allowed: true, attemptsLeft: 2 });
    // The last attempt is never FengSui's to spend
    assert.deepEqual(pinAttemptAllowed(1), { allowed: false, reason: "last_attempt" });
    assert.deepEqual(pinAttemptAllowed(0), { allowed: false, reason: "none_left" });
    assert.deepEqual(pinAttemptAllowed(null), { allowed: false, reason: "unknown" });
    assert.deepEqual(pinAttemptAllowed(undefined), { allowed: false, reason: "unknown" });
  });

  it("takes a USSD string of keypad characters, a reply, or a cancel", () => {
    assert.deepEqual(readUssdRequest({ code: "*100#" }), { kind: "send", code: "*100#" });
    assert.deepEqual(readUssdRequest({ action: "reply", code: "1" }), { kind: "reply", code: "1" });
    assert.deepEqual(readUssdRequest({ action: "cancel" }), { kind: "cancel" });
    for (const code of ["", "*100# ", "*100#;AT", "abc", "*".repeat(41), 100]) invalid(() => readUssdRequest({ code }), /"code" must be 1 to 40 of the characters 0-9, \* and #/);
    invalid(() => readUssdRequest({ action: "dial", code: "*100#" }), /"action" must be "send", "reply" or "cancel"/);
  });

  it("reads back from state.json only a change it could have written", () => {
    assert.deepEqual([...LINK_CHANGE_KINDS], ["sim_slot", "network_mode", "operator", "apn"]);
    const good: unknown[] = [
      { kind: "sim_slot", previous: { kind: "physical", index: 1 } },
      { kind: "network_mode", previous: "auto" },
      { kind: "operator", previous: { mode: "auto" } },
      { kind: "operator", previous: { mode: "manual", plmn: "27201", rat: null } },
      { kind: "apn", previous: { mode: "auto" } },
      { kind: "apn", previous: { mode: "profile", id: "3" } },
      { kind: "apn", previous: { mode: "context", apn: "internet", ipType: "ipv4v6" } },
      { kind: "apn", previous: { mode: "context", apn: "", ipType: "ipv4" } },
    ];
    for (const change of good) assert.equal(isLinkChange(change), true, JSON.stringify(change));
    const bad: unknown[] = [
      null,
      "sim_slot",
      { kind: "sim_slot", previous: { kind: "tray", index: 1 } },
      { kind: "network_mode", previous: "5g" },
      { kind: "operator", previous: { mode: "manual", plmn: "abc", rat: null } },
      { kind: "operator", previous: { mode: "manual", plmn: "27201", rat: "LTE" } },
      { kind: "apn", previous: { mode: "profile", id: "3; reboot" } },
      { kind: "apn", previous: { mode: "context", apn: 'x"', ipType: "ipv4" } },
      { kind: "apn", previous: null },
      { kind: "reboot", previous: "auto" },
    ];
    for (const change of bad) assert.equal(isLinkChange(change), false, JSON.stringify(change));
  });
});

describe("cellular settings: what the drivers share", () => {
  it("shows a USSD answer as text, with its line breaks and without control characters", () => {
    assert.equal(ussdText("Balance: 5.00\r\n1. Top up\n2. Exit"), "Balance: 5.00\n1. Top up\n2. Exit");
    assert.equal(ussdText("a\u0000b\u001bc\u009fd"), "abcd");
    assert.equal(ussdText("   "), null);
    assert.equal(ussdText(null), null);
    assert.equal(ussdText("x".repeat(1500))?.length, 1000);
    // ZTE hands the answer back as UTF-16 hexadecimal; a firmware that sends plain text is read as it is
    assert.equal(zteUssdText(ucs2Hex("余额 5.00")), "余额 5.00");
    assert.equal(zteUssdText("Balance: 5"), "Balance: 5");
    assert.equal(zteUssdText(""), null);
    assert.equal(zteUssdText(undefined), null);
  });

  it("reads ZTE's mode names and scan rows the way its own pages do", () => {
    assert.deepEqual(
      ["WL_AND_5G", "Only_5G", "LTE_AND_5G", "Only_LTE", "WCDMA_AND_LTE", "Only_WCDMA", "NETWORK_auto", "only_lte"].map(zteModeOf),
      ["auto", "nr_sa", "nr_nsa", "lte", "lte_wcdma", "wcdma", "auto", "lte"]
    );
    assert.equal(zteModeOf("TD_W_LTE"), null, "a name FengSui has no mode for is not guessed");
    assert.equal(zteModeOf(""), null);
    assert.deepEqual(parseZteOperators('2,"Demo Mobile",27201,7;1,"Other Net",27202,2,0;3,"Third",27203,12;x;0,"bad",12,7'), [
      { plmn: "27201", name: "Demo Mobile", rat: "4G", state: "current" },
      { plmn: "27202", name: "Other Net", rat: "3G", state: "available" },
      { plmn: "27203", name: "Third", rat: "5G", state: "forbidden" },
    ]);
    assert.deepEqual(parseZteOperators(""), []);
    assert.equal(parseZteOperators(Array.from({ length: 80 }, (_, i) => `1,"n",${27201 + i},7`).join(";")).length, MAX_SCAN_ROWS);
  });

  it("names a scan row's technology by the AT+COPS number, and keeps an operator's name short and printable", () => {
    assert.deepEqual(["0", "2", "7", "11", "12", "13", "99", ""].map(operatorRatOf), ["2G", "3G", "4G", "5G", "5G", "5G", null, null]);
    assert.deepEqual((["2G", "3G", "4G", "5G", null] as const).map(operatorActOf), ["0", "2", "7", "12", null]);
    assert.equal(operatorName('"Demo\u0007 Mobile"'), "Demo Mobile");
    assert.equal(operatorName("x".repeat(80))?.length, 48);
    assert.equal(operatorName(""), null);
    assert.equal(operatorChoice("9", "Demo", "27201", "7")?.state, "unknown");
    assert.equal(operatorChoice("1", "Demo", "2720", "7"), null);
  });

  it("writes ZTE's limit size in whole megabytes and compares a limit as the router keeps it", () => {
    assert.equal(zteLimitSize(20 * 1024 ** 3), "20_1024");
    assert.equal(zteLimitSize(500 * 1024 ** 2), "500_1");
    assert.equal(zteLimitSize(1536 * 1024 ** 2), "1536_1");
    assert.throws(() => zteLimitSize(1000), CpeControlValidationError);
    const on = { enabled: true, bytes: 20 * 1024 ** 3, alertPercent: 80 };
    assert.equal(sameDataLimit(on, { enabled: true, bytes: 20 * 1024 ** 3 }), true);
    assert.equal(sameDataLimit(on, { enabled: true, bytes: 10 * 1024 ** 3 }), false);
    assert.equal(sameDataLimit(on, { enabled: false, bytes: null }), false);
    assert.equal(sameDataLimit(on, { enabled: true, bytes: null }), null, "on, with a size the router did not say");
    assert.equal(sameDataLimit({ enabled: false, bytes: null, alertPercent: null }, { enabled: false, bytes: 123 }), true);
    assert.equal(sameDataLimit(on, null), null);
    assert.equal(sameDataLimit(on, { enabled: null, bytes: null }), null);
  });
});
