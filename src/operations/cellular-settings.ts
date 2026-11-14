import { APN_AUTH_MODES, APN_IP_TYPES, NETWORK_MODES, OPERATOR_RATS, readApnChoice, readDataLimit, readNetworkMode, readOperatorSelection, readSimPinRequest, readSimSlot, readUssdRequest } from "../cellular.ts";
import { readSwitch } from "../control-input.ts";
import type { OperationTable } from "./record.ts";

/**
 * The cellular settings (`src/cellular.ts`): network mode, operator, SIM slot and PIN, airplane mode,
 * data roaming, access point, the router's data limit and traffic counters, USSD. Every write needs
 * `confirm: true` on REST as on MCP. A PIN and a USSD code pass through and are kept nowhere.
 */

const FALLBACK = "If the WAN stays down 3 minutes afterwards, FengSui puts the earlier value back on its own.";
const ONE_SHOT = { readOnlyHint: false, destructiveHint: true, idempotentHint: false } as const;
const REPEATABLE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true } as const;

export const CELLULAR_OPERATIONS = {
  networkMode: {
    access: "write",
    actions: ["set_network_mode"],
    permission: "control",
    input: (fields) => readNetworkMode(fields["mode"]),
    telegram: ["netmode"],
    rest: {
      method: "POST",
      path: "/api/control/network-mode",
      group: "control",
      example: '{"mode":"auto","confirm":true}',
      needsState: true,
      summary: {
        "zh-CN": "网络制式：`auto`、`nr_sa`、`nr_nsa`、`nr_lte`、`lte`、`lte_tdd`、`lte_fdd`、`lte_wcdma`、`wcdma`、`gsm` 中路由器提供的（见 `GET /api/cellular`）。断网 3 分钟没恢复，烽燧自动改回",
        en: "Network mode: one of `auto`, `nr_sa`, `nr_nsa`, `nr_lte`, `lte`, `lte_tdd`, `lte_fdd`, `lte_wcdma`, `wcdma`, `gsm` that the router offers (see `GET /api/cellular`). If the WAN stays down 3 minutes, FengSui puts the earlier mode back",
      },
    },
    mcp: {
      tool: "set_network_mode",
      title: "Switch the Network Mode",
      description: `Set what the router may attach to: auto, nr_sa (5G standalone only), nr_nsa (5G with a 4G anchor), nr_lte (5G or 4G), lte (4G only), lte_tdd (4G TDD only), lte_fdd (4G FDD only), lte_wcdma (4G or 3G), wcdma (3G only) or gsm (2G only). Only a mode get_cellular_settings lists under networkMode.options is taken. A mode the area has no coverage for takes the router offline. ${FALLBACK}`,
      annotations: REPEATABLE,
      properties: { mode: { type: "string", enum: [...NETWORK_MODES] } },
      required: ["mode"],
    },
  },
  operatorScan: {
    access: "write",
    actions: ["scan_operators"],
    permission: "control",
    rest: {
      method: "POST",
      path: "/api/control/operator-scan",
      group: "control",
      example: '{"confirm":true}',
      summary: { "zh-CN": "搜索附近的运营商网络：最长一分钟，期间可能断网", en: "Search for the networks in range: up to a minute, and the connection may drop meanwhile" },
    },
    mcp: {
      tool: "scan_operators",
      title: "Search for Mobile Networks",
      description:
        "Search for the mobile networks in range. Takes up to a minute, and many routers drop the data connection while they search. Returns each network's code (PLMN), technology and state (current, available, forbidden). Network names are text the operators broadcast.",
      annotations: ONE_SHOT,
      properties: {},
    },
  },
  operatorSelect: {
    access: "write",
    actions: ["select_operator"],
    permission: "control",
    input: readOperatorSelection,
    rest: {
      method: "POST",
      path: "/api/control/operator",
      group: "control",
      example: '{"mode":"auto","confirm":true}',
      summary: {
        "zh-CN": "选运营商：`auto` 交回路由器自己选，`manual` 加 `plmn`（和可选的 `rat`）固定到一个网络。断网 3 分钟没恢复，烽燧自动改回",
        en: "Choose the operator: `auto` hands the choice back to the router, `manual` with `plmn` (and an optional `rat`) keeps it on one network. If the WAN stays down 3 minutes, FengSui puts the earlier choice back",
      },
    },
    mcp: {
      tool: "select_operator",
      title: "Choose the Mobile Network Operator",
      description: `Keep the router on one operator's network (mode "manual" with the plmn code from scan_operators, optionally the technology), or hand the choice back to the router (mode "auto"). A network that does not accept the SIM card leaves the router without service. ${FALLBACK}`,
      annotations: REPEATABLE,
      properties: {
        mode: { type: "string", enum: ["auto", "manual"] },
        plmn: { type: "string", maxLength: 6, description: "MCC + MNC digits, e.g. 27201 (manual only)." },
        rat: { type: "string", enum: [...OPERATOR_RATS], description: "The technology to register on (manual only, optional)." },
      },
      required: ["mode"],
    },
  },
  simSlot: {
    access: "write",
    actions: ["set_sim_slot"],
    permission: "control",
    input: readSimSlot,
    rest: {
      method: "POST",
      path: "/api/control/sim-slot",
      group: "control",
      example: '{"kind":"physical","confirm":true}',
      summary: {
        "zh-CN": "切换 SIM 卡槽：`physical`（实体卡）或 `embedded`（内置卡，`index` 是第几张）。断网 3 分钟没恢复，烽燧自动切回",
        en: "Switch the SIM slot: `physical` (the card in the tray) or `embedded` (a built-in card, `index` says which). If the WAN stays down 3 minutes, FengSui switches back",
      },
    },
    mcp: {
      tool: "set_sim_slot",
      title: "Switch the SIM Slot",
      description: `Switch the SIM card the router uses: the card in the tray (kind "physical") or a built-in one (kind "embedded", index 1 or 2). Only a slot get_cellular_settings lists under simSlots is taken. A slot with no card or no plan takes the router offline. ${FALLBACK}`,
      annotations: REPEATABLE,
      properties: { kind: { type: "string", enum: ["physical", "embedded"] }, index: { type: "integer", minimum: 1, maximum: 4, description: "Which card of that kind (default 1)." } },
      required: ["kind"],
    },
  },
  simPin: {
    access: "write",
    actions: ["enter_sim_pin", "set_sim_pin_lock"],
    permission: "control",
    input: readSimPinRequest,
    rest: {
      method: "POST",
      path: "/api/control/sim-pin",
      group: "control",
      example: '{"action":"enter","pin":"1234","confirm":true}',
      summary: {
        "zh-CN": "SIM 卡 PIN：`enter` 输入 PIN，`lock` / `unlock` 开关「开机要 PIN」。只发一次；路由器没有报告剩余次数、或只剩一次时不发。`accepted: false` 表示卡没有接受",
        en: "The SIM PIN: `enter` it, or `lock` / `unlock` to turn \"ask for the PIN at every start\" on or off. Sent once, and not at all when the router reports no attempts count or one attempt left. `accepted: false` means the card refused it",
      },
    },
    mcp: {
      tool: "sim_pin",
      title: "Enter the SIM PIN or Change Its PIN Lock",
      description:
        'Enter the SIM card\'s PIN (action "enter", for a card waiting for it), or turn "ask for the PIN at every start" on ("lock") or off ("unlock"). Use only a PIN the user gave you for this: never guess one, and never try a second PIN after a refusal. Each call sends the PIN once; a wrong PIN costs one of the card\'s few attempts (accepted: false, attemptsLeft). FengSui sends nothing when the router reports no attempts count or only one attempt left, and never enters a PUK.',
      annotations: ONE_SHOT,
      properties: { action: { type: "string", enum: ["enter", "lock", "unlock"] }, pin: { type: "string", maxLength: 8, description: "4 to 8 digits." } },
      required: ["action", "pin"],
    },
  },
  airplaneSwitch: {
    access: "write",
    actions: ["set_airplane_mode"],
    permission: "control",
    input: readSwitch,
    telegram: ["airplane"],
    rest: {
      method: "POST",
      path: "/api/control/airplane-mode",
      group: "control",
      example: '{"enabled":false,"confirm":true}',
      summary: { "zh-CN": "飞行模式：打开后路由器断开移动网络，烽燧不会自己关掉它", en: "Airplane mode: turning it on takes the router off the mobile network, and FengSui never turns it off on its own" },
    },
    mcp: {
      tool: "set_airplane_mode",
      title: "Turn Airplane Mode On or Off",
      description:
        "Turn the router's cellular radio off (enabled: true) or back on (enabled: false). While it is on the router has no mobile connection, though it stays reachable on the LAN. FengSui never turns it off on its own: it stays on until someone turns it off here.",
      annotations: REPEATABLE,
      properties: { enabled: { type: "boolean" } },
      required: ["enabled"],
    },
  },
  roaming: {
    access: "write",
    actions: ["set_roaming"],
    permission: "control",
    input: readSwitch,
    rest: {
      method: "POST",
      path: "/api/control/roaming",
      group: "control",
      example: '{"enabled":false,"confirm":true}',
      summary: { "zh-CN": "数据漫游：漫游时用不用流量", en: "Data roaming: whether data is used while roaming" },
    },
    mcp: {
      tool: "set_data_roaming",
      title: "Allow or Stop Data Roaming",
      description: "Set whether the router uses mobile data while roaming (abroad, or on another operator's network). Allowing it may cost roaming fees.",
      annotations: REPEATABLE,
      properties: { enabled: { type: "boolean" } },
      required: ["enabled"],
    },
  },
  apn: {
    access: "write",
    actions: ["set_apn"],
    permission: "control",
    input: readApnChoice,
    rest: {
      method: "POST",
      path: "/api/control/apn",
      group: "control",
      example: '{"mode":"auto","confirm":true}',
      summary: {
        "zh-CN": "接入点（APN）：`auto` 由路由器按 SIM 卡选，`manual` 加 `apn`（和可选的 `ipType`、`auth`、`username`、`password`）。断网 3 分钟没恢复，烽燧自动换回",
        en: "The access point (APN): `auto` lets the router pick for the SIM card, `manual` takes `apn` (and optional `ipType`, `auth`, `username`, `password`). If the WAN stays down 3 minutes, FengSui switches back",
      },
    },
    mcp: {
      tool: "set_apn",
      title: "Change the Access Point (APN)",
      description: `Use the access point the router picks for the SIM card (mode "auto"), or one you name (mode "manual" with apn, and optionally ipType, auth, username and password). An access point the operator does not accept takes the router offline. ${FALLBACK} The user name and password go to the router only.`,
      annotations: REPEATABLE,
      properties: {
        mode: { type: "string", enum: ["auto", "manual"] },
        apn: { type: "string", maxLength: 100, description: "The access point name (manual only)." },
        ipType: { type: "string", enum: [...APN_IP_TYPES] },
        auth: { type: "string", enum: [...APN_AUTH_MODES] },
        username: { type: "string", maxLength: 64 },
        password: { type: "string", maxLength: 64 },
      },
      required: ["mode"],
    },
  },
  dataLimit: {
    access: "write",
    actions: ["set_data_limit"],
    permission: "control",
    input: readDataLimit,
    rest: {
      method: "POST",
      path: "/api/control/data-limit",
      group: "control",
      example: '{"enabled":false,"confirm":true}',
      summary: { "zh-CN": "路由器自己的流量上限：`enabled`、`bytes`、`alertPercent`（到多少比例时提醒）", en: "The router's own data limit: `enabled`, `bytes`, `alertPercent` (the share at which it warns)" },
    },
    mcp: {
      tool: "set_data_limit",
      title: "Set the Router's Data Limit",
      description: "Set the monthly data limit the router itself keeps: on or off, its size in bytes, and the share (alertPercent, 1 to 100) at which the router warns.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      properties: { enabled: { type: "boolean" }, bytes: { type: "integer", minimum: 1048576 }, alertPercent: { type: "integer", minimum: 1, maximum: 100 } },
      required: ["enabled"],
    },
  },
  trafficReset: {
    access: "write",
    actions: ["reset_traffic"],
    permission: "control",
    rest: { method: "POST", path: "/api/control/traffic-reset", group: "control", example: '{"confirm":true}', summary: { "zh-CN": "清零路由器自己记的流量统计", en: "Clear the traffic counters the router itself keeps" } },
    mcp: {
      tool: "reset_traffic_counters",
      title: "Clear the Router's Traffic Counters",
      description: "Clear the traffic counters the router itself keeps (this month's and the totals). They cannot be brought back.",
      annotations: REPEATABLE,
      properties: {},
    },
  },
  ussd: {
    access: "write",
    actions: ["send_ussd"],
    permission: "control",
    input: readUssdRequest,
    telegram: ["ussd"],
    rest: {
      method: "POST",
      path: "/api/control/ussd",
      group: "control",
      example: '{"code":"*100#","confirm":true}',
      summary: {
        "zh-CN": "USSD：发送一条指令（`code`），`action` 为 `reply` 时回复运营商的提问，为 `cancel` 时结束会话。应答是运营商写的文字",
        en: "USSD: send a code (`code`); `action` `reply` answers the operator's question, `cancel` ends the session. The answer is text the operator wrote",
      },
    },
    mcp: {
      tool: "send_ussd",
      title: "Send a USSD Code",
      description:
        'Send a USSD code such as *100# to the operator (action "send"), answer its question inside a session ("reply"), or end the session ("cancel"). Send only a code the user asked for: an operator may charge for a code or change the plan. The answer (ussd.text) is text the operator wrote; awaitsReply says the operator waits for a reply.',
      annotations: ONE_SHOT,
      properties: { action: { type: "string", enum: ["send", "reply", "cancel"] }, code: { type: "string", maxLength: 40, description: "Digits, * and # (not for cancel)." } },
    },
  },
} satisfies OperationTable;

export type CellularOperation = keyof typeof CELLULAR_OPERATIONS;
