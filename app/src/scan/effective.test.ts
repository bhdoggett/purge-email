import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "@core/decide.ts";
import { effectiveLabel, flagsOf } from "./effective.ts";
import { fakeAnswers, makeSummary } from "./fakes.ts";

const NOW = new Date(2026, 9, 7, 12).getTime();
const NONE: ReadonlySet<string> = new Set();

describe("effectiveLabel", () => {
  const promo = fakeAnswers({ promotion: 0.97 });

  it("uses Jev's label without an override", () => {
    expect(effectiveLabel(makeSummary("a"), promo, undefined, DEFAULT_SETTINGS, NOW, NONE)).toMatchObject({ label: "purge/promotion", source: "jev", decision: "purge" });
  });
  it("lets an override beat Jev", () => {
    const e = effectiveLabel(makeSummary("a"), promo, { id: "a", slug: "maybe", at: 1 }, DEFAULT_SETTINGS, NOW, NONE);
    expect(e).toMatchObject({ label: "purge/maybe", source: "override", decision: "purge" });
  });
  it("gives no label for a keep override", () => {
    expect(effectiveLabel(makeSummary("a"), promo, { id: "a", slug: null, at: 1 }, DEFAULT_SETTINGS, NOW, NONE).label).toBeNull();
  });
  it("labels a kept email when overridden", () => {
    const starred = makeSummary("s", { labels: ["STARRED"] });
    expect(effectiveLabel(starred, null, { id: "s", slug: "social", at: 1 }, DEFAULT_SETTINGS, NOW, NONE).label).toBe("purge/social");
  });
  it("follows a prefix change", () => {
    const e = effectiveLabel(makeSummary("a"), promo, { id: "a", slug: "work", at: 1 }, { ...DEFAULT_SETTINGS, labelPrefix: "old mail" }, NOW, NONE);
    expect(e.label).toBe("old mail/work");
  });
  it("keeps mail newer than the age, unless overridden", () => {
    const recent = makeSummary("r", { date: new Date(2026, 8, 1).toUTCString() });
    const six = { ...DEFAULT_SETTINGS, ageMonths: 6 };
    expect(effectiveLabel(recent, promo, undefined, six, NOW, NONE)).toMatchObject({ label: null, decision: "keep", reason: "too new" });
    expect(effectiveLabel(recent, promo, { id: "r", slug: "promotion", at: 1 }, six, NOW, NONE).label).toBe("purge/promotion");
  });
});

describe("flagsOf", () => {
  it("reads starred, attachments and the date", () => {
    const s = makeSummary("a", { labels: ["STARRED"], attachmentNames: ["x.pdf"], date: "Mon, 01 Jan 2024 00:00:00 +0000" });
    expect(flagsOf(s, NONE)).toEqual({ starred: true, attachmentCount: 1, receivedAt: Date.UTC(2024, 0, 1), senderClose: false });
  });
  it("gives a null date when the Date header can't be read", () => {
    expect(flagsOf(makeSummary("a", { date: "bad date" }), NONE).receivedAt).toBeNull();
    expect(flagsOf(makeSummary("a", { date: "" }), NONE).receivedAt).toBeNull();
  });
});

describe("close people", () => {
  const on = { ...DEFAULT_SETTINGS, trivialPersonal: true };
  const ann = makeSummary("a", { from: '"Lee, Ann" <Ann@Example.com>' });
  const trivial = { ...fakeAnswers({ none: 1 }, { personal: 0.9 }), significance: 0.1 };

  it("marks the sender close when their address is in the close set", () => {
    expect(flagsOf(ann, new Set(["ann@example.com"])).senderClose).toBe(true);
    expect(flagsOf(ann, new Set(["bo@example.com"])).senderClose).toBe(false);
    expect(flagsOf(makeSummary("x", { from: "" }), new Set([""])).senderClose).toBe(false);
  });

  it("labels trivial personal mail from someone not close purge/personal", () => {
    expect(effectiveLabel(ann, trivial, undefined, on, NOW, NONE)).toMatchObject({ label: "purge/personal", decision: "purge", reason: "personal trivial 0.90" });
  });

  it("keeps it once the sender is close", () => {
    expect(effectiveLabel(ann, trivial, undefined, on, NOW, new Set(["ann@example.com"]))).toMatchObject({ label: null, decision: "keep", reason: "close person" });
  });

  it("lets an override beat the rule", () => {
    expect(effectiveLabel(ann, trivial, { id: "a", slug: null, at: 1 }, on, NOW, NONE).label).toBeNull();
  });
});
