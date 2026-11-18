import { readTimeSeriesArgs, readTimeSeriesQuery } from "../control-input.ts";
import { type OperationTable, flag } from "./record.ts";

/**
 * Reading what FengSui has read, and reading it again now: the REST reads (the daemon's latest data,
 * no router session), the refreshes (one read session), and the agents' read tools, which read the
 * cache or, when asked, the router in one call.
 */

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true } as const;

export const READ_OPERATIONS = {
  telemetry: {
    access: "read",
    permission: null,
    telegram: { menu: ["status"] },
    rest: {
      method: "GET",
      path: "/api/telemetry",
      group: "read",
      summary: { "zh-CN": "最新的信号、载波、速率、流量和 WAN 状态，以及锁定状态和最近的告警", en: "The latest signal, carriers, rates, traffic and WAN state, with the lock state and recent alerts" },
    },
    mcp: {
      tool: "get_cpe_telemetry",
      title: "Get the Router's Signal, Carriers and Traffic",
      description:
        "Read the router's latest readings: the serving 4G and 5G cells with their signal (RSRP, RSRQ, SINR, RSSI), modulation, MIMO layers and transmit power, each aggregated carrier's band and bandwidth, the WAN addresses and connection state, live upload and download rates, today's and this month's traffic, the router's own status (SIM card, battery, temperatures, where it reports them), and the band and cell locks in force. Use it first to see how the connection is doing. A reading the router does not report is null.",
      annotations: READ_ONLY,
      properties: {
        refresh: {
          type: "boolean",
          description: "true: read the router now, in a short session that steps aside when someone is signed in to its own web page. Omitted or false: the latest 5-second poll (read now when there is none yet).",
        },
      },
      input: flag("refresh"),
    },
  },
  timeseries: {
    access: "read",
    permission: null,
    input: readTimeSeriesQuery,
    rest: {
      method: "GET",
      path: "/api/timeseries",
      group: "read",
      summary: {
        "zh-CN": "历史：速率、RSRP、SINR。`?preset=1h`（或 `6h`、`12h`、`24h`），或 `?preset=custom&fromMs=…&toMs=…`",
        en: "History: rates, RSRP and SINR. `?preset=1h` (or `6h`, `12h`, `24h`), or `?preset=custom&fromMs=…&toMs=…`",
      },
    },
    mcp: {
      tool: "query_telemetry_history",
      title: "Query Signal and Speed History",
      description: "Return the history FengSui keeps of the download and upload rates, the 4G and 5G RSRP and SINR, and the temperature, as time buckets over the last hour, 6, 12 or 24 hours, or a custom window. Use it to see when the signal or speed changed, before and after a band or cell lock for example. Reads FengSui's own records, not the router.",
      annotations: READ_ONLY,
      properties: {
        preset: { type: "string", enum: ["1h", "6h", "12h", "24h", "custom"], description: "The window to return, ending now: '1h' (default), '6h', '12h' or '24h'; 'custom' takes fromMs and toMs." },
        fromMs: { type: "integer", description: "Start of a custom window, as a Unix time in milliseconds (required with preset 'custom')." },
        toMs: { type: "integer", description: "End of a custom window, as a Unix time in milliseconds (required with preset 'custom')." },
        bucketMs: { type: "integer", minimum: 1, description: "Width of each time bucket in milliseconds (optional; chosen from the window when omitted)." },
        maxPoints: { type: "integer", description: "Most buckets to return, 1 to 1440 (default 360)." },
      },
      input: readTimeSeriesArgs,
    },
  },
  neighbors: {
    access: "read",
    section: "neighbors",
    permission: null,
    rest: { method: "GET", path: "/api/neighbors", group: "read", summary: { "zh-CN": "附近的基站（上一次扫描的结果）", en: "Nearby cells, from the last scan" } },
    mcp: {
      tool: "list_neighbor_cells",
      title: "List Nearby 4G and 5G Cells",
      description: "List the 4G (LTE) and 5G (NR) cells the router can hear besides the one it uses: each cell's band, channel number (EARFCN or NR-ARFCN), PCI and signal (RSRP, RSRQ, RSSI, SINR, as far as the router reports them). Use it before locking a cell: only cells listed here or currently in use can be locked, with their values copied from this result.",
      annotations: READ_ONLY,
      properties: { scanNow: { type: "boolean", description: "true: ask the router for a new scan now. false: the last scan only (none yet gives null). Omitted: a new scan only when there is no earlier one." } },
      input: flag("scanNow"),
    },
  },
  topology: {
    access: "read",
    section: "topology",
    permission: null,
    rest: { method: "GET", path: "/api/topology", group: "read", summary: { "zh-CN": "已连接设备", en: "Connected devices" } },
    mcp: {
      tool: "list_terminal_topology",
      title: "List Connected Devices",
      description: "List the devices connected to the router, wired and Wi-Fi: each one's name, MAC and IP addresses, how it is connected (cable, or the Wi-Fi band), its link rate and the DHCP lease time left, as far as the router reports them. Use it to find the device the user means, by its MAC or IP address, before changing its internet access.",
      annotations: READ_ONLY,
      properties: { refresh: { type: "boolean", description: "true: read the list from the router now. Omitted or false: the last list FengSui read." } },
      input: flag("refresh"),
    },
  },
  settings: {
    access: "read",
    section: "settings",
    permission: null,
    rest: { method: "GET", path: "/api/settings", group: "read", summary: { "zh-CN": "路由器设置：UPnP、DMZ、防火墙、Wi-Fi 7、天线、移动数据", en: "Router settings: UPnP, DMZ, firewall, Wi-Fi 7, antenna, mobile data" } },
    mcp: {
      tool: "get_router_settings",
      title: "Get the Router's Switches",
      description: "Read the router's switches and modes: UPnP, the DMZ host, the firewall and its IP, MAC and URL filters and WAN ping, the NAT type, bridge mode, Wi-Fi multi-link operation (MLO) and 5 GHz priority, the antenna mode and whether external antennas are plugged in, and mobile data. Only what this router reports is filled in. Use it to see the current state before changing any of them.",
      annotations: READ_ONLY,
      properties: { refresh: { type: "boolean", description: "true: read the switches from the router now. Omitted or false: the last values FengSui read." } },
      input: flag("refresh"),
    },
  },
  accessControlView: {
    access: "read",
    section: "accessControl",
    permission: null,
    rest: { method: "GET", path: "/api/access-control", group: "read", summary: { "zh-CN": "Wi-Fi 黑白名单和上网时段", en: "The Wi-Fi MAC filter and internet schedules" } },
    mcp: {
      tool: "get_access_control",
      title: "Get Wi-Fi Access Control and Internet Time Rules",
      description:
        "Read the router's Wi-Fi MAC filter (off, blacklist or whitelist, both lists and how many entries each can hold) and its parental-control internet time rules (each device's allowed online windows; outside them the device is cut off). Use it to see who is blocked and which rules exist, with their ids, before changing access; for the devices connected right now use list_terminal_topology.",
      annotations: READ_ONLY,
      properties: { refresh: { type: "boolean", description: "Read the router now instead of the cached snapshot." } },
      input: flag("refresh"),
    },
  },
  cellular: {
    access: "read",
    permission: null,
    rest: {
      method: "GET",
      path: "/api/cellular",
      group: "read",
      summary: {
        "zh-CN": "蜂窝设置（上一次读到的）：网络制式和路由器提供的选项、可切换的 SIM 卡槽、运营商怎么选、接入点（APN）、路由器自己的流量上限",
        en: "The cellular settings as last read: the network mode and the ones the router offers, the SIM slots it can switch between, how the operator is chosen, the access point (APN), the router's own data limit",
      },
    },
    mcp: {
      tool: "get_cellular_settings",
      title: "Get Cellular Settings",
      description:
        "Read the router's cellular settings: the network mode in use and the ones it can be set to, the SIM slots it can switch between and the one in use, the SIM card's state and PIN attempts left, airplane mode, data roaming, how the operator is chosen, the access point (APN, never its password) and the router's own data limit. A part the router does not report is null.",
      annotations: READ_ONLY,
      properties: { refresh: { type: "boolean", description: "Read the router now instead of the last snapshot." } },
      input: flag("refresh"),
    },
  },
  sessionStatus: {
    access: "read",
    permission: null,
    rest: { method: "GET", path: "/api/session/status", group: "read", summary: { "zh-CN": "烽燧和路由器之间的状态：是否在让位、是否熔断、自愈在做什么", en: "How FengSui stands with the router: yielding, breaker, what self-healing is doing" } },
    mcp: {
      tool: "get_cpe_session_status",
      title: "Check FengSui's Session With the Router",
      description:
        "Report how FengSui stands with the router. Use it when a reading comes back empty or a change is refused, to learn why, and before a band or cell lock, to see what FengSui will undo on its own; for the signal use get_cpe_telemetry, for the router's switches get_router_settings. It says whether someone is signed in to the router's own web page (FengSui then steps aside) and how long FengSui's last session held the router's admin seat. It says whether the breaker is open: the router refused the password or locked its login, so FengSui stopped signing in until the owner fixes it. selfHeal says whether a lock is undone when the WAN is still down lockRollback.afterMin minutes later, when an open lock window ends, and how many of the 24-hour WAN redials are spent.",
      annotations: READ_ONLY,
      properties: { probeLive: { type: "boolean", description: "Also ask the router right now, without a login, whether someone is signed in (Huawei routers only; on another brand the tool answers VALIDATION_ERROR)." } },
      input: flag("probeLive"),
    },
  },
  deviceProfile: {
    access: "read",
    permission: null,
    rest: {
      method: "GET",
      path: "/api/device/profile",
      group: "read",
      summary: { "zh-CN": "识别到的型号、固件和能力，以及它在「支持的设备」表里的那一行（不含设备标识）", en: "The identified model, firmware and capabilities, and its row of Supported devices (no identifiers)" },
    },
  },
  alerts: {
    access: "read",
    permission: null,
    telegram: { menu: ["alerts"] },
    rest: { method: "GET", path: "/api/alerts", group: "read", summary: { "zh-CN": "最近 100 条告警，以及每个通知渠道的发送统计", en: "The last 100 alerts, and delivery counts per notification channel" } },
  },
  audit: {
    access: "read",
    permission: null,
    rest: { method: "GET", path: "/api/audit", group: "read", summary: { "zh-CN": "审计日志：谁在什么时候改了什么（`?limit=`，最多 500 条）", en: "The audit log: who changed what, and when (`?limit=`, up to 500)" } },
  },
  telemetryRefresh: {
    access: "read",
    permission: null,
    rest: { method: "POST", path: "/api/telemetry/refresh", group: "refresh", summary: { "zh-CN": "马上读一次信号", en: "Read the signal now" } },
  },
  neighborsScan: {
    access: "read",
    section: "neighbors",
    permission: null,
    rest: { method: "POST", path: "/api/neighbors/scan", group: "refresh", summary: { "zh-CN": "马上扫描附近的基站", en: "Scan for nearby cells now" } },
  },
  topologyRefresh: {
    access: "read",
    section: "topology",
    permission: null,
    rest: { method: "POST", path: "/api/topology/refresh", group: "refresh", summary: { "zh-CN": "马上读一次已连接设备", en: "Read the connected devices now" } },
  },
  settingsRefresh: {
    access: "read",
    section: "settings",
    permission: null,
    rest: { method: "POST", path: "/api/settings/refresh", group: "refresh", summary: { "zh-CN": "马上读一次路由器设置", en: "Read the router settings now" } },
  },
  accessControlRefresh: {
    access: "read",
    section: "accessControl",
    permission: null,
    rest: { method: "POST", path: "/api/access-control/refresh", group: "refresh", summary: { "zh-CN": "马上读一次黑白名单和上网时段", en: "Read the MAC filter and schedules now" } },
  },
  cellularRefresh: {
    access: "read",
    permission: null,
    rest: { method: "POST", path: "/api/cellular/refresh", group: "refresh", summary: { "zh-CN": "马上读一次蜂窝设置", en: "Read the cellular settings now" } },
  },
} satisfies OperationTable;
