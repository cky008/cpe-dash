import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GlobalTelemetrySnapshot } from "../src/api-contract.ts";
import type { BatteryStatus, SimCardStatus } from "../src/router-status.ts";
import { airplaneLine, batteryLine, loadText, roamingLine, routerUptimeSec, sensorsText, simPinLine, simSlotText, simStateLine, wifiText } from "../web/src/core/status-view.ts";
import { en } from "../web/src/i18n/en.ts";
import type { MessageKey } from "../web/src/i18n/zh-CN.ts";
import { zhCN } from "../web/src/i18n/zh-CN.ts";

function translator(dict: Readonly<Record<MessageKey, string>>) {
  return (key: MessageKey, params: Record<string, string | number> = {}): string => dict[key].replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? `{${name}}`));
}
const t = translator(en);
const zh = translator(zhCN);

const sim = (over: Partial<SimCardStatus> = {}): SimCardStatus => ({ state: "ready", pinLockEnabled: null, pinAttemptsLeft: null, pukAttemptsLeft: null, slot: null, ...over });
const battery = (over: Partial<BatteryStatus> = {}): BatteryStatus => ({ percent: 64, charging: null, temperatureC: null, minutesToFull: null, minutesToEmpty: null, ...over });

describe("console: the router's status in words (web/src/core/status-view.ts)", () => {
  it("names the SIM card's state, slot and PIN tries, in the colour that says how urgent it is", () => {
    assert.deepEqual(simStateLine(sim(), t), { text: "Ready", tone: "ok" });
    assert.deepEqual(simStateLine(sim({ state: "pin_required" }), t), { text: "Needs its PIN", tone: "bad" });
    assert.deepEqual(simStateLine(sim({ state: "absent" }), zh), { text: "没有插卡", tone: "warn" });
    assert.equal(simStateLine(sim({ state: "error" }), t)?.tone, "bad");
    assert.equal(simStateLine(sim({ state: null }), t), null, "HiLink's status code is shown then");
    assert.equal(simStateLine(null, t), null);
    assert.deepEqual([simSlotText(sim({ slot: { kind: "physical", index: 1 } }), t), simSlotText(sim({ slot: { kind: "embedded", index: 1 } }), t), simSlotText(sim({ slot: { kind: "embedded", index: 2 } }), zh), simSlotText(sim(), t)], [
      "Physical card",
      "Built-in (eSIM)",
      "内置卡 2（eSIM）",
      null,
    ]);
    assert.deepEqual(simPinLine(sim({ pinLockEnabled: true, pinAttemptsLeft: 3, pukAttemptsLeft: 10 }), t), { text: "Asked at start · PIN 3 · PUK 10 tries left", tone: "plain" });
    assert.equal(simPinLine(sim({ pinAttemptsLeft: 1 }), t)?.tone, "warn");
    assert.equal(simPinLine(sim({ pinAttemptsLeft: 0, pukAttemptsLeft: 10 }), t)?.tone, "bad");
    assert.deepEqual(simPinLine(sim({ pinLockEnabled: false }), zh), { text: "没开", tone: "plain" });
    assert.equal(simPinLine(sim(), t), null, "nothing reported: no row");
  });

  it("words roaming and airplane mode, a row only where the router says", () => {
    assert.deepEqual(roamingLine({ active: true, dataAllowed: false }, t), { text: "Roaming · data off abroad", tone: "warn" });
    assert.deepEqual(roamingLine({ active: null, dataAllowed: true }, zh), { text: "漫游时用数据", tone: "plain" });
    assert.deepEqual([roamingLine({ active: null, dataAllowed: null }, t), roamingLine(null, t)], [null, null]);
    assert.deepEqual(airplaneLine(true, t), { text: "On · no mobile connection", tone: "bad" });
    assert.deepEqual(airplaneLine(false, t), { text: "Off", tone: "plain" });
    assert.equal(airplaneLine(null, t), null);
  });

  it("puts the battery in one line: charge, charging, the router's estimate and its temperature", () => {
    assert.deepEqual(batteryLine(battery({ charging: true, minutesToFull: 92, temperatureC: 36.4 }), t, "en"), { text: "64% · charging · full in about 1h 32m · 36 °C", tone: "ok" });
    assert.deepEqual(batteryLine(battery({ percent: 18, charging: false, minutesToEmpty: 50 }), zh, "zh-CN"), { text: "18% · 用电池 · 约还能用 50分", tone: "warn" });
    assert.equal(batteryLine(battery({ percent: 8, charging: false }), t, "en")?.tone, "bad");
    assert.equal(batteryLine(battery({ percent: 8, charging: true }), t, "en")?.tone, "ok", "low but charging");
    assert.equal(batteryLine(battery({ percent: 15 }), t, "en")?.text, "15%");
    assert.deepEqual([batteryLine(battery({ percent: null }), t, "en"), batteryLine(null, t, "en")], [null, null]);
  });

  it("words the load, Wi-Fi and the sensors, and leaves out what the router does not report", () => {
    assert.equal(loadText({ uptimeSec: null, cpuPercent: 12, memoryPercent: 40 }, t), "CPU 12% · memory 40%");
    assert.equal(loadText({ uptimeSec: 60, cpuPercent: null, memoryPercent: 40 }, zh), "内存 40%");
    assert.equal(loadText({ uptimeSec: 60, cpuPercent: null, memoryPercent: null }, t), null);
    assert.equal(wifiText({ enabled: true, guestEnabled: false }, t), "On · guest network off");
    assert.equal(wifiText({ enabled: null, guestEnabled: null }, t), null);
    assert.equal(
      sensorsText(
        [
          { kind: "modem_4g", name: null, celsius: 46 },
          { kind: "pa", name: null, celsius: 44.2 },
          { kind: "other", name: "aoss-0-usr", celsius: 38 },
          { kind: "other", name: null, celsius: 30 },
        ],
        t
      ),
      "4G modem 46 · PA 44 · aoss-0-usr 38 · Other 30 °C"
    );
    assert.equal(sensorsText([{ kind: "modem", name: null, celsius: 46 }], t), null, "one value is the temperature row itself");
  });

  it("shows no uptime for a router that reports none of its own", () => {
    const telemetry = { device: { uptimeSec: 3600 }, capturedAtMs: 1_000_000 } as unknown as GlobalTelemetrySnapshot;
    assert.equal(routerUptimeSec(telemetry, 1_010_000), 3610);
    assert.equal(routerUptimeSec({ ...telemetry, unavailable: ["uptime"] }, 1_010_000), null);
    assert.equal(routerUptimeSec(null, 0), null);
  });
});
