import { describe, expect, it } from "vitest";
import { applyProgress, applyPercent } from "./applyProgress.ts";

describe("apply progress store", () => {
  it("is null when idle and holds done/total while running", () => {
    expect(applyProgress.get()).toBeNull();
    applyProgress.set({ done: 1, total: 4 });
    expect(applyProgress.get()).toEqual({ done: 1, total: 4 });
    applyProgress.set(null);
    expect(applyProgress.get()).toBeNull();
  });

  it("rounds to a percent and shows 0 for an empty plan", () => {
    expect(applyPercent({ done: 1, total: 3 })).toBe(33);
    expect(applyPercent({ done: 0, total: 0 })).toBe(0);
  });
});
