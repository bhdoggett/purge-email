import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "@core/decide.ts";
import { effectiveLabel } from "./effective.ts";
import { fakeAnswers, makeSummary } from "./fakes.ts";

describe("effectiveLabel", () => {
  const promo = fakeAnswers({ promotion: 0.97 });

  it("uses Jev's label without an override", () => {
    expect(effectiveLabel(makeSummary("a"), promo, undefined, DEFAULT_SETTINGS)).toMatchObject({ label: "purge/promotion", source: "jev", decision: "purge" });
  });
  it("lets an override beat Jev", () => {
    const e = effectiveLabel(makeSummary("a"), promo, { id: "a", slug: "maybe", at: 1 }, DEFAULT_SETTINGS);
    expect(e).toMatchObject({ label: "purge/maybe", source: "override", decision: "purge" });
  });
  it("gives no label for a keep override", () => {
    expect(effectiveLabel(makeSummary("a"), promo, { id: "a", slug: null, at: 1 }, DEFAULT_SETTINGS).label).toBeNull();
  });
  it("labels a kept email when overridden", () => {
    const starred = makeSummary("s", { labels: ["STARRED"] });
    expect(effectiveLabel(starred, null, { id: "s", slug: "social", at: 1 }, DEFAULT_SETTINGS).label).toBe("purge/social");
  });
  it("follows a prefix change", () => {
    const e = effectiveLabel(makeSummary("a"), promo, { id: "a", slug: "work", at: 1 }, { ...DEFAULT_SETTINGS, labelPrefix: "old mail" });
    expect(e.label).toBe("old mail/work");
  });
});
