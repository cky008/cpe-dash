import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  canonicalizeRateLimitBucketKey,
  isAllowedHttpHostHeader,
  loadConfig,
  normalizeCpeUrl,
  resolveClientIp,
  resolveRequestSecureScheme,
} from "../src/config.ts";
import {
  SUPPORTED_LOCALES,
  getFlatCatalog,
  getLocaleCatalog,
  normalizeLocale,
  t,
  verifyLocaleParity,
} from "../src/i18n.ts";

describe("Phase 2 config hardening: CIDR XFF, /64 rate-limit key, DNS rebinding & URL fragment guard", () => {
  it("strips benign SPA hashes while rejecting suspicious URL fragment smuggling in normalizeCpeUrl", () => {
    assert.equal(normalizeCpeUrl("http://192.168.8.1/#/home"), "http://192.168.8.1");
    assert.throws(() => normalizeCpeUrl("http://192.168.8.1/#@attacker.example?x=1"), /fragment/i);
  });

  it("supports CIDR ranges in trustedProxies via net.BlockList and rejects malformed XFF hops", () => {
    // Docker bridge subnet 172.16.0.0/12 trusted -> extracts real LAN client IP
    const ipFromCidrProxy = resolveClientIp(
      "::ffff:172.18.0.2",
      "192.168.8.55, 172.18.0.1",
      ["127.0.0.1", "::1", "172.16.0.0/12"]
    );
    assert.equal(ipFromCidrProxy, "192.168.8.55");

    // Malformed / injected XFF hop stops traversal safely instead of poisoning rate-limit key
    const malformedHop = resolveClientIp(
      "127.0.0.1",
      "spoofed-garbage-token, 192.168.8.88",
      ["127.0.0.1"]
    );
    assert.equal(malformedHop, "192.168.8.88");

    const allGarbage = resolveClientIp("127.0.0.1", "not-an-ip", ["127.0.0.1"]);
    assert.equal(allGarbage, "127.0.0.1");
  });

  it("canonicalizes IPv6 addresses to /64 prefix for SLAAC-resistant rate limiting", () => {
    const k1 = canonicalizeRateLimitBucketKey("2001:db8:abcd:0012:1111:2222:3333:4444");
    const k2 = canonicalizeRateLimitBucketKey("2001:db8:abcd:12:aaaa:bbbb:cccc:dddd");
    assert.equal(k1, k2);
    assert.equal(k1, "2001:0db8:abcd:0012::/64");
    assert.equal(canonicalizeRateLimitBucketKey("192.168.8.20"), "192.168.8.20");
  });

  it("honors X-Forwarded-Proto: https only when peer matches trustedProxies", () => {
    assert.equal(resolveRequestSecureScheme(false, "192.168.8.99", "https", ["127.0.0.1"]), false);
    assert.equal(resolveRequestSecureScheme(false, "127.0.0.1", "https", ["127.0.0.1"]), true);
    assert.equal(resolveRequestSecureScheme(true, "192.168.8.99", undefined, []), true);
  });

  it("blocks DNS rebinding Host headers while allowing LAN, Tailscale, localhost and ALLOWED_HOSTS", () => {
    assert.equal(isAllowedHttpHostHeader("192.168.8.10:18384", []), true);
    assert.equal(isAllowedHttpHostHeader("localhost:18384", []), true);
    assert.equal(isAllowedHttpHostHeader("ds923.tailnet.ts.net:18384", []), true);
    assert.equal(isAllowedHttpHostHeader("[::1]:18384", []), true);
    assert.equal(isAllowedHttpHostHeader("evil-rebind.attacker.example:18384", []), false);
    assert.equal(isAllowedHttpHostHeader("", []), false);
    assert.equal(
      isAllowedHttpHostHeader("cpe.example.com:18384", ["cpe.example.com"]),
      true
    );
  });

  it("loads extended Phase 2 AppConfig defaults cleanly", () => {
    const cfg = loadConfig({
      envPath: "/nonexistent/.env",
      ignoreProcessEnv: true,
      overrides: {
        CPE_URL: "http://192.168.8.1",
        CPE_PASSWORD: "test_dummy_password",
        DEFAULT_LOCALE: "en",
        ALLOWED_HOSTS: "cpe.example.com, nas.local",
      },
    });
    assert.equal(cfg.defaultLocale, "en");
    assert.deepEqual(cfg.allowedHosts, ["cpe.example.com", "nas.local"]);
    assert.equal(cfg.webPort, 18384);
    assert.equal(cfg.mcpHttpEnabled, true);
    assert.equal(cfg.redactSensitiveInApi, true);
  });
});

describe("zero-dependency strongly-typed i18n engine", () => {
  it("verifies 100% key parity between zh-CN.json and en.json", () => {
    const parity = verifyLocaleParity();
    assert.deepEqual(parity.missingInEn, []);
    assert.deepEqual(parity.missingInZh, []);
    assert.ok(parity.totalKeys >= 40);
  });

  it("normalizes locale inputs safely and blocks path-traversal strings", () => {
    assert.equal(normalizeLocale("zh-CN"), "zh-CN");
    assert.equal(normalizeLocale("zh-Hans-CN"), "zh-CN");
    assert.equal(normalizeLocale("en"), "en");
    assert.equal(normalizeLocale("en-US,en;q=0.9"), "en");
    assert.equal(normalizeLocale("../../etc/passwd"), "zh-CN");
    assert.equal(normalizeLocale(undefined), "zh-CN");
    assert.deepEqual(SUPPORTED_LOCALES, ["zh-CN", "en"]);
  });

  it("interpolates {params} deterministically and stores catalogs in null-prototype maps", () => {
    assert.equal(
      t("zh-CN", "session.mode_yielding"),
      "用户正在使用 CPE 后台，监控自动避让中"
    );
    assert.equal(
      t("en", "rf.ca_active", { count: 3, bandwidth: 140 }),
      "3CA Active (140 MHz)"
    );
    assert.equal(
      t("zh-CN", "auth.rate_limited", { seconds: 45 }),
      "请求过于频繁，请在 45 秒后重试"
    );

    const flat = getFlatCatalog("zh-CN");
    assert.equal(Object.getPrototypeOf(flat), null);
    const nested = getLocaleCatalog("en");
    assert.equal(Object.getPrototypeOf(nested), null);
  });
});
