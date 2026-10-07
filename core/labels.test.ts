import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type Settings } from "./decide.ts";
import { appLabelNames, candidateQuery, labelFor, needsRescan, validatePrefix } from "./labels.ts";
import { type Answers, QUESTIONS_VERSION } from "./questions.ts";

function answers(kind: Partial<Answers["kind"]>): Answers {
  return {
    version: QUESTIONS_VERSION,
    kind: { newsletter: 0, promotion: 0, social: 0, securityAlert: 0, shipping: 0, scam: 0, work: 0, automated: 0, none: 0, ...kind },
    protect: { personal: 0, financial: 0, accountLegal: 0 },
    inputTokens: 1,
  };
}

describe("labelFor", () => {
  it("uses the strongest checked kind", () => {
    expect(labelFor("purge", answers({ newsletter: 0.3, securityAlert: 0.6 }), DEFAULT_SETTINGS)).toBe("purge/security-alert");
  });
  it("ignores unchecked kinds", () => {
    const s: Settings = { ...DEFAULT_SETTINGS, purgeKinds: ["newsletter"] };
    expect(labelFor("purge", answers({ newsletter: 0.3, promotion: 0.6 }), s)).toBe("purge/newsletter");
  });
  it("breaks ties by PURGE_KINDS order", () => {
    expect(labelFor("purge", answers({ promotion: 0.5, newsletter: 0.5 }), DEFAULT_SETTINGS)).toBe("purge/newsletter");
  });
  it("labels judged review decisions maybe", () => {
    expect(labelFor("review", answers({ promotion: 0.6 }), DEFAULT_SETTINGS)).toBe("purge/maybe");
  });
  it("gives no label to unjudged review, stale answers, or keep", () => {
    expect(labelFor("review", null, DEFAULT_SETTINGS)).toBeNull();
    expect(labelFor("review", { ...answers({}), version: 1 }, DEFAULT_SETTINGS)).toBeNull();
    expect(labelFor("keep", answers({ promotion: 0.9 }), DEFAULT_SETTINGS)).toBeNull();
  });
  it("uses the configured prefix", () => {
    expect(labelFor("purge", answers({ scam: 1 }), { ...DEFAULT_SETTINGS, labelPrefix: "old mail" })).toBe("old mail/scam");
  });
});

describe("appLabelNames", () => {
  it("lists 8 kinds plus maybe", () => {
    expect(appLabelNames("p")).toEqual(["p/newsletter", "p/promotion", "p/social", "p/security-alert", "p/shipping", "p/scam", "p/work", "p/automated", "p/maybe"]);
  });
});

describe("validatePrefix", () => {
  it.each([["purge", null], ["old mail_2014-x", null], ["", "Enter a label name."], ["a/b", "Use letters, numbers, spaces, - or _ only."], ["x".repeat(41), "Keep the label name to 40 characters or fewer."]])("%s", (raw, expected) => {
    expect(validatePrefix(raw)).toBe(expected);
  });
});

describe("candidateQuery", () => {
  it("includes protections only when on", () => {
    expect(candidateQuery(DEFAULT_SETTINGS)).toBe("older_than:10y -has:attachment -is:starred -in:spam -in:trash -in:chats");
    expect(candidateQuery({ ...DEFAULT_SETTINGS, keepAttachments: false, keepStarred: false, years: 5 })).toBe("older_than:5y -in:spam -in:trash -in:chats");
  });
});

describe("needsRescan", () => {
  it("is true only for years and protections", () => {
    expect(needsRescan(DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS, years: 12 })).toBe(true);
    expect(needsRescan(DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS, keepStarred: false })).toBe(true);
    expect(needsRescan(DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS, keepAttachments: false })).toBe(true);
    expect(needsRescan(DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS, labelPrefix: "x", strictness: "careful", purgeKinds: [] })).toBe(false);
  });
});
