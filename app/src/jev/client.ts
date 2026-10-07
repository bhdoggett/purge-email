import { TypeSafeClient } from "@typesafe-ai/sdk";
import { type Answers, buildState, type EmailFacts, QUESTIONS, type Significance, SIGNIFICANCE_QUESTIONS, toAnswers, toSignificance } from "@core/questions.ts";
import { proxyFetch } from "../bridge/proxyFetch.ts";

export type Judge = (facts: EmailFacts) => Promise<Answers>;
/** Asks whether a personal email is meaningful to keep. Callers strip the preview first when previews are off. */
export type SignificanceJudge = (facts: EmailFacts) => Promise<Significance>;

/** Rust replaces this placeholder with the real key, so the webview never holds it. */
const PLACEHOLDER_KEY = "managed-by-rust";

function createClient(fetchFn: typeof proxyFetch): TypeSafeClient {
  return new TypeSafeClient({ apiKey: PLACEHOLDER_KEY, fetch: fetchFn, dangerouslyAllowBrowser: true });
}

export function createJudge(fetchFn: typeof proxyFetch = proxyFetch): Judge {
  const client = createClient(fetchFn);
  return async (facts) => toAnswers(await client.systemOne({ state: buildState(facts), questions: QUESTIONS }));
}

export function createSignificanceJudge(fetchFn: typeof proxyFetch = proxyFetch): SignificanceJudge {
  const client = createClient(fetchFn);
  return async (facts) => toSignificance(await client.systemOne({ state: buildState(facts), questions: SIGNIFICANCE_QUESTIONS }));
}
