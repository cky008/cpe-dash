import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import type { AppConfig } from "./types.ts";

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export interface LoadConfigOptions {
  envPath?: string;
  overrides?: Record<string, string>;
  ignoreProcessEnv?: boolean;
  allowPublicCpeHost?: boolean;
}

export interface NormalizeUrlOptions {
  allowPublicHost?: boolean;
}

/**
 * Check whether an IPv4 address belongs to RFC 1918, RFC 6598 (CGNAT/Tailscale 100.64.0.0/10),
 * Loopback (127.0.0.0/8), or Link-Local (169.254.0.0/16).
 */
export function isPrivateOrLanIpv4(ip: string): boolean {
  const parts = ip.split(".");
  if (parts.length !== 4) return false;
  const octets = parts.map((p) => Number.parseInt(p, 10));
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = octets as [number, number, number, number];
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

/**
 * Check whether an IPv6 address is Loopback (`::1`), ULA (`fc00::/7`), or Link-Local (`fe80::/10`),
 * or an IPv4-mapped private IPv6 (`::ffff:192.168.x.x`).
 */
export function isPrivateOrLanIpv6(rawIp: string): boolean {
  const ip = rawIp.replace(/^\[|\]$/g, "").split("%")[0]?.toLowerCase() ?? "";
  if (!ip || net.isIP(ip) !== 6) return false;
  if (ip === "::1") return true;
  if (ip.startsWith("::ffff:")) {
    return isPrivateOrLanIpv4(ip.slice(7));
  }
  const firstHextet = Number.parseInt(ip.split(":")[0] || "0", 16);
  if ((firstHextet & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
  if ((firstHextet & 0xffc0) === 0xfe80) return true; // fe80::/10 Link-Local
  return false;
}

/**
 * Validate that a CPE target hostname is a safe private/LAN/local target to prevent SSRF.
 */
export function isAllowedCpeHost(hostname: string): boolean {
  const clean = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!clean) return false;
  if (clean === "localhost" || clean.endsWith(".local") || clean.endsWith(".lan") || clean.endsWith(".internal") || clean.endsWith(".ts.net")) {
    return true;
  }
  const ipVersion = net.isIP(clean);
  if (ipVersion === 4) return isPrivateOrLanIpv4(clean);
  if (ipVersion === 6) return isPrivateOrLanIpv6(clean);
  // Single-label LAN hostnames (e.g. "homerouter" or "cpe")
  if (/^[a-z0-9-]+$/.test(clean)) return true;
  return false;
}

/**
 * Parse a `.env` file string into a prototype-free dictionary without mutating `process.env`.
 */
export function parseDotEnv(content: string): Record<string, string> {
  const result = Object.create(null) as Record<string, string>;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const cleaned = line.startsWith("export ") ? line.slice(7).trim() : line;
    const eqIdx = cleaned.indexOf("=");
    if (eqIdx <= 0) continue;
    const key = cleaned.slice(0, eqIdx).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || FORBIDDEN_KEYS.has(key)) continue;
    let value = cleaned.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      const quote = value[0];
      value = value.slice(1, -1);
      if (quote === '"') {
        value = value.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
      }
    } else {
      const commentIdx = value.indexOf(" #");
      if (commentIdx >= 0) {
        value = value.slice(0, commentIdx).trim();
      }
    }
    result[key] = value;
  }
  return result;
}

/**
 * Normalize and SSRF-validate CPE base URL:
 * - Restricts protocol to `http:` or `https:`.
 * - Rejects embedded credentials (`user:pass@host`) and query strings.
 * - Enforces private/LAN host allowlist unless `allowPublicHost` is explicitly enabled.
 */
export function normalizeCpeUrl(rawUrl: string, opts: NormalizeUrlOptions = {}): string {
  let url = (rawUrl || "http://192.168.8.1").trim();
  if (!/^https?:\/\//i.test(url)) {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
      throw new Error(`Unsupported CPE_URL protocol in "${rawUrl}" (only http/https allowed)`);
    }
    url = `http://${url}`;
  }
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Unsupported CPE_URL protocol "${parsed.protocol}"`);
  }
  if (parsed.username || parsed.password) {
    throw new Error("CPE_URL must not embed credentials; configure CPE_USERNAME/CPE_PASSWORD in .env");
  }
  if (parsed.search) {
    throw new Error("CPE_URL must not contain query parameters");
  }
  if (!opts.allowPublicHost && !isAllowedCpeHost(parsed.hostname)) {
    throw new Error(
      `SSRF guard blocked non-private CPE_URL host "${parsed.hostname}"; expected LAN/RFC1918/Tailscale address`
    );
  }
  return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, "")}`;
}

/**
 * Extract authentic client IP for rate-limiting/auditing without allowing `X-Forwarded-For` spoofing.
 * Only honors `X-Forwarded-For` when the direct TCP socket peer matches `trustedProxies`.
 */
export function resolveClientIp(
  socketRemoteAddress: string | undefined,
  xForwardedFor: string | undefined,
  trustedProxies: ReadonlyArray<string>
): string {
  const peer = normalizeSocketIp(socketRemoteAddress ?? "");
  if (!peer) return "unknown";
  const trusted = new Set(trustedProxies.map(normalizeSocketIp).filter(Boolean));
  if (!trusted.has(peer) || !xForwardedFor) {
    return peer;
  }
  const chain = xForwardedFor
    .split(",")
    .map((ip) => normalizeSocketIp(ip.trim()))
    .filter(Boolean);
  // Walk right-to-left through proxy hops to find the right-most untrusted client IP
  for (let i = chain.length - 1; i >= 0; i--) {
    const hop = chain[i]!;
    if (!trusted.has(hop)) {
      return hop;
    }
  }
  return chain[0] ?? peer;
}

function normalizeSocketIp(ip: string): string {
  const trimmed = ip.trim();
  if (trimmed.startsWith("::ffff:")) {
    const v4 = trimmed.slice(7);
    if (net.isIP(v4) === 4) return v4;
  }
  return trimmed;
}

function parseBool(val: string | undefined, defaultValue: boolean): boolean {
  if (val === undefined || val === "") return defaultValue;
  const v = val.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return defaultValue;
}

function parseIntSafe(val: string | undefined, defaultValue: number): number {
  if (val === undefined || val === "") return defaultValue;
  const n = Number.parseInt(val, 10);
  return Number.isFinite(n) ? n : defaultValue;
}

/**
 * Load strongly-typed `AppConfig` from `.env` and `process.env`.
 */
export function loadConfig(options: LoadConfigOptions = {}): AppConfig {
  const envPath = options.envPath ?? path.resolve(process.cwd(), ".env");
  let fileEnv: Record<string, string> = Object.create(null) as Record<string, string>;
  if (fs.existsSync(envPath)) {
    fileEnv = parseDotEnv(fs.readFileSync(envPath, "utf8"));
  }

  const get = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      if (options.overrides?.[k] !== undefined && options.overrides[k] !== "") {
        return options.overrides[k];
      }
      if (!options.ignoreProcessEnv && process.env[k] !== undefined && process.env[k] !== "") {
        return process.env[k];
      }
      if (fileEnv[k] !== undefined && fileEnv[k] !== "") {
        return fileEnv[k];
      }
    }
    return undefined;
  };

  const cpeUrl = normalizeCpeUrl(get("CPE_URL", "CPE_HOST") ?? "http://192.168.8.1", {
    allowPublicHost: Boolean(options.allowPublicCpeHost),
  });
  const cpeUsername = get("CPE_USERNAME", "CPE_USER") ?? "admin";
  const cpePassword = get("CPE_PASSWORD", "CPEPASSWORD") ?? "";
  const dataEncryptionKey = get("DATA_ENCRYPTION_KEY") ?? cpePassword;
  const apiToken = get("API_TOKEN") ?? cpePassword;

  const rawTrusted = get("TRUSTED_PROXIES") ?? "127.0.0.1,::1";
  const trustedProxies = rawTrusted
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const webEnabled = parseBool(get("WEB_ENABLED", "WEB_UI_ENABLED"), true);
  const webPort = Math.max(0, parseIntSafe(get("WEB_PORT"), 18384));
  const webHost = get("WEB_HOST") ?? "0.0.0.0";

  const pollIntervalMs = Math.max(1000, parseIntSafe(get("POLL_INTERVAL_MS"), 5000));
  const neighborScanIntervalMs = Math.max(
    10000,
    parseIntSafe(get("NEIGHBOR_SCAN_INTERVAL_MS"), 60000)
  );
  const requestTimeoutMs = Math.max(3000, parseIntSafe(get("REQUEST_TIMEOUT_MS"), 15000));
  const respectBrowserSession = parseBool(get("RESPECT_BROWSER_SESSION"), true);

  const stateFile = path.resolve(process.cwd(), get("STATE_FILE") ?? "./data/state.json");
  const cpeHarPath = get("CPE_HAR_PATH") ?? "";

  return {
    cpeUrl,
    cpeUsername,
    cpePassword,
    dataEncryptionKey,
    apiToken,
    trustedProxies,
    webEnabled,
    webPort,
    webHost,
    pollIntervalMs,
    neighborScanIntervalMs,
    requestTimeoutMs,
    respectBrowserSession,
    stateFile,
    cpeHarPath,
  };
}
