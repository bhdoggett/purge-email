import { TypeSafeClient } from "@typesafe-ai/sdk";
import { type Answers, buildState, type EmailFacts, QUESTIONS, toAnswers } from "@core/questions.ts";
import { proxyFetch } from "../bridge/proxyFetch.ts";

export type Judge = (facts: EmailFacts) => Promise<Answers>;

/** Rust replaces this placeholder with the real key, so the webview never holds it. */
const PLACEHOLDER_KEY = "managed-by-rust";

export function createJudge(fetchFn: typeof proxyFetch = proxyFetch): Judge {
  const client = new TypeSafeClient({ apiKey: PLACEHOLDER_KEY, fetch: fetchFn, dangerouslyAllowBrowser: true });
  return async (facts) => toAnswers(await client.systemOne({ state: buildState(facts), questions: QUESTIONS }));
}
