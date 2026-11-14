/**
 * `fileURLToPath` for the live demo's bundle (scripts/build-web.ts puts it in place of `node:url`).
 * Modules find their files next to themselves through `import.meta.url`; in the page that is the
 * script's own address, whose path then names a file of the demo's in-memory file system (./fs.ts).
 */
export function fileURLToPath(input: string | URL): string {
  const url = typeof input === "string" ? new URL(input) : input;
  return decodeURIComponent(url.pathname);
}

export function pathToFileURL(input: string): URL {
  return new URL(`file://${input.startsWith("/") ? "" : "/"}${input}`);
}

export default { fileURLToPath, pathToFileURL };
