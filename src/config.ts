import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeLocale } from "./i18n.ts";
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
  if (
    clean === "localhost" ||
    clean.endsWith(".local") ||
    clean.endsWith(".lan") ||
    clean.endsWith(".internal") ||
    clean.endsWith(".ts.net")
  ) {
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
 * Validate HTTP `Host` header against private/LAN/Tailscale hostnames and explicit `ALLOWED_HOSTS`
 * to defeat DNS rebinding attacks against `:18384` and `/mcp`.
 */
export function isAllowedHttpHostHeader(
  rawHostHeader: string | undefined,
  allowedHosts: ReadonlyArray<string>
): boolean {
  if (!rawHostHeader) return false;
  const trimmed = rawHostHeader.slice(0, 255).trim().toLowerCase();
  if (!trimmed) return false;

  let hostname = "";
  if (trimmed.startsWith("[")) {
    const closeBracket = trimmed.indexOf("]");
    if (closeBracket <= 1) return false;
    hostname = trimmed.slice(1, closeBracket);
    const rest = trimmed.slice(closeBracket + 1);
    if (rest && !/^:\d{1,5}$/.test(rest)) return false;
  } else {
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx >= 0) {
      const portPart = trimmed.slice(colonIdx + 1);
      if (!/^\d{1,5}$/.test(portPart)) return false;
      hostname = trimmed.slice(0, colonIdx);
    } else {
      hostname = trimmed;
    }
  }

  if (!hostname) return false;
  const allowSet = new Set(allowedHosts.map((h) => h.trim().toLowerCase()).filter(Boolean));
  if (allowSet.has(hostname) || allowSet.has(trimmed)) {
    return true;
  }
  return isAllowedCpeHost(hostname);
}

/**
 * A quoted value followed by a comment (`'a b' # note`) without the comment: the last quote that is followed by
 * whitespace and `#` closes it. One pass from the end, no backtracking pattern; anything else is returned as it is.
 */
function stripCommentAfterQuote(value: string): string {
  const quote = value[0];
  if ((quote !== '"' && quote !== "'") || value.endsWith(quote)) return value;
  for (let i = value.length - 1; i > 0; i--) {
    if (value[i] !== quote) continue;
    const rest = value.slice(i + 1);
    const after = rest.trimStart();
    if (after.startsWith("#") && after.length < rest.length) return value.slice(0, i + 1);
  }
  return value;
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
    let value = stripCommentAfterQuote(cleaned.slice(eqIdx + 1).trim());
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      const quote = value[0];
      value = value.slice(1, -1);
      if (quote === '"') {
        value = value.replace(/\\(["\\n])/g, (_m, ch: string) => (ch === "n" ? "\n" : ch));
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
 * - Rejects embedded credentials (`user:pass@host`), query strings, and `#fragments`.
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
  if (parsed.hash && /[?@\s%]/.test(parsed.hash)) {
    throw new Error("CPE_URL must not contain suspicious URL fragment injection");
  }
  if (!opts.allowPublicHost && !isAllowedCpeHost(parsed.hostname)) {
    throw new Error(
      `SSRF guard blocked non-private CPE_URL host "${parsed.hostname}"; expected LAN/RFC1918/Tailscale address`
    );
  }
  return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, "")}`;
}

function normalizeSocketIp(raw: string): string {
  let ip = raw.slice(0, 128).trim();
  if (!ip) return "";
  if (ip.startsWith("[")) {
    const closeIdx = ip.indexOf("]");
    if (closeIdx > 1) {
      ip = ip.slice(1, closeIdx);
    }
  }
  const pctIdx = ip.indexOf("%");
  if (pctIdx > 0) {
    ip = ip.slice(0, pctIdx);
  }
  const lower = ip.toLowerCase();
  if (lower.startsWith("::ffff:")) {
    const v4Candidate = lower.slice(7);
    if (net.isIP(v4Candidate) === 4) {
      return v4Candidate;
    }
  }
  const ver = net.isIP(lower);
  if (ver === 4 || ver === 6) {
    return lower;
  }
  // Handle IPv4:port in XFF if supplied by a proxy
  const lastColon = lower.lastIndexOf(":");
  if (lastColon > 0 && lower.indexOf(":") === lastColon) {
    const hostOnly = lower.slice(0, lastColon);
    if (net.isIP(hostOnly) === 4) return hostOnly;
  }
  return "";
}

/**
 * Build a `net.BlockList` supporting both single IPv4/IPv6 addresses and CIDR prefixes (`172.16.0.0/12`).
 */
export function buildTrustedProxyBlockList(trustedProxies: ReadonlyArray<string>): net.BlockList {
  const blockList = new net.BlockList();
  for (const entry of trustedProxies) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const slashIdx = trimmed.indexOf("/");
    if (slashIdx > 0) {
      const addr = normalizeSocketIp(trimmed.slice(0, slashIdx));
      const prefix = Number.parseInt(trimmed.slice(slashIdx + 1), 10);
      const ver = net.isIP(addr);
      if (ver === 4 && Number.isInteger(prefix) && prefix >= 0 && prefix <= 32) {
        blockList.addSubnet(addr, prefix, "ipv4");
      } else if (ver === 6 && Number.isInteger(prefix) && prefix >= 0 && prefix <= 128) {
        blockList.addSubnet(addr, prefix, "ipv6");
      }
    } else {
      const addr = normalizeSocketIp(trimmed);
      const ver = net.isIP(addr);
      if (ver === 4) blockList.addAddress(addr, "ipv4");
      else if (ver === 6) blockList.addAddress(addr, "ipv6");
    }
  }
  return blockList;
}

function isIpInBlockList(blockList: net.BlockList, ip: string): boolean {
  const ver = net.isIP(ip);
  if (ver === 4) return blockList.check(ip, "ipv4");
  if (ver === 6) return blockList.check(ip, "ipv6");
  return false;
}

/**
 * Extract authentic client IP for rate-limiting/auditing without allowing `X-Forwarded-For` spoofing.
 * Honors `X-Forwarded-For` ONLY when the direct TCP socket peer matches `trustedProxies` (exact IP or CIDR),
 * and validates every hop via `net.isIP` from right to left.
 */
export function resolveClientIp(
  socketRemoteAddress: string | undefined,
  xForwardedFor: string | undefined,
  trustedProxies: ReadonlyArray<string>
): string {
  const peer = normalizeSocketIp(socketRemoteAddress ?? "");
  if (!peer) return "unknown";
  const trustedList = buildTrustedProxyBlockList(trustedProxies);
  if (!isIpInBlockList(trustedList, peer) || !xForwardedFor) {
    return peer;
  }

  const rawTokens = xForwardedFor.slice(0, 1024).split(",");
  let lastValidTrusted = peer;
  // Walk right-to-left through proxy hops; stop immediately on malformed hop or first untrusted valid IP
  for (let i = rawTokens.length - 1; i >= 0; i--) {
    const hop = normalizeSocketIp(rawTokens[i] ?? "");
    if (!hop) {
      return lastValidTrusted;
    }
    if (!isIpInBlockList(trustedList, hop)) {
      return hop;
    }
    lastValidTrusted = hop;
  }
  return lastValidTrusted;
}

/**
 * Determine whether the incoming HTTP request arrived over HTTPS (either direct TLS socket
 * or `X-Forwarded-Proto: https` from a `trustedProxies` peer).
 */
export function resolveRequestSecureScheme(
  isTlsSocket: boolean,
  socketRemoteAddress: string | undefined,
  xForwardedProto: string | undefined,
  trustedProxies: ReadonlyArray<string>
): boolean {
  if (isTlsSocket) return true;
  if (!xForwardedProto) return false;
  const peer = normalizeSocketIp(socketRemoteAddress ?? "");
  if (!peer) return false;
  const trustedList = buildTrustedProxyBlockList(trustedProxies);
  if (!isIpInBlockList(trustedList, peer)) return false;
  const proto = xForwardedProto.split(",")[0]?.trim().toLowerCase() ?? "";
  return proto === "https";
}

function expandIpv6Hextets(ip: string): string[] | null {
  if (net.isIP(ip) !== 6) return null;
  let normalized = ip;
  try {
    normalized = new URL(`http://[${ip}]`).hostname.slice(1, -1);
  } catch {
    return null;
  }
  const parts = normalized.split("::");
  if (parts.length > 2) return null;
  const left = parts[0] ? parts[0].split(":") : [];
  const right = parts.length === 2 && parts[1] ? parts[1].split(":") : [];
  const missing = 8 - (left.length + right.length);
  if (missing < 0) return null;
  const full = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (full.length !== 8) return null;
  return full.map((h) => h.padStart(4, "0").toLowerCase());
}

/**
 * Collapse IPv6 client addresses to their `/64` prefix so SLAAC privacy-extension address rotation
 * cannot bypass per-client brute-force rate limits.
 */
export function canonicalizeRateLimitBucketKey(clientIp: string): string {
  const clean = normalizeSocketIp(clientIp);
  if (!clean) return "unknown";
  if (net.isIP(clean) === 4) return clean;
  const hextets = expandIpv6Hextets(clean);
  if (!hextets) return clean;
  return `${hextets.slice(0, 4).join(":")}::/64`;
}

/**
 * The serve daemon's `/mcp` URL for the stdio bridge. An explicit `MCP_DAEMON_URL` must be http(s)
 * on a private/LAN/loopback host without credentials, query or fragment (the bridge sends the
 * Bearer API_TOKEN there); otherwise the URL is derived from `WEB_HOST` / `WEB_PORT`.
 */
export function resolveDaemonMcpUrl(raw: string | undefined, webHost: string, webPort: number): string {
  if (raw?.trim()) {
    const parsed = new URL(raw.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`MCP_DAEMON_URL must use http(s), got "${parsed.protocol}"`);
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error("MCP_DAEMON_URL must not contain credentials, a query or a fragment");
    }
    if (!isAllowedCpeHost(parsed.hostname)) {
      throw new Error(`MCP_DAEMON_URL host "${parsed.hostname}" is not a private/LAN address`);
    }
    return `${parsed.origin}${parsed.pathname === "/" ? "/mcp" : parsed.pathname}`;
  }
  const wildcard = !webHost || webHost === "0.0.0.0" || webHost === "::";
  const host = wildcard ? "127.0.0.1" : webHost.includes(":") ? `[${webHost}]` : webHost;
  return `http://${host}:${webPort}/mcp`;
}

/**
 * Canonicalize an IANA time zone (`europe/dublin` -> `Europe/Dublin`). An invalid value from `.env`
 * is a configuration error; an invalid value inherited from the real process environment (e.g. a
 * POSIX `TZ` string set by a container runtime) is left to the process and reported as `null`.
 */
export function resolveTimeZone(raw: string | undefined, opts: { inherited?: boolean } = {}): string | null {
  const value = raw?.trim();
  if (!value) return null;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    if (opts.inherited) return null;
    throw new Error(`Invalid TZ "${value}" (expected an IANA time zone such as Europe/Dublin or UTC)`);
  }
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

/** Minutes for an opt-in automatic action: unset, `0` or invalid is off (`0`), else clamped to [min, max]; returns ms. */
function parseMinutesOrOff(val: string | undefined, min: number, max: number): number {
  const minutes = parseIntSafe(val, 0);
  return minutes > 0 ? Math.min(max, Math.max(min, minutes)) * 60_000 : 0;
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
  const cpeAllowLegacyLoginAfterScram = parseBool(get("CPE_ALLOW_LEGACY_LOGIN_AFTER_SCRAM"), false);
  const cpeRequireEccSignature = parseBool(get("CPE_REQUIRE_ECC_SIGNATURE"), true);
  const tzFromProcess =
    !options.ignoreProcessEnv && Boolean(process.env["TZ"]) && !options.overrides?.["TZ"];
  const timeZone = resolveTimeZone(get("TZ"), { inherited: tzFromProcess });
  const dataEncryptionKey = get("DATA_ENCRYPTION_KEY") ?? cpePassword;
  const apiToken = get("API_TOKEN") ?? cpePassword;
  const apiTokenReadonly = get("API_TOKEN_READONLY") ?? "";
  // A "read-only" token that is really the full token (or the router password) would grant everything
  if (apiTokenReadonly && (apiTokenReadonly === apiToken || apiTokenReadonly === cpePassword)) {
    throw new Error("API_TOKEN_READONLY must differ from API_TOKEN and CPE_PASSWORD");
  }

  const rawTrusted = get("TRUSTED_PROXIES") ?? "127.0.0.1,::1";
  const trustedProxies = rawTrusted
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const rawAllowedHosts = get("ALLOWED_HOSTS") ?? "";
  const allowedHosts = rawAllowedHosts
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const webEnabled = parseBool(get("WEB_ENABLED", "WEB_UI_ENABLED"), true);
  const webPort = Math.max(0, parseIntSafe(get("WEB_PORT"), 18384));
  const webHost = get("WEB_HOST") ?? "0.0.0.0";
  const defaultLocale = normalizeLocale(get("DEFAULT_LOCALE"), "zh-CN");

  const mcpHttpEnabled = parseBool(get("MCP_HTTP_ENABLED"), true);
  const mcpAllowMutations = parseBool(get("MCP_ALLOW_MUTATIONS"), false);
  const mcpAllowAccessControl = parseBool(get("MCP_ALLOW_ACCESS_CONTROL"), false);
  const mcpAllowExperimental = parseBool(get("MCP_ALLOW_EXPERIMENTAL"), false);
  const mcpDaemonUrl = resolveDaemonMcpUrl(get("MCP_DAEMON_URL"), webHost, webPort);
  const peerDiscoveryEnabled = parseBool(get("PEER_DISCOVERY_ENABLED"), false);
  const peerDiscoveryPort = Math.min(65535, Math.max(1, parseIntSafe(get("PEER_DISCOVERY_PORT"), 18385)));
  const sseHeartbeatMs = Math.max(3000, parseIntSafe(get("SSE_HEARTBEAT_MS"), 15000));
  const sseMaxClients = Math.max(1, parseIntSafe(get("SSE_MAX_CLIENTS"), 32));
  const historyRetentionHours = Math.max(1, parseIntSafe(get("HISTORY_RETENTION_HOURS"), 168));
  const stateFlushIntervalMs = Math.max(
    10000,
    parseIntSafe(get("STATE_FLUSH_INTERVAL_MS"), 30 * 60 * 1000)
  );
  const rateLimitWindowMs = Math.max(5000, parseIntSafe(get("RATE_LIMIT_WINDOW_MS"), 60000));
  const rateLimitMaxAuthFailures = Math.max(
    3,
    parseIntSafe(get("RATE_LIMIT_MAX_AUTH_FAILURES"), 8)
  );
  const sessionTtlMs = Math.max(60000, parseIntSafe(get("SESSION_TTL_MS"), 24 * 60 * 60 * 1000));
  const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const distWebPublic = path.join(pkgRoot, "dist", "web", "public");
  const defaultStaticDir = fs.existsSync(distWebPublic)
    ? distWebPublic
    : path.join(pkgRoot, "public");
  const rawStatic = get("STATIC_DIR");
  const staticDir = rawStatic ? path.resolve(process.cwd(), rawStatic) : defaultStaticDir;
  const redactSensitiveInApi = parseBool(get("REDACT_SENSITIVE_IN_API"), true);

  const pollIntervalMs = Math.max(1000, parseIntSafe(get("POLL_INTERVAL_MS"), 5000));
  const neighborScanIntervalMs = Math.max(
    10000,
    parseIntSafe(get("NEIGHBOR_SCAN_INTERVAL_MS"), 60000)
  );
  const requestTimeoutMs = Math.max(3000, parseIntSafe(get("REQUEST_TIMEOUT_MS"), 15000));
  const respectBrowserSession = parseBool(get("RESPECT_BROWSER_SESSION"), true);

  const stateFile = path.resolve(process.cwd(), get("STATE_FILE") ?? "./data/state.json");
  const cpeHarPath = get("CPE_HAR_PATH") ?? "";

  const dataDir = path.dirname(stateFile);
  const dataFile = (key: string, fallbackName: string): string => {
    const raw = get(key);
    return raw ? path.resolve(process.cwd(), raw) : path.join(dataDir, fallbackName);
  };
  // Empty (the default): the daemon takes the country from the SIM's IMSI once it has read it
  const rawCountry = (get("DEFAULT_COUNTRY_CODE") ?? "").trim();
  const defaultCountryCode = /^\+?\d{1,4}$/.test(rawCountry) ? `+${rawCountry.replace(/^\+/, "")}` : "";
  const pickEnum = <T extends string>(raw: string | undefined, allowed: ReadonlyArray<T>, fallback: T): T => {
    const v = raw?.trim().toLowerCase();
    return (allowed as ReadonlyArray<string>).includes(v ?? "") ? (v as T) : fallback;
  };
  const telegramChatIds = (get("TELEGRAM_CHAT_IDS") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^-?\d{1,20}$/.test(s));

  return {
    cpeUrl,
    cpeUsername,
    cpePassword,
    cpeAllowLegacyLoginAfterScram,
    cpeRequireEccSignature,
    timeZone,
    dataEncryptionKey,
    apiToken,
    apiTokenReadonly,
    trustedProxies,
    allowedHosts,
    webEnabled,
    webPort,
    webHost,
    defaultLocale,
    mcpHttpEnabled,
    mcpAllowMutations,
    mcpAllowAccessControl,
    mcpAllowExperimental,
    mcpDaemonUrl,
    peerDiscoveryEnabled,
    peerDiscoveryPort,
    sseHeartbeatMs,
    sseMaxClients,
    historyRetentionHours,
    stateFlushIntervalMs,
    rateLimitWindowMs,
    rateLimitMaxAuthFailures,
    sessionTtlMs,
    staticDir,
    redactSensitiveInApi,
    pollIntervalMs,
    neighborScanIntervalMs,
    requestTimeoutMs,
    respectBrowserSession,
    stateFile,
    cpeHarPath,
    smsEnabled: parseBool(get("SMS_ENABLED"), true),
    defaultCountryCode,
    smsFile: dataFile("SMS_FILE", "sms.json"),
    contactsFile: dataFile("CONTACTS_FILE", "contacts.json"),
    smsFullSyncIntervalMs: Math.max(60_000, parseIntSafe(get("SMS_FULL_SYNC_INTERVAL_MS"), 30 * 60_000)),
    smsSeedExistingOnStart: parseBool(get("SMS_SEED_EXISTING_ON_START"), true),
    smsAutoMarkRead: parseBool(get("SMS_AUTO_MARK_READ"), false),
    smsSendStatusTimeoutMs: Math.min(120_000, Math.max(5000, parseIntSafe(get("SMS_SEND_STATUS_TIMEOUT_MS"), 45_000))),
    telegramBotToken: get("TELEGRAM_BOT_TOKEN") ?? "",
    telegramChatIds,
    telegramApiBase: get("TELEGRAM_API_BASE") ?? "https://api.telegram.org",
    telegramStateFile: dataFile("TELEGRAM_STATE_FILE", "telegram.json"),
    webhookUrl: get("WEBHOOK_URL") ?? "",
    webhookSecret: get("WEBHOOK_SECRET") ?? "",
    alertsEnabled: parseBool(get("ALERTS_ENABLED"), true),
    alertNotifyMinSeverity: pickEnum(get("ALERT_NOTIFY_MIN_SEVERITY"), ["info", "warning", "critical"] as const, "warning"),
    alertRsrpThresholdDbm: parseIntSafe(get("ALERT_RSRP_THRESHOLD_DBM"), -110),
    alertSinrThresholdDb: parseIntSafe(get("ALERT_SINR_THRESHOLD_DB"), 0),
    // A lock needs a few minutes to re-attach and prove itself; anything shorter would undo good locks
    lockRollbackAfterMs: parseMinutesOrOff(get("LOCK_ROLLBACK_AFTER_MIN"), 3, 1440),
    wanReconnectAfterMs: parseMinutesOrOff(get("WAN_AUTO_RECONNECT_AFTER_MIN"), 1, 1440),
    metricsEnabled: parseBool(get("METRICS_ENABLED"), false),
    settingsFile: path.join(path.dirname(stateFile), "settings.json"),
    auditFile: path.join(path.dirname(stateFile), "audit.json"),
    mcpSmsAccess: pickEnum(get("MCP_SMS_ACCESS"), ["none", "read", "full"] as const, "read"),
    mcpSmsSendPolicy: pickEnum(get("MCP_SMS_SEND_POLICY"), ["known", "any"] as const, "known"),
    mcpSmsSendLimitPerHour: Math.max(0, parseIntSafe(get("MCP_SMS_SEND_LIMIT_PER_HOUR"), 10)),
  };
}
