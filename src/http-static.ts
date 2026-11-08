import fs from "node:fs";
import fsp from "node:fs/promises";
import type { ServerResponse } from "node:http";
import path from "node:path";

const MIME_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

export const STATIC_CSP =
  "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

type SendJson = (res: ServerResponse, statusCode: number, body: unknown) => void;

/**
 * Serve the prebuilt offline frontend from `rootDir` (GET/HEAD only) with a strict CSP. Blocks NUL
 * bytes, dot/`@` path segments (`.env`, `.git`, Synology `@eaDir`), traversal outside the root and
 * symlinks that resolve outside it.
 */
export async function serveStaticAsset(
  res: ServerResponse,
  method: string,
  pathname: string,
  rootDir: string,
  sendJson: SendJson
): Promise<void> {
  if (method !== "GET" && method !== "HEAD") {
    sendJson(res, 405, { ok: false, errorCode: "METHOD_NOT_ALLOWED", message: "Static assets support GET/HEAD only" });
    return;
  }
  if (!fs.existsSync(rootDir)) {
    sendJson(res, 404, {
      ok: false,
      errorCode: "STATIC_ROOT_NOT_FOUND",
      message: "Frontend assets not built yet; REST API and /api/events SSE are online",
    });
    return;
  }

  const relPath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  if (relPath.includes("\0")) {
    sendJson(res, 400, { ok: false, errorCode: "BAD_PATH", message: "Invalid path" });
    return;
  }
  if (relPath.split("/").some((seg) => seg.startsWith(".") || seg.startsWith("@"))) {
    sendJson(res, 404, { ok: false, errorCode: "ASSET_NOT_FOUND", message: `Asset not found: ${pathname}` });
    return;
  }

  const realRoot = await fsp.realpath(rootDir);
  const candidate = path.resolve(realRoot, relPath);
  if (candidate !== realRoot && !candidate.startsWith(`${realRoot}${path.sep}`)) {
    sendJson(res, 403, { ok: false, errorCode: "PATH_TRAVERSAL_BLOCKED", message: "Forbidden static path" });
    return;
  }

  let targetFile = candidate;
  try {
    const stat = await fsp.stat(targetFile);
    if (stat.isDirectory()) {
      targetFile = path.join(targetFile, "index.html");
    }
    const realTarget = await fsp.realpath(targetFile);
    if (!realTarget.startsWith(`${realRoot}${path.sep}`) && realTarget !== realRoot) {
      sendJson(res, 403, { ok: false, errorCode: "SYMLINK_ESCAPE_BLOCKED", message: "Forbidden symlink target" });
      return;
    }

    const ext = path.extname(realTarget).toLowerCase();
    const fileBytes = await fsp.readFile(realTarget);
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] ?? "application/octet-stream",
      "Content-Length": String(fileBytes.length),
      "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "Content-Security-Policy": STATIC_CSP,
    });
    if (method === "HEAD") {
      res.end();
    } else {
      res.end(fileBytes);
    }
  } catch {
    sendJson(res, 404, { ok: false, errorCode: "ASSET_NOT_FOUND", message: `Asset not found: ${pathname}` });
  }
}
