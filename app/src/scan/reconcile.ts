import type { Settings } from "@core/decide.ts";
import { appLabelNames } from "@core/labels.ts";
import type { Answers } from "@core/questions.ts";
import { AppError } from "../bridge/errors.ts";
import { type Gmail, GmailError, type Summary } from "../gmail/client.ts";
import type { LabelRecord, Override, Store } from "../storage/db.ts";
import { effectiveLabel } from "./effective.ts";

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
  /** The user's choices from the Review screen. */
  overrides: Map<string, Override>;
}

export interface ReconcilePlan {
  add: Map<string, string[]>; // label name → ids
  remove: Map<string, string[]>; // label name → ids
  put: LabelRecord[];
  del: string[];
  userRemoved: number;
  userChosen: number;
  /** Just-labeled ids left alone because Gmail's lists don't confirm their label yet. */
  deferred: number;
}

/** Gmail answers 400 or 409 when it refuses a label name. */
export function asLabelNameError(err: unknown): unknown {
  if (err instanceof GmailError && (err.status === 400 || err.status === 409)) {
    return new AppError({ kind: "Invalid", detail: "Gmail didn't accept that label name. Try another on the Rules screen." });
  }
  return err;
}

export async function summarize(store: Store, settings: Settings, now: number = Date.now()): Promise<{ purge: number; keep: number; review: number }> {
  const scan = await store.getScan();
  const summaries = await store.allSummaries();
  const answers = await store.allAnswers();
  const overrides = await store.allOverrides();
  const counts = { purge: 0, keep: 0, review: 0 };
  for (const id of scan?.candidateIds ?? []) {
    const s = summaries.get(id);
    if (!s) continue;
    const e = effectiveLabel(s, answers.get(id) ?? null, overrides.get(id), settings, now);
    counts[e.source === "override" ? (e.label === null ? "keep" : e.label.endsWith("/maybe") ? "review" : "purge") : e.decision]++;
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
 * anything the user changed by hand, any app-named label the app has no record of, or anything
 * in Trash or Spam. Inside the grace window it only acts when Gmail's lists confirm the recorded
 * label; otherwise it defers, so it never undoes a change the user just made.
 * An override newer than the app's last label on an email beats the user's earlier Gmail change.
 */
export function planReconcile(i: ReconcileInput): ReconcilePlan {
  const plan: ReconcilePlan = { add: new Map(), remove: new Map(), put: [], del: [], userRemoved: 0, userChosen: 0, deferred: 0 };
  const records = new Map(i.records);
  // An override only means something for an email that is still a candidate.
  const candidateSet = new Set(i.candidates);
  const overrides = new Map([...i.overrides].filter(([id]) => candidateSet.has(id)));
  const inGrace = (r: LabelRecord) => i.now - r.labeledAt < USER_CHANGE_GRACE_MS;
  /** An override made after the app last labeled this email beats any change the user made in Gmail before it. */
  const overrideWins = (r: LabelRecord) => (overrides.get(r.id)?.at ?? -Infinity) > r.labeledAt;

  // 1. Detect user changes on records old enough for Gmail's lists to be trusted.
  for (const r of i.records.values()) {
    if (r.userRemoved || inGrace(r) || overrideWins(r)) continue;
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

  // 2. An app-named label the app has no record of may be the user's own: record it as theirs and never touch it.
  for (const id of i.live) {
    if (records.has(id) || overrides.has(id)) continue;
    const r: LabelRecord = { id, label: i.anywhere.get(id)!, labeledAt: i.now, userRemoved: false, userChosen: true };
    records.set(id, r);
    plan.put.push(r);
  }

  // 3. Desired label per id: only candidates with a summary can have one.
  const desired = new Map<string, string | null>();
  for (const id of i.candidates) {
    const s = i.summaries.get(id);
    const answers = i.answers.get(id) ?? null;
    desired.set(id, s ? effectiveLabel(s, answers, overrides.get(id), i.settings, i.now).label : null);
  }

  // 4. Apply to live, candidate and just-labeled ids the user hasn't taken over.
  const recent = [...records.values()].filter((r) => inGrace(r)).map((r) => r.id);
  for (const id of new Set([...i.candidates, ...i.live, ...recent])) {
    const r = records.get(id);
    if (r && (r.userRemoved || r.userChosen) && !overrideWins(r)) continue;
    const isLive = i.live.has(id);
    // In Trash or Spam: never changed.
    if (!isLive && i.anywhere.has(id)) continue;
    const current = isLive ? i.anywhere.get(id)! : null;
    const want = desired.get(id) ?? null;
    // Just labeled: Gmail's lists may lag behind, so a missing or different label could be lag or a
    // user change. Act only when Gmail confirms the recorded label; otherwise wait for the window to pass.
    if (r && inGrace(r) && current !== r.label) {
      if (current !== null || want !== r.label) plan.deferred++;
      continue;
    }
    if (current === want) {
      // An override already in effect is stamped as applied, so a later Gmail change is read as the user's.
      if (overrides.has(id) && (r ? overrideWins(r) : isLive)) {
        if (want !== null) plan.put.push({ id, label: want, labeledAt: i.now, userRemoved: false, userChosen: false });
        else if (r) plan.put.push({ ...r, labeledAt: i.now });
      }
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

export interface GmailLabelState {
  labelIds: Map<string, string>; // label name → Gmail label id, for labels that exist
  /** id → app label name on the message anywhere (Trash and Spam included). */
  anywhere: Map<string, string>;
  /** ids carrying an app label outside Trash and Spam. */
  live: Set<string>;
}

/** Reads which app labels (current prefix plus any recorded) are on which messages in Gmail. */
export async function readGmailState(gmail: Gmail, settings: Settings, records: Map<string, LabelRecord>): Promise<GmailLabelState> {
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
  return { labelIds, anywhere, live };
}

export interface Preview {
  plan: ReconcilePlan;
  added: number;
  removed: number;
  moved: number;
  /** Label name → how many emails outside Trash and Spam it will hold after Apply. Labels with none left out. */
  totals: Map<string, number>;
  /** Prefixes of labels the plan empties that are not under the current prefix (old names after a rename). */
  oldPrefixes: string[];
  gmail: GmailLabelState;
}

export const isPending = (p: Pick<Preview, "added" | "removed" | "moved">): boolean => p.added + p.removed + p.moved > 0;

export function labelTotalsAfter(live: Set<string>, anywhere: Map<string, string>, plan: ReconcilePlan): Map<string, number> {
  const after = new Map<string, string>();
  for (const id of live) after.set(id, anywhere.get(id)!);
  for (const [name, ids] of plan.remove) for (const id of ids) if (after.get(id) === name) after.delete(id);
  for (const [name, ids] of plan.add) for (const id of ids) after.set(id, name);
  const totals = new Map<string, number>();
  for (const name of after.values()) totals.set(name, (totals.get(name) ?? 0) + 1);
  return totals;
}

/**
 * Works out what `reconcile` would change in Gmail, without writing anything.
 * `added` and `removed` count ids that only gained or only lost a label; `moved` counts ids that did both.
 */
export async function previewReconcile(deps: { gmail: Gmail; store: Store; now?: () => number }, settings: Settings): Promise<Preview> {
  const { gmail, store } = deps;
  const now = (deps.now ?? Date.now)();
  const scan = await store.getScan();
  // Without a finished scan there are no candidates, so a plan would strip every app label.
  if (!scan?.finished || !scan.settingsAtScan) throw new AppError({ kind: "Invalid", detail: "Scan your mail first." });
  const records = await store.allLabels();
  const state = await readGmailState(gmail, settings, records);

  const plan = planReconcile({
    now,
    settings,
    candidates: scan.candidateIds,
    summaries: await store.allSummaries(),
    answers: await store.allAnswers(),
    records,
    anywhere: state.anywhere,
    live: state.live,
    overrides: await store.allOverrides(),
  });

  const added = new Set([...plan.add.values()].flat());
  const removed = new Set([...plan.remove.values()].flat());
  const moved = [...added].filter((id) => removed.has(id)).length;
  const oldPrefixes = [
    ...new Set(
      [...plan.remove.keys()]
        .filter((name) => name.includes("/"))
        .map((name) => name.slice(0, name.lastIndexOf("/")))
        .filter((prefix) => prefix !== settings.labelPrefix),
    ),
  ];
  return {
    plan,
    added: added.size - moved,
    removed: removed.size - moved,
    moved,
    totals: labelTotalsAfter(state.live, state.anywhere, plan),
    oldPrefixes,
    gmail: state,
  };
}

/** Writes a previewed plan to Gmail and the store. */
export async function applyPreview(deps: { gmail: Gmail; store: Store }, settings: Settings, preview: Preview): Promise<void> {
  const { gmail, store } = deps;
  const { plan } = preview;
  // Add before remove: if this stops halfway, an email has two labels rather than none.
  for (const [name, ids] of plan.add) {
    const labelId = await gmail.ensureLabel(name).catch((err: unknown) => {
      throw asLabelNameError(err);
    });
    await gmail.addLabel(labelId, ids);
  }
  for (const [name, ids] of plan.remove) {
    // A label the user deleted from Gmail is already off every email.
    const labelId = preview.gmail.labelIds.get(name);
    if (labelId !== undefined) await gmail.removeLabel(labelId, ids);
  }
  await store.putLabels(plan.put);
  await store.deleteLabels(plan.del);
  const scan = await store.getScan();
  if (scan) await store.putScan({ ...scan, settingsAtScan: settings });
}

/** Brings the app's labels in Gmail in line with `settings` over the current scan's candidates. */
export async function reconcile(
  deps: { gmail: Gmail; store: Store; now?: () => number },
  settings: Settings,
): Promise<{ added: number; removed: number; moved: number; userRemoved: number; userChosen: number; deferred: number }> {
  const p = await previewReconcile(deps, settings);
  await applyPreview(deps, settings, p);
  return { added: p.added, removed: p.removed, moved: p.moved, userRemoved: p.plan.userRemoved, userChosen: p.plan.userChosen, deferred: p.plan.deferred };
}

/**
 * True when labels under `prefix` already hold mail in Gmail but the app has never labeled anything
 * under that prefix: they are probably the user's own labels, and the app would mix with them.
 */
export async function prefixInUseByUser(gmail: Gmail, records: Map<string, LabelRecord>, prefix: string): Promise<boolean> {
  const under = `${prefix.toLowerCase()}/`;
  if ([...records.values()].some((r) => !r.userChosen && r.label.toLowerCase().startsWith(under))) return false;
  for (const name of [prefix, ...appLabelNames(prefix)]) {
    const labelId = await gmail.findLabelId(name);
    if (labelId === null) continue;
    if ((await gmail.listIds("", 1, { labelIds: [labelId], includeSpamTrash: true })).length > 0) return true;
  }
  return false;
}

/**
 * Message count per app label under the current prefix, skipping starred mail when it is protected.
 * Read by label id only (no search text): starred mail is subtracted using the STARRED label id.
 * Labels with none are left out.
 */
export async function countByLabel(gmail: Gmail, settings: Settings): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const name of appLabelNames(settings.labelPrefix)) {
    const labelId = await gmail.findLabelId(name);
    if (labelId === null) continue;
    let n = (await gmail.listIds("", Infinity, { labelIds: [labelId] })).length;
    if (settings.keepStarred && n > 0) n -= (await gmail.listIds("", Infinity, { labelIds: [labelId, "STARRED"] })).length;
    if (n > 0) counts.set(name, n);
  }
  return counts;
}
