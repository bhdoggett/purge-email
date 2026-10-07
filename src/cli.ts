import { appendFile, readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import pLimit from "p-limit";
import {
	addLabel,
	connect,
	ensureLabel,
	type Gmail,
	getSummary,
	listIds,
	retryStats,
	login,
	type MessageSummary,
	trash,
} from "./gmail.ts";
import { type Judgment, judge } from "./judge.ts";

const JUDGMENTS_PATH = "reports/judgments.jsonl";
const SUMMARIES_PATH = "reports/summaries.jsonl";
// IDs that have already received the purge label once. A rerun never re-labels
// them, so removing the label in Gmail during review sticks.
const LABELED_PATH = "reports/labeled.jsonl";
const LABEL_BATCH = 500;
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
		concurrency: { type: "string", default: "4" },
		"keep-at": { type: "string", default: "0.5" },
		"trash-below": { type: "string", default: "0.1" },
		yes: { type: "boolean", default: false },
	},
});

const [command] = positionals;

function decide(
	msg: MessageSummary,
	j: Judgment | null,
	keepAt: number,
	trashBelow: number,
): [Decision, string] {
	if (msg.labels.includes("STARRED")) return ["keep", "starred"];
	if (msg.attachmentNames.length > 0)
		return ["keep", `attachment: ${msg.attachmentNames.join(", ")}`];
	if (!j) return ["review", "not judged"];
	const reasons = (["personal", "financial", "accountLegal"] as const)
		.map((k) => [k, j[k]] as const)
		.sort((a, b) => b[1] - a[1]);
	const [topKey, topProb] = reasons[0]!;
	if (topProb >= keepAt) return ["keep", `${topKey} ${topProb.toFixed(2)}`];
	if (topProb < trashBelow)
		return [
			"trash",
			`max keep ${topProb.toFixed(2)}, bulk ${j.bulk.toFixed(2)}`,
		];
	return ["review", `${topKey} ${topProb.toFixed(2)} uncertain`];
}

/** Reads a JSONL file of {id, ...} records into a map keyed by id. */
async function loadJsonl<T>(path: string, field: string): Promise<Map<string, T>> {
	const map = new Map<string, T>();
	try {
		for (const line of (await readFile(path, "utf8")).split("\n")) {
			if (!line) continue;
			const record = JSON.parse(line) as Record<string, unknown>;
			map.set(record.id as string, record[field] as T);
		}
	} catch {
		// File doesn't exist yet.
	}
	return map;
}

function csvCell(s: string): string {
	return `"${s.replaceAll('"', '""')}"`;
}

function formatDuration(ms: number): string {
	const min = Math.round(ms / 60_000);
	return min < 60 ? `${min}m` : `${Math.floor(min / 60)}h${String(min % 60).padStart(2, "0")}m`;
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

	// Threads where the owner sent a message are a strong "personal" signal.
	const sent = await listIds(gmail, `in:sent older_than:${years}y`);
	const repliedThreads = new Set(sent.map((m) => m.threadId));

	const judgments = await loadJsonl<Judgment>(JUDGMENTS_PATH, "judgment");
	const summaries = await loadJsonl<MessageSummary>(SUMMARIES_PATH, "summary");
	const labeled = await loadJsonl<true>(LABELED_PATH, "labeled");
	const cached = candidates.filter((c) => summaries.has(c.id) && judgments.has(c.id)).length;
	console.log(`${candidates.length} candidates (${cached} already done, ${candidates.length - cached} to go)`);

	const labelId = await ensureLabel(gmail, PURGE_LABEL);
	let pendingLabels: string[] = [];
	let labeledCount = 0;
	async function flushLabels(): Promise<void> {
		const ids = pendingLabels;
		pendingLabels = [];
		if (ids.length === 0) return;
		try {
			await addLabel(gmail, labelId, ids);
		} catch (err) {
			// Keep the IDs for the next flush instead of ending the run.
			console.error(`labeling ${ids.length} messages failed, will retry: ${(err as Error).message}`);
			pendingLabels.unshift(...ids);
			return;
		}
		await appendFile(LABELED_PATH, ids.map((id) => JSON.stringify({ id, labeled: true })).join("\n") + "\n");
		labeledCount += ids.length;
	}

	const run = pLimit(Number(values.concurrency));
	const started = Date.now();
	let done = 0;
	let failed = 0;

	const entries = await Promise.all(
		candidates.map(({ id }) =>
			run(async (): Promise<PlanEntry> => {
				let msg = summaries.get(id);
				if (!msg) {
					try {
						msg = await getSummary(gmail, id);
						await appendFile(SUMMARIES_PATH, `${JSON.stringify({ id, summary: msg })}\n`);
					} catch (err) {
						failed++;
						console.error(`fetch failed for ${id}: ${(err as Error).message}`);
						done++;
						return { id, decision: "review", reason: "fetch failed", date: "", from: "", subject: "", judgment: null };
					}
				}
				let j = judgments.get(id) ?? null;
				if (!j && msg.attachmentNames.length === 0) {
					try {
						j = await judge(msg, repliedThreads.has(msg.threadId));
						await appendFile(JUDGMENTS_PATH, `${JSON.stringify({ id, judgment: j })}\n`);
					} catch (err) {
						failed++;
						console.error(`judge failed for ${id}: ${(err as Error).message}`);
					}
				}
				const [decision, reason] = decide(msg, j, keepAt, trashBelow);
				if (decision === "trash" && !labeled.has(id)) {
					labeled.set(id, true);
					pendingLabels.push(id);
					if (pendingLabels.length >= LABEL_BATCH) await flushLabels();
				}
				if (++done % 100 === 0) {
					const eta = ((Date.now() - started) / done) * (candidates.length - done);
					console.log(
						`${done}/${candidates.length} | labeled ${labeledCount + pendingLabels.length} | ~${formatDuration(eta)} left | rate-limit waits ${retryStats.rateLimited} | failed ${failed}`,
					);
				}
				return { id, decision, reason, date: msg.date, from: msg.from, subject: msg.subject, judgment: j };
			}),
		),
	);
	await flushLabels();

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
	console.log(`\ntrash ${counts.trash} | keep ${counts.keep} | review ${counts.review} | failed ${failed}`);
	console.log(`Wrote ${jsonPath} and ${csvPath}`);
	console.log(`Newly labeled ${labeledCount} messages "${PURGE_LABEL}". Review in Gmail with: label:${PURGE_LABEL}`);
	console.log("Remove the label (or star) anything you want to keep, then: npm run apply -- --yes");
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
	console.log(
		`Moved ${ids.length} messages to Trash (recoverable for 30 days).`,
	);
}

async function apply(gmail: Gmail): Promise<void> {
	// The Gmail label is the source of truth, so edits made while reviewing count.
	// Starred messages are skipped as a last-minute escape hatch.
	const ids = (await listIds(gmail, `label:${PURGE_LABEL} -is:starred`)).map(
		(m) => m.id,
	);
	if (!values.yes) {
		console.log(
			`Would move ${ids.length} messages labeled "${PURGE_LABEL}" to Trash. Re-run with --yes to do it.`,
		);
		return;
	}
	await trashAll(gmail, ids);
}

async function spam(gmail: Gmail): Promise<void> {
	const ids = (await listIds(gmail, "in:spam")).map((m) => m.id);
	if (!values.yes) {
		console.log(
			`Would move ${ids.length} spam messages to Trash. Re-run with --yes to do it.`,
		);
		return;
	}
	await trashAll(gmail, ids);
}

try {
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
  		console.log(
  			"Commands: auth | plan [--years 10] [--limit N] | apply [--yes] | spam [--yes]",
  		);
  }
} catch (err) {
  // Print only the message; Google API errors otherwise dump hundreds of lines.
  console.error(`Error: ${(err as Error).message}`);
  process.exitCode = 1;
}
