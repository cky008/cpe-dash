import { readTimeRuleChange, readWifiDeviceAccess, readWifiMacFilterChange } from "../control-input.ts";
import { type OperationTable, ownArguments } from "./record.ts";

/**
 * Who reaches the internet: one Wi-Fi device blocked or let back on, the Wi-Fi MAC filter, the
 * internet time rules. They take the token's `access` permission. An agent names a device by its MAC
 * or by its LAN IPv4 from the connected devices, so its tools read their own arguments.
 */

const DEVICE_PROPS = {
  macAddress: { type: "string", maxLength: 17, description: "The device's MAC address (AA:BB:CC:DD:EE:FF), as list_terminal_topology gives it." },
  ipv4Address: { type: "string", maxLength: 15, description: "Instead of macAddress: the device's LAN IPv4 address, as list_terminal_topology gives it." },
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
        "Cut one Wi-Fi device off the network (action 'block', through the router's Wi-Fi MAC blacklist, as the router's own device page does) or let it back on ('unblock'). FengSui refuses to block the machine it runs on. Use it only for a device the user named; get_access_control shows who is blocked.",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
      properties: { action: { type: "string", enum: ["block", "unblock"], description: "'block' cuts the device off, 'unblock' lets it back on." }, ...DEVICE_PROPS },
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
        "Turn the router's Wi-Fi MAC filter off, to a blacklist ('deny': listed devices cannot join) or to a whitelist ('allow': only listed devices can), optionally with the complete list for that mode; or add and remove addresses on the list in use. A whitelist cuts off every Wi-Fi device not on it, so make sure the user's own devices are listed. get_access_control shows the current filter.",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
      properties: {
        mode: { type: "string", enum: ["off", "allow", "deny"], description: "'off', 'deny' (blacklist) or 'allow' (whitelist)." },
        macAddresses: { type: "array", items: { type: "string", maxLength: 17 }, maxItems: 64, description: "The complete list of MAC addresses for mode, replacing the one there." },
        add: { type: "array", items: { type: "string", maxLength: 17 }, maxItems: 64, description: "MAC addresses to add to the list in use." },
        remove: { type: "array", items: { type: "string", maxLength: 17 }, maxItems: 64, description: "MAC addresses to take off the list in use." },
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
        "Create, change or delete an internet time rule (parental control). A rule is an ALLOWED online window for one device on chosen weekdays: once a device has rules, it is cut off outside all of its windows. Times are HH:mm in 15-minute steps; an end before the start runs past midnight. get_access_control lists the rules and their ids.",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
      properties: {
        action: { type: "string", enum: ["create", "update", "delete"], description: "'create' a rule, 'update' or 'delete' the one with id." },
        id: { type: "string", maxLength: 128, description: "The rule's id, as get_access_control lists it (update and delete only)." },
        ...DEVICE_PROPS,
        weekMask: { type: "string", maxLength: 7, description: "Seven 0s and 1s for the days the window applies, Monday first: 1111100 is Monday to Friday." },
        startTime: { type: "string", maxLength: 5, description: "When the allowed window opens, HH:mm in 15-minute steps." },
        endTime: { type: "string", maxLength: 5, description: "When it closes, HH:mm in 15-minute steps; earlier than startTime runs past midnight." },
        enabled: { type: "boolean", description: "false keeps the rule but stops applying it." },
      },
      required: ["action"],
      input: ownArguments,
    },
  },
} satisfies OperationTable;
