import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "@core/decide.ts";
import type { ScanRecord } from "./storage/db.ts";
import { stageAvailability } from "./stages.ts";

const scan = (over: Partial<ScanRecord> = {}): ScanRecord => ({
  ageMonths: 120,
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
    expect(stageAvailability(null, false, "idle")).toEqual({ rules: true, scan: false, review: false, apply: false });
  });
  it("allows Scan only when this session has scan progress", () => {
    expect(stageAvailability(null, true, "judging").scan).toBe(true);
    expect(stageAvailability(scan(), false, "paused").scan).toBe(true);
    expect(stageAvailability(scan({ finished: true, settingsAtScan: DEFAULT_SETTINGS }), false, "done").scan).toBe(true);
  });
  it("keeps Scan open after a relaunch when a scan is saved, so it never sits greyed before Results", () => {
    expect(stageAvailability(scan(), false, "idle").scan).toBe(true);
    expect(stageAvailability(scan({ finished: true, settingsAtScan: DEFAULT_SETTINGS }), false, "idle")).toEqual({ rules: true, scan: true, review: true, apply: true });
  });
  it("allows Results only when the latest scan finished and nothing is running", () => {
    expect(stageAvailability(scan({ finished: true, settingsAtScan: DEFAULT_SETTINGS }), false, "done").review).toBe(true);
  });
  it("greys Results out as soon as a new scan starts, and while it's paused", () => {
    expect(stageAvailability(scan({ finished: false, settingsAtScan: DEFAULT_SETTINGS }), true, "judging").review).toBe(false);
    expect(stageAvailability(scan({ finished: false, settingsAtScan: DEFAULT_SETTINGS }), false, "paused").review).toBe(false);
  });
  it("opens Review and Apply together, only after a finished scan", () => {
    const finished = scan({ finished: true, settingsAtScan: DEFAULT_SETTINGS });
    const a = stageAvailability(finished, false, "idle");
    expect(a.review).toBe(true);
    expect(a.apply).toBe(true);
    const running = stageAvailability(finished, true, "judging");
    expect(running.review).toBe(false);
    expect(running.apply).toBe(false);
  });
});
