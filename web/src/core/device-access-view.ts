import type { ReadSection, SchedulerStatusSnapshot, WriteFeature, WriteFeatureState, WriteResultRecord } from "../../../src/api-contract.ts";

/**
 * What the console offers for the router it watches (multi-model phase 2), decided without the DOM
 * from `schedulerStatus.device`: a model FengSui was not verified on is read-only, and a section it
 * turned out not to provide shows as such instead of waiting for data. The daemon enforces both on
 * its side; this only keeps the console from offering what it would refuse.
 */

/** The router is a model nobody verified: no write control is offered. */
export function writesLocked(scheduler: SchedulerStatusSnapshot | null): boolean {
  return scheduler?.device.writes === "read_only";
}

/** The model of a read-only router, as the daemon shows it (`?` when it is not plain text). */
export function readOnlyModel(scheduler: SchedulerStatusSnapshot | null): string | null {
  return writesLocked(scheduler) ? (scheduler?.device.model ?? "?") : null;
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

/** What a write is on the router (multi-model phase 3); `unknown` before the daemon names a model. */
export function writeState(scheduler: SchedulerStatusSnapshot | null, feature: WriteFeature): WriteFeatureState {
  return scheduler?.device.features?.[feature] ?? "unknown";
}

/** The console may offer this write: verified, turned on as experimental, or no model yet (the daemon checks it then). */
export function canWrite(scheduler: SchedulerStatusSnapshot | null, feature: WriteFeature): boolean {
  const state = writeState(scheduler, feature);
  return state === "verified" || state === "consented" || state === "unknown";
}

/** The experimental writes its owner turned on for this router (a model nobody verified), in the daemon's order. */
export function experimentalWrites(scheduler: SchedulerStatusSnapshot | null): WriteFeature[] {
  const features = scheduler?.device.writes === "read_only" ? scheduler.device.features : undefined;
  return features ? (Object.keys(features) as WriteFeature[]).filter((feature) => features[feature] === "consented") : [];
}

/** Every write feature with its state, for the Device tab of a model nobody verified (empty otherwise). */
export function experimentalOffer(scheduler: SchedulerStatusSnapshot | null): Array<{ feature: WriteFeature; state: WriteFeatureState }> {
  const features = scheduler?.device.writes === "read_only" ? scheduler.device.features : undefined;
  return features ? (Object.keys(features) as WriteFeature[]).map((feature) => ({ feature, state: features[feature] })) : [];
}

/** How a write result's read-back reads in the console: its tone and the outcome to name. */
export function readbackTone(result: Pick<WriteResultRecord, "outcome" | "readback">): "success" | "warning" | "error" | "info" {
  if (result.outcome === "failed") return "error";
  if (result.readback === "match") return "success";
  if (result.readback === "mismatch") return "warning";
  return "info";
}
