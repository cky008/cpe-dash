import { modelLabel } from "./device-access.ts";

/**
 * Where owners of other models report how FengSui works on their router (multi-model phase 2): a
 * new issue on the project with the device-report form. The console opens it in a new tab with a
 * title and the template only; the report itself is never put in the URL (GitHub caps URL length,
 * and nothing leaves the console unless the owner copies or attaches it). Zero dependencies: the
 * console and the static demo share it.
 */

/** The project's "new issue" page. */
export const ISSUE_NEW_URL = "https://github.com/cky008/cpe-dash/issues/new";

/** `.github/ISSUE_TEMPLATE/<this>`: the device compatibility report form. */
export const DEVICE_REPORT_TEMPLATE = "device-report.yml";

const MAX_TITLE = 120;

/** `Device report: B535-232 · 11.0.1.2(H7SP2C00)`; parts that are not plain text read as `?`. */
export function deviceIssueTitle(identity: { model: string | null; softwareVersion: string | null } | null): string {
  const model = identity?.model ? modelLabel(identity.model) : "unknown model";
  const firmware = identity?.softwareVersion ? ` · ${modelLabel(identity.softwareVersion)}` : "";
  return `Device report: ${model}${firmware}`.slice(0, MAX_TITLE);
}

/** The new-issue URL for this router: the device-report template and a title, nothing else. */
export function deviceIssueUrl(identity: { model: string | null; softwareVersion: string | null } | null): string {
  const url = new URL(ISSUE_NEW_URL);
  url.searchParams.set("template", DEVICE_REPORT_TEMPLATE);
  url.searchParams.set("title", deviceIssueTitle(identity));
  return url.toString();
}
