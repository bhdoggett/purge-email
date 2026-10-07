import { describe, expect, it } from "vitest";
import { ageFromInput, initialUnit, MAX_MONTHS, shownNumber, switchUnit } from "./ageUnits.ts";

describe("age units", () => {
  it("starts in years when the months divide by 12", () => {
    expect(initialUnit(120)).toBe("years");
    expect(initialUnit(0)).toBe("years");
    expect(initialUnit(18)).toBe("months");
  });
  it("shows the number in the chosen unit", () => {
    expect(shownNumber(24, "years")).toBe(2);
    expect(shownNumber(24, "months")).toBe(24);
  });
  it("turns typed text into whole months within limits", () => {
    expect(ageFromInput("2", "years")).toBe(24);
    expect(ageFromInput("7", "months")).toBe(7);
    expect(ageFromInput("2.6", "months")).toBe(3);
    expect(ageFromInput("", "years")).toBe(0);
    expect(ageFromInput("-4", "months")).toBe(0);
    expect(ageFromInput("99", "years")).toBe(MAX_MONTHS);
    expect(ageFromInput("999", "months")).toBe(MAX_MONTHS);
  });
  it("keeps the months when switching unit where possible", () => {
    expect(switchUnit(24, "months")).toBe(24);
    expect(switchUnit(24, "years")).toBe(24);
    expect(switchUnit(7, "months")).toBe(7);
  });
  it("rounds to the nearest year when switching uneven months to years", () => {
    expect(switchUnit(18, "years")).toBe(24);
    expect(switchUnit(17, "years")).toBe(12);
  });
  it("never rounds a set age down to any age", () => {
    expect(switchUnit(5, "years")).toBe(12);
    expect(switchUnit(0, "years")).toBe(0);
  });
});
