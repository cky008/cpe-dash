/**
 * Copy-ready MCP client setup for the console's "connect an agent" guide. Pure strings: the token
 * the owner pastes stays in the page (never stored or sent), and the shell command quotes every
 * value so a token with `$`, quotes or spaces cannot turn into shell syntax.
 */

/** Shown until a token is pasted: the read-only token is the one to give an agent. */
export const TOKEN_PLACEHOLDER = "<API_TOKEN_READONLY>";
/** The static demo has no daemon behind it; its guide shows the documentation domain instead. */
export const DEMO_ORIGIN = "https://cpe.example.com";

export function mcpEndpoint(origin: string, demo: boolean): string {
  return `${(demo ? DEMO_ORIGIN : origin).replace(/\/+$/, "")}/mcp`;
}

export function tokenOrPlaceholder(raw: string): string {
  return raw.trim() || TOKEN_PLACEHOLDER;
}

/** For display only (screenshots, screen sharing): the copied text keeps the real token. */
export function maskToken(token: string): string {
  if (token === TOKEN_PLACEHOLDER) return token;
  return `${"•".repeat(8)}${token.length > 8 ? token.slice(-4) : ""}`;
}

/** POSIX single-quoted word: `'` becomes `'\''`. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function claudeCodeCommand(url: string, token: string): string {
  return `claude mcp add --transport http fengsui ${shellQuote(url)} --header ${shellQuote(`Authorization: Bearer ${token}`)}`;
}

/** `mcpServers` entry for remote (Streamable HTTP) clients: `.mcp.json`, Cursor, VS Code, … */
export function mcpJsonConfig(url: string, token: string): string {
  return JSON.stringify({ mcpServers: { fengsui: { type: "http", url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2);
}
