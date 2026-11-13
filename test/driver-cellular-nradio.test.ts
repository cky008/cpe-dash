import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CpeControlValidationError } from "../src/control-error.ts";
import { nradioModeOf, nradioModesOffered } from "../src/drivers/nradio.ts";
import { getXmlTag } from "../src/protocols/hilink/xml.ts";
import { cellularOf, daemonOn, fullSession, newCheck } from "./helpers/driver-daemon.ts";
import { NRADIO_PASSWORD, NRADIO_URL, nradioRouter } from "./helpers/nradio-router.ts";
import { createStrictCpe } from "./helpers/strict-cpe.ts";
import { ZTE_PASSWORD, zteRouter } from "./helpers/zte-goform-router.ts";

/**
 * NRadio (NROS) routers: the network mode as a setting of its own, both antennas at once, and a
 * lock on a channel alone, each through the module's bridge as its notes write it. Mock routers only.
 */

const tags = (body: string, names: ReadonlyArray<string>): Array<string | null> => names.map((name) => getXmlTag(body, name));

describe("nradio: the network mode", () => {
  it("offers the four modes every bridge takes, and 3G / 2G only where the module's own list names them", async () => {
    assert.deepEqual(nradioModesOffered(null), ["auto", "nr_sa", "nr_nsa", "lte"]);
    assert.deepEqual(nradioModesOffered("<response><AccessList><Access>00</Access><Access> 02 </Access><Access>03</Access></AccessList></response>"), ["auto", "nr_sa", "nr_nsa", "lte", "wcdma"]);
    assert.deepEqual(["00", "0801", "0802", "03", "02", "01", "0308", "", null].map(nradioModeOf), ["auto", "nr_sa", "nr_nsa", "lte", "wcdma", "gsm", null, null, null]);
    const plain = nradioRouter();
    assert.deepEqual(await plain.client.withSession((s) => cellularOf(s).read()), { networkMode: "auto", networkModes: ["auto", "nr_sa", "nr_nsa", "lte"] });
    const full = nradioRouter({ accessList: ["00", "01", "02", "03", "08"] });
    assert.deepEqual((await full.client.withSession((s) => cellularOf(s).read()))?.networkModes, ["auto", "nr_sa", "nr_nsa", "lte", "wcdma", "gsm"]);
  });

  it("writes the mode alone, with the bands the module reports sent back as they are", async () => {
    const { client, state } = nradioRouter();
    state.netMode = "<response><NetworkMode>00</NetworkMode><NetworkBand>3FFFFFFF</NetworkBand><LTEBand>5</LTEBand><NR5GBand>20000000000000000000</NR5GBand></response>";
    const check = newCheck();
    await client.withSession((s) => cellularOf(s).setNetworkMode("wcdma", check));
    const post = state.posts.find((p) => p.path === "/api/net/net-mode");
    assert.deepEqual(tags(post?.body ?? "", ["NetworkMode", "NetworkBand", "LTEBand", "NR5GBand"]), ["02", "3FFFFFFF", "5", "20000000000000000000"]);
    assert.ok(post?.token, "with the session's request token");
    assert.deepEqual(check, { endpoints: ["nradio:/api/net/net-mode"], readback: "match", reason: null });
    await client.withSession((s) => cellularOf(s).setNetworkMode("nr_sa", newCheck()));
    assert.equal(getXmlTag(state.netMode, "NetworkMode"), "0801");
    const sent = state.posts.length;
    await assert.rejects(client.withSession((s) => cellularOf(s).setNetworkMode("lte_wcdma", newCheck())), CpeControlValidationError);
    assert.equal(state.posts.filter((p) => p.path === "/api/net/net-mode").length, state.posts.slice(0, sent).filter((p) => p.path === "/api/net/net-mode").length);
  });

  it("through the daemon: takes 3G only where the module lists it, and hands self-healing the mode it had", async () => {
    const without = nradioRouter();
    const fx = daemonOn("nradio", without.mock.fetchImpl, NRADIO_URL, NRADIO_PASSWORD, "root");
    try {
      await assert.rejects(fx.core.controls.setNetworkMode("wcdma", { confirm: true }), /offers no "wcdma" network mode \(it offers auto, nr_sa, nr_nsa, lte\)/);
      assert.equal(without.state.posts.filter((p) => p.path === "/api/net/net-mode").length, 0);
      await fx.core.controls.setNetworkMode("lte", { confirm: true });
      assert.deepEqual(fx.linkChanges.at(-1)?.change, { kind: "network_mode", previous: "auto" });
    } finally {
      await fx.cleanup();
    }
    const listed = nradioRouter({ accessList: ["00", "02", "03"] });
    const fy = daemonOn("nradio", listed.mock.fetchImpl, NRADIO_URL, NRADIO_PASSWORD, "root");
    try {
      const result = await fy.core.controls.setNetworkMode("wcdma", { confirm: true });
      assert.deepEqual([result.networkMode, result.cellular?.networkMode], ["wcdma", { current: "wcdma", options: ["auto", "nr_sa", "nr_nsa", "lte", "wcdma"] }]);
    } finally {
      await fy.cleanup();
    }
  });
});

describe("nradio: both antennas, and a lock on a channel alone", () => {
  it("writes the notes' code 3 for both antennas at once, and never sends the H168-383 a fourth mode", async () => {
    const { client, state, mock } = nradioRouter();
    const check = newCheck();
    assert.equal(await client.withSession((s) => fullSession(s).setAntennaMode("hybrid", check)), 3);
    assert.deepEqual([state.antenna, check.readback], ["3", "match"]);
    const fx = daemonOn("nradio", mock.fetchImpl, NRADIO_URL, NRADIO_PASSWORD, "root");
    try {
      assert.deepEqual(await fx.core.controls.setAntennaMode("hybrid"), { mode: "hybrid", rawCode: 3 });
      await assert.rejects(fx.core.controls.setAntennaMode("both" as never), CpeControlValidationError);
    } finally {
      await fx.cleanup();
    }
    const cpe = createStrictCpe();
    const h168 = daemonOn("huawei", cpe.fetchImpl, "http://192.168.8.1", cpe.password);
    try {
      assert.ok(await h168.core.monitor.identifyDevice());
      const sent = cpe.stats.requests.length;
      await assert.rejects(h168.core.controls.setAntennaMode("hybrid"), (err: unknown) => err instanceof CpeControlValidationError && /no "hybrid" mode/.test(err.message));
      assert.equal(cpe.stats.requests.length, sent, "refused before any session");
    } finally {
      await h168.cleanup();
    }
  });

  it("locks a channel without a PCI with enable 1, and names the band for 5G", async () => {
    const { client, state } = nradioRouter();
    const lte = newCheck();
    await client.withSession((s) => fullSession(s).setFrequencyLock({ rat: "LTE", band: 1, arfcn: 300, scsKhz: null }, lte));
    assert.deepEqual(tags(state.posts.at(-1)?.body ?? "", ["mode", "enable", "scstype", "freq", "band", "cellid"]), ["0", "1", null, "300", "1", "0"]);
    assert.deepEqual(lte, { endpoints: ["nradio:/api/net/lock-freq"], readback: "unknown", reason: "unreadable" });
    await client.withSession((s) => fullSession(s).setFrequencyLock({ rat: "NR", band: 78, arfcn: 650000, scsKhz: null }, newCheck()));
    assert.deepEqual(tags(state.posts.at(-1)?.body ?? "", ["mode", "enable", "scstype", "freq", "band", "cellid"]), ["1", "1", "1", "650000", "78", "0"]);
    await assert.rejects(client.withSession((s) => fullSession(s).setFrequencyLock({ rat: "LTE", band: 1, arfcn: 650000, scsKhz: null }, newCheck())), /outside B1/);
  });

  it("through the daemon: a cell lock without a PCI is a channel lock here, and still refused where the brand locks cells only", async () => {
    const { mock, state } = nradioRouter();
    const fx = daemonOn("nradio", mock.fetchImpl, NRADIO_URL, NRADIO_PASSWORD, "root");
    try {
      const lock = await fx.core.controls.lockCell({ rat: "NR", band: "N78", arfcn: 650000 });
      assert.deepEqual([lock.mode, lock.cellLock], ["cell_lock", { rat: "NR", band: 78, arfcn: 650000, pci: null }]);
      assert.equal(getXmlTag(state.posts.filter((p) => p.path === "/api/net/lock-freq").at(-1)?.body ?? "", "enable"), "1");
      await fx.core.controls.lockCell({ rat: "NR", band: "N78", arfcn: 650000, pci: 142 });
      assert.deepEqual(tags(state.posts.filter((p) => p.path === "/api/net/lock-freq").at(-1)?.body ?? "", ["enable", "cellid"]), ["2", "142"]);
    } finally {
      await fx.cleanup();
    }
    const zte = zteRouter();
    const fy = daemonOn("zte-goform", zte.mock.fetchImpl, "http://192.168.0.1", ZTE_PASSWORD);
    try {
      await assert.rejects(fy.core.controls.lockCell({ rat: "LTE", band: "B1", arfcn: 300 }), /pci is required for a cell lock on this router/);
      assert.equal(zte.mock.requests.length, 0, "checked before any session");
    } finally {
      await fy.cleanup();
    }
  });
});
