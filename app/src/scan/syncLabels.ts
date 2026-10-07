import { decide, type Settings } from "@core/decide.ts";
import type { Gmail } from "../gmail/client.ts";
import type { Store } from "../storage/db.ts";

export function settingsEqual(a: Settings, b: Settings): boolean {
  const norm = (s: Settings) => JSON.stringify({ ...s, purgeKinds: [...s.purgeKinds].sort(), protects: [...s.protects].sort() });
  return norm(a) === norm(b);
}

async function decisions(store: Store, settings: Settings): Promise<Map<string, "purge" | "keep" | "review">> {
  const scan = await store.getScan();
  const summaries = await store.allSummaries();
  const answers = await store.allAnswers();
  const out = new Map<string, "purge" | "keep" | "review">();
  for (const id of scan?.candidateIds ?? []) {
    const s = summaries.get(id);
    if (!s) continue;
    out.set(id, decide({ starred: s.labels.includes("STARRED"), attachmentCount: s.attachmentNames.length }, answers.get(id) ?? null, settings).decision);
  }
  return out;
}

export async function summarize(store: Store, settings: Settings) {
  const counts = { purge: 0, keep: 0, review: 0 };
  for (const d of (await decisions(store, settings)).values()) counts[d]++;
  return counts;
}

/**
 * Makes the app's label in Gmail match `settings` over the current scan's candidates.
 *
 * - An app-labeled email whose label is gone from Gmail (anywhere, Trash included) was
 *   unlabeled by the user: it is marked `userRemoved` and never labeled again.
 * - A candidate that is now a purge decision gets the label, unless the user removed it.
 * - A labeled email (outside Trash and Spam) that is not a purge decision under the current
 *   candidates loses the label. This includes app-labeled emails that are no longer
 *   candidates at all, for example after the age setting was raised.
 */
export async function syncLabels(deps: { gmail: Gmail; store: Store; labelName: string }, settings: Settings) {
  const { gmail, store, labelName } = deps;
  const labelId = await gmail.ensureLabel(labelName);
  // `in:anywhere` so messages the app moved to Trash still count as labeled.
  const anywhere = new Set((await gmail.listIds(`label:${labelName} in:anywhere`)).map((m) => m.id));
  // Without `in:anywhere` Gmail skips Trash and Spam; only these are worth unlabeling.
  const live = new Set((await gmail.listIds(`label:${labelName}`)).map((m) => m.id));
  const labels = await store.allLabels();

  let userRemoved = 0;
  for (const rec of labels.values()) {
    if (rec.labeledByApp && !rec.userRemoved && !anywhere.has(rec.id)) {
      rec.userRemoved = true;
      userRemoved++;
    }
  }

  const decided = await decisions(store, settings);
  const toAdd: string[] = [];
  const toRemove = new Set<string>();
  for (const [id, decision] of decided) {
    const rec = labels.get(id);
    if (decision === "purge" && !anywhere.has(id) && !rec?.userRemoved) toAdd.push(id);
    if (decision !== "purge" && live.has(id)) toRemove.add(id);
  }
  for (const rec of labels.values()) {
    if (rec.labeledByApp && !rec.userRemoved && live.has(rec.id) && decided.get(rec.id) !== "purge") toRemove.add(rec.id);
  }

  await gmail.addLabel(labelId, toAdd);
  await gmail.removeLabel(labelId, [...toRemove]);
  for (const id of toAdd) labels.set(id, { id, labeledByApp: true, userRemoved: false });
  // The app took these labels off itself, so forget them: a later purge decision may label them again.
  for (const id of toRemove) labels.delete(id);
  await store.deleteLabels([...toRemove]);
  await store.putLabels([...labels.values()]);
  const scan = await store.getScan();
  if (scan) await store.putScan({ ...scan, settingsAtScan: settings });
  return { added: toAdd.length, removed: toRemove.size, userRemoved };
}
