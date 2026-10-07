import type { NavTarget } from "./components/Header.tsx";
import type { ScanRecord } from "./storage/db.ts";

export type StageAvailability = Record<NavTarget, boolean>;

export const UNAVAILABLE_HINT: Record<NavTarget, string> = {
  rules: "",
  scan: "Start a scan from Rules first.",
  review: "Results appear after a scan finishes.",
};

/** Which stages can be opened: Scan once any scan exists or runs, Results once a scan has finished. */
export function stageAvailability(scan: ScanRecord | null, scanning: boolean): StageAvailability {
  return {
    rules: true,
    scan: scanning || scan !== null,
    review: scan?.settingsAtScan != null,
  };
}
