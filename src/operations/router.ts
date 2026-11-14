import { readAntennaMode, readBandLock, readCellLockCommand, readConfirmed, readSecurityControl, readSecuritySwitchArgs, readSwitch, readWifi7, readWifiAndAntennaArgs } from "../control-input.ts";
import { H168_383_LTE_BANDS, H168_383_NR_BANDS } from "../rf-bounds.ts";
import type { OperationTable } from "./record.ts";

/** The router's controls: the band and cell locks, unlocking, reboot and redial, its switches, the antenna, mobile data. */

const LTE_BAND_LIST = H168_383_LTE_BANDS.map((b) => `B${b}`).join(", ");
const NR_BAND_LIST = H168_383_NR_BANDS.map((b) => `N${b}`).join(", ");
const BAND_SELECTION = {
  oneOf: [
    { type: "string", enum: ["all"] },
    { type: "array", items: { oneOf: [{ type: "string" }, { type: "number" }] } },
  ],
} as const;
const ONE_SHOT = { readOnlyHint: false, destructiveHint: true, idempotentHint: false } as const;
const REPEATABLE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true } as const;

export const ROUTER_OPERATIONS = {
  bandLock: {
    access: "write",
    actions: ["lock_band"],
    permission: "control",
    input: readBandLock,
    rest: {
      method: "POST",
      path: "/api/control/band-lock",
      group: "control",
      example: '{"lteBands":["B1","B3"]}',
      summary: { "zh-CN": "锁频段（`lteBands`、`nrBands`，`\"all\"` 为全部频段；只给一种制式时另一种不变）", en: "Lock bands (`lteBands`, `nrBands`, `\"all\"` for every band; the type you leave out stays as it is)" },
    },
    mcp: {
      tool: "lock_band",
      title: "Lock 4G LTE & 5G NR Frequency Bands",
      description: `Dynamically lock 4G LTE bands (via BandMask bitwise codec) and/or 5G NR bands (via lock_mode=3), e.g., lteBands=['B1','B3'], nrBands=['N78']. LTE bands must be ones the H168-383 supports (${LTE_BAND_LIST}); NR bands must be ones it supports (${NR_BAND_LIST}). Locking LTE to bands no nearby cell uses drops all connectivity. Politely aborts if a human admin is logged in. Requires confirm: true.`,
      annotations: REPEATABLE,
      properties: {
        lteBands: { ...BAND_SELECTION, description: `4G LTE bands to lock (subset of ${LTE_BAND_LIST}) or 'all' to restore all LTE bands.` },
        nrBands: { ...BAND_SELECTION, description: "5G NR bands to lock (e.g. ['N78', 'N41']) or 'all' to unlock NR bands." },
      },
      // On a model nobody verified the band lock writes LTE bands only, from those the router advertises
      onUnverified: (tool, context) => {
        const bands = (context.lteBands ?? []).map((band) => `B${band}`).join(", ") || "none advertised";
        const { nrBands: _nr, ...properties } = tool.inputSchema.properties;
        return {
          ...tool,
          description: `Lock 4G LTE bands only (no NR band on this model), from those the router advertises: ${bands}; or 'all' to unlock. Locking LTE to bands no nearby cell uses drops all connectivity. Politely aborts if a human admin is logged in.`,
          inputSchema: { ...tool.inputSchema, properties: { ...properties, lteBands: { ...BAND_SELECTION, description: `LTE bands to lock (subset of ${bands}) or 'all' to unlock.` } } },
        };
      },
    },
  },
  cellLock: {
    access: "write",
    actions: ["lock_cell"],
    permission: "control",
    // Omitted or null pci means a frequency lock; anything else must be a number, never silently dropped
    input: (fields) => readCellLockCommand(fields, { allowNullPci: true }),
    rest: {
      method: "POST",
      path: "/api/control/cell-lock",
      group: "control",
      example: '{"rat":"NR","band":"N78","arfcn":650000,"pci":211}',
      summary: { "zh-CN": "锁小区；不给 `pci` 时只锁频点", en: "Lock a cell; without `pci`, lock the channel only" },
    },
    mcp: {
      tool: "lock_cell",
      title: "Lock Specific 4G/5G Base Station Cell (PCI + ARFCN)",
      description:
        "Lock the modem onto a specific 4G LTE or 5G NR frequency (lock_mode=1) or physical cell PCI + ARFCN (lock_mode=2). Only cells FengSui has observed (serving cell, aggregated carriers or the latest neighbour scan) can be locked: call list_neighbor_cells first and copy rat/band/arfcn/pci from its result. Requires confirm: true.",
      annotations: REPEATABLE,
      properties: {
        rat: { type: "string", enum: ["LTE", "NR"], description: "Radio technology ('LTE' or 'NR')." },
        band: { oneOf: [{ type: "string" }, { type: "number" }], description: "Band label or number (e.g. 'B1' or 'N78')." },
        arfcn: { type: "integer", minimum: 0, description: "Downlink EARFCN or NR-ARFCN of an observed cell." },
        pci: { type: "integer", minimum: 0, maximum: 1007, description: "Optional Physical Cell ID (LTE 0..503, NR 0..1007). Omit to lock frequency only." },
        more: {
          type: "array",
          maxItems: 9,
          description:
            "Optional further candidate cells of the same RAT, each observed like the first: the router picks among them. Only routers that lock several cells at once take them (an OpenWrt router with a Quectel module, 4G; a FiberHome LG6151M); any other refuses them before anything is sent. The first cell then needs its pci.",
          items: {
            type: "object",
            properties: {
              band: { oneOf: [{ type: "string" }, { type: "number" }], description: "Band label or number." },
              arfcn: { type: "integer", minimum: 0, description: "Downlink EARFCN or NR-ARFCN of an observed cell." },
              pci: { type: "integer", minimum: 0, maximum: 1007, description: "Its Physical Cell ID." },
            },
            required: ["band", "arfcn", "pci"],
            additionalProperties: false,
          },
        },
      },
      required: ["rat", "band", "arfcn"],
    },
  },
  unlock: {
    access: "write",
    // Filed under the band lock; the gate opens it wherever the band lock or the cell lock is open
    actions: ["unlock_rf_locks"],
    permission: "control",
    rest: { method: "POST", path: "/api/control/unlock", group: "control", summary: { "zh-CN": "解除锁频段和锁小区", en: "Clear band and cell locks" } },
    mcp: {
      tool: "unlock_rf_locks",
      title: "Clear All Band & Cell Locks",
      description:
        "Clear all 4G/5G cell, frequency, and band locks and restore automatic full-band selection (the modem may briefly re-attach, dropping the cellular link). Requires confirm: true.",
      annotations: REPEATABLE,
      properties: {},
    },
  },
  reboot: {
    access: "write",
    actions: ["reboot_cpe"],
    permission: "control",
    rest: { method: "POST", path: "/api/control/reboot", group: "control", example: '{"confirm":true}', summary: { "zh-CN": "重启路由器", en: "Restart the router" } },
    mcp: {
      tool: "reboot_cpe",
      title: "Reboot Huawei 5G CPE Router",
      description: "Remotely reboot the Huawei H168-383 router (takes ~45-90s). Strictly requires confirm: true.",
      annotations: ONE_SHOT,
      properties: { confirm: { type: "boolean", description: "Mandatory safety confirmation flag: MUST be explicitly set to true." } },
    },
  },
  reconnect: {
    access: "write",
    actions: ["reconnect_cellular"],
    permission: "control",
    input: readConfirmed("Cellular reconnect requires explicit { confirm: true }"),
    rest: { method: "POST", path: "/api/control/reconnect", group: "control", example: '{"confirm":true}', summary: { "zh-CN": "重拨移动网络（不重启路由器）", en: "Redial the mobile connection (no restart)" } },
    mcp: {
      tool: "reconnect_cellular",
      title: "Reconnect Cellular WAN Session",
      description: "Trigger a fast cellular WAN PDN reconnect (POST /api/net/reconnect) without rebooting the router.",
      annotations: ONE_SHOT,
      properties: { confirm: { type: "boolean", description: "Must be true to confirm cellular reconnect." } },
    },
  },
  securitySwitches: {
    access: "write",
    actions: ["set_security_switches"],
    permission: "control",
    input: readSecurityControl,
    rest: {
      method: "POST",
      path: "/api/control/security",
      group: "control",
      example: '{"upnpEnabled":false}',
      summary: { "zh-CN": "UPnP、DMZ、防火墙（`upnpEnabled`、`dmz`、`firewall`，只给要改的）", en: "UPnP, DMZ and firewall (`upnpEnabled`, `dmz`, `firewall`; send only what changes)" },
    },
    mcp: {
      tool: "set_security_switches",
      title: "Update UPnP, DMZ & Firewall Switches",
      description: "Toggle HAR-verified H168-383 security switches: UPnP, DMZ host, Main Firewall, IP/MAC/URL filter, and WAN Ping block. Requires confirm: true.",
      annotations: REPEATABLE,
      properties: {
        upnpEnabled: { type: "boolean" },
        dmzEnabled: { type: "boolean" },
        dmzIpAddress: { type: "string", description: "LAN IPv4 address for DMZ host." },
        firewallMainSwitch: { type: "boolean" },
        firewallIpFilterSwitch: { type: "boolean" },
        firewallWanPortPingSwitch: { type: "boolean" },
        firewallMacFilterSwitch: { type: "boolean" },
        firewallUrlFilterSwitch: { type: "boolean" },
      },
      // One flat argument per switch, where the REST body has `dmz` and `firewall` objects
      input: readSecuritySwitchArgs,
    },
  },
  wifi7: {
    access: "write",
    actions: ["set_wifi7_mlo"],
    permission: "control",
    input: readWifi7,
    rest: {
      method: "POST",
      path: "/api/control/wifi7",
      group: "control",
      example: '{"mloEnable":true}',
      summary: { "zh-CN": "Wi-Fi 7 多链路（`mloEnable`）和双频优选（`dbhoEnable`）", en: "Wi-Fi 7 multi-link (`mloEnable`) and dual-band steering (`dbhoEnable`)" },
    },
  },
  antenna: {
    access: "write",
    actions: ["set_antenna_mode"],
    permission: "control",
    input: (fields) => readAntennaMode(fields["mode"]),
    rest: { method: "POST", path: "/api/control/antenna", group: "control", example: '{"mode":"auto"}', summary: { "zh-CN": "天线：`auto`、`internal`、`external`", en: "Antenna: `auto`, `internal`, `external`" } },
  },
  mobileData: {
    access: "write",
    actions: ["set_mobile_data"],
    permission: "control",
    input: readSwitch,
    rest: { method: "POST", path: "/api/control/mobile-data", group: "control", example: '{"enabled":true}', summary: { "zh-CN": "打开或关闭移动数据", en: "Turn mobile data on or off" } },
  },
  wifiAndAntenna: {
    access: "write",
    actions: ["set_wifi7_mlo", "set_antenna_mode"],
    permission: "control",
    input: readWifiAndAntennaArgs,
    mcp: {
      tool: "set_wifi_and_antenna",
      title: "Configure Wi-Fi 7 MLO & Antenna Mode",
      description:
        "Toggle Wi-Fi 7 (802.11be) Multi-Link Operation (mloEnable), Dual-Band Handover (dbhoEnable), and/or cellular antenna mode ('auto' | 'internal' | 'external'; 'hybrid', internal and external together, only on a router that has it). Requires confirm: true.",
      annotations: REPEATABLE,
      properties: {
        mloEnable: { type: "boolean" },
        dbhoEnable: { type: "boolean" },
        antennaMode: { type: "string", enum: ["auto", "internal", "external", "hybrid"] },
      },
    },
  },
} satisfies OperationTable;
