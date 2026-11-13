import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CpeControlValidationError } from "../src/control-error.ts";
import { assertOneCell, readCellLockCommand, readDriverCellLockTargets } from "../src/control-input.ts";
import type { WriteCheck } from "../src/device-access.ts";
import { CORE_TOOLS } from "../src/mcp-core-tools.ts";
import { validateToolArguments } from "../src/mcp-schema.ts";
import { parseQuectelLteCellLock } from "../src/protocols/at/quectel.ts";
import { ROUTER_FAMILY_FACTS } from "../src/router-family.ts";
import { MAX_LOCK_CELLS } from "../src/rf-bounds.ts";
import { daemonOn } from "./helpers/driver-daemon.ts";
import { OPENWRT_PASSWORD, openwrtRouter } from "./helpers/openwrt-router.ts";
import { createStrictCpe } from "./helpers/strict-cpe.ts";
import { ZTE_PASSWORD, zteRouter } from "./helpers/zte-goform-router.ts";

/**
 * A cell lock that names several candidate cells (the router picks among them): Quectel's
 * `AT+QNWLOCK="common/4g",<n>,<freq>,<pci>,...` and FiberHome LG6151M's cell list. Mock routers only;
 * placeholder cells (B3 / 1850 / PCI 211, B1 / 300 / PCI 142).
 */

const check = (): WriteCheck => ({ endpoints: [], readback: "none", reason: null });
const TWO = { rat: "LTE", band: "B3", arfcn: 1850, pci: 211, more: [{ band: "B1", arfcn: 300, pci: 142 }] } as const;

describe("several candidate cells: input", () => {
  it("takes `more` as { band, arfcn, pci } each, a PCI on the first cell too, and at most the cap", () => {
    assert.deepEqual(readCellLockCommand({ ...TWO }, { allowNullPci: true }).more, [{ band: "B1", arfcn: 300, pci: 142 }]);
    // An empty list is no list
    assert.equal(readCellLockCommand({ ...TWO, more: [] }, { allowNullPci: true }).more, undefined);
    for (const [args, message] of [
      [{ ...TWO, pci: undefined }, /"pci" is required when "more"/],
      [{ ...TWO, more: "B1/300/142" }, /"more" must be a list/],
      [{ ...TWO, more: [{ band: "B1", arfcn: 300 }] }, /"more\[0\]\.pci" must be a finite integer/],
      [{ ...TWO, more: [["B1", 300, 142]] }, /"more\[0\]" must be \{ band, arfcn, pci \}/],
      [{ ...TWO, more: Array.from({ length: MAX_LOCK_CELLS }, (_, i) => ({ band: "B1", arfcn: 300, pci: i })) }, /at most 10 cells/],
    ] as const) {
      assert.throws(() => readCellLockCommand(args as Record<string, unknown>, { allowNullPci: true }), message);
    }
  });

  it("refuses them where a brand locks one cell at a time, and names twice the same cell nowhere", () => {
    const command = readCellLockCommand({ ...TWO }, { allowNullPci: false });
    assert.throws(() => assertOneCell(command), /locks one cell at a time/);
    assert.doesNotThrow(() => assertOneCell({ rat: "LTE", band: 3, arfcn: 1850, pci: 211 }));
    assert.deepEqual(
      readDriverCellLockTargets(command, ROUTER_FAMILY_FACTS.openwrt).map(({ arfcn, pci, band }) => [band, arfcn, pci]),
      [
        [3, 1850, 211],
        [1, 300, 142],
      ]
    );
    assert.throws(() => readDriverCellLockTargets({ ...command, rat: "NR", band: "N78", arfcn: 650000, more: [{ band: "N78", arfcn: 650000, pci: 142 }] }, ROUTER_FAMILY_FACTS.openwrt), /one 5G cell at a time/);
    assert.throws(() => readDriverCellLockTargets(command, ROUTER_FAMILY_FACTS["zte-goform"]), /one 4G cell at a time/);
    assert.throws(() => readDriverCellLockTargets({ ...command, more: [{ band: "B3", arfcn: 1850, pci: 211 }] }, ROUTER_FAMILY_FACTS.openwrt), /named twice/);
  });

  it("lets the MCP tool take `more` as objects, each field checked, and nothing else", () => {
    const tool = CORE_TOOLS.find((t) => t.name === "lock_cell");
    assert.ok(tool);
    assert.equal(validateToolArguments(tool.inputSchema, { ...TWO, confirm: true }), null);
    assert.match(validateToolArguments(tool.inputSchema, { ...TWO, confirm: true, more: [{ band: "B1", arfcn: 300 }] }) ?? "", /"more"\[0\]\.pci is required/);
    assert.match(validateToolArguments(tool.inputSchema, { ...TWO, confirm: true, more: [{ band: "B1", arfcn: 300, pci: 142, earfcn: 1 }] }) ?? "", /"more"\[0\]\.earfcn is not a known field/);
    assert.match(validateToolArguments(tool.inputSchema, { ...TWO, confirm: true, more: [{ band: "B1", arfcn: -1, pci: 142 }] }) ?? "", /"more"\[0\]\.arfcn must be >= 0/);
    assert.match(validateToolArguments(tool.inputSchema, { ...TWO, confirm: true, more: ["B1"] }) ?? "", /"more"\[0\] must be an object/);
  });
});

describe("several candidate cells: Quectel on OpenWrt", () => {
  it("reads the module's list of locked LTE cells", () => {
    assert.deepEqual(parseQuectelLteCellLock('+QNWLOCK: "common/4g",2,1850,211,300,142\r\n\r\nOK'), { locked: true, arfcn: 1850, pci: 211, band: null, others: [{ arfcn: 300, pci: 142 }] });
    assert.deepEqual(parseQuectelLteCellLock('+QNWLOCK: "common/4g",1,1850,211\nOK'), { locked: true, arfcn: 1850, pci: 211, band: null });
    assert.deepEqual(parseQuectelLteCellLock('+QNWLOCK: "common/4g",0\nOK'), { locked: false });
    assert.equal(parseQuectelLteCellLock("ERROR"), null);
  });

  it("sends the cells in one command, reads them back, and refuses 5G or a Fibocom module before sending", async () => {
    const quectel = openwrtRouter({ brand: "quectel" });
    await quectel.client.withSession(async (s) => {
      const write = check();
      assert.ok(s.setCellLocks);
      await s.setCellLocks(
        [
          { rat: "LTE", band: 3, arfcn: 1850, pci: 211, scsKhz: null },
          { rat: "LTE", band: 1, arfcn: 300, pci: 142, scsKhz: null },
        ],
        write
      );
      assert.equal(quectel.state.lock4g, "2,1850,211,300,142");
      assert.deepEqual([write.endpoints, write.readback], [["openwrt:AT+QNWLOCK/4g"], "match"]);
      await assert.rejects(s.setCellLocks([{ rat: "NR", band: 78, arfcn: 650000, pci: 142, scsKhz: 30 }], check()), /one 5G cell at a time/);
    });
    const fibocom = openwrtRouter({ brand: "fibocom" });
    await fibocom.client.withSession(async (s) => {
      const sent = fibocom.calls.length;
      await assert.rejects(s.setCellLocks?.([{ rat: "LTE", band: 3, arfcn: 1850, pci: 211, scsKhz: null }], check()) ?? Promise.reject(new Error("no setCellLocks")), /one cell at a time/);
      assert.equal(fibocom.calls.length, sent, "nothing sent");
    });
  });

  it("locks them through the daemon, which keeps the further cells in the lock state", async () => {
    const router = openwrtRouter({ brand: "quectel" });
    const daemon = daemonOn("openwrt", router.mock.fetchImpl, "http://192.168.1.1", OPENWRT_PASSWORD, "root");
    try {
      await daemon.core.monitor.refreshTelemetry();
      const state = await daemon.core.controls.lockCell({ rat: "LTE", band: "B3", arfcn: 1850, pci: 211, more: [{ band: "B1", arfcn: 300, pci: 142 }] });
      assert.deepEqual(state.cellLock, { rat: "LTE", band: 3, arfcn: 1850, pci: 211, more: [{ band: 1, arfcn: 300, pci: 142 }] });
      assert.deepEqual(state.lteBands, [3, 1]);
      assert.equal(router.state.lock4g, "2,1850,211,300,142");
      assert.equal(daemon.core.scheduler.genericWrites.at(-1)?.readback, "match");
    } finally {
      await daemon.cleanup();
    }
  });
});

describe("several candidate cells: routers that lock one", () => {
  it("refuses them on the H168-383 and on a ZTE router before anything is queued", async () => {
    const cpe = createStrictCpe();
    const huawei = daemonOn("huawei", cpe.fetchImpl, "http://192.168.8.1", cpe.password);
    try {
      assert.ok(await huawei.core.monitor.identifyDevice());
      const sent = cpe.stats.requests.length;
      await assert.rejects(huawei.core.controls.lockCell({ rat: "NR", band: "N78", arfcn: 650000, pci: 211, more: [{ band: "N78", arfcn: 650000, pci: 142 }] }), (err: unknown) => err instanceof CpeControlValidationError && /one cell at a time/.test(err.message));
      assert.equal(cpe.stats.requests.length, sent, "nothing sent to the verified router");
    } finally {
      await huawei.cleanup();
    }
    const zte = zteRouter({ sim: true, simSlot: "0" });
    const daemon = daemonOn("zte-goform", zte.mock.fetchImpl, "http://192.168.0.1", ZTE_PASSWORD);
    try {
      await daemon.core.monitor.refreshTelemetry();
      const sent = zte.mock.requests.length;
      await assert.rejects(daemon.core.controls.lockCell({ rat: "LTE", band: "B3", arfcn: 1850, pci: 211, more: [{ band: "B1", arfcn: 300, pci: 142 }] }), /one 4G cell at a time/);
      assert.equal(zte.mock.requests.length, sent, "no session");
    } finally {
      await daemon.cleanup();
    }
  });
});
