import { describe, expect, it } from "vitest";
import { cutoff, DEFAULT_SETTINGS, decide, normalizeSettings, type Settings } from "./decide.ts";
import { type Answers, QUESTIONS_VERSION } from "./questions.ts";

function answers(kind: Partial<Answers["kind"]>, protect: Partial<Answers["protect"]> = {}): Answers {
  return {
    version: QUESTIONS_VERSION,
    kind: { newsletter: 0, promotion: 0, social: 0, securityAlert: 0, shipping: 0, scam: 0, work: 0, automated: 0, none: 0, ...kind },
    protect: { personal: 0, financial: 0, accountLegal: 0, ...protect },
    inputTokens: 800,
  };
}
const NOW = new Date(2026, 9, 7, 12).getTime();
const OLD = new Date(2010, 0, 1).getTime();
const plain = { starred: false, attachmentCount: 0, receivedAt: OLD };

describe("decide", () => {
  it("keeps starred mail regardless of answers", () => {
    expect(decide({ starred: true, attachmentCount: 0, receivedAt: OLD }, answers({ promotion: 1 }), DEFAULT_SETTINGS, NOW).decision).toBe("keep");
  });

  it("keeps mail with attachments regardless of answers", () => {
    const r = decide({ starred: false, attachmentCount: 2, receivedAt: OLD }, answers({ promotion: 1 }), DEFAULT_SETTINGS, NOW);
    expect(r).toEqual({ decision: "keep", reason: "attachment" });
  });

  it("marks unjudged mail for review", () => {
    expect(decide(plain, null, DEFAULT_SETTINGS, NOW).decision).toBe("review");
  });

  it("treats answers from an older question version as unjudged", () => {
    expect(decide(plain, { ...answers({ promotion: 1 }), version: 1 }, DEFAULT_SETTINGS, NOW).decision).toBe("review");
  });

  it("sums probabilities across checked kinds", () => {
    const r = decide(plain, answers({ newsletter: 0.5, promotion: 0.4, none: 0.1 }), DEFAULT_SETTINGS, NOW);
    expect(r.decision).toBe("purge");
    expect(r.reason).toBe("newsletter 0.50, promotion 0.40");
  });

  it("ignores unchecked kinds", () => {
    const settings: Settings = { ...DEFAULT_SETTINGS, purgeKinds: ["newsletter"] };
    expect(decide(plain, answers({ newsletter: 0.55, promotion: 0.4 }), settings, NOW).decision).toBe("review");
  });

  it("protect wins over purge when above protectAt", () => {
    const r = decide(plain, answers({ promotion: 0.95 }, { financial: 0.6 }), DEFAULT_SETTINGS, NOW);
    expect(r).toEqual({ decision: "keep", reason: "financial 0.60" });
  });

  it("ignores unchecked protect questions", () => {
    const settings: Settings = { ...DEFAULT_SETTINGS, protects: ["personal"] };
    expect(decide(plain, answers({ promotion: 0.95 }, { financial: 0.9 }), settings, NOW).decision).toBe("purge");
  });

  it("applies strictness presets", () => {
    const a = answers({ promotion: 0.7 }, { personal: 0.4 });
    expect(decide(plain, a, { ...DEFAULT_SETTINGS, strictness: "careful" }, NOW).decision).toBe("keep");
    expect(decide(plain, a, { ...DEFAULT_SETTINGS, strictness: "balanced" }, NOW).decision).toBe("review");
    expect(decide(plain, a, { ...DEFAULT_SETTINGS, strictness: "aggressive" }, NOW).decision).toBe("purge");
  });

  it("keeps mail whose purge score is below the review threshold", () => {
    expect(decide(plain, answers({ none: 0.8, promotion: 0.2 }), DEFAULT_SETTINGS, NOW).decision).toBe("keep");
  });

  it("judges starred and attachment mail normally when protection is off", () => {
    const s = { ...DEFAULT_SETTINGS, keepStarred: false, keepAttachments: false };
    expect(decide({ starred: true, attachmentCount: 1, receivedAt: OLD }, answers({ promotion: 0.95 }), s, NOW).decision).toBe("purge");
  });
});

describe("decide: age", () => {
  const promo = answers({ promotion: 0.95 });
  const sixMonths = { ...DEFAULT_SETTINGS, ageMonths: 6 };

  it("keeps mail newer than the age as too new", () => {
    const recent = { ...plain, receivedAt: new Date(2026, 6, 1).getTime() };
    expect(decide(recent, promo, sixMonths, NOW)).toEqual({ decision: "keep", reason: "too new" });
  });

  it("judges mail old enough by the normal rules", () => {
    const older = { ...plain, receivedAt: new Date(2026, 2, 1).getTime() };
    expect(decide(older, promo, sixMonths, NOW).decision).toBe("purge");
  });

  it("keeps mail with no readable date as too new while an age is set", () => {
    expect(decide({ ...plain, receivedAt: null }, promo, sixMonths, NOW)).toEqual({ decision: "keep", reason: "too new" });
  });

  it("ignores the date when the age is 0 (any age)", () => {
    const any = { ...DEFAULT_SETTINGS, ageMonths: 0 };
    expect(decide({ ...plain, receivedAt: NOW }, promo, any, NOW).decision).toBe("purge");
    expect(decide({ ...plain, receivedAt: null }, promo, any, NOW).decision).toBe("purge");
  });

  it("checks starred and attachments before age", () => {
    expect(decide({ starred: true, attachmentCount: 0, receivedAt: NOW }, promo, sixMonths, NOW).reason).toBe("starred");
    expect(decide({ starred: false, attachmentCount: 1, receivedAt: NOW }, promo, sixMonths, NOW).reason).toBe("attachment");
  });

  it("checks age before judging", () => {
    expect(decide({ ...plain, receivedAt: NOW }, null, sixMonths, NOW).reason).toBe("too new");
  });
});

describe("cutoff", () => {
  it("subtracts calendar months in local time", () => {
    expect(cutoff(new Date(2026, 9, 7, 12).getTime(), 6)).toBe(new Date(2026, 3, 7, 12).getTime());
    expect(cutoff(new Date(2026, 9, 7, 12).getTime(), 120)).toBe(new Date(2016, 9, 7, 12).getTime());
  });
  it("wraps across the year", () => {
    expect(cutoff(new Date(2026, 1, 15).getTime(), 3)).toBe(new Date(2025, 10, 15).getTime());
    expect(cutoff(new Date(2026, 0, 1).getTime(), 1)).toBe(new Date(2025, 11, 1).getTime());
  });
  it("returns now for 0 months", () => {
    expect(cutoff(NOW, 0)).toBe(NOW);
  });
});

describe("normalizeSettings", () => {
  it("turns stored years into months", () => {
    const s = normalizeSettings({ years: 10 }, DEFAULT_SETTINGS);
    expect(s.ageMonths).toBe(120);
    expect("years" in s).toBe(false);
  });
  it("keeps 0 years as any age", () => {
    expect(normalizeSettings({ years: 0 }, DEFAULT_SETTINGS).ageMonths).toBe(0);
  });
  it("keeps an existing ageMonths over years", () => {
    expect(normalizeSettings({ ageMonths: 18, years: 10 }, DEFAULT_SETTINGS).ageMonths).toBe(18);
  });
  it("fills missing fields from the defaults", () => {
    const s = normalizeSettings({ purgeKinds: ["scam"], years: 2 }, { ...DEFAULT_SETTINGS, labelPrefix: "x" });
    expect(s).toEqual({ ...DEFAULT_SETTINGS, labelPrefix: "x", purgeKinds: ["scam"], ageMonths: 24 });
  });
  it("uses the default age when neither is stored", () => {
    expect(normalizeSettings({}, DEFAULT_SETTINGS).ageMonths).toBe(120);
  });
});
