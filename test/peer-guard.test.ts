import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { beaconKeyMaterial, createFengSuiRuntime } from "../src/cli.ts";
import { loadConfig } from "../src/config.ts";
import { ConsoleSettings } from "../src/console-settings.ts";
import { createFengSuiCore, stopFengSuiCore } from "../src/core.ts";
import { StorageCipher } from "../src/encrypted-file.ts";
import { PeerDaemonGuard, type PeerTransport, createUdpPeerTransport } from "../src/peer-guard.ts";
import { PeerDaemonStandbyError } from "../src/scheduler.ts";
import { EncryptedStateStore } from "../src/state-store.ts";
import { TimeSeriesRingBuffer } from "../src/timeseries.ts";
import { createStrictCpe } from "./helpers/strict-cpe.ts";
import { removeTempDir, tempDir } from "./helpers/temp-dir.ts";
import { mockConnection } from "./helpers/connection.ts";

/** In-memory broadcast LAN: every datagram reaches every other attached transport. */
function createLan() {
  const members: Array<{ address: string; handlers: Array<(payload: Buffer, address: string) => void> }> = [];
  const sent: Buffer[] = [];
  return {
    sent,
    attach(address: string): PeerTransport {
      const member = { address, handlers: [] as Array<(payload: Buffer, address: string) => void> };
      members.push(member);
      return {
        send: (payload) => {
          sent.push(payload);
          for (const other of members) if (other !== member) for (const h of other.handlers) h(payload, address);
        },
        onMessage: (handler) => member.handlers.push(handler),
        close: () => {
          const idx = members.indexOf(member);
          if (idx >= 0) members.splice(idx, 1);
        },
      };
    },
  };
}

const SECRET = "shared_cpe_password";

describe("cross-host duplicate daemon guard (signed LAN beacons)", () => {
  it("elects the earlier daemon as leader and puts the later one on standby until the leader goes quiet", () => {
    const lan = createLan();
    let clock = 1_000_000;
    const now = () => clock;
    const a = new PeerDaemonGuard({ secret: SECRET, cpeHost: "192.168.8.1", transport: lan.attach("192.168.8.10"), now, startedAtMs: 1000, instanceId: "aaaaaaaaaaaaaaaa" });
    const b = new PeerDaemonGuard({ secret: SECRET, cpeHost: "192.168.8.1", transport: lan.attach("192.168.8.20"), now, startedAtMs: 2000, instanceId: "bbbbbbbbbbbbbbbb" });
    const events: string[] = [];
    a.on("peer", (e: { standby: boolean }) => events.push(`a:peer:${e.standby}`));
    a.on("standby", () => events.push("a:standby"));
    b.on("standby", (leader: { address: string }) => events.push(`b:standby:${leader.address}`));
    b.on("resume", () => events.push("b:resume"));

    a.announce();
    b.announce();
    assert.equal(a.getState().standby, false, "the earlier daemon leads");
    assert.equal(b.getState().standby, true);
    assert.deepEqual(b.getState().peers.map((p) => p.address), ["192.168.8.10"]);
    assert.ok(events.includes("b:standby:192.168.8.10"));
    assert.ok(events.includes("a:peer:false"), "the leader learns about the newcomer and stays active");
    assert.ok(!events.includes("a:standby"));

    // The leader stops; its peer entry ages out and the standby daemon resumes
    a.stop();
    clock += b.peerTimeoutMs + 1;
    b.sweep();
    assert.equal(b.getState().standby, false);
    assert.equal(events.at(-1), "b:resume");
    b.stop();
  });

  it("ignores forged, foreign-CPE, replayed, oversized, malformed and own beacons", () => {
    const lan = createLan();
    let clock = 5_000_000;
    const now = () => clock;
    const victim = new PeerDaemonGuard({ secret: SECRET, cpeHost: "192.168.8.1", transport: lan.attach("192.168.8.10"), now, startedAtMs: 9000 });
    const attacker = new PeerDaemonGuard({ secret: "guessed_password", cpeHost: "192.168.8.1", transport: lan.attach("192.168.8.66"), now, startedAtMs: 1 });
    const otherCpe = new PeerDaemonGuard({ secret: SECRET, cpeHost: "192.168.9.1", transport: lan.attach("192.168.8.30"), now, startedAtMs: 1 });
    attacker.announce();
    otherCpe.announce();
    victim.announce();
    assert.equal(victim.getState().standby, false);
    assert.deepEqual(victim.getState().peers, []);

    // A genuine beacon captured long ago cannot be replayed
    const genuine = new PeerDaemonGuard({ secret: SECRET, cpeHost: "192.168.8.1", transport: createLan().attach("x"), now: () => clock - 600_000, startedAtMs: 1 });
    const captured: Buffer[] = [];
    const tap = createLan();
    const tapped = new PeerDaemonGuard({ secret: SECRET, cpeHost: "192.168.8.1", transport: tap.attach("192.168.8.40"), now: () => clock - 600_000, startedAtMs: 1 });
    tapped.announce();
    captured.push(...tap.sent);
    for (const payload of captured) victim.handle(payload, "192.168.8.40");
    victim.handle(Buffer.alloc(4096, 0x7b), "192.168.8.41");
    victim.handle(Buffer.from("{not json"), "192.168.8.42");
    victim.handle(Buffer.from(JSON.stringify({ v: 1, id: "zz", startedAtMs: 1, sentAtMs: clock, cpe: "x", mac: "00" })), "192.168.8.43");
    const own = createLan();
    const self = new PeerDaemonGuard({ secret: SECRET, cpeHost: "192.168.8.1", transport: own.attach("192.168.8.10"), now, startedAtMs: 1 });
    self.announce();
    for (const payload of own.sent) self.handle(payload, "192.168.8.10");
    assert.deepEqual(victim.getState().peers, []);
    assert.deepEqual(self.getState().peers, [], "own beacons are ignored");
    clock += 1;
    genuine.stop();
    victim.stop();
  });

  it("keys beacons with memory-hard scrypt, so a captured beacon is no fast oracle for the router password", () => {
    const lan = createLan();
    const clock = 7_000_000;
    const victim = new PeerDaemonGuard({ secret: SECRET, cpeHost: "192.168.8.1", transport: lan.attach("192.168.8.10"), now: () => clock, startedAtMs: 9000 });
    const beacon = (key: Buffer, v: number, id: string): Buffer => {
      const fields = { v, id, startedAtMs: 1, sentAtMs: clock, cpe: crypto.createHmac("sha256", key).update("192.168.8.1").digest("hex").slice(0, 16) };
      const mac = crypto.createHmac("sha256", key).update(`${fields.v}|${fields.id}|${fields.startedAtMs}|${fields.sentAtMs}|${fields.cpe}`).digest("hex");
      return Buffer.from(JSON.stringify({ ...fields, mac }));
    };
    // Version 1 keyed the HMAC with one HKDF of the password: billions of guesses per second offline
    const fastKey = Buffer.from(crypto.hkdfSync("sha256", Buffer.from(SECRET), Buffer.from("fengsui-peer-beacon-v1"), Buffer.from("beacon"), 32));
    victim.handle(beacon(fastKey, 1, "1111111111111111"), "192.168.8.66");
    assert.deepEqual(victim.getState().peers, [], "a fast-HKDF (v1) beacon is no longer accepted");
    const hardKey = crypto.scryptSync(Buffer.from(SECRET), Buffer.from("fengsui-peer-beacon-v2|192.168.8.1"), 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    victim.handle(beacon(hardKey, 2, "2222222222222222"), "192.168.8.20");
    assert.deepEqual(victim.getState().peers.map((p) => p.address), ["192.168.8.20"]);
    assert.equal(victim.getState().standby, true);
    victim.stop();
  });

  it("breaks a start-time tie by instance id", () => {
    const lan = createLan();
    const low = new PeerDaemonGuard({ secret: SECRET, cpeHost: "cpe.lan", transport: lan.attach("192.168.8.11"), startedAtMs: 42, instanceId: "1111111111111111" });
    const high = new PeerDaemonGuard({ secret: SECRET, cpeHost: "CPE.lan", transport: lan.attach("192.168.8.12"), startedAtMs: 42, instanceId: "ffffffffffffffff" });
    low.announce();
    high.announce();
    assert.equal(low.getState().standby, false);
    assert.equal(high.getState().standby, true, "host names compare case-insensitively");
    low.stop();
    high.stop();
  });

  it("keeps a standby scheduler off the router: reads skip, controls fail with PEER_DAEMON_ACTIVE", async () => {
    const cpe = createStrictCpe();
    const dir = tempDir("fengsui-standby-");
    const core = createFengSuiCore({
      connection: mockConnection(cpe),
      stateStore: new EncryptedStateStore({ filePath: path.join(dir, "state.json"), encryptionKey: "standby_key" }),
      timeseries: new TimeSeriesRingBuffer({ retentionHours: 24 }),
    });
    core.monitor.init();
    try {
      core.scheduler.setPeerStandby("192.168.8.10");
      const status = core.scheduler.getStatus();
      assert.equal(status.mode, "standby_peer");
      assert.equal(status.peerStandby.active, true);
      assert.equal(status.peerStandby.peerAddress, "192.168.8.10");
      assert.equal(await core.monitor.refreshTelemetry(), null);
      await assert.rejects(() => core.controls.unlockAllLocks(), (err: unknown) => err instanceof PeerDaemonStandbyError && err.peerAddress === "192.168.8.10");
      assert.equal(cpe.stats.requests.length, 0, "no request reached the router");
      core.scheduler.setPeerStandby(null);
      assert.ok(await core.monitor.refreshTelemetry());
      assert.equal(core.scheduler.getStatus().peerStandby.active, false);
    } finally {
      await stopFengSuiCore(core);
      removeTempDir(dir);
    }
  });

  it("stays silent until it has a key, takes it from its key source and follows a changed router password", () => {
    const lan = createLan();
    let clock = 1_000_000;
    const now = (): number => clock;
    let source: { secret: string; cpeHost: string } | null = null;
    const fresh = new PeerDaemonGuard({ keySource: () => source, transport: lan.attach("192.168.8.10"), now, startedAtMs: 9000, instanceId: "bbbbbbbbbbbbbbbb" });
    const leader = new PeerDaemonGuard({ secret: SECRET, cpeHost: "192.168.8.1", transport: lan.attach("192.168.8.20"), now, startedAtMs: 1000, instanceId: "aaaaaaaaaaaaaaaa" });
    const before = lan.sent.length;
    fresh.announce();
    assert.equal(lan.sent.length, before, "no router connection yet: nothing to sign with, so nothing is sent");
    leader.announce();
    assert.equal(fresh.getState().standby, false, "and nothing it could verify is accepted");
    source = { secret: SECRET, cpeHost: "192.168.8.1" };
    leader.announce();
    assert.equal(fresh.getState().standby, true, "keyed from the router connection once there is one");
    // A new router password saved here: beacons signed with the old one no longer verify, so the leader times out
    source = { secret: "new_router_password", cpeHost: "192.168.8.1" };
    clock += leader.peerTimeoutMs + 1;
    leader.announce();
    fresh.sweep();
    assert.equal(fresh.getState().standby, false);
  });

  it("takes the beacon key only from a saved router connection with a password and a readable address", () => {
    assert.equal(beaconKeyMaterial(null), null, "no router connection saved yet");
    assert.equal(beaconKeyMaterial({ url: "http://192.168.8.1", username: "admin", password: "" }), null);
    assert.equal(beaconKeyMaterial({ url: "not a url", username: "admin", password: SECRET }), null, "a store edited by hand never throws in the beacon");
    assert.deepEqual(beaconKeyMaterial({ url: "http://192.168.8.1", username: "admin", password: SECRET }), { secret: SECRET, cpeHost: "192.168.8.1" });
  });

  it("keys the beacon on the router password saved in the console when .env holds none", async () => {
    const cpe = createStrictCpe();
    const lan = createLan();
    const dirs = [0, 1].map(() => tempDir("fengsui-twohosts-console-"));
    const makeConfig = async (dir: string) => {
      const envPath = path.join(dir, ".env");
      // The recommended .env: no router credentials, the console keeps them
      fs.writeFileSync(
        envPath,
        [
          "API_TOKEN=two_hosts_token",
          "DATA_ENCRYPTION_KEY=two_hosts_key",
          "WEB_HOST=127.0.0.1",
          "WEB_PORT=0",
          `STATE_FILE=${path.join(dir, "data", "state.json")}`,
          "POLL_INTERVAL_MS=600000",
          "NEIGHBOR_SCAN_INTERVAL_MS=600000",
          "SMS_ENABLED=false",
        ].join("\n")
      );
      const config = loadConfig({ envPath, ignoreProcessEnv: true });
      const settings = new ConsoleSettings({ filePath: config.settingsFile, cipher: new StorageCipher(config.dataEncryptionKey) });
      settings.setCpe({ url: "http://192.168.8.1", username: "admin", password: cpe.password });
      await settings.flush();
      return { envPath, config };
    };
    const first = await makeConfig(dirs[0]!);
    const second = await makeConfig(dirs[1]!);
    const nas = createFengSuiRuntime({ ...first, fetchImpl: cpe.fetchImpl, peerTransport: lan.attach("192.168.8.10"), log: () => undefined });
    // The daemon created first leads: keep the two creation times apart (equal ones fall to the random instance id)
    await new Promise((resolve) => setTimeout(resolve, 5));
    const mac = createFengSuiRuntime({ ...second, fetchImpl: cpe.fetchImpl, peerTransport: lan.attach("192.168.8.44"), log: () => undefined });
    try {
      await nas.start();
      await mac.start();
      assert.equal(mac.scheduler.getStatus().mode, "standby_peer");
      assert.notEqual(nas.scheduler.getStatus().mode, "standby_peer");
      assert.equal(cpe.stats.overlapLoginAttempts, 0);
    } finally {
      await mac.close();
      await nas.close();
      for (const dir of dirs) removeTempDir(dir);
    }
  });

  it("runs two daemons on different hosts against one router: the second stands by and refuses writes", async () => {
    const cpe = createStrictCpe();
    const lan = createLan();
    const dirs = [0, 1].map(() => tempDir("fengsui-twohosts-"));
    const makeConfig = (dir: string) => {
      const envPath = path.join(dir, ".env");
      fs.writeFileSync(
        envPath,
        [
          "CPE_URL=http://192.168.8.1",
          `CPE_PASSWORD=${cpe.password}`,
          "API_TOKEN=two_hosts_token",
          "DATA_ENCRYPTION_KEY=two_hosts_key",
          "WEB_HOST=127.0.0.1",
          "WEB_PORT=0",
          `STATE_FILE=${path.join(dir, "data", "state.json")}`,
          "POLL_INTERVAL_MS=600000",
          "NEIGHBOR_SCAN_INTERVAL_MS=600000",
          "SMS_ENABLED=false",
        ].join("\n")
      );
      return { envPath, config: loadConfig({ envPath, ignoreProcessEnv: true }) };
    };
    const first = makeConfig(dirs[0]!);
    const second = makeConfig(dirs[1]!);
    const nas = createFengSuiRuntime({ ...first, fetchImpl: cpe.fetchImpl, peerTransport: lan.attach("192.168.8.10"), log: () => undefined });
    // The daemon created first leads: keep the two creation times apart (equal ones fall to the random instance id)
    await new Promise((resolve) => setTimeout(resolve, 5));
    const mac = createFengSuiRuntime({ ...second, fetchImpl: cpe.fetchImpl, peerTransport: lan.attach("192.168.8.44"), log: () => undefined });
    try {
      await nas.start();
      await mac.start();
      assert.equal(mac.scheduler.getStatus().mode, "standby_peer");
      assert.notEqual(nas.scheduler.getStatus().mode, "standby_peer");
      assert.ok(mac.scheduler.getRecentAlerts().some((a) => a.code === "DUPLICATE_DAEMON" && a.messageEn.includes("192.168.8.10")));
      assert.ok(nas.scheduler.getRecentAlerts().some((a) => a.code === "DUPLICATE_DAEMON" && a.messageEn.includes("192.168.8.44")));
      assert.equal(cpe.stats.overlapLoginAttempts, 0);

      const bound = await mac.httpServer.listen();
      const res = await fetch(`http://${bound.host}:${bound.port}/api/control/unlock`, {
        method: "POST",
        headers: { Authorization: "Bearer two_hosts_token", "Content-Type": "application/json" },
        body: "{}",
      });
      assert.equal(res.status, 409);
      const body = (await res.json()) as { errorCode: string; peerAddress: string };
      assert.equal(body.errorCode, "PEER_DAEMON_ACTIVE");
      assert.equal(body.peerAddress, "192.168.8.10");
    } finally {
      await mac.close();
      await nas.close();
      for (const dir of dirs) removeTempDir(dir);
    }
  });

  it("sends and receives beacons over real UDP (loopback)", async () => {
    const port = 20000 + Math.floor(Math.random() * 20000);
    const transport = createUdpPeerTransport({ port, targetAddress: "127.0.0.1" });
    try {
      const received = new Promise<Buffer>((resolve) => transport.onMessage((payload) => resolve(payload)));
      await new Promise((r) => setTimeout(r, 50));
      transport.send(Buffer.from("fengsui-beacon-smoke"));
      const payload = await Promise.race([received, new Promise<null>((r) => setTimeout(() => r(null), 2000))]);
      assert.equal(payload?.toString("utf8"), "fengsui-beacon-smoke");
    } finally {
      transport.close();
    }
  });
});
