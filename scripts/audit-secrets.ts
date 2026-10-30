import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, parseDotEnv } from "../src/config.ts";

/**
 * Zero-Secret, Zero-PII & Pure-TypeScript Repository Gate for `cpe-dash` (FengSui / 烽燧).
 *
 * Scans tracked files, working tree, and full `git log -p --all` history for:
 *   1. Forbidden `.js` / `.mjs` / `.cjs` source files in `src/`, `scripts/`, or `test/`.
 *   2. Tracked `.env`, `data/*` (except empty `.gitkeep`), `.probe-cache/`, `*.har`, `*.apk*`, `*.dll`, `*.pem`.
 *   3. Literal secrets loaded from `.env` (`CPE_PASSWORD`, `API_TOKEN`, `DATA_ENCRYPTION_KEY`, `TELEGRAM_API`).
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

const ALLOWED_PLACEHOLDERS = new Set([
  "1234567890:AAExampleBotTokenFromBotFather",
  "860000000000000",
  "350000000000000",
  "272010000000000",
  "460000000000000",
  "8935301000000000000",
]);

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
      ].filter((s) => Boolean(s) && s.length >= 4 && s !== "your_cpe_admin_password")
    )
  );

  // 1. Check tracked files if commits or staged entries exist
  const trackedFiles = execSync("git ls-files", { encoding: "utf8" })
    .split(/\r?\n/)
    .filter(Boolean);

  const forbiddenTracked = trackedFiles.filter(
    (f) =>
      f === ".env" ||
      (f.startsWith(".env.") && f !== ".env.example") ||
      (f.startsWith("data/") && f !== "data/.gitkeep") ||
      f.startsWith(".probe-cache/") ||
      f.endsWith(".har") ||
      f.endsWith(".pcap") ||
      f.endsWith(".apk") ||
      f.includes(".apk.") ||
      f.endsWith(".dll") ||
      f.endsWith(".pem") ||
      f.endsWith(".key")
  );
  if (forbiddenTracked.length > 0) {
    console.error("Forbidden sensitive or binary capture files tracked in git:", forbiddenTracked);
    process.exit(1);
  }

  const gitkeepFile = path.join(root, "data", ".gitkeep");
  if (fs.existsSync(gitkeepFile) && fs.readFileSync(gitkeepFile, "utf8").length > 0) {
    console.error("data/.gitkeep must remain empty (0 bytes).");
    process.exit(1);
  }

  // 2. Enforce 100% Pure TypeScript rule (forbid .js/.mjs/.cjs inside src/, scripts/, test/)
  const jsViolations: string[] = [];
  for (const subDir of ["src", "scripts", "test"]) {
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
      maxBuffer: 64 * 1024 * 1024,
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

main();
