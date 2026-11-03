import type { ReadSection, SchedulerStatusSnapshot } from "../../../src/api-contract.ts";

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
