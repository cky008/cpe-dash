import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, parseDotEnv } from "../src/config.ts";

/**
 * Zero-Secret, Zero-PII & Pure-TypeScript Repository Gate for `cpe-dash` (FengSui / 烽燧).
 *
 * Scans tracked files, working tree, and full `git log -p --all` history for:
 *   1. Forbidden `.js` / `.mjs` / `.cjs` source files in `src/`, `scripts/`, `test/` or `web/`, and type escapes
 *      (explicit `any`, `@ts-ignore` / `@ts-expect-error` / `@ts-nocheck`) in their TypeScript.
 *   2. Tracked `.env`, `data/*` (except empty `.gitkeep`), `.probe-cache/`, captures (`*.har`, `*.pcap*`, `*.saz`),
 *      contact exports (`*.vcf`), `*.apk*`, `*.dll`, `*.pem`, `*.key`.
 *   3. Literal secrets loaded from `.env` (`CPE_PASSWORD`, `API_TOKEN`, `DATA_ENCRYPTION_KEY`, `TELEGRAM_API`,
 *      `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_IDS`, `WEBHOOK_URL`, `WEBHOOK_SECRET`).
 *   4. Private keys, real tokens, or unredacted 15-digit IMEI/IMSI numbers outside allowed RFC test placeholders.
 */
const HIGH_RISK_PATTERNS: ReadonlyArray<{ name: string; regex: RegExp }> = [
  { name: "PEM Private Key", regex: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
  { name: "Real Telegram Bot Token", regex: /\b\d{8,11}:AA[A-Za-z0-9_-]{30,}\b/ },
  { name: "GitHub Personal Access Token", regex: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
  { name: "AWS Access Key", regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "15-digit IMEI/IMSI candidate", regex: /\b(?:86|35|460|272)\d{12,13}\b/ },
  { name: "19-20 digit ICCID candidate", regex: /\b89\d{17,18}\b/ },
];

/** Hand-written sources: backend, scripts, tests and the web dashboard (its build output lives in dist/). */
const TYPESCRIPT_SOURCE_DIRS = ["src", "scripts", "test", "web"] as const;

/** Escapes from strict typing (铁律一): explicit `any` and directives that silence the compiler. */
export const TYPE_ESCAPES: ReadonlyArray<{ name: string; regex: RegExp }> = [
  {
    name: "explicit any",
    // Annotations, casts, arrays, type arguments and tuples (`Record<string, any>`), return types and unions
    regex: /(?::\s*any\b|\bas\s+any\b|[<,]\s*any\s*[>,\]]|\bany\[\]|=>\s*any\b|\|\s*any\s*(?:[;,)>\]=|]|$)|\bany\s*\|)/,
  },
  { name: "TypeScript suppression directive", regex: /@ts-(?:ignore|expect-error|nocheck)\b/ },
];

/** One explicit type escape: its 1-based line and the rule that caught it. */
export interface TypeEscapeFinding {
  readonly line: number;
  readonly name: string;
}

/** Sources the type-escape scan reads (`.tsx` too, should a view ever use it). */
export function isTypeScriptFile(f: string): boolean {
  return f.endsWith(".ts") || f.endsWith(".tsx");
}


/**
 * Explicit type escapes in one file. Each line is checked on its own, then each pair of lines joined
 * with a space (an annotation split as `x:` + `any`), reported once at the second line.
 */
export function scanTypeEscapes(content: string): TypeEscapeFinding[] {
  const lines = content.split("\n");
  const findings: TypeEscapeFinding[] = [];
  const matchedLineIndices = new Set<number>();

  lines.forEach((line, i) => {
    for (const escape of TYPE_ESCAPES) {
      if (escape.regex.test(line)) {
        findings.push({ line: i + 1, name: escape.name });
        matchedLineIndices.add(i);
      }
    }
  });

  for (let i = 0; i < lines.length - 1; i++) {
    if (matchedLineIndices.has(i) || matchedLineIndices.has(i + 1)) {
      continue;
    }
    const lineA = lines[i] ?? "";
    const lineB = lines[i + 1] ?? "";
    const joined = `${lineA} ${lineB}`;
    for (const escape of TYPE_ESCAPES) {
      if (escape.regex.test(joined)) {
        findings.push({ line: i + 2, name: escape.name });
      }
    }
  }

  return findings;
}


const ALLOWED_PLACEHOLDERS = new Set([
  "1234567890:AAExampleBotTokenFromBotFather",
  "860000000000000",
  "350000000000000",
  "272010000000000",
  "460000000000000",
  "8935301000000000000",
]);

/** Webhook URLs on RFC 2606 documentation domains are placeholders, not secrets. */
function isDocumentationUrl(raw: string): boolean {
  try {
    return /(?:^|\.)example\.(?:com|org|net)$/i.test(new URL(raw).hostname);
  } catch {
    return false;
  }
}

function scanText(label: string, content: string, dynamicSecrets: ReadonlyArray<string>): string[] {
  const issues: string[] = [];

  for (const sec of dynamicSecrets) {
    if (content.includes(sec)) {
      issues.push(`${label}: contains literal secret from local .env`);
    }
  }

  for (const pat of HIGH_RISK_PATTERNS) {
    const matches = content.match(new RegExp(pat.regex.source, "g")) ?? [];
    for (const m of matches) {
      if (!ALLOWED_PLACEHOLDERS.has(m)) {
        issues.push(`${label}: matched ${pat.name}`);
      }
    }
  }

  return issues;
}

/** Files that must never be tracked: secrets, runtime data, captures, contact exports and binaries. */
export function isForbiddenTrackedFile(f: string): boolean {
  const normalized = f.toLowerCase();
  const base = normalized.split(/[/\\]/).pop() ?? normalized;
  return (
    base === ".env" ||
    (base.startsWith(".env.") && base !== ".env.example") ||
    (f.startsWith("data/") && f !== "data/.gitkeep") ||
    f.startsWith(".probe-cache/") ||
    normalized.endsWith(".har") ||
    /\.pcap(?:ng)?(?:\.|$)/i.test(f) ||
    normalized.endsWith(".saz") ||
    normalized.endsWith(".vcf") ||
    normalized.endsWith(".apk") ||
    normalized.includes(".apk.") ||
    normalized.endsWith(".dll") ||
    normalized.endsWith(".exe") ||
    normalized.endsWith(".dex") ||
    normalized.endsWith(".so") ||
    normalized.endsWith(".p12") ||
    normalized.endsWith(".pfx") ||
    normalized.endsWith(".pem") ||
    normalized.endsWith(".key")
  );
}

function main(): void {
  const root = process.cwd();
  const envPath = path.join(root, ".env");
  const rawEnv = fs.existsSync(envPath) ? parseDotEnv(fs.readFileSync(envPath, "utf8")) : {};
  const cfg = loadConfig({ envPath, allowPublicCpeHost: true });

  const dynamicSecrets = Array.from(
    new Set(
      [
        cfg.cpePassword,
        cfg.apiToken,
        cfg.dataEncryptionKey,
        rawEnv["TELEGRAM_API"] ?? "",
        rawEnv["TELEGRAM_BOT_TOKEN"] ?? "",
        cfg.telegramBotToken,
        cfg.webhookSecret,
        isDocumentationUrl(cfg.webhookUrl) ? "" : cfg.webhookUrl,
        // Real Telegram user/group IDs are personal identifiers; short IDs are test fixtures
        ...cfg.telegramChatIds.filter((id) => id.replace(/^-/, "").length >= 7),
      ].filter((s) => Boolean(s) && s.length >= 4 && s !== "your_cpe_admin_password")
    )
  );

  // 1. Check tracked files if commits or staged entries exist
  const trackedFiles = execSync("git ls-files", { encoding: "utf8" })
    .split(/\r?\n/)
    .filter(Boolean);

  const forbiddenTracked = trackedFiles.filter(isForbiddenTrackedFile);
  if (forbiddenTracked.length > 0) {
    console.error("Forbidden sensitive or binary capture files tracked in git:", forbiddenTracked);
    process.exit(1);
  }

  const gitkeepFile = path.join(root, "data", ".gitkeep");
  if (fs.existsSync(gitkeepFile) && fs.readFileSync(gitkeepFile, "utf8").length > 0) {
    console.error("data/.gitkeep must remain empty (0 bytes).");
    process.exit(1);
  }

  // 2. Enforce 100% Pure TypeScript rule (forbid .js/.mjs/.cjs inside src/, scripts/, test/, web/)
  const jsViolations: string[] = [];
  for (const subDir of TYPESCRIPT_SOURCE_DIRS) {
    const absSub = path.join(root, subDir);
    if (!fs.existsSync(absSub)) continue;
    const walkJs = (d: string): void => {
      for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, ent.name);
        if (ent.isDirectory()) {
          walkJs(full);
        } else if (/\.(?:js|mjs|cjs|jsx)$/.test(ent.name)) {
          jsViolations.push(path.relative(root, full));
        }
      }
    };
    walkJs(absSub);
  }
  if (jsViolations.length > 0) {
    console.error("Pure TypeScript violation (.js source files detected):", jsViolations);
    process.exit(1);
  }

  // 2b. Strict TypeScript: no explicit `any` and no compiler suppressions (this file names the patterns)
  const typeEscapes: string[] = [];
  const auditSelf = path.join("scripts", "audit-secrets.ts");
  const walkTs = (d: string): void => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, ent.name);
      const rel = path.relative(root, full);
      if (ent.isDirectory()) {
        walkTs(full);
      } else if (isTypeScriptFile(ent.name) && rel !== auditSelf) {
        for (const finding of scanTypeEscapes(fs.readFileSync(full, "utf8"))) {
          typeEscapes.push(`${rel}:${finding.line} (${finding.name})`);
        }
      }
    }
  };
  for (const subDir of TYPESCRIPT_SOURCE_DIRS) {
    if (fs.existsSync(path.join(root, subDir))) walkTs(path.join(root, subDir));
  }
  if (typeEscapes.length > 0) {
    console.error("Strict TypeScript violation (type escapes detected):", typeEscapes);
    process.exit(1);
  }

  // 3. Scan working-tree files
  const findings: string[] = [];
  const ignoredDirs = new Set([
    ".git",
    "node_modules",
    "dist",
    "data",
    "coverage",
    ".probe-cache",
    "scratch",
    "tmp",
  ]);
  const walk = (dir: string): void => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ignoredDirs.has(ent.name) || ent.name === ".env" || (ent.name.startsWith(".env.") && ent.name !== ".env.example")) {
        continue;
      }
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full);
      } else if (ent.isFile()) {
        const text = fs.readFileSync(full, "utf8");
        findings.push(...scanText(path.relative(root, full), text, dynamicSecrets));
      }
    }
  };
  walk(root);

  // 4. Scan full git commit history if repo has at least one commit
  let hasCommits = false;
  try {
    execSync("git rev-parse --verify HEAD", { stdio: "ignore" });
    hasCommits = true;
  } catch {
    hasCommits = false;
  }
  if (hasCommits) {
    const gitHistory = execSync("git log -p --all", {
      maxBuffer: 512 * 1024 * 1024,
      encoding: "utf8",
    });
    findings.push(...scanText("git-history", gitHistory, dynamicSecrets));
  }

  if (findings.length > 0) {
    console.error("Secret / PII Audit Failed:");
    for (const f of findings) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.log(
    `Secret, PII & Pure-TS Audit Passed (${trackedFiles.length} tracked files${hasCommits ? " + full git history" : ""} clean).`
  );
}

// Run as `npm run audit:secrets`; importing the module (tests) only exposes the rules
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main();
}
