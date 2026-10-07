import { appendFile, readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import pLimit from "p-limit";
import {
  addLabel,
  connect,
  ensureLabel,
  getSummary,
  listIds,
  login,
  trash,
  type Gmail,
  type MessageSummary,
} from "./gmail.ts";
import { judge, type Judgment } from "./judge.ts";

const CACHE_PATH = "reports/judgments.jsonl";
const PURGE_LABEL = "purge";

type Decision = "trash" | "keep" | "review";

interface PlanEntry {
  id: string;
  decision: Decision;
  reason: string;
  date: string;
  from: string;
  subject: string;
  judgment: Judgment | null;
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    years: { type: "string", default: "10" },
    limit: { type: "string" },
    concurrency: { type: "string", default: "8" },
    "keep-at": { type: "string", default: "0.5" },
    "trash-below": { type: "string", default: "0.1" },
    yes: { type: "boolean", default: false },
  },
});

const [command] = positionals;

function decide(msg: MessageSummary, j: Judgment | null, keepAt: number, trashBelow: number): [Decision, string] {
  if (msg.labels.includes("STARRED")) return ["keep", "starred"];
  if (msg.attachmentNames.length > 0) return ["keep", `attachment: ${msg.attachmentNames.join(", ")}`];
  if (!j) return ["review", "not judged"];
  const reasons = (["personal", "financial", "accountLegal"] as const)
    .map((k) => [k, j[k]] as const)
    .sort((a, b) => b[1] - a[1]);
  const [topKey, topProb] = reasons[0]!;
  if (topProb >= keepAt) return ["keep", `${topKey} ${topProb.toFixed(2)}`];
  if (topProb < trashBelow) return ["trash", `max keep ${topProb.toFixed(2)}, bulk ${j.bulk.toFixed(2)}`];
  return ["review", `${topKey} ${topProb.toFixed(2)} uncertain`];
}

async function loadCache(): Promise<Map<string, Judgment>> {
  const cache = new Map<string, Judgment>();
  try {
    for (const line of (await readFile(CACHE_PATH, "utf8")).split("\n")) {
      if (!line) continue;
      const { id, judgment } = JSON.parse(line) as { id: string; judgment: Judgment };
      cache.set(id, judgment);
    }
  } catch {
    // No cache yet.
  }
  return cache;
}

function csvCell(s: string): string {
  return `"${s.replaceAll('"', '""')}"`;
}

async function plan(gmail: Gmail): Promise<void> {
  const years = Number(values.years);
  const limit = values.limit ? Number(values.limit) : Infinity;
  const keepAt = Number(values["keep-at"]);
  const trashBelow = Number(values["trash-below"]);

  // Cheap deterministic filters stay in the Gmail query; Jev only sees what's left.
  const q = `older_than:${years}y -has:attachment -is:starred -in:spam -in:trash -in:chats`;
  console.log(`Searching: ${q}`);
  const candidates = await listIds(gmail, q, limit);
  console.log(`${candidates.length} candidates`);

  // Threads where the owner sent a message are a strong "personal" signal.
  const sent = await listIds(gmail, `in:sent older_than:${years}y`);
  const repliedThreads = new Set(sent.map((m) => m.threadId));

  const cache = await loadCache();
  const run = pLimit(Number(values.concurrency));
  let done = 0;

  const entries = await Promise.all(
    candidates.map(({ id }) =>
      run(async (): Promise<PlanEntry> => {
        const msg = await getSummary(gmail, id);
        let j = cache.get(id) ?? null;
        if (!j && msg.attachmentNames.length === 0) {
          try {
            j = await judge(msg, repliedThreads.has(msg.threadId));
            await appendFile(CACHE_PATH, JSON.stringify({ id, judgment: j }) + "\n");
          } catch (err) {
            console.error(`judge failed for ${id}: ${(err as Error).message}`);
          }
        }
        const [decision, reason] = decide(msg, j, keepAt, trashBelow);
        if (++done % 100 === 0) console.log(`${done}/${candidates.length}`);
        return { id, decision, reason, date: msg.date, from: msg.from, subject: msg.subject, judgment: j };
      }),
    ),
  );

  const stamp = new Date().toISOString().replaceAll(":", "-").slice(0, 19);
  const jsonPath = `reports/plan-${stamp}.json`;
  const csvPath = `reports/plan-${stamp}.csv`;
  await writeFile(jsonPath, JSON.stringify(entries, null, 2));
  await writeFile(
    csvPath,
    ["decision,reason,date,from,subject,id"]
      .concat(entries.map((e) => [e.decision, e.reason, e.date, e.from, e.subject, e.id].map(csvCell).join(",")))
      .join("\n"),
  );

  const counts = { trash: 0, keep: 0, review: 0 };
  for (const e of entries) counts[e.decision]++;
  console.log(`\ntrash ${counts.trash} | keep ${counts.keep} | review ${counts.review}`);
  console.log(`Wrote ${jsonPath} and ${csvPath}`);

  const purgeIds = entries.filter((e) => e.decision === "trash").map((e) => e.id);
  await addLabel(gmail, await ensureLabel(gmail, PURGE_LABEL), purgeIds);
  console.log(`Labeled ${purgeIds.length} messages "${PURGE_LABEL}".`);
  console.log(`Review them in Gmail with: label:${PURGE_LABEL}`);
  console.log(`Remove the label (or star) anything you want to keep, then: npm run apply -- --yes`);
}

async function trashAll(gmail: Gmail, ids: string[]): Promise<void> {
  const run = pLimit(Number(values.concurrency));
  let done = 0;
  await Promise.all(
    ids.map((id) =>
      run(async () => {
        await trash(gmail, id);
        if (++done % 100 === 0) console.log(`${done}/${ids.length}`);
      }),
    ),
  );
  console.log(`Moved ${ids.length} messages to Trash (recoverable for 30 days).`);
}

async function apply(gmail: Gmail): Promise<void> {
  // The Gmail label is the source of truth, so edits made while reviewing count.
  // Starred messages are skipped as a last-minute escape hatch.
  const ids = (await listIds(gmail, `label:${PURGE_LABEL} -is:starred`)).map((m) => m.id);
  if (!values.yes) {
    console.log(`Would move ${ids.length} messages labeled "${PURGE_LABEL}" to Trash. Re-run with --yes to do it.`);
    return;
  }
  await trashAll(gmail, ids);
}

async function spam(gmail: Gmail): Promise<void> {
  const ids = (await listIds(gmail, "in:spam")).map((m) => m.id);
  if (!values.yes) {
    console.log(`Would move ${ids.length} spam messages to Trash. Re-run with --yes to do it.`);
    return;
  }
  await trashAll(gmail, ids);
}

switch (command) {
  case "auth":
    await login();
    console.log("Saved token.json");
    break;
  case "plan":
    await plan(await connect());
    break;
  case "apply":
    await apply(await connect());
    break;
  case "spam":
    await spam(await connect());
    break;
  default:
    console.log("Commands: auth | plan [--years 10] [--limit N] | apply [--yes] | spam [--yes]");
}
