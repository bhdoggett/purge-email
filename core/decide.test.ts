import { describe, expect, it } from "vitest";
import { cutoff, DEFAULT_SETTINGS, decide, needsSignificance, normalizeSettings, type Settings, TRIVIAL_LINE } from "./decide.ts";
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
const plain = { starred: false, attachmentCount: 0, receivedAt: OLD, senderClose: false, closeKnown: true };

describe("decide", () => {
  it("keeps starred mail regardless of answers", () => {
    expect(decide({ starred: true, attachmentCount: 0, receivedAt: OLD, senderClose: false, closeKnown: true }, answers({ promotion: 1 }), DEFAULT_SETTINGS, NOW).decision).toBe("keep");
  });

  it("keeps mail with attachments regardless of answers", () => {
    const r = decide({ starred: false, attachmentCount: 2, receivedAt: OLD, senderClose: false, closeKnown: true }, answers({ promotion: 1 }), DEFAULT_SETTINGS, NOW);
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
    expect(decide({ starred: true, attachmentCount: 1, receivedAt: OLD, senderClose: false, closeKnown: true }, answers({ promotion: 0.95 }), s, NOW).decision).toBe("purge");
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

  it("keeps mail with no readable date while an age is set, saying the date is missing", () => {
    expect(decide({ ...plain, receivedAt: null }, promo, sixMonths, NOW)).toEqual({ decision: "keep", reason: "no date" });
  });

  it("ignores the date when the age is 0 (any age)", () => {
    const any = { ...DEFAULT_SETTINGS, ageMonths: 0 };
    expect(decide({ ...plain, receivedAt: NOW }, promo, any, NOW).decision).toBe("purge");
    expect(decide({ ...plain, receivedAt: null }, promo, any, NOW).decision).toBe("purge");
  });

  it("checks starred and attachments before age", () => {
    expect(decide({ starred: true, attachmentCount: 0, receivedAt: NOW, senderClose: false, closeKnown: true }, promo, sixMonths, NOW).reason).toBe("starred");
    expect(decide({ starred: false, attachmentCount: 1, receivedAt: NOW, senderClose: false, closeKnown: true }, promo, sixMonths, NOW).reason).toBe("attachment");
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
  it("clamps to the last day of a shorter month", () => {
    expect(cutoff(new Date(2025, 2, 31, 12).getTime(), 1)).toBe(new Date(2025, 1, 28, 12).getTime());
    expect(cutoff(new Date(2024, 1, 29, 12).getTime(), 12)).toBe(new Date(2023, 1, 28, 12).getTime());
    expect(cutoff(new Date(2026, 4, 31, 12).getTime(), 1)).toBe(new Date(2026, 3, 30, 12).getTime());
    expect(cutoff(new Date(2026, 0, 31, 12).getTime(), 1)).toBe(new Date(2025, 11, 31, 12).getTime());
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

describe("sendPreviews setting", () => {
  it("defaults to sending previews and fills it in for settings saved before it existed", () => {
    expect(DEFAULT_SETTINGS.sendPreviews).toBe(true);
    expect(normalizeSettings({ ageMonths: 6 }, DEFAULT_SETTINGS).sendPreviews).toBe(true);
    expect(normalizeSettings({ sendPreviews: false }, DEFAULT_SETTINGS).sendPreviews).toBe(false);
  });
});

describe("trivialPersonal setting", () => {
  it("defaults to off and is filled in for settings saved before it existed", () => {
    expect(DEFAULT_SETTINGS.trivialPersonal).toBe(false);
    expect(normalizeSettings({ ageMonths: 6 }, DEFAULT_SETTINGS).trivialPersonal).toBe(false);
    expect(normalizeSettings({ trivialPersonal: true }, DEFAULT_SETTINGS).trivialPersonal).toBe(true);
  });
});

describe("decide: trivial personal mail", () => {
  const on: Settings = { ...DEFAULT_SETTINGS, trivialPersonal: true };
  const personal = (significance?: number, protect: Partial<Answers["protect"]> = {}) => {
    const a = answers({ none: 1 }, { personal: 0.9, ...protect });
    return significance === undefined ? a : { ...a, significance };
  };

  it("keeps mail from a close person", () => {
    expect(decide({ ...plain, senderClose: true }, personal(0.01), on, NOW)).toEqual({ decision: "keep", reason: "close person" });
  });

  it("keeps personal mail whose significance hasn't been asked", () => {
    expect(decide(plain, personal(), on, NOW)).toEqual({ decision: "keep", reason: "personal unchecked" });
  });

  it("keeps meaningful personal mail", () => {
    expect(decide(plain, personal(0.72), on, NOW)).toEqual({ decision: "keep", reason: "meaningful 0.72" });
    expect(decide(plain, personal(0.3), on, NOW)).toEqual({ decision: "keep", reason: "meaningful 0.30" });
  });

  it("labels trivial personal mail from someone not close with the personal slug", () => {
    expect(decide(plain, personal(0.15), on, NOW)).toEqual({ decision: "purge", reason: "personal trivial 0.85", slug: "personal" });
  });

  it("uses the strictness line for what counts as trivial", () => {
    expect(TRIVIAL_LINE).toEqual({ careful: 0.2, balanced: 0.3, aggressive: 0.4 });
    const a = personal(0.25);
    expect(decide(plain, a, { ...on, strictness: "careful" }, NOW).decision).toBe("keep");
    expect(decide(plain, a, { ...on, strictness: "balanced" }, NOW).decision).toBe("purge");
    expect(decide(plain, personal(0.35), { ...on, strictness: "aggressive" }, NOW).decision).toBe("purge");
    expect(decide(plain, personal(0.35), { ...on, strictness: "balanced" }, NOW).decision).toBe("keep");
  });

  it("uses the strictness protect line for what counts as personal", () => {
    const a = answers({ none: 1 }, { personal: 0.4 });
    const trivial = { ...a, significance: 0.05 };
    expect(decide(plain, trivial, { ...on, strictness: "careful" }, NOW).slug).toBe("personal");
    // Below the balanced protect line the email isn't personal enough: the kinds logic decides.
    expect(decide(plain, trivial, on, NOW)).toEqual({ decision: "keep", reason: "purge score 0.00" });
  });

  it("keeps personal mail from an unknown sender, and never asks about it", () => {
    expect(decide({ ...plain, senderClose: null }, personal(0.01), on, NOW)).toEqual({ decision: "keep", reason: "sender unknown" });
    expect(needsSignificance({ ...plain, senderClose: null }, personal(), on, NOW)).toBe(false);
  });

  it("keeps personal mail unchecked while the close list isn't known, and never asks about it", () => {
    const unknown = { ...plain, closeKnown: false };
    expect(decide(unknown, personal(0.01), on, NOW)).toEqual({ decision: "keep", reason: "personal unchecked" });
    expect(decide({ ...unknown, senderClose: true }, personal(0.01), on, NOW).reason).toBe("personal unchecked");
    expect(needsSignificance(unknown, personal(), on, NOW)).toBe(false);
  });

  it("lets financial and account protects win first", () => {
    expect(decide(plain, personal(0.05, { financial: 0.6 }), on, NOW)).toEqual({ decision: "keep", reason: "financial 0.60" });
    expect(decide(plain, personal(0.05, { accountLegal: 0.8 }), on, NOW)).toEqual({ decision: "keep", reason: "accountLegal 0.80" });
  });

  it("ignores financial and account protects that aren't checked", () => {
    const s: Settings = { ...on, protects: ["personal"] };
    expect(decide(plain, personal(0.05, { financial: 0.9 }), s, NOW).slug).toBe("personal");
  });

  it("still keeps starred, attachment, too new and unjudged mail first", () => {
    expect(decide({ ...plain, starred: true }, personal(0.05), on, NOW).reason).toBe("starred");
    expect(decide({ ...plain, attachmentCount: 1 }, personal(0.05), on, NOW).reason).toBe("attachment");
    expect(decide({ ...plain, receivedAt: NOW }, personal(0.05), on, NOW).reason).toBe("too new");
    expect(decide(plain, null, on, NOW).reason).toBe("not judged");
  });

  it("behaves as before when the setting is off", () => {
    expect(decide(plain, personal(0.05), DEFAULT_SETTINGS, NOW)).toEqual({ decision: "keep", reason: "personal 0.90" });
    expect(decide({ ...plain, senderClose: true }, answers({ promotion: 0.95 }), DEFAULT_SETTINGS, NOW).decision).toBe("purge");
    expect(decide({ ...plain, senderClose: null, closeKnown: false }, personal(0.05), DEFAULT_SETTINGS, NOW)).toEqual({ decision: "keep", reason: "personal 0.90" });
    const unprotected: Settings = { ...DEFAULT_SETTINGS, protects: [] };
    expect(decide(plain, { ...answers({ promotion: 0.95 }, { personal: 0.9 }), significance: 0.01 }, unprotected, NOW)).toEqual({ decision: "purge", reason: "promotion 0.95" });
  });

  it("leaves non-personal mail to the kinds logic", () => {
    expect(decide(plain, { ...answers({ promotion: 0.95 }), significance: 0.01 }, on, NOW)).toEqual({ decision: "purge", reason: "promotion 0.95" });
  });
});

describe("needsSignificance", () => {
  const on: Settings = { ...DEFAULT_SETTINGS, trivialPersonal: true };
  const personal = answers({ none: 1 }, { personal: 0.9 });
  it("is true only for unchecked personal mail from someone not close", () => {
    expect(needsSignificance(plain, personal, on, NOW)).toBe(true);
    expect(needsSignificance(plain, personal, DEFAULT_SETTINGS, NOW)).toBe(false);
    expect(needsSignificance({ ...plain, senderClose: true }, personal, on, NOW)).toBe(false);
    expect(needsSignificance(plain, { ...personal, significance: 0.5 }, on, NOW)).toBe(false);
    expect(needsSignificance(plain, answers({ promotion: 1 }), on, NOW)).toBe(false);
    expect(needsSignificance({ ...plain, starred: true }, personal, on, NOW)).toBe(false);
    expect(needsSignificance(plain, answers({ none: 1 }, { personal: 0.9, financial: 0.9 }), on, NOW)).toBe(false);
  });
});
