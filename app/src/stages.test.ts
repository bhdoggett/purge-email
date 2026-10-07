import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "@core/decide.ts";
import type { ScanRecord } from "./storage/db.ts";
import { stageAvailability } from "./stages.ts";

const scan = (over: Partial<ScanRecord> = {}): ScanRecord => ({
  years: 10,
  candidateIds: [],
  repliedThreadIds: [],
  finished: false,
  startedAt: 0,
  settingsAtScan: null,
  msPerEmail: null,
  ...over,
});

describe("stageAvailability", () => {
  it("allows only Rules before any scan", () => {
    expect(stageAvailability(null, false)).toEqual({ rules: true, scan: false, review: false });
  });
  it("allows Scan while a scan runs or once one exists", () => {
    expect(stageAvailability(null, true).scan).toBe(true);
    expect(stageAvailability(scan(), false)).toEqual({ rules: true, scan: true, review: false });
  });
  it("allows Results once a scan has finished at least once", () => {
    expect(stageAvailability(scan({ finished: true, settingsAtScan: DEFAULT_SETTINGS }), false).review).toBe(true);
    // A new unfinished scan keeps the earlier labels' settings, so Results stays open.
    expect(stageAvailability(scan({ finished: false, settingsAtScan: DEFAULT_SETTINGS }), true).review).toBe(true);
  });
});
