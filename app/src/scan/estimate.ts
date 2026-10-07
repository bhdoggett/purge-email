import type { Settings } from "@core/decide.ts";
import { QUESTIONS_VERSION } from "@core/questions.ts";
import type { Gmail } from "../gmail/client.ts";
import type { Store } from "../storage/db.ts";
import { candidateQuery } from "./engine.ts";
import { JEV_USD_PER_TOKEN } from "./progress.ts";

const DEFAULT_TOKENS_PER_EMAIL = 800;
/** Conservative default before any scan has measured real Gmail pace. */
const DEFAULT_MS_PER_EMAIL = 400;

export async function estimate(deps: { gmail: Gmail; store: Store }, settings: Settings, limit?: number) {
  const ids = (await deps.gmail.listIds(candidateQuery(settings.years), limit)).map((m) => m.id);
  const answers = await deps.store.allAnswers();
  const summaries = await deps.store.allSummaries();
  const judged = [...answers.values()].filter((a) => a.version === QUESTIONS_VERSION);
  const avgTokens = judged.length ? judged.reduce((s, a) => s + a.inputTokens, 0) / judged.length : DEFAULT_TOKENS_PER_EMAIL;
  const toJudge = ids.filter((id) => answers.get(id)?.version !== QUESTIONS_VERSION).length;
  const toFetch = ids.filter((id) => !summaries.has(id)).length;
  const msPerEmail = (await deps.store.getScan())?.msPerEmail ?? DEFAULT_MS_PER_EMAIL;
  return {
    count: ids.length,
    toJudge,
    costUsd: toJudge * avgTokens * JEV_USD_PER_TOKEN,
    ms: Math.max(toFetch, toJudge) * msPerEmail,
  };
}
