import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as esbuild from "esbuild";
import { DOCS_SITE } from "../web/src/core/help.ts";
import { type JsonSchema, validateJsonSchema } from "./json-schema.ts";
import { type ZipEntry, writeZip } from "./zip.ts";

/**
 * `npm run build:mcpb`: the Claude Desktop extension, dist/fengsui-<version>.mcpb (an MCP Bundle: a zip with a
 * manifest.json). See docs/dev/sources.md §24 for the format and where each rule here comes from.
 *
 * - server/index.js: src/desktop-extension.ts and what it imports (the stdio bridge and the LAN address checks),
 *   bundled by esbuild into one ES module, with no source map. The build fails if any other module gets in.
 * - manifest.json: written from package.json (name, version, licence, the Node of `engines`), then checked against
 *   the official schema (mcpb/mcpb-manifest-v0.3.schema.json, unchanged from modelcontextprotocol/mcpb) and the
 *   checks `mcpb validate` adds to it (icon, entry point, variables), plus ours (a sensitive setting is text).
 * - icon.png / icon-dark.png from mcpb/ (`npm run brand:icon` draws them from the logo), FengSui's LICENSE, and a
 *   package.json that marks server/index.js as an ES module.
 *
 * The archive is stored (scripts/zip.ts) with a fixed timestamp, so the same sources give the same bytes.
 */

const ROOT = path.resolve(import.meta.dirname, "..");

/** Where Desktop finds the server inside the bundle. */
export const ENTRY_POINT = "server/index.js";
/** The files of the bundle, in archive order. */
export const BUNDLE_FILES = ["manifest.json", "package.json", ENTRY_POINT, "icon.png", "icon-dark.png", "LICENSE"] as const;
/** The esbuild entry: the extension started on the real process. */
const ENTRY_NAME = "mcpb-entry.ts";
/**
 * Every module that may end up in server/index.js: the bridge and nothing of the daemon (no scheduler, router
 * client, store or configuration loader). A new import fails the build until it is reviewed and added here.
 */
export const BUNDLE_INPUTS = [ENTRY_NAME, "src/desktop-extension.ts", "src/lan-address.ts", "src/mcp-stdio-bridge.ts", "src/http-body.ts", "src/json-safe.ts", "src/mcp-headers.ts"] as const;

const MANIFEST_VERSION = "0.3";
const SCHEMA_FILE = path.join(ROOT, "mcpb", "mcpb-manifest-v0.3.schema.json");

export interface PackageJson {
  name: string;
  version: string;
  license: string;
  author: string;
  engines: { node: string };
  repository: { url: string };
}

export type Manifest = Record<string, unknown>;

export function readPackageJson(): PackageJson {
  return JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as PackageJson;
}

/** The repository as a browser opens it (package.json writes it the npm way, `git+https://….git`). */
function repositoryUrl(pkg: PackageJson): string {
  return pkg.repository.url.replace(/^git\+/, "").replace(/\.git$/, "");
}

/** The extension's manifest. Everything that changes with a release comes from package.json. */
export function extensionManifest(pkg: PackageJson): Manifest {
  const repo = repositoryUrl(pkg);
  return {
    manifest_version: MANIFEST_VERSION,
    name: "fengsui",
    display_name: "FengSui 烽燧",
    version: pkg.version,
    description: "Connect Claude to FengSui, the self-hosted console for your 4G / 5G router: its signal, history and SMS, read-only unless you allow more.",
    long_description: [
      "FengSui (烽燧) is a self-hosted console for 4G / 5G routers that runs on your own NAS or computer. Its built-in MCP server lets Claude read the router's signal, nearby cells, history and SMS, and, only where you allow it, change the router.",
      "This extension connects Claude Desktop to that server. It runs no server of its own and never talks to the router: it forwards each request to FengSui's MCP address on your LAN or Tailscale, with the token you enter. Desktop keeps the token in your system keychain.",
      "**Before you install:** FengSui must be running (for example in Docker on a NAS) and this computer must reach it. In FengSui, create a token under Settings → Tokens & AI. A token with nothing ticked reads the router and changes nothing.",
      "The tools that change the router stay off until you turn them on in FengSui and give the token that permission.",
    ].join("\n\n"),
    author: { name: pkg.author, url: `https://github.com/${pkg.author}` },
    repository: { type: "git", url: repo },
    homepage: repo,
    documentation: `${DOCS_SITE}en/docs/agents/`,
    support: `${repo}/issues`,
    icon: "icon.png",
    icons: [
      { src: "icon.png", size: "512x512", theme: "light" },
      { src: "icon-dark.png", size: "512x512", theme: "dark" },
    ],
    server: {
      type: "node",
      entry_point: ENTRY_POINT,
      mcp_config: {
        command: "node",
        args: [`\${__dirname}/${ENTRY_POINT}`],
        // The only two variables the extension reads (src/desktop-extension.ts)
        env: { MCP_DAEMON_URL: "${user_config.daemon_url}", API_TOKEN: "${user_config.api_token}" },
      },
    },
    tools_generated: true,
    keywords: ["router", "4g", "5g", "lte", "signal", "sms", "self-hosted", "nas"],
    license: pkg.license,
    compatibility: {
      platforms: ["darwin", "win32", "linux"],
      runtimes: { node: pkg.engines.node },
    },
    user_config: {
      daemon_url: {
        type: "string",
        title: "FengSui MCP address · 烽燧 MCP 地址",
        description:
          "FengSui's MCP address, by the IP of the machine FengSui runs on, on your LAN or Tailscale: for example http://192.168.8.10:18384/mcp or http://100.64.0.10:18384/mcp. Use an IP, not a domain name: only LAN, private and Tailscale addresses are accepted. 填运行烽燧那台机器在局域网或 Tailscale 里的 IP，例如 http://100.64.0.10:18384/mcp；不要填域名。",
        required: true,
      },
      api_token: {
        type: "string",
        title: "Token · 令牌",
        description:
          "A token from FengSui's Settings → Tokens & AI. One with nothing ticked reads the router and changes nothing. Desktop keeps it in your system keychain. 在烽燧的「设置 → 令牌与 AI」里生成；不勾任何权限的令牌只能读取，不能改动路由器。令牌保存在系统钥匙串里。",
        sensitive: true,
        required: true,
      },
    },
  };
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** The variables Desktop replaces in mcp_config (MCPB 2.1.2, src/node/validate.ts `VALID_VARIABLE_PATTERN`). */
const VALID_VARIABLE = /^\$\{(__dirname|pathSeparator|\/|user_config\..+)\}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Everything wrong with the bundle (empty when it is fine): the official schema, then what `mcpb validate` checks
 * beyond it (a manifest version; icons relative, present and PNG; the entry point present and a script; only the
 * variables Desktop replaces), and two of ours: each `${user_config.…}` is declared, and only text is sensitive.
 */
export function checkBundle(manifest: Manifest, files: ReadonlyMap<string, Uint8Array>): string[] {
  const schema = JSON.parse(fs.readFileSync(SCHEMA_FILE, "utf8")) as JsonSchema;
  const problems = validateJsonSchema(schema, manifest);
  if (manifest["manifest_version"] === undefined && manifest["dxt_version"] === undefined) problems.push("manifest_version is missing");
  const icons = [manifest["icon"], ...(Array.isArray(manifest["icons"]) ? manifest["icons"].map((icon: unknown) => (isRecord(icon) ? icon["src"] : undefined)) : [])];
  for (const icon of icons) {
    if (typeof icon !== "string") continue;
    const data = files.get(icon);
    if (path.isAbsolute(icon) || icon.includes("${")) problems.push(`icon ${icon} must be a path inside the bundle`);
    else if (!data) problems.push(`icon ${icon} is not in the bundle`);
    else if (!Buffer.from(data.subarray(0, 8)).equals(PNG_SIGNATURE)) problems.push(`icon ${icon} is not a PNG`);
  }
  const server = isRecord(manifest["server"]) ? manifest["server"] : {};
  const entry = server["entry_point"];
  if (typeof entry === "string") {
    if (!files.has(entry)) problems.push(`entry point ${entry} is not in the bundle`);
    else if (server["type"] === "node" && !/\.(?:js|mjs|cjs)$/.test(entry)) problems.push(`entry point ${entry} is not a script`);
  }
  const userConfig = isRecord(manifest["user_config"]) ? manifest["user_config"] : {};
  const mcpConfig = isRecord(server["mcp_config"]) ? server["mcp_config"] : {};
  const strings: Array<[string, unknown]> = [["mcp_config.command", mcpConfig["command"]]];
  if (Array.isArray(mcpConfig["args"])) mcpConfig["args"].forEach((arg: unknown, i: number) => strings.push([`mcp_config.args[${i}]`, arg]));
  if (isRecord(mcpConfig["env"])) for (const [key, value] of Object.entries(mcpConfig["env"])) strings.push([`mcp_config.env.${key}`, value]);
  for (const [where, value] of strings) {
    if (typeof value !== "string") continue;
    for (const [variable] of value.matchAll(/\$\{[^}]+\}/g)) {
      if (!VALID_VARIABLE.test(variable)) problems.push(`${variable} in ${where} is not a variable Desktop replaces`);
      const key = /^\$\{user_config\.(.+)\}$/.exec(variable)?.[1];
      if (key !== undefined && !(key in userConfig)) problems.push(`user_config.${key} is not declared (used in ${where})`);
    }
  }
  for (const [key, option] of Object.entries(userConfig)) {
    if (isRecord(option) && option["sensitive"] === true && option["type"] !== "string") problems.push(`user_config.${key} is sensitive but not a string`);
  }
  return problems;
}

export interface BuiltMcpb {
  file: string;
  manifest: Manifest;
  /** The modules bundled into server/index.js, relative to the repository. */
  inputs: string[];
  sha256: string;
}

/** Build, check and write dist/fengsui-<version>.mcpb (or into `outDir`). */
export async function buildMcpb(opts: { outDir?: string } = {}): Promise<BuiltMcpb> {
  const pkg = readPackageJson();
  const result = await esbuild.build({
    stdin: {
      contents: 'import { startDesktopExtension } from "./src/desktop-extension.ts";\nstartDesktopExtension(process);\n',
      resolveDir: ROOT,
      sourcefile: ENTRY_NAME,
      loader: "ts",
    },
    absWorkingDir: ROOT,
    bundle: true,
    platform: "node",
    format: "esm",
    target: `node${pkg.engines.node.replace(/^>=\s*/, "")}`,
    sourcemap: false,
    legalComments: "none",
    charset: "utf8",
    metafile: true,
    write: false,
    logLevel: "silent",
    banner: {
      js: `// FengSui (烽燧) ${pkg.version}: the Claude Desktop extension's stdio bridge to FengSui's MCP server.\n// Built from src/desktop-extension.ts of ${repositoryUrl(pkg)} (${pkg.license}).`,
    },
  });
  const inputs = Object.keys(result.metafile.inputs);
  const stray = inputs.filter((input) => !(BUNDLE_INPUTS as ReadonlyArray<string>).includes(input));
  if (stray.length > 0) throw new Error(`the extension would carry modules it must not: ${stray.join(", ")} (only the bridge belongs in it; see BUNDLE_INPUTS)`);
  const server = result.outputFiles[0];
  if (!server || result.outputFiles.length !== 1) throw new Error("esbuild did not produce exactly one file");

  const manifest = extensionManifest(pkg);
  const contents: Record<(typeof BUNDLE_FILES)[number], Uint8Array> = {
    "manifest.json": Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
    "package.json": Buffer.from(`${JSON.stringify({ name: manifest["name"], version: pkg.version, private: true, type: "module", license: pkg.license }, null, 2)}\n`),
    [ENTRY_POINT]: server.contents,
    "icon.png": fs.readFileSync(path.join(ROOT, "mcpb", "icon.png")),
    "icon-dark.png": fs.readFileSync(path.join(ROOT, "mcpb", "icon-dark.png")),
    LICENSE: fs.readFileSync(path.join(ROOT, "LICENSE")),
  };
  const entries: ZipEntry[] = BUNDLE_FILES.map((name) => ({ name, data: contents[name] }));
  const problems = checkBundle(manifest, new Map(entries.map((e) => [e.name, e.data])));
  if (problems.length > 0) throw new Error(`the extension's manifest does not pass the MCP Bundle checks:\n  - ${problems.join("\n  - ")}`);

  const archive = writeZip(entries);
  const outDir = opts.outDir ?? path.join(ROOT, "dist");
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `fengsui-${pkg.version}.mcpb`);
  fs.writeFileSync(file, archive);
  return { file, manifest, inputs, sha256: crypto.createHash("sha256").update(archive).digest("hex") };
}

async function main(): Promise<void> {
  const built = await buildMcpb();
  const size = fs.statSync(built.file).size;
  process.stdout.write(`[build:mcpb] ${path.relative(ROOT, built.file)} (${(size / 1024).toFixed(1)} KiB, sha256 ${built.sha256})\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main().catch((err: unknown) => {
    process.stderr.write(`[build:mcpb] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
