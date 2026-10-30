import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SupportedLocale } from "./types.ts";

export const SUPPORTED_LOCALES = ["zh-CN", "en"] as const satisfies ReadonlyArray<SupportedLocale>;

export type I18nKey =
  | "_meta.name"
  | "_meta.code"
  | "app.title"
  | "app.brand_name"
  | "app.subtitle"
  | "app.device_model"
  | "auth.login_title"
  | "auth.password_placeholder"
  | "auth.submit"
  | "auth.logout"
  | "auth.unauthorized"
  | "auth.csrf_rejected"
  | "auth.rate_limited"
  | "auth.session_note"
  | "session.mode_idle"
  | "session.mode_active"
  | "session.mode_yielding"
  | "session.mode_resumed"
  | "session.mode_circuit_tripped"
  | "session.circuit_reset_ok"
  | "rf.section_title"
  | "rf.ca_active"
  | "rf.ca_single"
  | "rf.pcc_label"
  | "rf.scc_label"
  | "rf.tac_label"
  | "rf.enodeb_label"
  | "rf.cell_id_label"
  | "rf.pci_label"
  | "rf.mcs_label"
  | "rf.mimo_label"
  | "rf.txpower_label"
  | "rf.temp_unavailable"
  | "traffic.section_title"
  | "traffic.download_rate"
  | "traffic.upload_rate"
  | "traffic.today_used"
  | "traffic.month_used"
  | "traffic.billing_day"
  | "traffic.window_1h"
  | "traffic.window_6h"
  | "traffic.window_12h"
  | "traffic.window_24h"
  | "traffic.window_custom"
  | "neighbors.section_title"
  | "neighbors.scan_now"
  | "neighbors.lock_this_cell"
  | "neighbors.empty_hint"
  | "controls.band_lock_applied"
  | "controls.cell_lock_applied"
  | "controls.unlock_all_applied"
  | "controls.reboot_confirm_required"
  | "controls.reboot_triggered"
  | "controls.reconnect_triggered"
  | "controls.security_updated"
  | "controls.wifi7_updated"
  | "controls.antenna_updated"
  | "controls.mobile_data_updated"
  | "controls.yielded_cannot_mutate"
  | "topology.section_title"
  | "topology.lan_1000m"
  | "topology.lan_100m"
  | "topology.wifi_5g"
  | "topology.wifi_2_4g"
  | "topology.lease_remaining"
  | "sms.sent_summary"
  | "sms.send_failed_summary"
  | "sms.marked_read_summary"
  | "sms.deleted_summary"
  | "alerts.cpe_unreachable"
  | "alerts.cpe_recovered"
  | "alerts.wan_down"
  | "alerts.wan_up"
  | "alerts.signal_degraded"
  | "alerts.signal_recovered"
  | "alerts.ca_dropped"
  | "alerts.reboot_detected"
  | "alerts.sms_storage_high"
  | "alerts.sms_storage_full"
  | "alerts.data_threshold";

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function resolveLocalesDir(): string {
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  const candidateFromSrc = path.resolve(thisDir, "..", "locales");
  if (fs.existsSync(candidateFromSrc)) {
    return candidateFromSrc;
  }
  return path.resolve(process.cwd(), "locales");
}

function toNullPrototypeTree(input: unknown): Record<string, unknown> {
  const out = Object.create(null) as Record<string, unknown>;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return out;
  }
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.has(k)) continue;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      out[k] = toNullPrototypeTree(v);
    } else if (typeof v === "string") {
      out[k] = v;
    }
  }
  return Object.freeze(out);
}

function flattenCatalog(
  node: Record<string, unknown>,
  prefix = "",
  acc: Record<string, string> = Object.create(null) as Record<string, string>
): Record<string, string> {
  for (const key of Object.keys(node)) {
    if (FORBIDDEN_KEYS.has(key)) continue;
    const fullKey = prefix ? `${prefix}.${key}` : key;
    const val = node[key];
    if (typeof val === "string") {
      acc[fullKey] = val;
    } else if (val && typeof val === "object" && !Array.isArray(val)) {
      flattenCatalog(val as Record<string, unknown>, fullKey, acc);
    }
  }
  return acc;
}

interface LoadedCatalogBundle {
  nested: Record<SupportedLocale, Record<string, unknown>>;
  flat: Record<SupportedLocale, Record<string, string>>;
}

let cachedBundle: LoadedCatalogBundle | null = null;

function ensureCatalogsLoaded(): LoadedCatalogBundle {
  if (cachedBundle) return cachedBundle;
  const dir = resolveLocalesDir();
  const zhRaw = JSON.parse(fs.readFileSync(path.join(dir, "zh-CN.json"), "utf8")) as unknown;
  const enRaw = JSON.parse(fs.readFileSync(path.join(dir, "en.json"), "utf8")) as unknown;

  const zhNested = toNullPrototypeTree(zhRaw);
  const enNested = toNullPrototypeTree(enRaw);
  const zhFlat = Object.freeze(flattenCatalog(zhNested));
  const enFlat = Object.freeze(flattenCatalog(enNested));

  cachedBundle = {
    nested: { "zh-CN": zhNested, en: enNested },
    flat: { "zh-CN": zhFlat, en: enFlat },
  };
  return cachedBundle;
}

/**
 * Normalize an arbitrary locale tag or `Accept-Language` header into a safe whitelisted `SupportedLocale`.
 */
export function normalizeLocale(
  raw: string | undefined | null,
  fallback: SupportedLocale = "zh-CN"
): SupportedLocale {
  if (!raw) return fallback;
  const primary = raw.slice(0, 64).split(",")[0]?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!primary) return fallback;
  if (primary === "en" || primary.startsWith("en-") || primary.startsWith("en_")) {
    return "en";
  }
  if (primary === "zh" || primary.startsWith("zh-") || primary.startsWith("zh_")) {
    return "zh-CN";
  }
  return fallback;
}

/**
 * Retrieve the nested null-prototype dictionary for a given locale (safe for `/api/i18n/:locale` JSON serialization).
 */
export function getLocaleCatalog(locale: SupportedLocale): Record<string, unknown> {
  return ensureCatalogsLoaded().nested[locale];
}

/**
 * Retrieve the flattened dot-path null-prototype dictionary (`"session.mode_yielding" -> "..."`).
 */
export function getFlatCatalog(locale: SupportedLocale): Record<string, string> {
  return ensureCatalogsLoaded().flat[locale];
}

/**
 * Deterministic `{variable}` linear string interpolation without regex backtracking.
 */
export function interpolateTemplate(
  template: string,
  params?: Readonly<Record<string, string | number>>
): string {
  if (!params) return template;
  let out = "";
  let cursor = 0;
  while (cursor < template.length) {
    const open = template.indexOf("{", cursor);
    if (open < 0) {
      out += template.slice(cursor);
      break;
    }
    const close = template.indexOf("}", open + 1);
    if (close < 0) {
      out += template.slice(cursor);
      break;
    }
    out += template.slice(cursor, open);
    const paramName = template.slice(open + 1, close);
    if (
      paramName &&
      !FORBIDDEN_KEYS.has(paramName) &&
      Object.prototype.hasOwnProperty.call(params, paramName)
    ) {
      out += String(params[paramName]);
    } else {
      out += `{${paramName}}`;
    }
    cursor = close + 1;
  }
  return out;
}

/**
 * Translate a strongly-typed `I18nKey` with safe `{param}` interpolation and automatic fallback.
 */
export function t(
  locale: SupportedLocale,
  key: I18nKey,
  params?: Readonly<Record<string, string | number>>
): string {
  const bundle = ensureCatalogsLoaded();
  const template = bundle.flat[locale][key] ?? bundle.flat["zh-CN"][key] ?? key;
  return interpolateTemplate(template, params);
}

/**
 * Verify 100% key symmetry between `zh-CN.json` and `en.json`.
 */
export function verifyLocaleParity(): {
  totalKeys: number;
  missingInEn: string[];
  missingInZh: string[];
} {
  const bundle = ensureCatalogsLoaded();
  const zhKeys = new Set(Object.keys(bundle.flat["zh-CN"]));
  const enKeys = new Set(Object.keys(bundle.flat.en));

  const missingInEn = [...zhKeys].filter((k) => !enKeys.has(k));
  const missingInZh = [...enKeys].filter((k) => !zhKeys.has(k));
  return {
    totalKeys: zhKeys.size,
    missingInEn,
    missingInZh,
  };
}
