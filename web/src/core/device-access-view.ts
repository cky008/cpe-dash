import type { ReadSection, SchedulerStatusSnapshot, WriteFeature, WriteFeatureState, WriteResultRecord } from "../../../src/api-contract.ts";

/**
 * What the console offers for the router it watches, decided without the DOM from
 * `schedulerStatus.device`: on a model FengSui was not verified on, the writes FengSui implements
 * for it are open (as experimental writes) unless their owner turned them off, and a section the
 * model turned out not to provide shows as such instead of waiting for data. The daemon enforces
 * both on its side; this only keeps the console from offering what it would refuse.
 */

/** The model of a router nobody verified, as the daemon shows it (`?` when it is not plain text); `null` on a verified or unknown one. */
export function unverifiedModel(scheduler: SchedulerStatusSnapshot | null): string | null {
  return scheduler?.device.writes === "experimental" ? (scheduler.device.model ?? "?") : null;
}

/** Reports settled every feature FengSui does on this model: the console calls it verified, and it is still written as its brand is. */
export function reportVerified(scheduler: SchedulerStatusSnapshot | null): boolean {
  return scheduler?.device.verification === "report-verified";
}

/** A read section this model turned out not to provide, with the router's code when it gave one. */
export function unavailableSection(scheduler: SchedulerStatusSnapshot | null, section: ReadSection): { code: string | null } | null {
  const read = scheduler?.device.reads[section];
  return read?.state === "unavailable" ? { code: read.code } : null;
}

/** `v1.6.0 · H168-383`: the version with the model the daemon goes by, when it knows one. */
export function versionLabel(version: string, scheduler: SchedulerStatusSnapshot | null): string {
  const model = scheduler?.device.model;
  return model ? `v${version} · ${model}` : `v${version}`;
}

/** What a write is on the router; `unknown` before the daemon names a model. */
export function writeState(scheduler: SchedulerStatusSnapshot | null, feature: WriteFeature): WriteFeatureState {
  return scheduler?.device.features?.[feature] ?? "unknown";
}

/** The console may offer this write: verified, open as an experimental write, or no model yet (the daemon checks it then). */
export function canWrite(scheduler: SchedulerStatusSnapshot | null, feature: WriteFeature): boolean {
  const state = writeState(scheduler, feature);
  return state === "verified" || state === "enabled" || state === "unknown";
}

/**
 * The writes open on a router of a model nobody verified, in the daemon's order: the experimental ones,
 * and those someone verified on this model (`VERIFIED_FEATURES`), which stay open the same way.
 */
export function experimentalWrites(scheduler: SchedulerStatusSnapshot | null): WriteFeature[] {
  const features = scheduler?.device.writes === "experimental" ? scheduler.device.features : undefined;
  return features ? (Object.keys(features) as WriteFeature[]).filter((feature) => features[feature] === "enabled" || features[feature] === "verified") : [];
}

/** A write's confirmation says it was never checked on a real router: an open write nobody verified on this model. */
export function unconfirmedWrite(scheduler: SchedulerStatusSnapshot | null, features: ReadonlyArray<WriteFeature>): boolean {
  return features.some((feature) => writeState(scheduler, feature) === "enabled");
}

/** Every write feature with its state, for the Device tab of a model nobody verified (empty otherwise). */
export function experimentalOffer(scheduler: SchedulerStatusSnapshot | null): Array<{ feature: WriteFeature; state: WriteFeatureState }> {
  const features = scheduler?.device.writes === "experimental" ? scheduler.device.features : undefined;
  return features ? (Object.keys(features) as WriteFeature[]).map((feature) => ({ feature, state: features[feature] })) : [];
}

/** A write its owner can turn off or back on: one FengSui implements for this router, on a model nobody verified. */
export function hasSwitch(scheduler: SchedulerStatusSnapshot | null, feature: WriteFeature): boolean {
  if (scheduler?.device.writes !== "experimental") return false;
  const state = writeState(scheduler, feature);
  return state === "enabled" || state === "disabled" || state === "verified";
}

/** How a write result's read-back reads in the console: its tone and the outcome to name. */
export function readbackTone(result: Pick<WriteResultRecord, "outcome" | "readback">): "success" | "warning" | "error" | "info" {
  if (result.outcome === "failed") return "error";
  if (result.readback === "match") return "success";
  if (result.readback === "mismatch") return "warning";
  return "info";
}
