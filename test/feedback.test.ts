import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { createFengSuiCore, stopFengSuiCore } from "../src/core.ts";
import { HuaweiCpeClient } from "../src/cpe-client.ts";
import { buildDeviceReport } from "../src/device-profile.ts";
import { DEVICE_REPORT_TEMPLATE, ISSUE_NEW_URL, deviceIssueTitle, deviceIssueUrl } from "../src/feedback.ts";
import { sanitizeDeviceReport } from "../src/sanitize.ts";
import { EncryptedStateStore } from "../src/state-store.ts";
import { TimeSeriesRingBuffer } from "../src/timeseries.ts";
import { blockNetwork, createCpeFamily } from "./helpers/cpe-family.ts";
import { removeTempDir, tempDir } from "./helpers/temp-dir.ts";

/**
 * Multi-model phase 2.4: the console's "report compatibility" entry. The owner creates the
 * desensitized device report, reads it, copies or downloads it, and opens a new issue whose URL
 * holds the form and a title only. Nothing is uploaded. Placeholders only, no network.
 */

const TEMPLATE = fs.readFileSync(path.join(".github", "ISSUE_TEMPLATE", DEVICE_REPORT_TEMPLATE), "utf8");

describe("feedback: the compatibility issue", () => {
  let restoreNetwork: () => void = () => undefined;
  before(() => {
    restoreNetwork = blockNetwork();
  });
  after(() => restoreNetwork());

  it("opens the project's new-issue page with the form and a title, never the report", () => {
    const url = new URL(deviceIssueUrl({ model: "B535-232", softwareVersion: "11.0.1.2(H7SP2C00)" }));
    assert.equal(`${url.origin}${url.pathname}`, ISSUE_NEW_URL);
    assert.deepEqual([...url.searchParams.keys()], ["template", "title"]);
    assert.equal(url.searchParams.get("template"), DEVICE_REPORT_TEMPLATE);
    assert.equal(url.searchParams.get("title"), "Device report: B535-232 · 11.0.1.2(H7SP2C00)");
    assert.ok(url.toString().length < 300, "short: GitHub caps URL length, and the report goes in the issue body");

    assert.equal(deviceIssueTitle(null), "Device report: unknown model");
    assert.equal(deviceIssueTitle({ model: "B535-232", softwareVersion: null }), "Device report: B535-232");
    assert.equal(deviceIssueTitle({ model: "B535<script>", softwareVersion: "1.0\n2.0" }), "Device report: ? · 1.0 2.0", "odd text never reaches the title as written");
    assert.ok(deviceIssueTitle({ model: "M".repeat(200), softwareVersion: "1" }).length <= 120);

    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8")) as { bugs: { url: string } };
    assert.equal(ISSUE_NEW_URL, `${pkg.bugs.url}/new`, "the same repository as package.json");
  });

  it("ships the device-report form with model, firmware, what works, the report and a privacy check", () => {
    for (const field of ["id: model", "id: firmware", "id: works", "id: broken", "id: report", "id: privacy"]) assert.ok(TEMPLATE.includes(field), field);
    assert.match(TEMPLATE, /^title: "Device report: "$/m, "the console's title starts the same way");
    assert.ok(deviceIssueTitle(null).startsWith("Device report: "));
    assert.match(TEMPLATE, /labels: \["device-report"\]/);
    assert.match(TEMPLATE, /H168-383/, "says what is verified");
    // Writes on another model are locked by default, not all of them for good: experimental ones may be on (R3-10)
    assert.doesNotMatch(TEMPLATE, /全部锁定|every write is locked/i);
    assert.match(TEMPLATE, /写操作默认锁定[^\n]*实验性写入/);
    assert.match(TEMPLATE, /writes are locked by default[^\n]*experimental writes/);
    assert.match(TEMPLATE, /required: true\n\s*$/, "the privacy check must be ticked");
    assert.doesNotMatch(TEMPLATE, /render:/, "a plain text area, so the downloaded file can be attached");
  });

  it("builds the report it asks for without an identifier, for a router of another model", async () => {
    // The family router answers device/information with the placeholder IMEI and WAN address
    const cpe = createCpeFamily({ login: "sha256", tokenFlow: "sestokinfo", model: "B535-232" });
    const dir = tempDir("fengsui-feedback-");
    const core = createFengSuiCore({
      client: new HuaweiCpeClient({ cpeUrl: "http://192.168.8.1", cpePassword: cpe.password, fetchImpl: cpe.fetchImpl }),
      stateStore: new EncryptedStateStore({ filePath: path.join(dir, "state.json"), encryptionKey: "feedback_key" }),
      timeseries: new TimeSeriesRingBuffer({ retentionHours: 1 }),
      pollIntervalMs: 600_000,
      neighborScanIntervalMs: 600_000,
    });
    core.monitor.init();
    try {
      const probe = await core.monitor.identifyDevice();
      assert.ok(probe);
      // What GET /api/console/device-report hands the console
      const report = sanitizeDeviceReport(
        buildDeviceReport({ probe, apiErrors: core.scheduler.apiErrorSnapshot(), fengsuiVersion: "1.6.0", generatedAtIso: "2026-11-03T00:00:00.000Z", access: core.scheduler.device.snapshot() })
      );
      const json = JSON.stringify(report);
      for (const identifier of ["860000000000000", "203.0.113.10"]) assert.equal(json.includes(identifier), false, identifier);
      assert.deepEqual([report.identity?.model, report.identity?.loginScheme, report.access?.writes], ["B535-232", "sha256", "read_only"]);
      const issue = deviceIssueUrl(report.identity);
      assert.equal(issue.includes("860000000000000") || issue.includes("203.0.113"), false);
      assert.deepEqual(cpe.stats.writes, [], "reading for a report writes nothing");
    } finally {
      await stopFengSuiCore(core);
      removeTempDir(dir);
    }
  });
});

describe("issue forms", () => {
  it("are YAML that GitHub accepts: no ': ' inside an unquoted value (it reads as a new key and the form is rejected)", () => {
    const dir = path.join(".github", "ISSUE_TEMPLATE");
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".yml"));
    assert.ok(files.length >= 4, "bug report, feature request, device report and the chooser config");
    for (const file of files) {
      fs.readFileSync(path.join(dir, file), "utf8")
        .split("\n")
        .forEach((line, i) => {
          const plain = /^\s*(?:- )?[A-Za-z_]+:\s+([^|>"'\s].*)$/.exec(line)?.[1];
          if (plain !== undefined) assert.doesNotMatch(plain, /:\s/, `${file}:${i + 1} needs quotes`);
        });
    }
  });
});
