import { readTimeRuleChange, readWifiDeviceAccess, readWifiMacFilterChange } from "../control-input.ts";
import { type OperationTable, ownArguments } from "./record.ts";

/**
 * Who reaches the internet: one Wi-Fi device blocked or let back on, the Wi-Fi MAC filter, the
 * internet time rules. They take the token's `access` permission. An agent names a device by its MAC
 * or by its LAN IPv4 from the connected devices, so its tools read their own arguments.
 */

const DEVICE_PROPS = {
  macAddress: { type: "string", maxLength: 17, description: "Device MAC address (AA:BB:CC:DD:EE:FF)." },
  ipv4Address: { type: "string", maxLength: 15, description: "Alternative to macAddress: the device's LAN IPv4 from list_terminal_topology." },
} as const;

export const ACCESS_OPERATIONS = {
  wifiAccess: {
    access: "write",
    actions: ["set_wifi_access"],
    section: "accessControl",
    permission: "access",
    input: readWifiDeviceAccess,
    rest: {
      method: "POST",
      path: "/api/control/wifi-access",
      group: "access",
      example: '{"action":"unblock","macAddress":"02:00:5E:10:00:01","confirm":true}',
      summary: { "zh-CN": "断开或恢复一台设备的 Wi-Fi（`block`、`unblock`）", en: "Block or unblock one device's Wi-Fi (`block`, `unblock`)" },
    },
    mcp: {
      tool: "set_device_internet_access",
      title: "Block or Restore a Wi-Fi Device",
      description:
        "Cut a Wi-Fi device off (Wi-Fi MAC blacklist, like the router's own Device management page) or restore it. Never applies to the machine running FengSui. Only for a device the user named.",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
      properties: { action: { type: "string", enum: ["block", "unblock"] }, ...DEVICE_PROPS },
      required: ["action"],
      input: ownArguments,
    },
  },
  wifiMacFilter: {
    access: "write",
    actions: ["set_wifi_access"],
    section: "accessControl",
    permission: "access",
    input: readWifiMacFilterChange,
    rest: {
      method: "POST",
      path: "/api/control/wifi-mac-filter",
      group: "access",
      example: '{"mode":"off","confirm":true}',
      summary: { "zh-CN": "Wi-Fi 黑白名单：`off`、`deny`、`allow`，或增删名单里的设备", en: "The Wi-Fi MAC filter: `off`, `deny`, `allow`, or add and remove entries" },
    },
    mcp: {
      tool: "set_wifi_mac_filter",
      title: "Change the Wi-Fi MAC Filter",
      description:
        "Switch the Wi-Fi MAC filter off / to blacklist (deny) / to whitelist (allow), optionally with the complete list for that mode, or add / remove MACs on the active list. A whitelist cuts off every Wi-Fi device not on it.",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
      properties: {
        mode: { type: "string", enum: ["off", "allow", "deny"] },
        macAddresses: { type: "array", items: { type: "string", maxLength: 17 }, maxItems: 64, description: "Complete list for `mode`." },
        add: { type: "array", items: { type: "string", maxLength: 17 }, maxItems: 64 },
        remove: { type: "array", items: { type: "string", maxLength: 17 }, maxItems: 64 },
      },
      input: ownArguments,
    },
  },
  timeRule: {
    access: "write",
    actions: ["manage_time_rule"],
    section: "accessControl",
    permission: "access",
    input: readTimeRuleChange,
    rest: {
      method: "POST",
      path: "/api/control/time-rule",
      group: "access",
      example: '{"action":"delete","id":"1","confirm":true}',
      needsState: true,
      summary: { "zh-CN": "上网时段：新建、修改、删除（`create`、`update`、`delete`）", en: "Internet schedules: create, update, delete" },
    },
    mcp: {
      tool: "manage_internet_time_rule",
      title: "Create, Update or Delete an Internet Time Rule",
      description:
        "Parental control: a rule is an ALLOWED online window (weekMask Monday-first like 1111100, HH:mm in 15-minute steps; an end before the start runs past midnight). A device with rules is cut off outside all of its windows.",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
      properties: {
        action: { type: "string", enum: ["create", "update", "delete"] },
        id: { type: "string", maxLength: 128, description: "Rule ID from get_access_control (update / delete), e.g. InternetGatewayDevice.X_FireWall.TimeRule.1." },
        ...DEVICE_PROPS,
        weekMask: { type: "string", maxLength: 7 },
        startTime: { type: "string", maxLength: 5 },
        endTime: { type: "string", maxLength: 5 },
        enabled: { type: "boolean" },
      },
      required: ["action"],
      input: ownArguments,
    },
  },
} satisfies OperationTable;
