import { decide, type Settings } from "@core/decide.ts";
import { appLabelNames, labelFor } from "@core/labels.ts";
import type { Answers } from "@core/questions.ts";
import type { Gmail, Summary } from "../gmail/client.ts";
import type { LabelRecord, Store } from "../storage/db.ts";

/** Gmail's lists can lag behind label changes; a record younger than this is never read as a user change. */
export const USER_CHANGE_GRACE_MS = 600_000;

export interface ReconcileInput {
  now: number;
  settings: Settings;
  candidates: string[];
  summaries: Map<string, Summary>;
  answers: Map<string, Answers>;
  records: Map<string, LabelRecord>;
  /** id → app label name on the message anywhere (Trash and Spam included). */
  anywhere: Map<string, string>;
  /** ids carrying an app label outside Trash and Spam. */
  live: Set<string>;
}

export interface ReconcilePlan {
  add: Map<string, string[]>; // label name → ids
  remove: Map<string, string[]>; // label name → ids
  put: LabelRecord[];
  del: string[];
  userRemoved: number;
  userChosen: number;
}

export function settingsEqual(a: Settings, b: Settings): boolean {
  // Record<keyof Settings, …> makes a new Settings field a type error here until it is compared.
  const norm = (s: Settings): Record<keyof Settings, unknown> => ({
    purgeKinds: [...s.purgeKinds].sort(),
    protects: [...s.protects].sort(),
    years: s.years,
    strictness: s.strictness,
    labelPrefix: s.labelPrefix,
    keepAttachments: s.keepAttachments,
    keepStarred: s.keepStarred,
  });
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

function decisionOf(summary: Summary, answers: Answers | null, settings: Settings) {
  return decide({ starred: summary.labels.includes("STARRED"), attachmentCount: summary.attachmentNames.length }, answers, settings).decision;
}

export async function summarize(store: Store, settings: Settings): Promise<{ purge: number; keep: number; review: number }> {
  const scan = await store.getScan();
  const summaries = await store.allSummaries();
  const answers = await store.allAnswers();
  const counts = { purge: 0, keep: 0, review: 0 };
  for (const id of scan?.candidateIds ?? []) {
    const s = summaries.get(id);
    if (s) counts[decisionOf(s, answers.get(id) ?? null, settings)]++;
  }
  return counts;
}

function push(map: Map<string, string[]>, key: string, id: string) {
  const list = map.get(key);
  if (list) list.push(id);
  else map.set(key, [id]);
}

/**
 * Decides which app labels to add and remove so Gmail matches `settings`, without touching
 * anything the user changed by hand or anything in Trash or Spam.
 */
export function planReconcile(i: ReconcileInput): ReconcilePlan {
  const plan: ReconcilePlan = { add: new Map(), remove: new Map(), put: [], del: [], userRemoved: 0, userChosen: 0 };
  const records = new Map(i.records);
  const inGrace = (r: LabelRecord) => i.now - r.labeledAt < USER_CHANGE_GRACE_MS;

  // 1. Detect user changes on records old enough for Gmail's lists to be trusted.
  for (const r of i.records.values()) {
    if (r.userRemoved || inGrace(r)) continue;
    const seen = i.anywhere.get(r.id);
    let changed: LabelRecord | null = null;
    if (seen === undefined) {
      changed = { ...r, userRemoved: true };
      plan.userRemoved++;
    } else if (seen !== r.label) {
      changed = { ...r, userChosen: true, label: seen };
      plan.userChosen++;
    }
    if (changed) {
      records.set(r.id, changed);
      plan.put.push(changed);
    }
  }

  // 2. Desired label per id: only candidates with a summary can have one.
  const desired = new Map<string, string | null>();
  for (const id of i.candidates) {
    const s = i.summaries.get(id);
    const answers = i.answers.get(id) ?? null;
    desired.set(id, s ? labelFor(decisionOf(s, answers, i.settings), answers, i.settings) : null);
  }

  // 3. Apply to live, candidate and just-labeled ids the user hasn't taken over.
  // Just-labeled records too: Gmail's lists may not show them yet, but their labels still need to follow the rules.
  const recent = [...records.values()].filter((r) => inGrace(r)).map((r) => r.id);
  for (const id of new Set([...i.candidates, ...i.live, ...recent])) {
    const r = records.get(id);
    if (r?.userRemoved || r?.userChosen) continue;
    const isLive = i.live.has(id);
    // In Trash or Spam: never changed.
    if (!isLive && i.anywhere.has(id)) continue;
    // Just labeled but not yet in Gmail's lists: trust the record's own label.
    const current = isLive ? (i.anywhere.get(id) ?? null) : r && inGrace(r) ? r.label : null;
    const want = desired.get(id) ?? null;

    if (current === want) {
      // Nothing is added, so an existing record keeps its labeledAt.
      if (want !== null && r?.label !== want) plan.put.push({ id, label: want, labeledAt: r?.labeledAt ?? i.now, userRemoved: false, userChosen: false });
      continue;
    }
    if (current !== null) push(plan.remove, current, id);
    if (want !== null) {
      push(plan.add, want, id);
      plan.put.push({ id, label: want, labeledAt: i.now, userRemoved: false, userChosen: false });
    } else if (r) {
      plan.del.push(id);
    }
  }
  return plan;
}

/** Ids of every message with label `labelId`, inside or outside Trash and Spam. */
async function idsOf(gmail: Gmail, labelId: string, includeSpamTrash: boolean): Promise<string[]> {
  return (await gmail.listIds("", Infinity, { labelIds: [labelId], includeSpamTrash })).map((m) => m.id);
}

/**
 * Brings the app's labels in Gmail in line with `settings` over the current scan's candidates.
 * `added` and `removed` count ids that only gained or only lost a label; `moved` counts ids that did both.
 */
export async function reconcile(
  deps: { gmail: Gmail; store: Store; now?: () => number },
  settings: Settings,
): Promise<{ added: number; removed: number; moved: number; userRemoved: number; userChosen: number }> {
  const { gmail, store } = deps;
  const now = (deps.now ?? Date.now)();
  const scan = await store.getScan();
  const records = await store.allLabels();

  const names = new Set([...appLabelNames(settings.labelPrefix), ...[...records.values()].map((r) => r.label)]);
  const labelIds = new Map<string, string>();
  const labelsOn = new Map<string, string[]>();
  const live = new Set<string>();
  for (const name of names) {
    const labelId = await gmail.findLabelId(name);
    if (labelId === null) continue;
    labelIds.set(name, labelId);
    for (const id of await idsOf(gmail, labelId, true)) push(labelsOn, id, name);
    for (const id of await idsOf(gmail, labelId, false)) live.add(id);
  }
  // A message with several app labels (e.g. an interrupted move) counts as carrying its recorded one.
  const anywhere = new Map<string, string>();
  for (const [id, labels] of labelsOn) {
    const recorded = records.get(id)?.label;
    anywhere.set(id, recorded !== undefined && labels.includes(recorded) ? recorded : labels[0]!);
  }

  const plan = planReconcile({
    now,
    settings,
    candidates: scan?.candidateIds ?? [],
    summaries: await store.allSummaries(),
    answers: await store.allAnswers(),
    records,
    anywhere,
    live,
  });

  // Add before remove: if this stops halfway, an email has two labels rather than none.
  for (const [name, ids] of plan.add) await gmail.addLabel(await gmail.ensureLabel(name), ids);
  for (const [name, ids] of plan.remove) {
    // A label the user deleted from Gmail is already off every email.
    const labelId = labelIds.get(name);
    if (labelId !== undefined) await gmail.removeLabel(labelId, ids);
  }
  await store.putLabels(plan.put);
  await store.deleteLabels(plan.del);
  if (scan) await store.putScan({ ...scan, settingsAtScan: settings });

  const added = new Set([...plan.add.values()].flat());
  const removed = new Set([...plan.remove.values()].flat());
  const moved = [...added].filter((id) => removed.has(id)).length;
  return { added: added.size - moved, removed: removed.size - moved, moved, userRemoved: plan.userRemoved, userChosen: plan.userChosen };
}

/** Message count per app label under the current prefix, skipping starred mail when it is protected. Labels with none are left out. */
export async function countByLabel(gmail: Gmail, settings: Settings): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const name of appLabelNames(settings.labelPrefix)) {
    const labelId = await gmail.findLabelId(name);
    if (labelId === null) continue;
    const n = (await gmail.listIds(settings.keepStarred ? "-is:starred" : "", Infinity, { labelIds: [labelId] })).length;
    if (n > 0) counts.set(name, n);
  }
  return counts;
}
