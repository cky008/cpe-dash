/**
 * POSIX `node:path` as far as the daemon's stores and its dictionary loader use it, for the live demo's
 * bundle (scripts/build-web.ts puts it in place of `node:path`); paths there name files of the demo's
 * in-memory file system (./fs.ts), whose working directory is `/`.
 */

export const sep = "/";

function normalizeParts(input: string): string {
  const out: string[] = [];
  for (const part of input.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return `/${out.join("/")}`;
}

export function resolve(...segments: string[]): string {
  let joined = "";
  for (const segment of segments) {
    if (segment === "") continue;
    joined = segment.startsWith("/") ? segment : `${joined}/${segment}`;
  }
  return normalizeParts(joined.startsWith("/") ? joined : `/${joined}`);
}

export function join(...segments: string[]): string {
  const joined = segments.filter((segment) => segment !== "").join("/");
  if (joined === "") return ".";
  const absolute = joined.startsWith("/");
  const normal = normalizeParts(joined);
  return absolute ? normal : normal.slice(1) || ".";
}

export function dirname(input: string): string {
  const trimmed = input.length > 1 ? input.replace(/\/+$/, "") : input;
  const at = trimmed.lastIndexOf("/");
  if (at < 0) return ".";
  if (at === 0) return "/";
  return trimmed.slice(0, at);
}

export function basename(input: string, ext?: string): string {
  const trimmed = input.length > 1 ? input.replace(/\/+$/, "") : input;
  const base = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  return ext !== undefined && ext !== base && base.endsWith(ext) ? base.slice(0, base.length - ext.length) : base;
}

export default { basename, dirname, join, resolve, sep };
