import { Buffer, type BufferEncoding } from "./buffer.ts";
import { basename, dirname, resolve } from "./path.ts";

/**
 * The live demo's file system: in memory, gone when the page reloads (scripts/build-web.ts puts it in
 * place of `node:fs` and `node:fs/promises`). It holds what the daemon's code reads and writes through
 * `fs`: the stores of the data directory (`state.json`, the SMS mirror, the contacts, the audit log,
 * the console settings, Telegram's chats) and the two dictionaries of `locales/` the demo puts there at
 * start (web/src/demo/runtime.ts). Only the calls that code makes are here, with Node's error codes.
 */

const files = new Map<string, string>();
const directories = new Set<string>(["/"]);
interface OpenFile {
  path: string;
  data: string;
}
const handles = new Map<number, OpenFile>();
let nextFd = 3;
let clock = 0;
const modified = new Map<string, number>();

class FsError extends Error {
  readonly code: string;
  constructor(code: string, syscall: string, path: string) {
    super(`${code}: ${syscall} '${path}'`);
    this.code = code;
  }
}

function key(path: string | URL): string {
  return resolve(typeof path === "string" ? path : decodeURIComponent(path.pathname));
}

function store(path: string, data: string): void {
  if (!directories.has(dirname(path))) throw new FsError("ENOENT", "open", path);
  if (directories.has(path)) throw new FsError("EISDIR", "open", path);
  files.set(path, data);
  modified.set(path, Date.now() + ++clock / 1000);
}

function textOf(data: string | ArrayBufferView): string {
  return typeof data === "string" ? data : Buffer.from(data).toString("utf8");
}

/** Put a file in place before the daemon's code starts (the demo's dictionaries). */
export function seedFile(path: string, content: string): void {
  mkdirSync(dirname(key(path)), { recursive: true });
  store(key(path), content);
}

export function existsSync(path: string | URL): boolean {
  const at = key(path);
  return files.has(at) || directories.has(at);
}

export function readFileSync(path: string | URL, options?: BufferEncoding | { encoding?: BufferEncoding }): string | Buffer {
  const at = key(path);
  if (directories.has(at)) throw new FsError("EISDIR", "read", at);
  const data = files.get(at);
  if (data === undefined) throw new FsError("ENOENT", "open", at);
  const encoding = typeof options === "string" ? options : options?.encoding;
  return encoding === undefined ? Buffer.from(data, "utf8") : data;
}

export function writeFileSync(target: string | URL | number, data: string | ArrayBufferView): void {
  if (typeof target === "number") {
    writeSync(target, data);
    return;
  }
  store(key(target), textOf(data));
}

export function mkdirSync(path: string | URL, options: { recursive?: boolean; mode?: number } = {}): void {
  const at = key(path);
  if (directories.has(at)) {
    if (options.recursive) return;
    throw new FsError("EEXIST", "mkdir", at);
  }
  if (files.has(at)) throw new FsError("EEXIST", "mkdir", at);
  const parent = dirname(at);
  if (!directories.has(parent)) {
    if (!options.recursive) throw new FsError("ENOENT", "mkdir", at);
    mkdirSync(parent, { recursive: true });
  }
  directories.add(at);
}

export function openSync(path: string | URL, flags: string = "r", _mode?: number): number {
  const at = key(path);
  if (flags === "r") {
    if (!files.has(at)) throw new FsError("ENOENT", "open", at);
  } else if (flags === "wx") {
    if (files.has(at)) throw new FsError("EEXIST", "open", at);
    store(at, "");
  } else if (flags === "w") {
    store(at, "");
  } else {
    throw new Error(`fs.openSync flag ${flags} is not available in the demo`);
  }
  const fd = nextFd++;
  handles.set(fd, { path: at, data: files.get(at) ?? "" });
  return fd;
}

export function writeSync(fd: number, data: string | ArrayBufferView): number {
  const handle = handles.get(fd);
  if (!handle) throw new FsError("EBADF", "write", String(fd));
  const text = textOf(data);
  handle.data += text;
  store(handle.path, handle.data);
  return text.length;
}

export function fsyncSync(fd: number): void {
  if (!handles.has(fd)) throw new FsError("EBADF", "fsync", String(fd));
}

export function closeSync(fd: number): void {
  if (!handles.delete(fd)) throw new FsError("EBADF", "close", String(fd));
}

export function renameSync(from: string | URL, to: string | URL): void {
  const source = key(from);
  const target = key(to);
  const data = files.get(source);
  if (data === undefined) throw new FsError("ENOENT", "rename", source);
  store(target, data);
  files.delete(source);
  modified.delete(source);
}

export function rmSync(path: string | URL, options: { force?: boolean; recursive?: boolean } = {}): void {
  const at = key(path);
  if (files.delete(at)) {
    modified.delete(at);
    return;
  }
  if (directories.has(at) && options.recursive) {
    for (const name of [...files.keys()]) if (name.startsWith(`${at}/`)) files.delete(name);
    for (const name of [...directories]) if (name === at || name.startsWith(`${at}/`)) directories.delete(name);
    return;
  }
  if (!options.force) throw new FsError("ENOENT", "rm", at);
}

export function readdirSync(path: string | URL): string[] {
  const at = key(path);
  if (!directories.has(at)) throw new FsError("ENOENT", "scandir", at);
  const names = new Set<string>();
  for (const name of [...files.keys(), ...directories]) if (name !== at && dirname(name) === at) names.add(basename(name));
  return [...names].sort();
}

export function statSync(path: string | URL): { isFile(): boolean; isDirectory(): boolean; size: number; mtimeMs: number } {
  const at = key(path);
  const data = files.get(at);
  if (data === undefined && !directories.has(at)) throw new FsError("ENOENT", "stat", at);
  return { isFile: () => data !== undefined, isDirectory: () => data === undefined, size: data?.length ?? 0, mtimeMs: modified.get(at) ?? 0 };
}

/** `fs.promises.open`'s handle, as `AtomicFileWriter` uses it. */
export class FileHandle {
  readonly #fd: number;
  constructor(fd: number) {
    this.#fd = fd;
  }
  async writeFile(data: string | ArrayBufferView): Promise<void> {
    writeSync(this.#fd, data);
  }
  async sync(): Promise<void> {
    fsyncSync(this.#fd);
  }
  async close(): Promise<void> {
    closeSync(this.#fd);
  }
}

export const promises = {
  async mkdir(path: string | URL, options?: { recursive?: boolean; mode?: number }): Promise<void> {
    mkdirSync(path, options);
  },
  async open(path: string | URL, flags?: string, mode?: number): Promise<FileHandle> {
    return new FileHandle(openSync(path, flags, mode));
  },
  async rename(from: string | URL, to: string | URL): Promise<void> {
    renameSync(from, to);
  },
  async rm(path: string | URL, options?: { force?: boolean; recursive?: boolean }): Promise<void> {
    rmSync(path, options);
  },
};

export default {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  promises,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
};
