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
    rest: {
      method: "GET",
      path: "/api/telemetry",
      group: "read",
      summary: { "zh-CN": "最新的信号、载波、速率、流量和 WAN 状态，以及锁定状态和最近的告警", en: "The latest signal, carriers, rates, traffic and WAN state, with the lock state and recent alerts" },
    },
    mcp: {
      tool: "get_cpe_telemetry",
      title: "Get 5G CPE Global Telemetry",
      description:
        "Fetch Huawei H168-383 5G/4G RF metrics, 3CA carrier aggregation, TAC, eNodeB ID, 256QAM MCS, MIMO rank, transmit power, dual-stack WAN IP, live UL/DL bps, Today vs Monthly traffic, thermal status, and active band/cell lock state.",
      annotations: READ_ONLY,
      properties: {
        refresh: {
          type: "boolean",
          description: "When true (or when cache is empty), triggers a polite ~150ms ephemeral CPE poll that automatically yields if a human admin is logged in.",
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
      title: "Query Multi-Scale Speed & RF Time-Series",
      description: "Query historical download/upload bps, 4G/5G RSRP & SINR, and temperature curves over presets ('1h', '6h', '12h', '24h') or a 'custom' [fromMs, toMs] window.",
      annotations: READ_ONLY,
      properties: {
        preset: { type: "string", enum: ["1h", "6h", "12h", "24h", "custom"], description: "Time window preset (defaults to '1h')." },
        fromMs: { type: "integer", description: "Start Unix timestamp in ms (required when preset === 'custom')." },
        toMs: { type: "integer", description: "End Unix timestamp in ms (required when preset === 'custom')." },
        bucketMs: { type: "integer", minimum: 1, description: "Optional aggregation bucket width in ms." },
        maxPoints: { type: "integer", description: "Maximum buckets to return (1..1440, default 360)." },
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
      title: "Scan 4G/5G Neighbor Base Stations",
      description: "Scan and list surrounding 4G LTE and 5G NR candidate neighbor cells (EARFCN, Band, PCI, RSRP, RSRQ, RSSI, SINR) to evaluate optimal tower locking.",
      annotations: READ_ONLY,
      properties: { scanNow: { type: "boolean", description: "Trigger an immediate ephemeral neighbor scan (default true if cache empty)." } },
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
      title: "List Connected LAN & Wi-Fi 7 Terminals",
      description: "Query connected Gigabit Ethernet (LAN_1000M) and 2.4GHz/5GHz Wi-Fi 7 client devices, negotiated PHY rates, dual-stack IPs, and remaining DHCP lease times.",
      annotations: READ_ONLY,
      properties: { refresh: { type: "boolean", description: "Refresh live HostInfo & topology from router." } },
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
      title: "Get Security, Wi-Fi 7 MLO & Antenna Settings",
      description: "Inspect UPnP, DMZ, Firewall switches, NAT type, Bridge mode, Wi-Fi 7 MLO/DBHO status, Antenna mode & insertion status, and Mobile Data switch.",
      annotations: READ_ONLY,
      properties: { refresh: { type: "boolean", description: "Refresh live router settings." } },
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
        "Read the router's Wi-Fi MAC filter (off / blacklist / whitelist, both lists, capacity) and its parental-control internet time rules (allowed online windows per device; outside them the device is cut off).",
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
      title: "Check CPE Single-Admin Session & Browser Avoidance Status",
      description:
        "Check whether a human administrator is currently using the official CPE WebUI (http://192.168.8.1), inspect ephemeral session hold latency, check the 108006/108007 circuit breaker, and see what WAN self-healing does on its own (selfHeal: whether a lock is rolled back when the WAN is still down lockRollback.afterMin minutes later, an open lock window's deadline, and the WAN redials spent of the 24 h cap).",
      annotations: READ_ONLY,
      properties: { probeLive: { type: "boolean", description: "Also perform an unauthenticated GET /api/user/state-login live check." } },
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
