import zlib from "node:zlib";

/**
 * A zip archive with no dependency, for the Claude Desktop extension (`.mcpb` is a zip): files only, stored (no
 * compression, method 0), as the brief for the bundle allows; the MCP Bundle unpacker (fflate's unzipSync) reads
 * stored entries like deflated ones. The same entries always make the same bytes: a fixed timestamp, entries in the
 * order given, no comment and no extra fields. Each file says it came from Unix with mode 0644, as `mcpb pack`
 * writes it, so an unpacker that applies modes makes the files readable and not executable.
 *
 * `readZip` reads back what `writeZip` wrote (stored entries only, CRC checked): the tests use it.
 */

export interface ZipEntry {
  /** A relative path with `/` separators, no `..`, no leading `/`. */
  name: string;
  data: Uint8Array;
}

const LOCAL_FILE = 0x04034b50;
const CENTRAL_FILE = 0x02014b50;
const END_OF_CENTRAL = 0x06054b50;
/** Version 2.0 of the zip format (what a stored file needs, and what most tools write). */
const VERSION = 20;
/** Made by Unix (3) at version 2.0: the external attributes carry a Unix mode. */
const MADE_BY_UNIX = (3 << 8) | VERSION;
const FILE_MODE = 0o644;
/** 1980-01-01 00:00:00, the earliest MS-DOS date: no build time leaks in, and two builds match. */
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

function checkName(name: string): void {
  if (!name || name.startsWith("/") || name.includes("\\") || name.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`zip entry name "${name}" must be a relative path with / separators`);
  }
  if (!/^[\x20-\x7e]+$/.test(name)) throw new Error(`zip entry name "${name}" must be printable ASCII`);
}

/** The archive of `entries`, stored. */
export function writeZip(entries: ReadonlyArray<ZipEntry>): Buffer {
  const seen = new Set<string>();
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    checkName(entry.name);
    if (seen.has(entry.name)) throw new Error(`zip entry "${entry.name}" appears twice`);
    seen.add(entry.name);
    const name = Buffer.from(entry.name, "ascii");
    const data = Buffer.from(entry.data);
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_FILE, 0);
    local.writeUInt16LE(VERSION, 4);
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra field length
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_FILE, 0);
    central.writeUInt16LE(MADE_BY_UNIX, 4);
    central.writeUInt16LE(VERSION, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE((FILE_MODE << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_CENTRAL, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, directory, end]);
}

/** The entries of a stored archive, in order, each checked against its CRC; anything else is an error. */
export function readZip(bytes: Uint8Array): ZipEntry[] {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const endAt = buf.length - 22;
  if (endAt < 0 || buf.readUInt32LE(endAt) !== END_OF_CENTRAL) throw new Error("not a zip archive (or one with a comment)");
  const count = buf.readUInt16LE(endAt + 10);
  let at = buf.readUInt32LE(endAt + 16);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(at) !== CENTRAL_FILE) throw new Error(`central directory entry ${i} is damaged`);
    const method = buf.readUInt16LE(at + 10);
    const crc = buf.readUInt32LE(at + 16);
    const size = buf.readUInt32LE(at + 20);
    const nameLength = buf.readUInt16LE(at + 28);
    const skip = buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
    const localAt = buf.readUInt32LE(at + 42);
    const name = buf.toString("ascii", at + 46, at + 46 + nameLength);
    if (method !== 0) throw new Error(`zip entry "${name}" is compressed (method ${method}); only stored entries are read`);
    if (buf.readUInt32LE(localAt) !== LOCAL_FILE) throw new Error(`zip entry "${name}" has no local header`);
    const dataAt = localAt + 30 + buf.readUInt16LE(localAt + 26) + buf.readUInt16LE(localAt + 28);
    const data = buf.subarray(dataAt, dataAt + size);
    if (zlib.crc32(data) !== crc) throw new Error(`zip entry "${name}" fails its CRC`);
    entries.push({ name, data: new Uint8Array(data) });
    at += 46 + nameLength + skip;
  }
  return entries;
}
