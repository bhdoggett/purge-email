import { describe, expect, it } from "vitest";
import { displaySubject, formatDuration, formatUsd } from "./format.ts";

describe("format", () => {
  it("formats durations", () => {
    expect(formatDuration(30_000)).toBe("under a minute");
    expect(formatDuration(5 * 60_000)).toBe("5 min");
    expect(formatDuration(5 * 3_600_000 + 40 * 60_000)).toBe("5 h 40 min");
  });
  it("formats cost", () => {
    expect(formatUsd(0.004)).toBe("under $0.01");
    expect(formatUsd(1.834)).toBe("$1.83");
  });
  it("shows a placeholder for an empty subject", () => {
    expect(displaySubject("")).toBe("(no subject)");
    expect(displaySubject("Hi")).toBe("Hi");
  });
});
