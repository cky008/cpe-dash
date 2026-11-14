import assert from "node:assert/strict";
import { EventEmitter as NodeEmitter } from "node:events";
import nodeCrypto from "node:crypto";
import nodeNet from "node:net";
import nodePath from "node:path";
import { describe, it } from "node:test";
import { AsyncLocalStorage } from "../web/src/demo/node/async-hooks.ts";
import { Buffer as DemoBuffer, type BufferEncoding } from "../web/src/demo/node/buffer.ts";
import demoCrypto from "../web/src/demo/node/crypto.ts";
import { EventEmitter as DemoEmitter } from "../web/src/demo/node/events.ts";
import fsp from "../web/src/demo/node/fs-promises.ts";
import fs, { seedFile } from "../web/src/demo/node/fs.ts";
import { Response as DemoResponse, anySignal, process as demoProcess, splitSetCookie } from "../web/src/demo/node/globals.ts";
import net from "../web/src/demo/node/net.ts";
import path from "../web/src/demo/node/path.ts";
import url from "../web/src/demo/node/url.ts";

/**
 * The live demo's stand-ins for the Node built-ins the daemon's services use (web/src/demo/node/,
 * only in the demo's bundle): each answers as Node's own does, byte for byte where bytes come out.
 * The browser tests (test/ui/demo.test.ts) run them together in a page.
 */

const ENCODINGS: ReadonlyArray<BufferEncoding> = ["utf8", "hex", "base64", "base64url", "latin1", "binary"];
const SAMPLES = [Buffer.alloc(0), Buffer.from([0, 255, 128, 1]), Buffer.from("héllo 你好 🍜", "utf8"), nodeCrypto.randomBytes(97)];

describe("the demo's Buffer", () => {
  it("writes and reads every encoding the daemon uses as Node does", () => {
    for (const bytes of SAMPLES) {
      for (const encoding of ENCODINGS) {
        const text = bytes.toString(encoding);
        assert.equal(DemoBuffer.from(bytes).toString(encoding), text, `${encoding} out`);
        assert.equal(DemoBuffer.from(text, encoding).toString("hex"), Buffer.from(text, encoding).toString("hex"), `${encoding} in`);
        assert.equal(DemoBuffer.byteLength(text, encoding), Buffer.byteLength(text, encoding), `${encoding} length`);
      }
    }
    // Node reads leniently: white space and either base64 alphabet, hex up to the first pair that is not one
    for (const [text, encoding] of [["ab c\\nd-_=", "base64"], ["abz1", "hex"], ["abc", "hex"], ["", "base64"]] as const) {
      assert.equal(DemoBuffer.from(text, encoding).toString("hex"), Buffer.from(text, encoding).toString("hex"), `${encoding} ${text}`);
    }
    assert.throws(() => DemoBuffer.from("x", "ucs2" as BufferEncoding), /Unknown encoding/);
  });

  it("allocates, joins, slices and reads integers as Node does", () => {
    const parts = [Buffer.from("ab"), Buffer.from("cde")];
    assert.equal(DemoBuffer.concat(parts).toString("hex"), Buffer.concat(parts).toString("hex"));
    assert.equal(DemoBuffer.concat(parts, 3).toString("hex"), Buffer.concat(parts, 3).toString("hex"));
    assert.equal(DemoBuffer.concat(parts, 8).toString("hex"), Buffer.concat(parts, 8).toString("hex"));
    assert.equal(DemoBuffer.alloc(4, 7).toString("hex"), Buffer.alloc(4, 7).toString("hex"));
    const ours = DemoBuffer.alloc(8);
    const theirs = Buffer.alloc(8);
    assert.equal(ours.writeUInt32LE(0xdeadbeef, 1), theirs.writeUInt32LE(0xdeadbeef, 1));
    assert.equal(ours.writeUInt16BE(0xbeef, 5), theirs.writeUInt16BE(0xbeef, 5));
    assert.equal(ours.toString("hex"), theirs.toString("hex"));
    assert.equal(ours.readUInt32LE(1), theirs.readUInt32LE(1));
    const sub = ours.subarray(1, 5);
    assert.ok(DemoBuffer.isBuffer(sub), "a slice is a Buffer as well");
    assert.equal(sub.toString("hex"), theirs.subarray(1, 5).toString("hex"));
    assert.equal(ours.toString("hex", 1, 3), theirs.toString("hex", 1, 3));
    assert.ok(DemoBuffer.from([1, 2]).equals(DemoBuffer.from([1, 2])) && !DemoBuffer.from([1, 2]).equals(DemoBuffer.from([1, 3])) && !DemoBuffer.from([1]).equals(DemoBuffer.from([1, 2])));
    assert.equal(DemoBuffer.from(new Uint8Array([9, 8]).buffer).toString("hex"), "0908");
    assert.equal(DemoBuffer.isBuffer(new Uint8Array(1)), false);
  });
});

describe("the demo's node:crypto", () => {
  it("hashes and MACs as Node does (SHA-256, MD5, keys longer than a block)", () => {
    for (const text of ["", "abc", "a".repeat(55), "a".repeat(56), "a".repeat(64), "a".repeat(1000), "héllo 你好 🍜"]) {
      for (const algorithm of ["sha256", "md5"]) {
        assert.equal(demoCrypto.createHash(algorithm).update(text).digest("hex"), nodeCrypto.createHash(algorithm).update(text).digest("hex"), `${algorithm} ${text.length}`);
        for (const key of ["key", "k".repeat(100)]) {
          assert.equal(demoCrypto.createHmac(algorithm, key).update(text, "utf8").digest("hex"), nodeCrypto.createHmac(algorithm, key).update(text, "utf8").digest("hex"), `hmac-${algorithm}`);
        }
      }
    }
    const chained = demoCrypto.createHash("sha256").update("ab").update(Buffer.from("cd")).digest();
    assert.equal(chained.toString("base64"), nodeCrypto.createHash("sha256").update("abcd").digest("base64"));
    assert.throws(() => demoCrypto.createHash("sha1"), /not available in the demo/);
  });

  it("derives keys as Node does (PBKDF2, HKDF, scrypt) and calls back asynchronously", async () => {
    assert.equal(demoCrypto.pbkdf2Sync("pw", "salt", 1000, 32, "sha256").toString("hex"), nodeCrypto.pbkdf2Sync("pw", "salt", 1000, 32, "sha256").toString("hex"));
    assert.equal(demoCrypto.pbkdf2Sync("pw", "salt", 3, 70, "sha256").toString("hex"), nodeCrypto.pbkdf2Sync("pw", "salt", 3, 70, "sha256").toString("hex"));
    assert.throws(() => demoCrypto.pbkdf2Sync("pw", "salt", 1, 32, "sha512"), /not available in the demo/);
    const ikm = nodeCrypto.randomBytes(32);
    const salt = nodeCrypto.randomBytes(16);
    assert.equal(Buffer.from(demoCrypto.hkdfSync("sha256", ikm, salt, "info", 42)).toString("hex"), Buffer.from(nodeCrypto.hkdfSync("sha256", ikm, salt, "info", 42)).toString("hex"));
    assert.throws(() => demoCrypto.hkdfSync("md5", ikm, salt, "info", 16), /not available in the demo/);
    for (const options of [{ N: 1024, r: 8, p: 1 }, { N: 16, r: 1, p: 2 }]) {
      assert.equal(demoCrypto.scryptSync("secret", "salt", 48, options).toString("hex"), nodeCrypto.scryptSync("secret", "salt", 48, options).toString("hex"));
    }
    assert.throws(() => demoCrypto.scryptSync("s", "s", 32, { N: 1000 }), /power of two/);
    const key = await new Promise<Buffer>((resolve, reject) => demoCrypto.scrypt("secret", "salt", 32, { N: 16, r: 1, p: 1 }, (err, out) => (err ? reject(err) : resolve(Buffer.from(out)))));
    assert.equal(key.toString("hex"), nodeCrypto.scryptSync("secret", "salt", 32, { N: 16, r: 1, p: 1 }).toString("hex"));
    const refused = await new Promise<Error | null>((resolve) => demoCrypto.scrypt("s", "s", 32, { N: 3 }, (err) => resolve(err)));
    assert.match(refused?.message ?? "", /power of two/);
  });

  it("encrypts and decrypts AES-256-GCM as Node does, in pieces, for any IV length, and refuses a wrong tag", () => {
    const key = nodeCrypto.randomBytes(32);
    for (const ivLength of [12, 16, 8]) {
      for (const length of [0, 1, 15, 16, 17, 100]) {
        const iv = nodeCrypto.randomBytes(ivLength);
        const plain = nodeCrypto.randomBytes(length);
        const aad = nodeCrypto.randomBytes(16);
        const reference = nodeCrypto.createCipheriv("aes-256-gcm", key, iv);
        reference.setAAD(aad);
        const expected = Buffer.concat([reference.update(plain), reference.final()]);
        const cipher = demoCrypto.createCipheriv("aes-256-gcm", key, iv).setAAD(aad);
        const out = DemoBuffer.concat([cipher.update(plain.subarray(0, 5)), cipher.update(plain.subarray(5)), cipher.final()]);
        assert.equal(out.toString("hex"), expected.toString("hex"), `iv ${ivLength}, ${length} bytes`);
        assert.equal(cipher.getAuthTag().toString("hex"), reference.getAuthTag().toString("hex"));
        const decipher = demoCrypto.createDecipheriv("aes-256-gcm", key, iv).setAAD(aad).setAuthTag(reference.getAuthTag());
        assert.equal(DemoBuffer.concat([decipher.update(expected), decipher.final()]).toString("hex"), plain.toString("hex"));
        const tampered = demoCrypto.createDecipheriv("aes-256-gcm", key, iv).setAAD(aad).setAuthTag(Buffer.alloc(16));
        tampered.update(expected);
        assert.throws(() => tampered.final(), /unable to authenticate/);
      }
    }
    const used = demoCrypto.createCipheriv("aes-256-gcm", key, Buffer.alloc(12));
    used.final();
    assert.throws(() => used.final(), /Unsupported state/);
    assert.throws(() => demoCrypto.createDecipheriv("aes-256-gcm", key, Buffer.alloc(12)).getAuthTag(), /Invalid state/);
    assert.throws(() => demoCrypto.createCipheriv("aes-128-cbc", key, Buffer.alloc(16)), /not available in the demo/);
    assert.throws(() => demoCrypto.createCipheriv("aes-256-gcm", key.subarray(0, 16), Buffer.alloc(12)), /Invalid key length/);
  });

  it("draws random values, UUIDs and integers in range, compares in constant time, and has no RSA", () => {
    assert.equal(demoCrypto.randomBytes(70_000).length, 70_000);
    assert.match(demoCrypto.randomUUID(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    for (let i = 0; i < 200; i++) {
      const n = demoCrypto.randomInt(3, 9);
      assert.ok(Number.isInteger(n) && n >= 3 && n < 9);
      assert.ok(demoCrypto.randomInt(5) < 5);
    }
    assert.throws(() => demoCrypto.randomInt(5, 5), RangeError);
    assert.equal(demoCrypto.timingSafeEqual(Buffer.from("ab"), Buffer.from("ab")), true);
    assert.equal(demoCrypto.timingSafeEqual(Buffer.from("ab"), Buffer.from("ac")), false);
    assert.throws(() => demoCrypto.timingSafeEqual(Buffer.from("a"), Buffer.from("ab")), /same byte length/);
    for (const rsa of [demoCrypto.createPublicKey, demoCrypto.createPrivateKey, demoCrypto.publicEncrypt, demoCrypto.privateDecrypt]) assert.throws(() => rsa(), /RSA is not available/);
    assert.equal(demoCrypto.constants.RSA_PKCS1_PADDING, nodeCrypto.constants.RSA_PKCS1_PADDING);
  });
});

describe("the demo's node:events, node:async_hooks, node:net, node:path and node:url", () => {
  it("calls listeners as Node's EventEmitter does: order, once, off, raw listeners and an unheard error", () => {
    const run = (emitter: NodeEmitter | DemoEmitter): string[] => {
      const heard: string[] = [];
      const a = (x: unknown): void => void heard.push(`a${String(x)}`);
      const b = (x: unknown): void => void heard.push(`b${String(x)}`);
      emitter.on("e", a);
      emitter.once("e", b);
      emitter.addListener("e", a);
      emitter.setMaxListeners(1);
      heard.push(String(emitter.emit("e", 1)), String(emitter.listenerCount("e")));
      emitter.off("e", a);
      emitter.emit("e", 2);
      emitter.once("f", b);
      for (const raw of emitter.rawListeners("f")) (raw as (x: unknown) => void)(3);
      heard.push(String(emitter.listenerCount("f")), String(emitter.listeners("e").length), String(emitter.emit("none")));
      emitter.removeListener("e", a);
      emitter.on("g", a).on("h", a);
      emitter.removeAllListeners("g");
      heard.push(String(emitter.listenerCount("g")), String(emitter.listenerCount("h")));
      emitter.removeAllListeners();
      heard.push(String(emitter.listenerCount("h")));
      return heard;
    };
    assert.deepEqual(run(new DemoEmitter()), run(new NodeEmitter()));
    assert.throws(() => new DemoEmitter().emit("error", new Error("boom")), /boom/);
    assert.throws(() => new DemoEmitter().emit("error", "text"), /Unhandled error event: text/);
    assert.equal(new DemoEmitter().off("missing", () => undefined).listenerCount("missing"), 0);
  });

  it("keeps an AsyncLocalStorage store for the synchronous run, nested ones included", () => {
    const store = new AsyncLocalStorage<string>();
    assert.equal(store.getStore(), undefined);
    const seen = store.run("outer", () => [store.getStore(), store.run("inner", () => store.getStore()), store.getStore()]);
    assert.deepEqual(seen, ["outer", "inner", "outer"]);
    assert.equal(store.getStore(), undefined);
    assert.throws(() => store.run("x", () => {
      throw new Error("thrown");
    }), /thrown/);
    assert.equal(store.getStore(), undefined, "a run that throws leaves no store");
  });

  it("tells IPv4 and IPv6 addresses as node:net does, and has no BlockList", () => {
    const cases = [
      "192.168.8.1", "0.0.0.0", "255.255.255.255", "256.1.1.1", "1.2.3", "01.2.3.4", "1.2.3.4.5", "a.b.c.d", "",
      "::", "::1", "2001:db8::42", "fe80::1%eth0", "fe80::1%", "1:2:3:4:5:6:7:8", "1:2:3:4:5:6:7:8:9", "1::2::3", "::ffff:192.168.8.1",
      "1:2:3:4:5:6:192.168.8.1", "1:2:3:4:5:6:7:192.168.8.1", "12345::", "g::1", ":1", "1:", "2001:db8:0:0:0:0:0:1", "::ffff:999.1.1.1", "1::2:3:4:5:6:7", "1::2:3:4:5:6:7:8",
    ];
    for (const input of cases) assert.equal(net.isIP(input), nodeNet.isIP(input), input);
    assert.throws(() => new net.BlockList(), /not available in the demo/);
  });

  it("joins and splits paths as POSIX node:path does, and reads file and page URLs", () => {
    for (const parts of [["/a", "b", "../c"], ["a", "./b"], ["/a/", "/b"], [""], ["/", ".."], ["a", "", "b"]]) {
      assert.equal(path.join(...parts), nodePath.posix.join(...parts), `join ${parts.join(" ")}`);
    }
    for (const parts of [["/a", "b"], ["/a", "/b", "c"], ["a", "..", "b"], ["/x/y", "../../.."]]) {
      assert.equal(path.resolve(...parts), nodePath.posix.resolve("/", ...parts), `resolve ${parts.join(" ")}`);
    }
    for (const input of ["/a/b/c.json", "/a/", "/", "a", "a/b"]) {
      assert.equal(path.dirname(input), nodePath.posix.dirname(input), `dirname ${input}`);
      assert.equal(path.basename(input), nodePath.posix.basename(input), `basename ${input}`);
    }
    assert.equal(path.basename("/a/b.json", ".json"), "b");
    assert.equal(path.basename("/a/.json", ".json"), ".json");
    assert.equal(url.fileURLToPath("file:///data/state%20x.json"), "/data/state x.json");
    assert.equal(url.fileURLToPath(new URL("https://demo.invalid/assets/chunk.js")), "/assets/chunk.js");
    assert.equal(url.pathToFileURL("/data/a.json").href, "file:///data/a.json");
    assert.equal(url.pathToFileURL("data").href, "file:///data");
  });
});

describe("the demo's in-memory file system", () => {
  it("does what the stores do: write through a temp file, rename, read back, list, remove", async () => {
    const dir = `/t-${nodeCrypto.randomUUID()}`;
    assert.equal(fs.existsSync(dir), false);
    fs.mkdirSync(`${dir}/data`, { recursive: true });
    assert.throws(() => fs.mkdirSync(`${dir}/data`), (err: { code?: string }) => err.code === "EEXIST");
    assert.throws(() => fs.mkdirSync(`${dir}/x/y`), (err: { code?: string }) => err.code === "ENOENT");
    const fd = fs.openSync(`${dir}/data/state.json.1.tmp`, "w", 0o600);
    fs.writeFileSync(fd, '{"a":');
    fs.writeSync(fd, Buffer.from("1}"));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    assert.throws(() => fs.closeSync(fd), (err: { code?: string }) => err.code === "EBADF");
    fs.renameSync(`${dir}/data/state.json.1.tmp`, `${dir}/data/state.json`);
    assert.equal(fs.readFileSync(`${dir}/data/state.json`, "utf8"), '{"a":1}');
    assert.equal(fs.readFileSync(`${dir}/data/state.json`).toString("utf8"), '{"a":1}');
    assert.deepEqual(fs.readdirSync(`${dir}/data`), ["state.json"]);
    assert.equal(fs.statSync(`${dir}/data/state.json`).isFile(), true);
    assert.equal(fs.statSync(`${dir}/data`).isDirectory(), true);
    assert.throws(() => fs.openSync(`${dir}/data/state.json`, "wx"), (err: { code?: string }) => err.code === "EEXIST");
    assert.throws(() => fs.readFileSync(`${dir}/data`), (err: { code?: string }) => err.code === "EISDIR");
    assert.throws(() => fs.readFileSync(`${dir}/missing`), (err: { code?: string }) => err.code === "ENOENT");
    assert.throws(() => fs.writeFileSync(`${dir}/none/x`, "x"), (err: { code?: string }) => err.code === "ENOENT");
    assert.throws(() => fs.openSync(`${dir}/x`, "a"), /not available in the demo/);
    assert.throws(() => fs.statSync(`${dir}/missing`), (err: { code?: string }) => err.code === "ENOENT");
    assert.throws(() => fs.renameSync(`${dir}/missing`, `${dir}/x`), (err: { code?: string }) => err.code === "ENOENT");
    assert.throws(() => fs.writeSync(999, "x"), (err: { code?: string }) => err.code === "EBADF");
    assert.throws(() => fs.fsyncSync(999), (err: { code?: string }) => err.code === "EBADF");
    assert.throws(() => fs.readdirSync(`${dir}/missing`), (err: { code?: string }) => err.code === "ENOENT");
    assert.equal(fs.openSync(`${dir}/data/state.json`, "r") > 2, true);
    assert.throws(() => fs.openSync(`${dir}/missing`, "r"), (err: { code?: string }) => err.code === "ENOENT");

    // What AtomicFileWriter does, through node:fs/promises
    await fsp.mkdir(`${dir}/data`, { recursive: true });
    const handle = await fsp.open(`${dir}/data/sms.json.tmp`, "w", 0o600);
    await handle.writeFile("[]");
    await handle.sync();
    await handle.close();
    await fsp.rename(`${dir}/data/sms.json.tmp`, `${dir}/data/sms.json`);
    await fsp.rm(`${dir}/data/none.tmp`, { force: true });
    assert.equal(fs.readFileSync(`${dir}/data/sms.json`, { encoding: "utf8" }), "[]");
    await assert.rejects(fsp.rm(`${dir}/data/none.tmp`), (err: { code?: string }) => err.code === "ENOENT");

    seedFile(`${dir}/locales/en.json`, "{}");
    assert.equal(fs.existsSync(`${dir}/locales/en.json`), true);
    fs.rmSync(`${dir}/locales/en.json`);
    fs.rmSync(dir, { recursive: true });
    assert.equal(fs.existsSync(`${dir}/data/sms.json`), false);
    assert.equal(fs.existsSync(dir), false);
    assert.throws(() => fs.rmSync(dir), (err: { code?: string }) => err.code === "ENOENT");
    assert.equal(fs.existsSync(new URL(`file://${dir}`)), false);
  });
});

describe("the demo's globals", () => {
  it("builds a Response that keeps Set-Cookie and reads its body once", async () => {
    const headers = new Headers({ "Content-Type": "text/html" });
    headers.append("Set-Cookie", "SessionID=a; Path=/");
    headers.append("Set-Cookie", "other=b; Path=/");
    const res = new DemoResponse("<response>OK</response>", { status: 200, headers });
    assert.equal(res.ok, true);
    assert.deepEqual(res.headers.getSetCookie(), ["SessionID=a; Path=/", "other=b; Path=/"]);
    assert.equal(res.body, null);
    const copy = res.clone();
    assert.equal(await res.text(), "<response>OK</response>");
    assert.equal(res.bodyUsed, true);
    await assert.rejects(res.text(), /already been read/);
    assert.throws(() => res.clone(), /already been consumed/);
    assert.equal(new TextDecoder().decode(await copy.arrayBuffer()), "<response>OK</response>");
    assert.deepEqual(await new DemoResponse('{"a":1}', { status: 404 }).json(), { a: 1 });
    assert.equal(new DemoResponse(null, { status: 502 }).ok, false);
    assert.equal(await new DemoResponse(new TextEncoder().encode("bytes")).text(), "bytes");
    assert.equal(await new DemoResponse().text(), "");
  });

  it("aborts with the first of several signals, and splits joined Set-Cookie headers", () => {
    const first = new AbortController();
    const second = new AbortController();
    const any = anySignal([first.signal, second.signal]);
    assert.equal(any.aborted, false);
    second.abort(new Error("second"));
    assert.equal(any.aborted, true);
    assert.equal((any.reason as Error).message, "second");
    const done = new AbortController();
    done.abort("already");
    assert.equal(anySignal([done.signal]).reason, "already");
    assert.deepEqual(splitSetCookie("a=1; Path=/; Expires=Wed, 21 Oct 2026 07:28:00 GMT, b=2; HttpOnly"), ["a=1; Path=/; Expires=Wed, 21 Oct 2026 07:28:00 GMT", "b=2; HttpOnly"]);
    assert.deepEqual(splitSetCookie(null), []);
    assert.equal(demoProcess.cwd(), "/");
    assert.equal(demoProcess.pid, 1);
    assert.throws(() => demoProcess.kill(), /not available in the demo/);
  });
});
