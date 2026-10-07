import type { NavTarget } from "./components/Header.tsx";
import type { Stage } from "./scan/progress.ts";
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
export function stageAvailability(scan: ScanRecord | null, scanning: boolean, stage: Stage): StageAvailability {
  return {
    rules: true,
    // Running or run this session, or a scan saved earlier (the screen then shows its summary).
    scan: scanning || stage !== "idle" || scan !== null,
    review: !scanning && scan !== null && scan.finished && scan.settingsAtScan != null,
  };
}
