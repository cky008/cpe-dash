import assert from "node:assert/strict";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { createFengSuiCore, stopFengSuiCore } from "../src/core.ts";
import { EncryptedStateStore } from "../src/state-store.ts";
import { TimeSeriesRingBuffer } from "../src/timeseries.ts";
import { blockNetwork } from "./helpers/cpe-family.ts";
import { createStrictCpe } from "./helpers/strict-cpe.ts";
import { removeTempDir, tempDir } from "./helpers/temp-dir.ts";
import { mockConnection } from "./helpers/connection.ts";

/**
 * The H168-383 is the one verified router: supporting other login methods must not change a single
 * request it gets. These sequences were recorded on the strict mock before phase 1 of multi-model
 * support (main@4fe393a): method, path, query keys, header names, cookie names and the body with
 * nonces and proofs masked, for a login with a telemetry poll, a write, and a wrong password.
 */

const XML = '<?xml version="1.0" encoding="UTF-8"?>';
const GET = "[_responsesource,accept,cookie,x-requested-with] {SessionID}";
const POST = "[__requestverificationtoken,_responsesource,accept,content-type,cookie,x-requested-with] {SessionID}";
const LOGIN = [
  "GET /api/user/state-login [_responsesource,accept,x-requested-with] {}",
  "GET /api/monitoring/status [_responsesource,accept,update-cookie,x-requested-with] {}",
  `GET /api/webserver/token ${GET}`,
  `POST /api/user/challenge_login ${POST} ${XML}<request><username>admin</username><firstnonce><hex></firstnonce><mode>1</mode></request>`,
  `POST /api/user/authentication_login ${POST} ${XML}<request><clientproof><hex></clientproof><finalnonce><hex></finalnonce></request>`,
];
const LOGOUT = `POST /api/user/logout ${POST} ${XML}<request><Logout>1</Logout></request>`;
const POLL = [
  ...LOGIN,
  ...[
    "/api/device/signal",
    "/api/device/seccellinfo",
    "/api/device/ri",
    "/api/net/cell-info",
    "/api/net/current-plmn",
    "/api/net/net-mode",
    "/api/device/information",
    "/api/device/basic_information",
    "/api/monitoring/status",
    "/api/monitoring/traffic-statistics",
    "/api/monitoring/month_statistics",
    "/api/monitoring/start_date",
  ].map((p) => `GET ${p} ${GET}`),
  LOGOUT,
];
const WRITE = [
  ...LOGIN,
  `POST /api/net/net-mode ${POST} ${XML}<request><NetworkMode>00</NetworkMode><NetworkBand>3fffffff</NetworkBand><LTEBand>5</LTEBand><networkOption>2</networkOption></request>`,
  `POST /api/net/lock-freq ${POST} ${XML}<request><lte_info><lock_mode>0</lock_mode><freq_infos></freq_infos><all_bands></all_bands></lte_info><nr_info><lock_mode>3</lock_mode><freq_infos><freq_info><band>78</band></freq_info></freq_infos><all_bands>20000000000000000000</all_bands></nr_info></request>`,
  LOGOUT,
];

function wireFixture(password?: string) {
  const cpe = createStrictCpe();
  const log: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const names = [...headers.keys()].sort().join(",");
    const cookies = (headers.get("cookie") ?? "")
      .split(";")
      .map((c) => c.split("=")[0]?.trim())
      .filter(Boolean)
      .join(",");
    const query = [...url.searchParams.keys()].join(",");
    const body = typeof init?.body === "string" ? init.body.replace(/[0-9a-f]{32,}/gi, "<hex>") : "";
    log.push(`${init?.method ?? "GET"} ${url.pathname}${query ? `?${query}` : ""} [${names}] {${cookies}} ${body}`.trimEnd());
    return await cpe.fetchImpl(input, init);
  };
  const dir = tempDir("fengsui-wire-");
  const core = createFengSuiCore({
    connection: mockConnection({ password: password ?? cpe.password, fetchImpl }),
    stateStore: new EncryptedStateStore({ filePath: path.join(dir, "state.json"), encryptionKey: "wire_key" }),
    timeseries: new TimeSeriesRingBuffer({ retentionHours: 1 }),
    pollIntervalMs: 600_000,
    neighborScanIntervalMs: 600_000,
  });
  core.monitor.init();
  return {
    cpe,
    core,
    take: (): string[] => log.splice(0),
    cleanup: async () => {
      await stopFengSuiCore(core);
      removeTempDir(dir);
    },
  };
}

describe("H168-383 wire sequences stay as recorded before other login methods", () => {
  let restoreNetwork: () => void = () => undefined;
  before(() => {
    restoreNetwork = blockNetwork();
  });
  after(() => restoreNetwork());

  it("logs in with SCRAM, polls and writes with exactly the recorded requests", async () => {
    const fx = wireFixture();
    try {
      assert.ok(await fx.core.monitor.refreshTelemetry());
      assert.deepEqual(fx.take(), POLL);
      await fx.core.controls.lockBands({ lteBands: [1, 3], nrBands: [78] });
      assert.deepEqual(fx.take(), WRITE);
      assert.deepEqual([fx.cpe.stats.tokenRejections, fx.cpe.stats.staleSessionRequests, fx.cpe.stats.overlapLoginAttempts], [0, 0, 0]);
    } finally {
      await fx.cleanup();
    }
  });

  it("submits a wrong password once, then sends nothing", async () => {
    const fx = wireFixture("not_the_router_password");
    try {
      await assert.rejects(fx.core.monitor.refreshTelemetry());
      await fx.core.monitor.refreshTelemetry().catch(() => undefined);
      assert.deepEqual(fx.take(), LOGIN);
      assert.deepEqual([fx.cpe.failedLogins(), fx.core.scheduler.isCircuitTripped()], [1, true]);
    } finally {
      await fx.cleanup();
    }
  });
});
