import type { NavTarget } from "./components/Header.tsx";
import type { ScanRecord } from "./storage/db.ts";

export type StageAvailability = Record<NavTarget, boolean>;

export const UNAVAILABLE_HINT: Record<NavTarget, string> = {
  rules: "",
  scan: "Start a scan from Rules first.",
  review: "Results appear when the scan finishes.",
};

/**
 * Which stages can be opened. Scan: once any scan exists or runs. Results: only when the latest
 * scan has finished and nothing is running, so a new scan always greys Results out until it's done.
 */
export function stageAvailability(scan: ScanRecord | null, scanning: boolean): StageAvailability {
  return {
    rules: true,
    scan: scanning || scan !== null,
    review: !scanning && scan !== null && scan.finished && scan.settingsAtScan != null,
  };
}
