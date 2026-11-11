import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { CpeControlValidationError } from "../src/cpe-domain.ts";
import { AtomicFileWriter, StorageCipher } from "../src/encrypted-file.ts";
import { ContactBook, parseVcardContacts } from "../src/sms/contacts.ts";
import { SmsMirrorStore, computeSmsUid } from "../src/sms/mirror.ts";
import type { SmsWireMessage } from "../src/sms/types.ts";
import { tempDir } from "./helpers/temp-dir.ts";

// Removed at process exit, when no background store write can recreate it
const tmpRoot = tempDir("fengsui-sms-stores-");
let seq = 0;
const tmpFile = (name: string): string => path.join(tmpRoot, `${++seq}-${name}`);

function wire(partial: Partial<SmsWireMessage> & Pick<SmsWireMessage, "index" | "phone" | "content" | "date">): SmsWireMessage {
  const direction = partial.direction ?? "in";
  const smstat = partial.smstat ?? (direction === "out" ? "3" : "1");
  return { isUnread: smstat === "0", direction, smstat, ...partial };
}

function makeStores(secret = "store_test_secret") {
  const cipher = StorageCipher.fromSecret(secret);
  const contacts = new ContactBook({ filePath: tmpFile("contacts.json"), cipher, defaultCountryCode: "+353" });
  const mirror = new SmsMirrorStore({ filePath: tmpFile("sms.json"), cipher, defaultCountryCode: "+353", contacts });
  return { cipher, contacts, mirror };
}

describe("AtomicFileWriter", () => {
  it("writes 0600 files atomically and applies concurrent writes in call order", async () => {
    const file = tmpFile("atomic.json");
    const writer = new AtomicFileWriter(file);
    await Promise.all([writer.write(() => "first"), writer.write(() => "second"), writer.write(() => "third")]);
    assert.equal(fs.readFileSync(file, "utf8"), "third");
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith(".tmp")), []);
  });

  it("surfaces serializer failures without leaving temp files and keeps the chain usable", async () => {
    const file = tmpFile("atomic-fail.json");
    const writer = new AtomicFileWriter(file);
    await assert.rejects(() =>
      writer.write(() => {
        throw new Error("serialize boom");
      })
    , /serialize boom/);
    await writer.write(() => "recovered");
    assert.equal(fs.readFileSync(file, "utf8"), "recovered");
  });
});

describe("StorageCipher.readJsonFileOrQuarantine", () => {
  it("quarantines undecryptable or corrupt files, but never moves aside a file it merely could not read", () => {
    const dir = fs.mkdtempSync(path.join(tmpRoot, "quarantine-"));
    const file = path.join(dir, "contacts.json");
    const cipher = StorageCipher.fromSecret("quarantine_key_v1");
    const quarantined = (): string[] => fs.readdirSync(dir).filter((n) => n.startsWith("contacts.json.unreadable-"));

    // An I/O failure says nothing about the content: surface it instead of starting empty
    fs.mkdirSync(file);
    assert.throws(() => cipher.readJsonFileOrQuarantine(file), /EISDIR/);
    assert.ok(fs.statSync(file).isDirectory(), "left where it was");
    fs.rmdirSync(file);
    if (process.getuid?.() !== 0) {
      // e.g. files still owned by another UID after a container user change
      cipher.writeJsonFile(file, { contacts: [] });
      fs.chmodSync(file, 0o000);
      assert.throws(() => cipher.readJsonFileOrQuarantine(file), /EACCES/);
      fs.chmodSync(file, 0o600);
      assert.deepEqual(cipher.readJsonFileOrQuarantine(file), { contacts: [] });
      fs.rmSync(file);
    }
    assert.deepEqual(quarantined(), []);

    fs.writeFileSync(file, "{ not json");
    assert.equal(cipher.readJsonFileOrQuarantine(file), null);
    assert.equal(quarantined().length, 1, "corrupt content is archived");

    StorageCipher.fromSecret("quarantine_key_v2").writeJsonFile(file, { contacts: [] });
    assert.equal(cipher.readJsonFileOrQuarantine(file), null);
    assert.equal(fs.existsSync(file), false);
    assert.equal(quarantined().length, 2, "content under another key is archived, never overwritten in place");
    assert.equal(cipher.readJsonFileOrQuarantine(file), null, "a missing file is simply empty");
  });
});

describe("SmsMirrorStore: CPE mirror, notification cursor and thread views", () => {
  it("re-indexes contacts and regroups threads once the default country becomes known", () => {
    const cipher = StorageCipher.fromSecret("store_test_secret");
    const contacts = new ContactBook({ filePath: tmpFile("contacts-country.json"), cipher, defaultCountryCode: "" });
    const mirror = new SmsMirrorStore({ filePath: tmpFile("sms-country.json"), cipher, defaultCountryCode: "", contacts });
    // The router reported one sender in its local spelling and once in full
    mirror.ingest(
      [
        wire({ index: 40101, phone: "0830000001", content: "local", date: "2026-10-28 18:00:00" }),
        wire({ index: 40102, phone: "+353830000001", content: "full", date: "2026-10-28 18:01:00" }),
      ],
      "incremental"
    );
    assert.equal(mirror.listThreads().length, 2, "without a country the local spelling cannot be placed");
    contacts.setDefaultCountryCode("+353");
    mirror.setDefaultCountryCode("+353");
    assert.equal(mirror.defaultCountryCode, "+353");
    assert.equal(contacts.defaultCountryCode, "+353");
    assert.equal(mirror.listThreads().length, 1, "both spellings are one conversation once the SIM says Ireland");
  });

  it("derives opaque stable uids that never embed the phone number", () => {
    const uid = computeSmsUid({ index: 40002, date: "2026-10-28 18:00:00", phone: "+353830000001" });
    assert.match(uid, /^[0-9a-f]{20}$/);
    assert.equal(uid, computeSmsUid({ index: 40002, date: "2026-10-28 18:00:00", phone: "+353830000001" }));
    assert.notEqual(uid, computeSmsUid({ index: 40002, date: "2026-10-28 18:00:01", phone: "+353830000001" }));
    assert.doesNotMatch(uid, /353830000001/);
  });

  it("upserts incremental batches, tracks read-state changes and extracts OTP codes for inbound only", () => {
    const { mirror } = makeStores();
    const first = mirror.ingest(
      [
        wire({ index: 1, phone: "DemoBank", content: "Your verification code is 482913", date: "2026-10-29 09:00:00", smstat: "0" }),
        wire({ index: 2, phone: "+353830000001", content: "code 1234 sent by me", date: "2026-10-29 09:05:00", direction: "out" }),
      ],
      "incremental"
    );
    assert.equal(first.added.length, 2);
    const inbound = mirror.list().find((m) => m.index === 1);
    assert.equal(inbound?.verificationCode, "482913");
    assert.equal(mirror.list().find((m) => m.index === 2)?.verificationCode, null);

    const second = mirror.ingest(
      [wire({ index: 1, phone: "DemoBank", content: "Your verification code is 482913", date: "2026-10-29 09:00:00", smstat: "1" })],
      "incremental"
    );
    assert.equal(second.added.length, 0);
    assert.equal(second.updated.length, 1);
    assert.equal(mirror.get(second.updated[0]!.uid)?.isUnread, false);
    assert.equal(mirror.size, 2);
  });

  it("full syncs drop messages no longer on the CPE (including provisional sends)", () => {
    const { mirror } = makeStores();
    mirror.ingest(
      [
        wire({ index: 1, phone: "+353830000001", content: "a", date: "2026-10-29 09:00:00" }),
        wire({ index: 2, phone: "+353830000001", content: "b", date: "2026-10-29 09:01:00" }),
      ],
      "full"
    );
    mirror.addPending("+353830000002", "pending text", "2026-10-29 09:02:00");
    const result = mirror.ingest([wire({ index: 2, phone: "+353830000001", content: "b", date: "2026-10-29 09:01:00" })], "full");
    assert.equal(result.removed.length, 2);
    assert.deepEqual(mirror.list().map((m) => m.index), [2]);
    assert.ok(mirror.getMeta().lastFullSyncAt);
  });

  it("replaces a provisional sent record once the router copy is read back", () => {
    const { mirror } = makeStores();
    const pending = mirror.addPending("+353830000001", "On my way", "2026-10-29 10:00:00");
    assert.equal(pending.pending, true);
    assert.equal(pending.direction, "out");
    const result = mirror.ingest(
      [wire({ index: 7, phone: "0830000001", content: "On my way", date: "2026-10-29 10:00:03", direction: "out" })],
      "incremental"
    );
    assert.equal(result.added.length, 1);
    assert.deepEqual(result.removed.map((m) => m.uid), [pending.uid]);
    assert.equal(mirror.get(pending.uid), undefined);
    assert.equal(mirror.size, 1);
  });

  it("keeps the read state FengSui holds where the router's own says nothing, and lets the router's win everywhere else", () => {
    const { mirror } = makeStores();
    const unread = wire({ index: 1, phone: "+353830000001", content: "one", date: "2026-11-10 12:00:00", smstat: "0" });
    mirror.ingest([unread], "full", { keepReadState: true });
    // The router lists it as read from now on (a modem marks what it lists): it stays unread until the owner reads it
    const listedRead = { ...unread, smstat: "1", isUnread: false };
    assert.deepEqual(mirror.ingest([listedRead], "full", { keepReadState: true }).updated, []);
    assert.equal(mirror.get(computeSmsUid(unread))?.isUnread, true);
    // Read in FengSui: a router that still calls it unread (it has no way to be told) does not undo that
    mirror.markRead([computeSmsUid(unread)]);
    assert.deepEqual(mirror.ingest([unread], "full", { keepReadState: true }).updated, []);
    assert.equal(mirror.get(computeSmsUid(unread))?.isUnread, false);
    // Text that changed (a long message completed) still updates, with the state kept
    const longer = { ...unread, content: "one two" };
    assert.equal(mirror.ingest([longer], "full", { keepReadState: true }).updated[0]?.isUnread, false);
    // A router that keeps the read state itself is followed
    assert.equal(mirror.ingest([longer], "full").updated[0]?.isUnread, true);
  });

  it("keeps its own copy of a message sent through a router that stores none", () => {
    const { mirror } = makeStores();
    const sent = mirror.addSent("+353830000001", "On my way", "2026-11-10 12:00:00");
    assert.deepEqual([sent.direction, sent.localOnly, sent.pending, sent.index, sent.isUnread], ["out", true, undefined, 0, false]);
    assert.match(sent.uid, /^sent-/);
    // A full sync that lists nothing leaves it, where a provisional send goes
    const pending = mirror.addPending("+353830000001", "soon", "2026-11-10 12:01:00");
    const removed = mirror.ingest([], "full").removed.map((m) => m.uid);
    assert.deepEqual(removed, [pending.uid]);
    assert.equal(mirror.get(sent.uid)?.content, "On my way");
    assert.equal(mirror.getThread("+353830000001").messages.length, 1);
  });

  it("marks read, removes, resolves uids and keeps a bounded notification cursor", () => {
    const { mirror } = makeStores();
    mirror.ingest(
      [
        wire({ index: 1, phone: "+353830000001", content: "x", date: "2026-10-29 09:00:00", smstat: "0" }),
        wire({ index: 2, phone: "+353830000001", content: "y", date: "2026-10-29 09:01:00", smstat: "0" }),
      ],
      "incremental"
    );
    const uids = mirror.list().map((m) => m.uid);
    assert.equal(mirror.findByUids([...uids, "missing"]).length, 2);
    assert.equal(mirror.markRead([uids[0]!]).length, 1);
    assert.equal(mirror.markRead([uids[0]!]).length, 0);
    assert.equal(mirror.remove([uids[1]!, "missing"]).length, 1);
    assert.equal(mirror.size, 1);

    assert.equal(mirror.isNotified("u1"), false);
    mirror.markNotified(["u1", "u2"]);
    assert.equal(mirror.isNotified("u1"), true);
    mirror.markNotified(Array.from({ length: 3100 }, (_, i) => `bulk-${i}`));
    assert.equal(mirror.isNotified("u1"), false);
    assert.equal(mirror.isNotified("bulk-3099"), true);
    assert.equal(mirror.getMeta().seeded, false);
    mirror.markSeeded();
    assert.equal(mirror.getMeta().seeded, true);
  });

  it("keeps deleted messages in Recently deleted, restores them as FengSui's own copies a full sync leaves, and purges by age", () => {
    const { mirror } = makeStores();
    const a = wire({ index: 40001, phone: "+353830000001", content: "Dinner at 7?", date: "2026-11-02 18:00:00" });
    const b = wire({ index: 40002, phone: "+353830000002", content: "Parcel at the door", date: "2026-11-02 19:00:00", smstat: "0" });
    mirror.ingest([a, b], "full");
    const [uidA, uidB] = [computeSmsUid(a), computeSmsUid(b)];
    const pending = mirror.addPending("+353830000003", "On my way", "2026-11-02 20:00:00");

    // Deleted: out of the threads, search and counts, into the bin with its time; a provisional send is only dropped
    const moved = mirror.trash([uidA, pending.uid], "2026-11-03T10:00:00.000Z");
    assert.deepEqual(moved.map((m) => m.uid).sort(), [uidA, pending.uid].sort());
    assert.equal(mirror.get(uidA), undefined);
    assert.deepEqual(mirror.listTrash().map((m) => [m.uid, m.deletedAtIso]), [[uidA, "2026-11-03T10:00:00.000Z"]]);
    assert.deepEqual(mirror.findTrash([uidA, uidB]).map((m) => m.uid), [uidA]);
    assert.deepEqual([mirror.stats().messagesTotal, mirror.stats().trashTotal], [1, 1]);
    assert.equal(mirror.listThreads({ search: "Dinner" }).length, 0);
    // A sync that still lists it (fetched before the delete, or a router that ignored it) does not bring it back
    mirror.ingest([a, b], "incremental");
    assert.equal(mirror.get(uidA), undefined);

    // Restored: back in its thread, kept only in FengSui (the router copy is gone), and a full sync leaves it
    assert.deepEqual(mirror.restore([uidA, "unknown"]).map((m) => [m.uid, m.localOnly]), [[uidA, true]]);
    assert.equal("deletedAtIso" in (mirror.get(uidA) ?? {}), false);
    mirror.ingest([b], "full");
    assert.equal(mirror.get(uidA)?.localOnly, true);
    assert.equal(mirror.listThreads({ search: "Dinner" }).length, 1);
    assert.equal(mirror.stats().trashTotal, 0);
    // Listed by the router again: the router's copy from now on, so a later delete reaches the router
    mirror.ingest([a, b], "full");
    assert.equal(mirror.get(uidA)?.localOnly, undefined);

    // Purged by age (deleted before the cutoff), by uid, or all at once
    mirror.trash([uidA], "2026-11-03T10:00:00.000Z");
    mirror.trash([uidB], "2026-11-05T10:00:00.000Z");
    assert.deepEqual(mirror.listTrash().map((m) => m.uid), [uidB, uidA], "newest deletion first");
    assert.deepEqual(mirror.purgeDeletedBefore("2026-11-04T00:00:00.000Z").map((m) => m.uid), [uidA]);
    assert.deepEqual(mirror.purge([uidB, "unknown"]).map((m) => m.uid), [uidB]);
    mirror.ingest([a], "incremental");
    mirror.trash([uidA], "2026-11-06T10:00:00.000Z");
    assert.deepEqual(mirror.purgeAll().map((m) => m.uid), [uidA]);
    assert.deepEqual([mirror.stats().trashTotal, mirror.listTrash().length], [0, 0]);
  });

  it("keeps Recently deleted encrypted across a restart and drops stored entries it cannot place", async () => {
    const { cipher, contacts, mirror } = makeStores();
    const a = wire({ index: 40001, phone: "+353830000001", content: "Dinner at 7?", date: "2026-11-02 18:00:00" });
    const b = wire({ index: 40002, phone: "+353830000002", content: "Parcel at the door", date: "2026-11-02 19:00:00" });
    mirror.ingest([a, b], "full");
    mirror.trash([computeSmsUid(a)], "2026-11-03T10:00:00.000Z");
    mirror.trash([computeSmsUid(b)], "2026-11-03T11:00:00.000Z");
    mirror.restore([computeSmsUid(b)]);
    await mirror.flush();
    const raw = fs.readFileSync(mirror.filePath, "utf8");
    assert.ok(!raw.includes("Dinner") && !raw.includes("+353830000001"), "encrypted on disk");
    const again = new SmsMirrorStore({ filePath: mirror.filePath, cipher, defaultCountryCode: "+353", contacts });
    again.load();
    assert.deepEqual(again.listTrash().map((m) => [m.content, m.deletedAtIso]), [["Dinner at 7?", "2026-11-03T10:00:00.000Z"]]);
    assert.equal(again.get(computeSmsUid(b))?.localOnly, true);

    // A stored entry without a uid or a deletion time is not guessed at
    const junk = new SmsMirrorStore({ filePath: tmpFile("sms-junk.json"), cipher, defaultCountryCode: "+353", contacts });
    fs.writeFileSync(junk.filePath, cipher.serializeJson({ version: 1, messages: [], notified: [], trash: [{ uid: "x" }, { deletedAtIso: "2026-11-03T10:00:00.000Z" }, null, { ...again.listTrash()[0] }] }));
    junk.load();
    assert.deepEqual(junk.listTrash().map((m) => m.content), ["Dinner at 7?"]);
  });

  it("groups threads across number spellings with filters, search, contact names and brand hints", () => {
    const { mirror, contacts } = makeStores();
    contacts.upsert({ phone: "0830000001", name: "Aoife", note: "neighbour" });
    mirror.ingest(
      [
        wire({ index: 1, phone: "+353830000001", content: "Hi there", date: "2026-10-29 09:00:00", smstat: "0" }),
        wire({ index: 2, phone: "0830000001", content: "Reply", date: "2026-10-29 09:01:00", direction: "out" }),
        wire({ index: 3, phone: "DemoBank", content: "Your verification code is 482913", date: "2026-10-29 10:00:00", smstat: "0" }),
        wire({ index: 4, phone: "+447700900123", content: "【示例快递】包裹已到", date: "2026-10-28 08:00:00" }),
      ],
      "incremental"
    );

    const all = mirror.listThreads();
    assert.deepEqual(all.map((t) => t.threadKey), ["alpha:demobank", "+353830000001", "+447700900123"]);
    const aoife = all[1]!;
    assert.equal(aoife.displayName, "Aoife");
    assert.equal(aoife.totalCount, 2);
    assert.equal(aoife.unreadCount, 1);
    assert.equal(aoife.replyPhone, "+353830000001");
    assert.equal(aoife.latestMessage.content, "Reply");
    assert.equal(all[0]!.replyPhone, null);
    assert.equal(all[0]!.latestOtp, "482913");
    assert.equal(all[2]!.displayName, "+447700900123 (示例快递)");

    assert.deepEqual(mirror.listThreads({ filter: "unread" }).map((t) => t.threadKey), ["alpha:demobank", "+353830000001"]);
    assert.deepEqual(mirror.listThreads({ filter: "otp" }).map((t) => t.threadKey), ["alpha:demobank"]);
    assert.deepEqual(mirror.listThreads({ search: "482913" }).map((t) => t.matchedPreview), ["Your verification code is 482913"]);
    assert.deepEqual(mirror.listThreads({ search: "aoife" }).map((t) => t.threadKey), ["+353830000001"]);
    assert.equal(mirror.listThreads({ limit: 1 }).length, 1);

    const detail = mirror.getThread("0830000001");
    assert.equal(detail.threadKey, "+353830000001");
    assert.deepEqual(detail.messages.map((m) => m.index), [1, 2]);
    assert.equal(detail.messages[0]?.contact?.name, "Aoife");
    assert.equal(detail.contact?.note, "neighbour");
    assert.equal(mirror.getThread("alpha:demobank").messages.length, 1);
    assert.equal(mirror.getThread("+353830000099").messages.length, 0);

    assert.deepEqual(mirror.stats(), { messagesTotal: 4, unreadTotal: 2, threadsTotal: 3, trashTotal: 0 });
  });

  it("persists encrypted (no plaintext bodies or numbers on disk) and archives unreadable files on key change", async () => {
    const cipher = StorageCipher.fromSecret("persist_secret");
    const file = tmpFile("sms-persist.json");
    const contacts = new ContactBook({ filePath: tmpFile("c.json"), cipher, defaultCountryCode: "+353" });
    const mirror = new SmsMirrorStore({ filePath: file, cipher, defaultCountryCode: "+353", contacts });
    mirror.ingest([wire({ index: 9, phone: "+353830000009", content: "secret body 777", date: "2026-10-29 11:00:00" })], "full", {
      counters: { localUnread: 0, localInbox: 1, localOutbox: 0, localDraft: 0, localMax: 500 },
      via: "sms-list",
    });
    mirror.markNotified(["n1"]);
    mirror.markSeeded();
    await mirror.flush();
    const raw = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(raw, /secret body|353830000009/);

    const reloaded = new SmsMirrorStore({ filePath: file, cipher, defaultCountryCode: "+353", contacts });
    reloaded.load();
    assert.equal(reloaded.size, 1);
    assert.equal(reloaded.isNotified("n1"), true);
    assert.equal(reloaded.getMeta().seeded, true);
    assert.equal(reloaded.getMeta().via, "sms-list");
    assert.equal(reloaded.getMeta().counters?.localInbox, 1);

    const wrongKey = new SmsMirrorStore({
      filePath: file,
      cipher: StorageCipher.fromSecret("rotated_secret"),
      defaultCountryCode: "+353",
      contacts,
    });
    wrongKey.load();
    assert.equal(wrongKey.size, 0);
    assert.ok(fs.readdirSync(path.dirname(file)).some((f) => f.startsWith(`${path.basename(file)}.unreadable-`)));

    // Rotating the key re-encrypts subsequent flushes with the new secret
    wrongKey.rotateEncryptionKey("rotated_secret");
    await wrongKey.flush();
    const rotated = new SmsMirrorStore({ filePath: file, cipher: StorageCipher.fromSecret("rotated_secret"), defaultCountryCode: "+353", contacts });
    rotated.load();
    assert.equal(rotated.size, 0);
    assert.equal(fs.existsSync(file), true);
  });
});

describe("ContactBook & vCard import", () => {
  it("parses vCard 2.1/3.0 with folding, quoted-printable UTF-8, CJK names and ORG fallback", () => {
    const vcf = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "FN:Aoife Example",
      "TEL;TYPE=CELL:+353 83 000 0001",
      "item1.TEL:083-000-0002",
      "END:VCARD",
      "BEGIN:VCARD",
      "VERSION:2.1",
      "N;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:=E5=BC=A0;=E4=B8=89;;;",
      "TEL:+447700900123",
      "END:VCARD",
      "BEGIN:VCARD",
      "ORG:Demo Plumbing Ltd;Ops",
      "TEL:+3538",
      " 30000003",
      "END:VCARD",
      "BEGIN:VCARD",
      "FN:No Phone",
      "END:VCARD",
      "TEL:+353830000099",
    ].join("\r\n");
    const parsed = parseVcardContacts(vcf);
    assert.deepEqual(parsed, [
      { name: "Aoife Example", phones: ["+353830000001", "0830000002"] },
      { name: "张三", phones: ["+447700900123"] },
      { name: "Demo Plumbing Ltd", phones: ["+353830000003"], org: "Demo Plumbing Ltd" },
    ]);
    assert.equal(parseVcardContacts(vcf, 1).length, 1);
    assert.deepEqual(parseVcardContacts(""), []);
  });

  it("upserts manual contacts across number spellings and validates input", () => {
    const { contacts } = makeStores();
    const created = contacts.upsert({ phone: "0830000001", name: "  Aoife  ", note: "neighbour" });
    assert.equal(created.name, "Aoife");
    assert.deepEqual(created.phones, ["+353830000001"]);
    const renamed = contacts.upsert({ phone: "+353830000001", name: "Aoife M" });
    assert.equal(renamed.id, created.id);
    assert.equal(renamed.name, "Aoife M");
    assert.equal(renamed.note, "neighbour");
    assert.equal(contacts.size, 1);

    assert.throws(() => contacts.upsert({ phone: "0830000001", name: " " }), CpeControlValidationError);
    assert.throws(() => contacts.upsert({ phone: "nope", name: "X" }), /Invalid recipient/);
    assert.throws(() => contacts.upsert({ phone: "0830000001", name: "x".repeat(65) }), /64/);
    assert.throws(() => contacts.upsert({ phone: "0830000001", name: "X", note: "n".repeat(201) }), /200/);

    assert.equal(contacts.resolvePhone("353830000001")?.name, "Aoife M");
    assert.equal(contacts.resolvePhone("Three"), null);
    assert.equal(contacts.knowsNumber("+353830000001"), true);
    assert.equal(contacts.knowsNumber("+353830000002"), false);
  });

  it("imports a full 5000-card export in linear time without stalling the event loop, merging repeats in the file", () => {
    const { contacts } = makeStores();
    contacts.upsert({ phone: "0830000001", name: "Aoife (manual)" });
    const cards = [["BEGIN:VCARD", "FN:Aoife export", "TEL:+353830000001", "END:VCARD"].join("\n")];
    // In the spare country code 999 (no subscriber anywhere): the reserved test blocks hold too few numbers for this
    for (let i = 0; i < 4990; i++) cards.push(["BEGIN:VCARD", `FN:Contact ${i}`, `TEL:+9991${String(i).padStart(7, "0")}`, "END:VCARD"].join("\n"));
    // A repeat inside the same file extends the card added earlier instead of adding a second contact
    cards.push(["BEGIN:VCARD", "FN:Contact 0 again", "TEL:+99910000000", "TEL:+99919999999", "END:VCARD"].join("\n"));
    const started = performance.now();
    const summary = contacts.importVcard(cards.join("\n"));
    const elapsedMs = performance.now() - started;
    // Rebuilding the whole index for every card took ~5 s here for 5000 cards (quadratic)
    assert.ok(elapsedMs < 2000, `import took ${Math.round(elapsedMs)} ms`);
    assert.deepEqual(summary, { parsed: 4992, added: 4990, updated: 2, total: 4991 });
    assert.equal(contacts.resolvePhone("+99919999999")?.name, "Contact 0 again");
    assert.equal(contacts.resolvePhone("+353830000001")?.name, "Aoife (manual)", "manual names win");
  });

  it("decides 'the same number' exactly: another country's number with the same last nine digits is a new contact, not a known one", () => {
    const { contacts } = makeStores();
    contacts.upsert({ phone: "+353830000001", name: "Aoife" });
    // Same last nine digits (830000001), another country: not Aoife's number
    const lookalike = "+999830000001";
    assert.equal(contacts.knowsNumber(lookalike), false, "the MCP known-recipient policy must not accept it");
    const added = contacts.upsert({ phone: lookalike, name: "Someone else" });
    assert.notEqual(added.id, contacts.resolvePhone("+353830000001")?.id);
    assert.equal(contacts.resolvePhone("+353830000001")?.name, "Aoife", "the saved contact is not renamed");
    assert.deepEqual(contacts.resolvePhone("+353830000001")?.phones, ["+353830000001"]);
    // Showing a sender is still forgiving: a national-format sender finds the saved name
    assert.equal(contacts.resolvePhone("0830000001")?.name, "Aoife");
  });

  it("keeps agent-filed contacts apart from owner-saved ones until the owner vouches for them", () => {
    const { contacts } = makeStores();
    const filed = contacts.upsert({ phone: "+447700900123", name: "Helpdesk" }, { source: "mcp" });
    assert.equal(filed.source, "mcp");
    assert.equal(contacts.knowsNumber("+447700900123"), true);
    assert.equal(contacts.knowsNumber("+447700900123", { ownerSavedOnly: true }), false);
    // An agent renaming an owner's contact leaves it owner-saved
    contacts.upsert({ phone: "0830000001", name: "Aoife" });
    assert.equal(contacts.upsert({ phone: "0830000001", name: "Aoife (agent)" }, { source: "mcp" }).source, "manual");
    // The owner's vCard export vouches for the filed number (and names it)
    contacts.importVcard(["BEGIN:VCARD", "FN:Support line", "TEL:+447700900123", "END:VCARD"].join("\n"));
    assert.equal(contacts.resolvePhone("+447700900123")?.source, "vcard");
    assert.equal(contacts.resolvePhone("+447700900123")?.name, "Support line");
    assert.equal(contacts.knowsNumber("+447700900123", { ownerSavedOnly: true }), true);
  });

  it("imports vCards without renaming manual contacts, then searches, removes and persists encrypted", async () => {
    const cipher = StorageCipher.fromSecret("contacts_secret");
    const file = tmpFile("contacts-persist.json");
    const book = new ContactBook({ filePath: file, cipher, defaultCountryCode: "+353" });
    book.upsert({ phone: "0830000001", name: "Aoife (manual)" });
    const summary = book.importVcard(
      ["BEGIN:VCARD", "FN:Aoife vCard", "TEL:+353830000001", "TEL:+353830000005", "END:VCARD",
        "BEGIN:VCARD", "FN:Brian", "TEL:0830000002", "END:VCARD"].join("\n")
    );
    assert.deepEqual(summary, { parsed: 2, added: 1, updated: 1, total: 2 });
    const aoife = book.resolvePhone("+353830000005");
    assert.equal(aoife?.name, "Aoife (manual)");
    assert.deepEqual(book.search("brian").map((c) => c.name), ["Brian"]);
    assert.deepEqual(book.search("0002").map((c) => c.name), ["Brian"]);
    assert.equal(book.search("", 1).length, 1);
    assert.equal(book.search("x".repeat(500)).length, 0);

    await book.flush();
    assert.doesNotMatch(fs.readFileSync(file, "utf8"), /Brian|353830000002/);
    const reloaded = new ContactBook({ filePath: file, cipher, defaultCountryCode: "+353" });
    reloaded.load();
    assert.equal(reloaded.size, 2);
    const brianId = reloaded.search("Brian")[0]!.id;
    assert.equal(reloaded.get(brianId)?.name, "Brian");
    assert.equal(reloaded.remove(brianId), true);
    assert.equal(reloaded.remove(brianId), false);
    assert.equal(reloaded.size, 1);
    assert.equal(reloaded.resolvePhone("0830000002"), null);
  });
});
