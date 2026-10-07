import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "@core/decide.ts";
import { effectiveLabel, flagsOf } from "./effective.ts";
import { fakeAnswers, makeSummary } from "./fakes.ts";

const NOW = new Date(2026, 9, 7, 12).getTime();

describe("effectiveLabel", () => {
  const promo = fakeAnswers({ promotion: 0.97 });

  it("uses Jev's label without an override", () => {
    expect(effectiveLabel(makeSummary("a"), promo, undefined, DEFAULT_SETTINGS, NOW)).toMatchObject({ label: "purge/promotion", source: "jev", decision: "purge" });
  });
  it("lets an override beat Jev", () => {
    const e = effectiveLabel(makeSummary("a"), promo, { id: "a", slug: "maybe", at: 1 }, DEFAULT_SETTINGS, NOW);
    expect(e).toMatchObject({ label: "purge/maybe", source: "override", decision: "purge" });
  });
  it("gives no label for a keep override", () => {
    expect(effectiveLabel(makeSummary("a"), promo, { id: "a", slug: null, at: 1 }, DEFAULT_SETTINGS, NOW).label).toBeNull();
  });
  it("labels a kept email when overridden", () => {
    const starred = makeSummary("s", { labels: ["STARRED"] });
    expect(effectiveLabel(starred, null, { id: "s", slug: "social", at: 1 }, DEFAULT_SETTINGS, NOW).label).toBe("purge/social");
  });
  it("follows a prefix change", () => {
    const e = effectiveLabel(makeSummary("a"), promo, { id: "a", slug: "work", at: 1 }, { ...DEFAULT_SETTINGS, labelPrefix: "old mail" }, NOW);
    expect(e.label).toBe("old mail/work");
  });
  it("keeps mail newer than the age, unless overridden", () => {
    const recent = makeSummary("r", { date: new Date(2026, 8, 1).toUTCString() });
    const six = { ...DEFAULT_SETTINGS, ageMonths: 6 };
    expect(effectiveLabel(recent, promo, undefined, six, NOW)).toMatchObject({ label: null, decision: "keep", reason: "too new" });
    expect(effectiveLabel(recent, promo, { id: "r", slug: "promotion", at: 1 }, six, NOW).label).toBe("purge/promotion");
  });
});

describe("flagsOf", () => {
  it("reads starred, attachments and the date", () => {
    const s = makeSummary("a", { labels: ["STARRED"], attachmentNames: ["x.pdf"], date: "Mon, 01 Jan 2024 00:00:00 +0000" });
    expect(flagsOf(s)).toEqual({ starred: true, attachmentCount: 1, receivedAt: Date.UTC(2024, 0, 1) });
  });
  it("gives a null date when the Date header can't be read", () => {
    expect(flagsOf(makeSummary("a", { date: "bad date" })).receivedAt).toBeNull();
    expect(flagsOf(makeSummary("a", { date: "" })).receivedAt).toBeNull();
  });
});
