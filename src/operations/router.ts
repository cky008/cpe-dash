import { readAntennaMode, readBandLock, readCellLockCommand, readSecurityControl, readSecuritySwitchArgs, readSwitch, readWifi7, readWifiAndAntennaArgs } from "../control-input.ts";
import type { OperationTable } from "./record.ts";

/** The router's controls: the band and cell locks, unlocking, reboot and redial, its switches, the antenna, mobile data. */

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
      example: '{"lteBands":["B1","B3"],"confirm":true}',
      summary: { "zh-CN": "锁频段（`lteBands`、`nrBands`，`\"all\"` 为全部频段；只给一种制式时另一种不变）", en: "Lock bands (`lteBands`, `nrBands`, `\"all\"` for every band; the type you leave out stays as it is)" },
    },
    mcp: {
      tool: "lock_band",
      title: "Lock 4G and 5G Bands",
      description:
        "Lock the router to the given 4G (LTE) and/or 5G (NR) bands, e.g. lteBands ['B1', 'B3'] and nrBands ['N78']; 'all' clears the lock for that kind, and a kind you leave out stays as it is. A band this router does not support is refused, with the bands it does, before anything is sent. Locking to bands no nearby cell uses takes the router offline: check get_cpe_telemetry and list_neighbor_cells first; unlock_rf_locks undoes the lock. If someone is signed in to the router's own web page, FengSui steps aside and sends nothing.",
      annotations: REPEATABLE,
      properties: {
        lteBands: { ...BAND_SELECTION, description: "4G bands to lock, e.g. ['B1', 'B3'], or 'all' for every 4G band." },
        nrBands: { ...BAND_SELECTION, description: "5G bands to lock, e.g. ['N78'], or 'all' for every 5G band." },
      },
      // On a model nobody verified the band lock writes LTE bands only, from those the router advertises;
      // on a brand with a driver of its own it is that driver's band lock, with the bands and mixes the brand takes
      onUnverified: (tool, context) => {
        if (context.ownDriver) {
          return {
            ...tool,
            description:
              "Lock 4G LTE and/or 5G NR bands, e.g., lteBands=['B1','B3'], nrBands=['N78']; 'all' restores every band of a kind, and a kind you leave out stays as it is. Which bands and which mixes of them this router takes is its own brand's matter: a selection it cannot take is refused, with the reason, before anything is sent. Locking to bands no nearby cell uses drops all connectivity. If someone is signed in to the router's own web page, FengSui steps aside and sends nothing.",
            inputSchema: { ...tool.inputSchema, properties: { ...tool.inputSchema.properties, lteBands: { ...BAND_SELECTION, description: "4G LTE bands to lock (e.g. ['B1', 'B3']) or 'all' to restore all LTE bands." } } },
          };
        }
        const bands = (context.lteBands ?? []).map((band) => `B${band}`).join(", ") || "none advertised";
        const { nrBands: _nr, ...properties } = tool.inputSchema.properties;
        return {
          ...tool,
          description: `Lock 4G LTE bands only (no NR band on this model), from those the router advertises: ${bands}; or 'all' to unlock. Locking LTE to bands no nearby cell uses drops all connectivity. If someone is signed in to the router's own web page, FengSui steps aside and sends nothing.`,
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
      example: '{"rat":"NR","band":"N78","arfcn":650000,"pci":211,"confirm":true}',
      summary: { "zh-CN": "锁小区；不给 `pci` 时只锁频点", en: "Lock a cell; without `pci`, lock the channel only" },
    },
    mcp: {
      tool: "lock_cell",
      title: "Lock a 4G or 5G Cell",
      description:
        "Lock the router to one 4G (LTE) or 5G (NR) cell, given by its channel number (ARFCN) and PCI, or to a channel alone when pci is left out. Only cells FengSui has seen can be locked (the serving cell, an aggregated carrier or one from the latest neighbour list): call list_neighbor_cells first and copy rat, band, arfcn and pci from its result. A cell that cannot serve the router takes it offline; unlock_rf_locks removes the lock.",
      annotations: REPEATABLE,
      properties: {
        rat: { type: "string", enum: ["LTE", "NR"], description: "'LTE' for a 4G cell, 'NR' for a 5G cell." },
        band: { oneOf: [{ type: "string" }, { type: "number" }], description: "The cell's band, as a label or a number (e.g. 'B1' or 'N78')." },
        arfcn: { type: "integer", minimum: 0, description: "The cell's downlink channel number (EARFCN for 4G, NR-ARFCN for 5G), as list_neighbor_cells gives it." },
        pci: { type: "integer", minimum: 0, maximum: 1007, description: "The cell's Physical Cell ID (4G 0 to 503, 5G 0 to 1007). Leave it out to lock the channel only." },
        more: {
          type: "array",
          maxItems: 9,
          description:
            "Optional further candidate cells of the same RAT, each observed like the first: the router picks among them. Only routers that lock several cells at once take them (an OpenWrt router with a Quectel module, 4G; a FiberHome LG6151M); any other refuses them before anything is sent. The first cell then needs its pci.",
          items: {
            type: "object",
            properties: {
              band: { oneOf: [{ type: "string" }, { type: "number" }], description: "The cell's band, as a label or a number." },
              arfcn: { type: "integer", minimum: 0, description: "The cell's downlink channel number, as list_neighbor_cells gives it." },
              pci: { type: "integer", minimum: 0, maximum: 1007, description: "The cell's Physical Cell ID." },
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
    rest: { method: "POST", path: "/api/control/unlock", group: "control", example: '{"confirm":true}', summary: { "zh-CN": "解除锁频段和锁小区", en: "Clear band and cell locks" } },
    mcp: {
      tool: "unlock_rf_locks",
      title: "Clear Band and Cell Locks",
      description:
        "Remove every 4G and 5G band, channel and cell lock, so the router chooses bands and cells on its own again. It may drop the mobile connection for a moment while it attaches again. Use it to undo lock_band or lock_cell; get_cpe_telemetry shows the locks in force.",
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
      title: "Restart the Router",
      description:
        "Restart the router. Every device on it loses the internet and the local network until it is back, a minute or two on most routers, and FengSui reads nothing from it meanwhile. FengSui never restarts the router on its own; use this only when the user asks for a restart.",
      annotations: ONE_SHOT,
      properties: {},
    },
  },
  reconnect: {
    access: "write",
    actions: ["reconnect_cellular"],
    permission: "control",
    rest: { method: "POST", path: "/api/control/reconnect", group: "control", example: '{"confirm":true}', summary: { "zh-CN": "重拨移动网络（不重启路由器）", en: "Redial the mobile connection (no restart)" } },
    mcp: {
      tool: "reconnect_cellular",
      title: "Reconnect the Mobile Connection",
      description:
        "Drop and set up again the router's mobile data connection without restarting it; the internet is down for a few seconds and the WAN address may change. On a router without a reconnect command of its own, FengSui turns the connection off and on again, and always sends the turn-on, even when the session is cut short.",
      annotations: ONE_SHOT,
      properties: {},
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
      example: '{"upnpEnabled":false,"confirm":true}',
      summary: { "zh-CN": "UPnP、DMZ、防火墙（`upnpEnabled`、`dmz`、`firewall`，只给要改的）", en: "UPnP, DMZ and firewall (`upnpEnabled`, `dmz`, `firewall`; send only what changes)" },
    },
    mcp: {
      tool: "set_security_switches",
      title: "Change UPnP, DMZ and Firewall Switches",
      description:
        "Turn the router's UPnP, DMZ host, firewall, its IP, MAC and URL filters, and the WAN ping block on or off. Send only the switches to change; the others stay as they are. get_router_settings shows the current state. A DMZ host is reachable from the internet on every port, and turning the firewall off removes the filters' protection.",
      annotations: REPEATABLE,
      properties: {
        upnpEnabled: { type: "boolean", description: "true lets devices on the network open ports on the router by themselves (UPnP); false stops it." },
        dmzEnabled: { type: "boolean", description: "true forwards every incoming connection to the DMZ host (dmzIpAddress); false turns the DMZ host off." },
        dmzIpAddress: { type: "string", description: "The LAN IPv4 address of the device to make the DMZ host." },
        firewallMainSwitch: { type: "boolean", description: "The router's firewall as a whole; the filters below work only while it is on." },
        firewallIpFilterSwitch: { type: "boolean", description: "The firewall's IP address filter." },
        firewallWanPortPingSwitch: { type: "boolean", description: "true blocks ping requests from the internet; false lets the router answer them." },
        firewallMacFilterSwitch: { type: "boolean", description: "The firewall's MAC address filter (for wired and Wi-Fi devices; the Wi-Fi MAC filter is set_wifi_mac_filter)." },
        firewallUrlFilterSwitch: { type: "boolean", description: "The firewall's website (URL) filter." },
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
      example: '{"mloEnable":true,"confirm":true}',
      summary: { "zh-CN": "Wi-Fi 7 多链路（`mloEnable`）和双频优选（`dbhoEnable`）", en: "Wi-Fi 7 multi-link (`mloEnable`) and dual-band steering (`dbhoEnable`)" },
    },
  },
  antenna: {
    access: "write",
    actions: ["set_antenna_mode"],
    permission: "control",
    input: (fields) => readAntennaMode(fields["mode"]),
    rest: { method: "POST", path: "/api/control/antenna", group: "control", example: '{"mode":"auto","confirm":true}', summary: { "zh-CN": "天线：`auto`、`internal`、`external`", en: "Antenna: `auto`, `internal`, `external`" } },
  },
  mobileData: {
    access: "write",
    actions: ["set_mobile_data"],
    permission: "control",
    input: readSwitch,
    rest: { method: "POST", path: "/api/control/mobile-data", group: "control", example: '{"enabled":true,"confirm":true}', summary: { "zh-CN": "打开或关闭移动数据", en: "Turn mobile data on or off" } },
    mcp: {
      tool: "set_mobile_data",
      title: "Turn Mobile Data On or Off",
      description:
        "Turn the router's mobile data on (enabled: true) or off (enabled: false). While it is off the router has no internet over the mobile network, though it stays reachable on the LAN. FengSui never turns it back on on its own: it stays off until someone turns it on here or in the console. Requires confirm: true.",
      annotations: REPEATABLE,
      properties: { enabled: { type: "boolean", description: "true turns mobile data on, false turns it off." } },
      required: ["enabled"],
    },
  },
  wifiAndAntenna: {
    access: "write",
    actions: ["set_wifi7_mlo", "set_antenna_mode"],
    permission: "control",
    input: readWifiAndAntennaArgs,
    mcp: {
      tool: "set_wifi_and_antenna",
      title: "Change Wi-Fi Multi-Link, 5 GHz Priority and the Antenna",
      description:
        "Turn Wi-Fi multi-link operation (MLO) or 5 GHz priority on or off, and/or choose which cellular antennas the router uses. Send only what changes; a setting this router does not have is refused before anything is sent. get_router_settings shows the current state. Wi-Fi devices may reconnect after an MLO or 5 GHz priority change.",
      annotations: REPEATABLE,
      properties: {
        mloEnable: { type: "boolean", description: "Wi-Fi multi-link operation (MLO): devices that support it use several bands at once. Some older devices connect badly while it is on." },
        dbhoEnable: { type: "boolean", description: "5 GHz priority: 2.4 GHz and 5 GHz share one Wi-Fi name and devices are steered to 5 GHz. Off gives each band its own name." },
        antennaMode: { type: "string", enum: ["auto", "internal", "external", "hybrid"], description: "Which cellular antennas to use: 'auto', 'internal', 'external', or 'hybrid' (internal and external together, only on a router that has it)." },
      },
    },
  },
} satisfies OperationTable;
