import net from "node:net";

/**
 * Which hosts count as the household's own network: private, LAN, loopback, link-local and Tailscale addresses,
 * and the names that only resolve there. `config.ts` uses these for the router's URL (SSRF), the HTTP `Host`
 * check and the stdio bridge's daemon URL; the Claude Desktop extension (`desktop-extension.ts`) carries this
 * module and the bridge only, so it imports nothing but `node:net`.
 */

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
 * The serve daemon's `/mcp` URL for the stdio bridge. An explicit `MCP_DAEMON_URL` must be http(s)
 * on a private/LAN/loopback host without credentials, query or fragment (the bridge sends the
 * Bearer API_TOKEN there); otherwise the URL is derived from `WEB_HOST` / `WEB_PORT`. `label` names
 * the setting in the errors (the Claude Desktop extension calls it the FengSui MCP address).
 */
export function resolveDaemonMcpUrl(raw: string | undefined, webHost: string, webPort: number, label = "MCP_DAEMON_URL"): string {
  if (raw?.trim()) {
    const parsed = new URL(raw.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`${label} must use http(s), got "${parsed.protocol}"`);
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error(`${label} must not contain credentials, a query or a fragment`);
    }
    if (!isAllowedCpeHost(parsed.hostname)) {
      throw new Error(`${label} host "${parsed.hostname}" is not a private/LAN address`);
    }
    return `${parsed.origin}${parsed.pathname === "/" ? "/mcp" : parsed.pathname}`;
  }
  const wildcard = !webHost || webHost === "0.0.0.0" || webHost === "::";
  const host = wildcard ? "127.0.0.1" : webHost.includes(":") ? `[${webHost}]` : webHost;
  return `http://${host}:${webPort}/mcp`;
}
