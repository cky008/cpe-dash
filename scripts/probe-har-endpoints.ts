import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { sanitizeFreeText, sanitizeJsonPayload, sanitizeXml } from "../src/sanitize.ts";

interface HarHeader {
  name?: unknown;
  value?: unknown;
}

interface HarContent {
  size?: unknown;
  mimeType?: unknown;
  text?: unknown;
  encoding?: unknown;
}

interface HarRequest {
  method?: unknown;
  url?: unknown;
  headers?: unknown;
  postData?: unknown;
}

interface HarResponse {
  status?: unknown;
  headers?: unknown;
  content?: unknown;
}

interface HarEntry {
  request?: unknown;
  response?: unknown;
}

interface EndpointSummary {
  path: string;
  methods: Set<string>;
  hits: number;
  encryptedModes: Set<string>;
  reqHeaders: Set<string>;
  payloadFormat: "xml" | "json" | "aes-gcm-hex" | "empty/other";
  tagsOrKeys: string[];
  sanitizedSample: string;
}

const FOCUS_KEYWORDS = [
  "carrier",
  "seccell",
  "cell",
  "neighbor",
  "nbrcell",
  "signal",
  "ri",
  "traffic",
  "month_statistics",
  "start_date",
  "daily-data",
  "host",
  "topology",
  "net-mode",
  "antenna",
  "wlandbho",
  "static-addr",
  "profiles",
  "state-login",
] as const;

const INTERESTING_REQ_HEADERS = new Set([
  "__requestverificationtoken",
  "_responsesource",
  "x-requested-with",
  "update-cookie",
  "content-type",
]);

function parseArgs(argv: ReadonlyArray<string>): { harPath?: string; jsonOut?: string } {
  const result: { harPath?: string; jsonOut?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--har" && argv[i + 1]) {
      result.harPath = argv[++i];
    } else if (arg?.startsWith("--har=")) {
      result.harPath = arg.slice(6);
    } else if (arg === "--out" && argv[i + 1]) {
      result.jsonOut = argv[++i];
    }
  }
  return result;
}

function decodeHarBody(content: HarContent | undefined): string {
  if (!content || typeof content.text !== "string") return "";
  if (content.encoding === "base64") {
    return Buffer.from(content.text, "base64").toString("utf8");
  }
  return content.text;
}

function detectFormat(body: string): EndpointSummary["payloadFormat"] {
  const t = body.trim();
  if (!t) return "empty/other";
  if (t.startsWith("<")) return "xml";
  if (t.startsWith("{") || t.startsWith("[")) return "json";
  if (t.length >= 64 && t.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(t)) return "aes-gcm-hex";
  return "empty/other";
}

function extractTopTagsOrKeys(body: string, fmt: EndpointSummary["payloadFormat"]): string[] {
  const trimmed = body.trim();
  if (fmt === "xml") {
    const seen = new Set<string>();
    for (const m of trimmed.matchAll(/<([A-Za-z0-9_:-]+)>/g)) {
      const tag = m[1];
      if (tag && tag !== "response" && tag !== "error") {
        seen.add(tag);
      }
      if (seen.size >= 24) break;
    }
    return [...seen];
  }
  if (fmt === "json") {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      const sampleObj = Array.isArray(parsed) ? (parsed[0] as unknown) : parsed;
      if (sampleObj && typeof sampleObj === "object") {
        return Object.keys(sampleObj as Record<string, unknown>).slice(0, 24);
      }
    } catch {
      return [];
    }
  }
  return [];
}

function sanitizeSampleBody(
  body: string,
  fmt: EndpointSummary["payloadFormat"],
  secrets: ReadonlyArray<string>
): string {
  const trimmed = body.trim();
  if (!trimmed) return "";
  if (fmt === "aes-gcm-hex") {
    return `<AES-256-GCM_HEX len=${trimmed.length}>`;
  }
  if (fmt === "xml") {
    const clean = sanitizeXml(trimmed, secrets).replace(/\s+/g, " ");
    return clean.length > 360 ? `${clean.slice(0, 360)}...` : clean;
  }
  if (fmt === "json") {
    const clean = sanitizeJsonPayload(trimmed, secrets);
    return clean.length > 360 ? `${clean.slice(0, 360)}...` : clean;
  }
  return sanitizeFreeText(trimmed.slice(0, 200), secrets);
}

function main(): void {
  const cli = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();
  const harPath = cli.harPath || cfg.cpeHarPath;
  if (!harPath) {
    console.error("Usage: npm run probe:har -- --har <path-to-har> (or set CPE_HAR_PATH in .env)");
    process.exit(1);
  }

  const resolvedHar = path.resolve(harPath);
  if (!fs.existsSync(resolvedHar)) {
    console.error(`HAR archive not found at: ${resolvedHar}`);
    process.exit(1);
  }

  const secrets = [cfg.cpePassword, cfg.apiToken, cfg.dataEncryptionKey].filter(
    (s) => Boolean(s) && s.length >= 4
  );

  const rawText = fs.readFileSync(resolvedHar, "utf8");
  const parsedRoot: unknown = JSON.parse(rawText);
  if (!parsedRoot || typeof parsedRoot !== "object" || !("log" in parsedRoot)) {
    throw new Error("Invalid HAR JSON root structure (missing .log)");
  }
  const logObj = (parsedRoot as { log?: { entries?: unknown } }).log;
  const entries = Array.isArray(logObj?.entries) ? (logObj.entries as HarEntry[]) : [];

  const apiMap = new Map<string, EndpointSummary>();
  const configPaths = new Set<string>();
  const jsDeclaredApis = new Set<string>();
  let jsBundleCount = 0;

  for (const entry of entries) {
    const req = (entry.request ?? {}) as HarRequest;
    const res = (entry.response ?? {}) as HarResponse;
    const rawUrl = typeof req.url === "string" ? req.url : "";
    if (!rawUrl) continue;

    let urlObj: URL;
    try {
      urlObj = new URL(rawUrl);
    } catch {
      continue;
    }

    const pathname = urlObj.pathname;
    const method = typeof req.method === "string" ? req.method.toUpperCase() : "GET";
    const resBody = decodeHarBody(res.content as HarContent | undefined);

    if (pathname.endsWith(".js") && resBody) {
      jsBundleCount += 1;
      for (const m of resBody.matchAll(/["'`](\/?api\/[a-zA-Z0-9_/-]+)["'`]/g)) {
        const rawRoute = m[1];
        if (rawRoute) {
          jsDeclaredApis.add(rawRoute.startsWith("/") ? rawRoute : `/${rawRoute}`);
        }
      }
      continue;
    }

    if (pathname.startsWith("/config/") && pathname.endsWith(".xml")) {
      configPaths.add(pathname);
      continue;
    }

    if (!pathname.startsWith("/api/")) continue;

    let item = apiMap.get(pathname);
    const fmt = detectFormat(resBody);
    if (!item) {
      item = {
        path: pathname,
        methods: new Set<string>(),
        hits: 0,
        encryptedModes: new Set<string>(),
        reqHeaders: new Set<string>(),
        payloadFormat: fmt,
        tagsOrKeys: [],
        sanitizedSample: "",
      };
      apiMap.set(pathname, item);
    }

    item.methods.add(method);
    item.hits += 1;
    const encType = urlObj.searchParams.get("enc-type");
    if (encType) {
      item.encryptedModes.add(`enc-type=${encType}`);
    }

    if (Array.isArray(req.headers)) {
      for (const h of req.headers as HarHeader[]) {
        const hName = typeof h.name === "string" ? h.name.toLowerCase() : "";
        if (INTERESTING_REQ_HEADERS.has(hName) && typeof h.name === "string") {
          item.reqHeaders.add(h.name);
        }
      }
    }

    if (resBody && (!item.sanitizedSample || item.payloadFormat === "empty/other")) {
      item.payloadFormat = fmt;
      item.tagsOrKeys = extractTopTagsOrKeys(resBody, fmt);
      item.sanitizedSample = sanitizeSampleBody(resBody, fmt, secrets);
    }
  }

  const sortedApis = [...apiMap.values()].sort((a, b) => a.path.localeCompare(b.path));
  const focusMatches = sortedApis.filter((ep) => {
    const lp = ep.path.toLowerCase();
    return FOCUS_KEYWORDS.some((kw) => lp.includes(kw));
  });

  console.log("=== [FengSui Probe #1] H168-383 HAR Archive Deconstruction Summary ===");
  console.log(`Total HTTP entries scanned : ${entries.length}`);
  console.log(`Captured /api/* endpoints  : ${sortedApis.length}`);
  console.log(`Captured /config/* XMLs    : ${configPaths.size}`);
  console.log(`Scanned WebUI *.js bundles : ${jsBundleCount}`);
  console.log(`Static /api/* in WebUI JS  : ${jsDeclaredApis.size}`);
  console.log("");
  console.log(`--- Focus Telemetry & Control Endpoints (${focusMatches.length}) ---`);
  for (const ep of focusMatches) {
    const methods = [...ep.methods].join("/");
    const enc = ep.encryptedModes.size > 0 ? ` [${[...ep.encryptedModes].join(",")}]` : "";
    const fields = ep.tagsOrKeys.slice(0, 12).join(", ");
    console.log(
      `• ${methods.padEnd(8)} ${ep.path.padEnd(36)} hits=${String(ep.hits).padEnd(3)} fmt=${ep.payloadFormat}${enc}`
    );
    if (fields) {
      console.log(`    fields : ${fields}`);
    }
    if (ep.sanitizedSample) {
      console.log(`    sample : ${ep.sanitizedSample}`);
    }
  }

  if (cli.jsonOut) {
    const outPath = path.resolve(cli.jsonOut);
    const serializable = {
      totalEntries: entries.length,
      capturedApiCount: sortedApis.length,
      configXmlPaths: [...configPaths].sort(),
      jsBundleCount,
      jsDeclaredApiPaths: [...jsDeclaredApis].sort(),
      endpoints: sortedApis.map((e) => ({
        path: e.path,
        methods: [...e.methods],
        hits: e.hits,
        encryptedModes: [...e.encryptedModes],
        reqHeaders: [...e.reqHeaders],
        payloadFormat: e.payloadFormat,
        tagsOrKeys: e.tagsOrKeys,
        sanitizedSample: e.sanitizedSample,
      })),
    };
    fs.mkdirSync(path.dirname(outPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(outPath, JSON.stringify(serializable, null, 2), { mode: 0o600 });
    console.log(`\nSanitized JSON inventory written to: ${outPath}`);
  }
}

main();
