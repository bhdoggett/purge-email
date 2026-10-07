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

export async function syncLabels(deps: { gmail: Gmail; store: Store; labelName: string }, settings: Settings) {
  const { gmail, store, labelName } = deps;
  const labelId = await gmail.ensureLabel(labelName);
  // `in:anywhere` so messages the app moved to Trash still count as labeled.
  const inGmail = new Set((await gmail.listIds(`label:${labelName} in:anywhere`)).map((m) => m.id));
  const labels = await store.allLabels();

  let userRemoved = 0;
  for (const rec of labels.values()) {
    if (rec.labeledByApp && !rec.userRemoved && !inGmail.has(rec.id)) {
      rec.userRemoved = true;
      userRemoved++;
    }
  }

  const toAdd: string[] = [];
  const toRemove: string[] = [];
  for (const [id, decision] of await decisions(store, settings)) {
    const rec = labels.get(id);
    if (decision === "purge" && !inGmail.has(id) && !rec?.userRemoved) toAdd.push(id);
    if (decision !== "purge" && inGmail.has(id)) toRemove.push(id);
  }

  await gmail.addLabel(labelId, toAdd);
  await gmail.removeLabel(labelId, toRemove);
  for (const id of toAdd) labels.set(id, { id, labeledByApp: true, userRemoved: false });
  await store.putLabels([...labels.values()]);
  const scan = await store.getScan();
  if (scan) await store.putScan({ ...scan, settingsAtScan: settings });
  return { added: toAdd.length, removed: toRemove.length, userRemoved };
}
