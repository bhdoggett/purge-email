import type { NavTarget } from "./components/Header.tsx";
import type { Stage } from "./scan/progress.ts";
import type { ScanRecord } from "./storage/db.ts";

export type StageAvailability = Record<NavTarget, boolean>;

export const UNAVAILABLE_HINT: Record<NavTarget, string> = {
  rules: "",
  scan: "Start or resume a scan from Rules first.",
  review: "Results appear when the scan finishes.",
};

/**
 * Which stages can be opened. Scan: only when this session has scan progress to show. Results: only when the latest
 * scan has finished and nothing is running, so a new scan always greys Results out until it's done.
 */
export function stageAvailability(scan: ScanRecord | null, scanning: boolean, stage: Stage): StageAvailability {
  return {
    rules: true,
    // Only when this session has scan progress to show (running, paused, finished, or stopped).
    // A scan saved from an earlier session is resumed from Rules, not opened here.
    scan: scanning || stage !== "idle",
    review: !scanning && scan !== null && scan.finished && scan.settingsAtScan != null,
  };
}
