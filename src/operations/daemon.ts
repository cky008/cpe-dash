import { DISCOVERY_MAX_PATHS, DISCOVERY_PAUSE_MS } from "../endpoint-discovery.ts";
import { FAMILY_WRITE_FEATURES } from "../router-family.ts";
import type { OperationTable } from "./record.ts";

/**
 * FengSui itself: its session with the router (the breaker), its liveness check, its event stream and
 * its metrics, and the tools an agent testing a router uses (the device report, the experimental
 * writes' switches, a read-only probe of endpoints FengSui does not use yet).
 */

export const DAEMON_OPERATIONS = {
  resetBreaker: {
    access: "write",
    permission: "control",
    rest: {
      method: "POST",
      path: "/api/session/reset-breaker",
      group: "control",
      summary: {
        "zh-CN": "解除路由器账户被锁（错误码 108007）引起的熔断，并重新读取 `.env`；密码错误引起的熔断请在「设置 → 路由器」改正密码",
        en: "Reset a breaker the router's account lock (108007) tripped, and reload `.env`; for a wrong password, correct it under Settings → Router",
      },
    },
  },
  deviceReport: {
    access: "read",
    permission: null,
    mcp: {
      tool: "get_device_report",
      title: "Desensitized Device Report",
      description:
        "The router's compatibility report as FengSui shares it in a compatibility issue: model and firmware, which read endpoints answered (and the router's error codes), each write feature's state on this router (verified, experimental and turned on, offered, unsupported) and the recent experimental write results with their read-back (match = the router took it). Structure only: no identifier, address or value from the router. Also says whether the owner lets AI agents turn experimental writes on (set_experimental_write) and read endpoints FengSui does not use (probe_router_endpoints).",
      annotations: { readOnlyHint: true },
      properties: {},
    },
  },
  experimentalWrite: {
    access: "write",
    permission: "control",
    mcp: {
      tool: "set_experimental_write",
      title: "Turn an Experimental Write Off or Back On (Unverified Model)",
      description:
        "On a router of a model FengSui was not verified on, the writes FengSui implements for it are on by default (get_device_report lists each under access.features: enabled, disabled, unsupported or not_implemented). This turns one off (enabled: false), after which every caller is refused it with DEVICE_WRITE_DISABLED, or back on (enabled: true). A write FengSui does not implement for this router, or one the router lacks what it needs for, has no switch. Offered only while the owner lets AI agents test this router (Settings → Device). After a band or cell lock on such a router, FengSui undoes the lock if the WAN stays down 3 minutes. Ask the user before changing a switch. Requires confirm: true.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      properties: {
        feature: { type: "string", enum: [...FAMILY_WRITE_FEATURES], description: "The experimental write to turn off or back on." },
        enabled: { type: "boolean", description: "false turns it off, true back on." },
      },
      required: ["feature", "enabled"],
    },
  },
  probeEndpoints: {
    access: "read",
    permission: null,
    mcp: {
      tool: "probe_router_endpoints",
      title: "Probe Router API Endpoints (Read-Only)",
      description: `Find what FengSui does not use yet on this router: read up to ${DISCOVERY_MAX_PATHS} HiLink API endpoints (GET only, e.g. /api/device/autorun-version) inside FengSui's own session; never log in to the router yourself (it allows one admin session, and wrong passwords lock it). Each result says whether FengSui already uses the endpoint (known), its state (supported; unsupported = router error 100002; restricted = 100003; unknown) and the structure of its answer: tag paths and value shapes, never a value. Paths that act on some firmware (an operator scan, reboot, reset, send, delete…) and the login, token and session endpoints are refused without being sent. Calls at least ${DISCOVERY_PAUSE_MS / 1000} s apart. Offered only while the owner lets AI agents test this router (Settings → Device).`,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      properties: {
        paths: {
          type: "array",
          items: { type: "string", maxLength: 96 },
          maxItems: DISCOVERY_MAX_PATHS,
          description: `1–${DISCOVERY_MAX_PATHS} API paths: /api/ and two to four segments of letters, digits, - and _.`,
        },
      },
      required: ["paths"],
    },
  },
  health: {
    access: "read",
    permission: null,
    rest: { method: "GET", path: "/api/health", group: "other", served: "open", summary: { "zh-CN": "存活检查：版本和运行时长", en: "Liveness check: version and uptime" } },
  },
  events: {
    access: "read",
    permission: null,
    rest: { method: "GET", path: "/api/events", group: "other", served: "events", summary: { "zh-CN": "实时事件流（见[实时事件](#events)）", en: "The live event stream (see [Live events](#events))" } },
  },
  metrics: {
    access: "read",
    permission: null,
    rest: {
      method: "GET",
      path: "/metrics",
      group: "other",
      served: "metrics",
      summary: { "zh-CN": "Prometheus 指标（打开后才有，见 [Prometheus 指标](#metrics)）", en: "Prometheus metrics (when turned on, see [Prometheus metrics](#metrics))" },
    },
  },
} satisfies OperationTable;
