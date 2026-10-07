import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "@core/decide.ts";
import { effectiveLabel, flagsOf } from "./effective.ts";
import { NO_CLOSE } from "./closeness.ts";
import { fakeAnswers, knownClose, makeSummary } from "./fakes.ts";

const NOW = new Date(2026, 9, 7, 12).getTime();
const NONE = NO_CLOSE;

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
    expect(flagsOf(s, NONE)).toEqual({ starred: true, attachmentCount: 1, receivedAt: Date.UTC(2024, 0, 1), senderClose: null, closeKnown: false });
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
  const sent = (to: string, overrides = {}) => makeSummary("s", { from: "Me <ME@gmail.com>", to, ...overrides });

  it("marks the sender close when their address is in the close set", () => {
    expect(flagsOf(ann, knownClose(["ann@example.com"]))).toMatchObject({ senderClose: true, closeKnown: true });
    expect(flagsOf(ann, knownClose(["bo@example.com"])).senderClose).toBe(false);
  });

  it("treats a sender whose address can't be read as unknown", () => {
    expect(flagsOf(makeSummary("x", { from: "" }), knownClose([""])).senderClose).toBeNull();
    expect(flagsOf(makeSummary("x", { from: "Mom" }), knownClose()).senderClose).toBeNull();
  });

  it("reads a no-reply sender as a known, not close, sender", () => {
    expect(flagsOf(makeSummary("x", { from: "No Reply <noreply@shop.com>" }), knownClose()).senderClose).toBe(false);
  });

  it("judges mail the user sent by its recipients", () => {
    expect(flagsOf(sent("Mom <mom@x.com>, bo@y.org"), knownClose(["mom@x.com"])).senderClose).toBe(true);
    expect(flagsOf(sent("bo@y.org", { cc: "Mom <mom@x.com>" }), knownClose(["mom@x.com"])).senderClose).toBe(true);
    expect(flagsOf(sent("bo@y.org"), knownClose(["mom@x.com"])).senderClose).toBe(false);
  });

  it("treats mail with the SENT label as sent, even when the From address differs", () => {
    const alias = makeSummary("s", { from: "Me <me@alias.com>", to: "mom@x.com", labels: ["SENT"] });
    expect(flagsOf(alias, knownClose(["mom@x.com"])).senderClose).toBe(true);
  });

  it("treats sent mail with no readable recipient as unknown", () => {
    expect(flagsOf(sent(""), knownClose(["mom@x.com"])).senderClose).toBeNull();
    expect(flagsOf(sent("me@gmail.com"), knownClose(["mom@x.com"])).senderClose).toBeNull();
  });

  it("isn't known without a complete close list", () => {
    expect(flagsOf(ann, NO_CLOSE).closeKnown).toBe(false);
  });

  it("labels trivial personal mail from someone not close purge/personal", () => {
    expect(effectiveLabel(ann, trivial, undefined, on, NOW, knownClose())).toMatchObject({ label: "purge/personal", decision: "purge", reason: "personal trivial 0.90" });
  });

  it("keeps it once the sender is close", () => {
    expect(effectiveLabel(ann, trivial, undefined, on, NOW, knownClose(["ann@example.com"]))).toMatchObject({ label: null, decision: "keep", reason: "close person" });
  });

  it("keeps a sent reply to a close person and labels one to someone who isn't", () => {
    expect(effectiveLabel(sent("Mom <mom@x.com>"), trivial, undefined, on, NOW, knownClose(["mom@x.com"]))).toMatchObject({ label: null, reason: "close person" });
    expect(effectiveLabel(sent("bo@y.org"), trivial, undefined, on, NOW, knownClose(["mom@x.com"])).label).toBe("purge/personal");
  });

  it("keeps it while the close list isn't known", () => {
    expect(effectiveLabel(ann, trivial, undefined, on, NOW, NO_CLOSE)).toMatchObject({ label: null, reason: "personal unchecked" });
  });

  it("lets an override beat the rule", () => {
    expect(effectiveLabel(ann, trivial, { id: "a", slug: null, at: 1 }, on, NOW, knownClose()).label).toBeNull();
  });
});
