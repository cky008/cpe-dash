import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import {
  canonicalizeRateLimitBucketKey,
  isAllowedCpeHost,
  isPrivateOrLanIpv4,
  isPrivateOrLanIpv6,
  loadConfig,
  normalizeCpeUrl,
  parseDotEnv,
  resolveClientIp,
} from "../src/config.ts";
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  computeScram,
  curve25519Mul,
  generateEccSession,
  huaweiXssDecode,
  huaweiXssEncode,
  stripInvalidControlChars,
  timingSafeEqualString,
  verifyPubkeySignature,
} from "../src/crypto.ts";
import { StorageCipher } from "../src/encrypted-file.ts";
import {
  inspectFieldFormat,
  maskMacAddress,
  sanitizeFreeText,
  sanitizeIpToken,
  sanitizeJsonPayload,
  sanitizeXml,
} from "../src/sanitize.ts";
import {
  MAX_XML_BYTES,
  buildXmlRequest,
  escapeXmlBasic,
  formatHuaweiDate,
  getXmlBlocks,
  getXmlTag,
  jsonToXml,
  parseXmlError,
  xmlToFlatRecord,
} from "../src/xml.ts";
import { removeTempDir, tempDir } from "./helpers/temp-dir.ts";

describe("config & SSRF / XFF security guards", () => {
  it("parses .env lines, quotes, exports, inline comments, and blocks prototype pollution keys", () => {
    const parsed = parseDotEnv(`
      # comment
      CPE_URL=http://192.168.8.1 # router gateway
      export CPE_PASSWORD="line1\\n\\"quoted\\\\"
      SINGLE_QUOTED='literal\\n'
      __proto__=polluted
      constructor=polluted
      INVALID-KEY=ignored
    `);
    assert.equal(Object.getPrototypeOf(parsed), null);
    assert.equal(parsed["CPE_URL"], "http://192.168.8.1");
    assert.equal(parsed["CPE_PASSWORD"], 'line1\n"quoted\\');
    assert.equal(parsed["SINGLE_QUOTED"], "literal\\n");
    assert.equal(Object.hasOwn(parsed, "__proto__"), false);
    assert.equal(Object.hasOwn(parsed, "constructor"), false);
  });

  it("validates RFC1918, Tailscale CGNAT, loopback, and IPv6 ULA/Link-Local addresses", () => {
    assert.equal(isPrivateOrLanIpv4("192.168.8.1"), true);
    assert.equal(isPrivateOrLanIpv4("10.0.0.1"), true);
    assert.equal(isPrivateOrLanIpv4("172.20.1.5"), true);
    assert.equal(isPrivateOrLanIpv4("100.100.10.20"), true);
    assert.equal(isPrivateOrLanIpv4("127.0.0.1"), true);
    assert.equal(isPrivateOrLanIpv4("169.254.1.1"), true);
    assert.equal(isPrivateOrLanIpv4("8.8.8.8"), false);
    assert.equal(isPrivateOrLanIpv4("999.1.1.1"), false);
    assert.equal(isPrivateOrLanIpv4("not-an-ip"), false);

    assert.equal(isPrivateOrLanIpv6("::1"), true);
    assert.equal(isPrivateOrLanIpv6("fd12:3456::1"), true);
    assert.equal(isPrivateOrLanIpv6("fe80::1%en0"), true);
    assert.equal(isPrivateOrLanIpv6("::ffff:192.168.8.1"), true);
    assert.equal(isPrivateOrLanIpv6("2001:4860:4860::8888"), false);
    assert.equal(isPrivateOrLanIpv6("invalid"), false);

    assert.equal(isAllowedCpeHost("192.168.8.1"), true);
    assert.equal(isAllowedCpeHost("cpe.local"), true);
    assert.equal(isAllowedCpeHost("nas.tailnet.ts.net"), true);
    assert.equal(isAllowedCpeHost("homerouter"), true);
    assert.equal(isAllowedCpeHost("example.com"), false);
    assert.equal(isAllowedCpeHost(""), false);
  });

  it("enforces SSRF checks in normalizeCpeUrl", () => {
    assert.equal(normalizeCpeUrl("192.168.8.1/#/home"), "http://192.168.8.1");
    assert.equal(normalizeCpeUrl("https://192.168.8.1:8443/sub/"), "https://192.168.8.1:8443/sub");
    assert.throws(() => normalizeCpeUrl("ftp://192.168.8.1"), /Unsupported CPE_URL protocol/);
    assert.throws(() => normalizeCpeUrl("http://admin:secret@192.168.8.1"), /embed credentials/);
    assert.throws(() => normalizeCpeUrl("http://192.168.8.1?x=1"), /query parameters/);
    assert.throws(() => normalizeCpeUrl("http://example.com"), /SSRF guard blocked/);
    assert.equal(normalizeCpeUrl("http://example.com", { allowPublicHost: true }), "http://example.com");
  });

  it("prevents X-Forwarded-For spoofing unless peer matches trustedProxies", () => {
    assert.equal(
      resolveClientIp("192.168.8.50", "1.2.3.4", ["127.0.0.1"]),
      "192.168.8.50"
    );
    assert.equal(
      resolveClientIp("::ffff:127.0.0.1", "198.51.100.25, 127.0.0.1", ["127.0.0.1"]),
      "198.51.100.25"
    );
    assert.equal(resolveClientIp(undefined, "198.51.100.25", ["127.0.0.1"]), "unknown");
  });

  it("loads typed AppConfig from a temporary .env file", () => {
    const tmpDir = tempDir("cpe-dash-cfg-");
    const envFile = path.join(tmpDir, ".env");
    fs.writeFileSync(
      envFile,
      [
        "CPE_URL=http://192.168.8.1",
        "CPE_PASSWORD=test_fixture_pwd",
        "WEB_PORT=18384",
        "WEB_ENABLED=false",
        "RESPECT_BROWSER_SESSION=yes",
        "POLL_INTERVAL_MS=3000",
      ].join("\n"),
      "utf8"
    );
    try {
      const cfg = loadConfig({ envPath: envFile, ignoreProcessEnv: true });
      assert.equal(cfg.cpeUrl, "http://192.168.8.1");
      assert.equal(cfg.cpePassword, "test_fixture_pwd");
      assert.equal(cfg.webPort, 18384);
      assert.equal(cfg.webEnabled, false);
      assert.equal(cfg.respectBrowserSession, true);
      assert.equal(cfg.pollIntervalMs, 3000);
    } finally {
      removeTempDir(tmpDir);
    }
  });
});

describe("crypto primitives (Curve25519, SCRAM-SHA256, AES-256-GCM, XSS)", () => {
  it("computes commutative Curve25519 ECDH shared secrets and validates inputs", () => {
    assert.equal(curve25519Mul(0n, 9n), 0n);
    const serverPriv = BigInt("0x09112233445566778899aabbccddeeff00112233445566778899aabbccddeeff");
    const serverPubHex = curve25519Mul(serverPriv, 9n).toString(16);
    const ecc = generateEccSession(serverPubHex);
    assert.equal(ecc.clientPubHex.length, 64);
    assert.equal(ecc.shareKeyHex.length, 64);

    const serverShared = curve25519Mul(serverPriv, BigInt(`0x${ecc.clientPubHex}`)).toString(16);
    assert.equal(ecc.shareKeyHex, serverShared);

    assert.throws(() => generateEccSession("not_hex"), /Invalid CPE ECC/);
    assert.throws(() => generateEccSession("01"), /Rejected weak CPE ECC/);
  });

  it("computes SCRAM-SHA256 proofs, pubkey HMAC verification, and constant-time equality", () => {
    const salt = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
    const proof = computeScram("fixture_pass", salt, 100, "aaaa", "aaaabbbb");
    assert.equal(proof.clientProofHex.length, 64);
    assert.equal(proof.expectedServerSig.length, 64);

    assert.throws(() => computeScram("p", "zz", 100, "a", "b"), /Invalid SCRAM salt/);
    assert.throws(() => computeScram("p", salt, 0, "a", "b"), /Invalid SCRAM iteration/);

    assert.equal(verifyPubkeySignature("", proof.serverKey, "abcd"), false);
    assert.equal(timingSafeEqualString("alpha", "alpha"), true);
    assert.equal(timingSafeEqualString("alpha", "bravo"), false);
    assert.equal(timingSafeEqualString("alpha", "alpha_longer"), false);
  });

  it("round-trips Huawei AES-256-GCM XML payloads and rejects malformed ciphertext", () => {
    const key = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const xml = "<response><Signal>-82dBm</Signal><Band>N78</Band></response>";
    assert.equal(aesGcmEncrypt("", key), "");
    const enc = aesGcmEncrypt(xml, key);
    assert.equal(aesGcmDecrypt(enc, key), xml);

    const errEnc = aesGcmEncrypt("<error><code>100003</code></error>", key);
    assert.equal(aesGcmDecrypt(errEnc, key), "<error><code>100003</code></error>");
    assert.throws(() => aesGcmDecrypt("short", key), /Invalid AES-GCM/);
  });

  it("encodes and decodes Huawei XSS entities and strips control characters", () => {
    const raw = `A&B <tag> "q" 's' / (1)`;
    const encoded = huaweiXssEncode(raw);
    assert.equal(encoded.includes("<"), false);
    assert.equal(huaweiXssDecode(encoded), raw);
    assert.equal(huaweiXssEncode(42), "42");
    assert.equal(huaweiXssDecode("&#65;&#x42;"), "AB");
    assert.equal(stripInvalidControlChars("ok\x00\x07\nnext"), "ok\nnext");
  });
});

describe("xml linear codec & prototype-pollution / size defenses", () => {
  it("extracts tags, repeater blocks, flat records, and XML errors safely", () => {
    const sample = `<?xml version="1.0"?><response><Empty/><Band>N78</Band><List><Item><Pci>120</Pci></Item><Item><Pci>345</Pci></Item></List><__proto__>bad</__proto__></response>`;
    assert.equal(getXmlTag(sample, "Empty"), "");
    assert.equal(getXmlTag(sample, "band"), "N78");
    assert.equal(getXmlTag(sample, "Missing"), null);

    const items = getXmlBlocks(sample, "Item");
    assert.equal(items.length, 2);
    assert.equal(getXmlTag(items[1]!, "Pci"), "345");

    const flat = xmlToFlatRecord(sample);
    assert.equal(Object.getPrototypeOf(flat), null);
    assert.equal(flat["Band"], "N78");
    assert.equal(flat["Empty"], "");
    assert.equal(Object.hasOwn(flat, "__proto__"), false);

    const err = parseXmlError(
      `<error><code>108006</code><message>bad</message><remaincount>2</remaincount><waittime>60</waittime></error>`
    );
    assert.deepEqual(err, { code: "108006", message: "bad", remainCount: 2, waitTime: 60 });
    assert.equal(parseXmlError("<response>OK</response>"), null);
  });

  it("builds requests, formats dates, escapes XML, and enforces tag/size limits", () => {
    const req = buildXmlRequest({ Mode: "00", Bands: { Band: ["B1", "B3"] }, Ignored: null });
    assert.equal(
      req,
      `<?xml version="1.0" encoding="UTF-8"?><request><Mode>00</Mode><Bands><Band>B1</Band><Band>B3</Band></Bands></request>`
    );
    assert.equal(escapeXmlBasic(`a&b<c>"'`), "a&amp;b&lt;c&gt;&quot;&#39;");
    assert.match(formatHuaweiDate(new Date("2026-10-30T12:34:56Z")), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    assert.throws(() => jsonToXml("__proto__", "x"), /Invalid or unsafe/);
    assert.throws(() => getXmlTag("x".repeat(MAX_XML_BYTES + 10), "a"), /maximum allowed size/);
  });
});

describe("sanitizer & StorageCipher", () => {
  it("redacts IMEI, IMSI, MAC, WAN IP, TAC, CellID, hostnames, and secrets while keeping RF physics", () => {
    const fakeImei = `86${"1234567890123"}`;
    const fakeImsi = `272${"019876543210"}`;
    const rawXml = [
      "<response>",
      "<DeviceName>H168-383</DeviceName>",
      `<Imei>${fakeImei}</Imei>`,
      `<Imsi>${fakeImsi}</Imsi>`,
      "<MacAddress1>AA:BB:CC:DD:EE:FF</MacAddress1>",
      "<WanIPAddress>89.101.202.33</WanIPAddress>",
      "<WanIPv6Address>2a02:8084:1234::99</WanIPv6Address>",
      "<tac>49152</tac>",
      "<cell_id>12345678</cell_id>",
      "<HostName>Personal-MacBook</HostName>",
      "<Ssid>HomeSecretWiFi</Ssid>",
      "<WpaPsk>MySecretPass123</WpaPsk>",
      "<band>78</band>",
      "<rsrp>-81dBm</rsrp>",
      "<CurrentDownloadRate>12500000</CurrentDownloadRate>",
      "</response>",
    ].join("");

    const clean = sanitizeXml(rawXml, ["MySecretPass123"]);
    assert.equal(clean.includes(fakeImei), false);
    assert.equal(clean.includes(fakeImsi), false);
    assert.equal(clean.includes("AA:BB:CC:DD:EE:FF"), false);
    assert.equal(clean.includes("89.101.202.33"), false);
    assert.equal(clean.includes("2a02:8084"), false);
    assert.equal(clean.includes("49152"), false);
    assert.equal(clean.includes("12345678"), false);
    assert.equal(clean.includes("Personal-MacBook"), false);
    assert.equal(clean.includes("HomeSecretWiFi"), false);
    assert.equal(clean.includes("MySecretPass123"), false);

    assert.equal(getXmlTag(clean, "DeviceName"), "H168-383");
    assert.equal(getXmlTag(clean, "WanIPAddress"), "198.51.100.42");
    assert.equal(getXmlTag(clean, "WanIPv6Address"), "2001:db8::42");
    assert.equal(getXmlTag(clean, "rsrp"), "-81dBm");
    assert.equal(getXmlTag(clean, "CurrentDownloadRate"), "12500000");

    assert.equal(maskMacAddress("11:22:33:44:55:66", 3), "00:00:5E:00:53:03");
    assert.equal(sanitizeIpToken("fe80::abcd:1234;2a02:1111::1"), "fe80::1;2001:db8::42");
    assert.equal(
      sanitizeFreeText("url?ecc-client-pubkey=abcdef0123456789abcdef&ip=8.8.4.4"),
      "url?ecc-client-pubkey=<REDACTED_ECC_PUBKEY>&ip=198.51.100.42"
    );

    assert.deepEqual(inspectFieldFormat("tac", "49152"), {
      tag: "tac",
      present: true,
      byteLength: 5,
      encodingHint: "decimal",
    });
    assert.deepEqual(inspectFieldFormat("tac", ""), {
      tag: "tac",
      present: false,
      byteLength: 0,
      encodingHint: "empty",
    });

    const rawJson = JSON.stringify([
      {
        MACAddress: "AA:BB:CC:11:22:33",
        HostName: "Secret-iPhone",
        ActualName: "OwnerPhone",
        IPAddress: "192.168.8.120",
        IPv6Address: "fe80::99;2a02:8084::55",
        InterfaceType: "Wireless",
        Frequency: "5GHz_1",
        rate: 1201,
      },
    ]);
    const cleanJson = sanitizeJsonPayload(rawJson);
    assert.equal(cleanJson.includes("AA:BB:CC:11:22:33"), false);
    assert.equal(cleanJson.includes("Secret-iPhone"), false);
    assert.equal(cleanJson.includes("2a02:8084"), false);
    assert.equal(cleanJson.includes("1201"), true);
    assert.equal(sanitizeJsonPayload("not-json 8.8.8.8"), "not-json 198.51.100.42");
  });

  it("encrypts and decrypts JSON state files at rest with 0600 permissions", () => {
    const tmpDir = tempDir("cpe-dash-cipher-");
    const filePath = path.join(tmpDir, "state.json");
    try {
      assert.throws(() => new StorageCipher(""), /non-empty secret/);
      const cipher = new StorageCipher("unit-test-master-secret");
      cipher.writeJsonFile(filePath, { sample: "telemetry", bands: ["B1", "B3", "N78"] });

      const stat = fs.statSync(filePath);
      assert.equal(stat.mode & 0o777, 0o600);
      const rawDisk = fs.readFileSync(filePath, "utf8");
      assert.equal(rawDisk.includes("telemetry"), false);

      const loaded = cipher.readJsonFile<{ sample: string; bands: string[] }>(filePath);
      assert.deepEqual(loaded, { sample: "telemetry", bands: ["B1", "B3", "N78"] });

      const disabled = StorageCipher.fromSecret("");
      assert.equal(disabled.enabled, false);
      assert.throws(() => disabled.readJsonFile(filePath), /Cannot decrypt/);
    } finally {
      removeTempDir(tmpDir);
    }
  });

  it("defends against Unicode index-shift, nested <error> spoofing, XML injection, and .env double-unescaping", () => {
    // 1. U+0130 ('İ') must NOT shift string indices during ASCII-only case-insensitive tag scan
    const turkishXml = "<response><ssid>İİİİ-5G</ssid><pci>321</pci></response>";
    assert.equal(getXmlTag(turkishXml, "pci"), "321");
    const flat = xmlToFlatRecord(turkishXml);
    assert.equal(flat["pci"], "321");

    // 2. parseXmlError must accept only root <error>, ignoring nested <error> inside <response>
    assert.equal(
      parseXmlError("<response><HostName>test</HostName><error><code>108006</code></error></response>"),
      null
    );
    const rootErr = parseXmlError('<?xml version="1.0" encoding="UTF-8"?><error><code>108006</code><remaincount>2</remaincount></error>');
    assert.equal(rootErr?.code, "108006");
    assert.equal(rootErr?.remainCount, 2);

    // 3. buildXmlRequest escapes XML metacharacters in primitive values once without double-escaping
    const escapedReq = buildXmlRequest({ username: 'admin<&>"' });
    assert.match(escapedReq, /<username>admin&lt;&amp;&gt;&quot;<\/username>/);

    // 4. parseDotEnv single-pass unescape preserves literal backslash+n ("\\n" -> "\n" two chars)
    const parsedEnv = parseDotEnv('LITERAL="foo\\\\nbar"\nNEWLINE="line1\\nline2"');
    assert.equal(parsedEnv["LITERAL"], "foo\\nbar");
    assert.equal(parsedEnv["NEWLINE"], "line1\nline2");

    // 5. canonicalizeRateLimitBucketKey normalizes embedded-IPv4 IPv6 addresses cleanly
    assert.equal(
      canonicalizeRateLimitBucketKey("2001:db8:abcd:12::198.51.100.42"),
      "2001:0db8:abcd:0012::/64"
    );
  });
});
