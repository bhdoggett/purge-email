import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, decide, type Settings } from "./decide.ts";
import { type Answers, QUESTIONS_VERSION } from "./questions.ts";

function answers(kind: Partial<Answers["kind"]>, protect: Partial<Answers["protect"]> = {}): Answers {
  return {
    version: QUESTIONS_VERSION,
    kind: { newsletter: 0, promotion: 0, social: 0, securityAlert: 0, shipping: 0, scam: 0, work: 0, automated: 0, none: 0, ...kind },
    protect: { personal: 0, financial: 0, accountLegal: 0, ...protect },
    inputTokens: 800,
  };
}
const plain = { starred: false, attachmentCount: 0 };

describe("decide", () => {
  it("keeps starred mail regardless of answers", () => {
    expect(decide({ starred: true, attachmentCount: 0 }, answers({ promotion: 1 }), DEFAULT_SETTINGS).decision).toBe("keep");
  });

  it("keeps mail with attachments regardless of answers", () => {
    const r = decide({ starred: false, attachmentCount: 2 }, answers({ promotion: 1 }), DEFAULT_SETTINGS);
    expect(r).toEqual({ decision: "keep", reason: "attachment" });
  });

  it("marks unjudged mail for review", () => {
    expect(decide(plain, null, DEFAULT_SETTINGS).decision).toBe("review");
  });

  it("treats answers from an older question version as unjudged", () => {
    expect(decide(plain, { ...answers({ promotion: 1 }), version: 1 }, DEFAULT_SETTINGS).decision).toBe("review");
  });

  it("sums probabilities across checked kinds", () => {
    const r = decide(plain, answers({ newsletter: 0.5, promotion: 0.4, none: 0.1 }), DEFAULT_SETTINGS);
    expect(r.decision).toBe("purge");
    expect(r.reason).toBe("newsletter 0.50, promotion 0.40");
  });

  it("ignores unchecked kinds", () => {
    const settings: Settings = { ...DEFAULT_SETTINGS, purgeKinds: ["newsletter"] };
    expect(decide(plain, answers({ newsletter: 0.55, promotion: 0.4 }), settings).decision).toBe("review");
  });

  it("protect wins over purge when above protectAt", () => {
    const r = decide(plain, answers({ promotion: 0.95 }, { financial: 0.6 }), DEFAULT_SETTINGS);
    expect(r).toEqual({ decision: "keep", reason: "financial 0.60" });
  });

  it("ignores unchecked protect questions", () => {
    const settings: Settings = { ...DEFAULT_SETTINGS, protects: ["personal"] };
    expect(decide(plain, answers({ promotion: 0.95 }, { financial: 0.9 }), settings).decision).toBe("purge");
  });

  it("applies strictness presets", () => {
    const a = answers({ promotion: 0.7 }, { personal: 0.4 });
    expect(decide(plain, a, { ...DEFAULT_SETTINGS, strictness: "careful" }).decision).toBe("keep");
    expect(decide(plain, a, { ...DEFAULT_SETTINGS, strictness: "balanced" }).decision).toBe("review");
    expect(decide(plain, a, { ...DEFAULT_SETTINGS, strictness: "aggressive" }).decision).toBe("purge");
  });

  it("keeps mail whose purge score is below the review threshold", () => {
    expect(decide(plain, answers({ none: 0.8, promotion: 0.2 }), DEFAULT_SETTINGS).decision).toBe("keep");
  });
});
