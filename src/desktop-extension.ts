import type { Writable } from "node:stream";
import { resolveDaemonMcpUrl } from "./lan-address.ts";
import { type BridgeHints, type BridgeProcess, BRIDGE_NOT_SET_UP, McpStdioBridge, refusingForwarder, runStdioProcess } from "./mcp-stdio-bridge.ts";

/**
 * The Claude Desktop extension (an MCP Bundle, built by scripts/build-mcpb.ts): the stdio bridge, run by Claude
 * Desktop's own Node. Desktop starts it with the two settings the person entered when installing it, as environment
 * variables: MCP_DAEMON_URL (the FengSui MCP address) and API_TOKEN (kept in the system keychain, marked sensitive
 * in the manifest). Those two variables are all it reads: no file, no other variable, so a `.env` on the computer
 * changes nothing. Like `cpe-dash mcp` it keeps no state and never talks to the router: every request goes to the
 * daemon's `/mcp`, which queues it with the daemon's own sessions.
 *
 * The packed file holds this module, the bridge and the address checks only (test/mcpb.test.ts reads the bundle).
 */

/** Where the person changes the two settings. */
export const EXTENSION_SETTINGS_PLACE = "Claude Desktop → Settings → Extensions → FengSui";

/** How the address and token are named in the messages, as the settings form names them. */
const ADDRESS = "the FengSui MCP address";
/** The longest token taken: far above any FengSui token, well under what an HTTP header holds. */
const MAX_TOKEN_LENGTH = 4096;
/** What a Bearer token can be made of: visible ASCII, nothing a header could not carry. */
const TOKEN_CHARACTERS = /^[\x21-\x7e]+$/;

export type ExtensionSettings = { ok: true; daemonUrl: string; apiToken: string } | { ok: false; problem: string };

/** A value Desktop did not fill in reaches the process as its `${user_config.…}` placeholder. */
function setting(value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  return trimmed.startsWith("${") ? "" : trimmed;
}

/**
 * The extension's two settings, checked as `cpe-dash mcp` checks MCP_DAEMON_URL: http(s) on a LAN, private or
 * Tailscale host, without credentials, query or fragment. A problem never quotes the token.
 */
export function readExtensionSettings(env: Readonly<Record<string, string | undefined>>): ExtensionSettings {
  const rawUrl = setting(env["MCP_DAEMON_URL"]);
  if (!rawUrl) return { ok: false, problem: `${ADDRESS} is empty` };
  let daemonUrl: string;
  try {
    daemonUrl = resolveDaemonMcpUrl(rawUrl, "", 0, ADDRESS);
  } catch (err) {
    // new URL() throws a TypeError for text that is not a URL
    const problem = err instanceof TypeError ? `${ADDRESS} is not a URL` : err instanceof Error ? err.message : String(err);
    return { ok: false, problem };
  }
  const apiToken = setting(env["API_TOKEN"]);
  if (!apiToken) return { ok: false, problem: "the token is empty" };
  if (apiToken.length > MAX_TOKEN_LENGTH || !TOKEN_CHARACTERS.test(apiToken)) {
    return { ok: false, problem: "the token has characters a FengSui token never has (copy it again, without spaces)" };
  }
  return { ok: true, daemonUrl, apiToken };
}

/** The error every request gets while the settings are unusable. */
function notSetUp(problem: string): string {
  return `FengSui extension is not set up: ${problem}. In ${EXTENSION_SETTINGS_PLACE}, enter the address of FengSui's MCP server by the IP of the machine it runs on, on your LAN or Tailscale (such as http://100.64.0.10:18384/mcp), and a token from FengSui's Settings → Tokens & AI.`;
}

/** The daemon runs on another machine (a NAS): nothing to start here, but the network and the token to check. */
const EXTENSION_HINTS: BridgeHints = {
  unreachable: `Check that FengSui is running and that this computer reaches that address on your LAN or Tailscale; the address is set in ${EXTENSION_SETTINGS_PLACE}.`,
  unauthorized: `FengSui did not accept the token: create one under Settings → Tokens & AI in the FengSui console, and enter it in ${EXTENSION_SETTINGS_PLACE}.`,
};

/** The parts of `process` the extension uses: its stdio, the environment Desktop passes, the log on stderr. */
export interface ExtensionProcess extends BridgeProcess {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stderr: Writable;
}

/** Run the extension on `proc` until Desktop closes stdin. `fetchImpl` is for tests. */
export function startDesktopExtension(proc: ExtensionProcess, deps: { fetchImpl?: typeof fetch } = {}): void {
  const log = (line: string): void => {
    proc.stderr.write(`${line}\n`);
  };
  const settings = readExtensionSettings(proc.env);
  if (!settings.ok) {
    const message = notSetUp(settings.problem);
    log(`[fengsui-mcpb] ${message}`);
    runStdioProcess(refusingForwarder(BRIDGE_NOT_SET_UP, message), proc, log);
    return;
  }
  const bridge = new McpStdioBridge({
    daemonUrl: settings.daemonUrl,
    apiToken: settings.apiToken,
    log,
    hints: EXTENSION_HINTS,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });
  log(`[fengsui-mcpb] ready -> ${bridge.daemonUrl} (stdio bridge: no router session in this process)`);
  runStdioProcess(bridge, proc, log);
}
