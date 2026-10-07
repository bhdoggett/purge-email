import { describe, expect, it } from "vitest";
import { buildState, QUESTIONS_VERSION, SIGNIFICANCE_QUESTIONS, toAnswers, toSignificance } from "./questions.ts";

describe("toAnswers", () => {
  it("maps SDK results and fills missing kind probabilities with 0", () => {
    const result = {
      model: "jev-1.13.0",
      usage: { input_tokens: 812, output_tokens: 40 },
      answers: {
        kind: { type: "choice", choice: "promotion", confidence: 0.9, probabilities: { promotion: 0.9, none: 0.1 } },
        personal: { type: "noul", noul: 0.02 },
        financial: { type: "noul", noul: 0.1 },
        accountLegal: { type: "noul", noul: 0.03 },
      },
    } as never;
    const a = toAnswers(result);
    expect(a.version).toBe(QUESTIONS_VERSION);
    expect(a.kind.promotion).toBe(0.9);
    expect(a.kind.newsletter).toBe(0);
    expect(a.protect).toEqual({ personal: 0.02, financial: 0.1, accountLegal: 0.03 });
    expect(a.inputTokens).toBe(812);
  });
});

describe("buildState", () => {
  it("keeps empty headers as empty strings", () => {
    const s = buildState({ from: "", to: "", cc: "", subject: "", date: "", snippet: "", ownerReplied: false, hasListUnsubscribe: false, labels: [], attachmentNames: [] });
    expect(s.email.subject).toBe("");
    expect(s.facts.ownerRepliedInThisThread).toBe(false);
  });

  it("passes attachment file names through", () => {
    const s = buildState({ from: "", to: "", cc: "", subject: "", date: "", snippet: "", ownerReplied: false, hasListUnsubscribe: false, labels: [], attachmentNames: ["a.pdf", "b.png"] });
    expect(s.facts.attachmentFileNames).toEqual(["a.pdf", "b.png"]);
  });
});

describe("significance question", () => {
  it("asks whether the email is personally meaningful, as a noul", () => {
    expect(SIGNIFICANCE_QUESTIONS.meaningful.type).toBe("noul");
    expect(SIGNIFICANCE_QUESTIONS.meaningful.instructions).toBe("Is this email personally meaningful to keep?");
    expect(SIGNIFICANCE_QUESTIONS.meaningful.criteria.false).toMatch(/^Trivial logistics/);
  });

  it("maps the SDK result to the probability of meaningful and the tokens used", () => {
    const result = { model: "jev", usage: { input_tokens: 640, output_tokens: 5 }, answers: { meaningful: { type: "noul", noul: 0.72 } } } as never;
    expect(toSignificance(result)).toEqual({ meaningful: 0.72, inputTokens: 640 });
  });

  it("doesn't change the questions version, so earlier answers stay valid", () => {
    expect(QUESTIONS_VERSION).toBe(2);
  });
});
