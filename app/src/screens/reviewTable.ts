import type { Decision, Settings } from "@core/decide.ts";
import { kindOfSlug, MAYBE, slugOfLabel, suggestedSlug } from "@core/labels.ts";
import { type Answers, PROTECTS, PURGE_KINDS, type ProtectId, type PurgeKind } from "@core/questions.ts";
import type { Summary } from "../gmail/client.ts";
import type { Override } from "../storage/db.ts";
import { effectiveLabel } from "../scan/effective.ts";

export interface TableRow {
  id: string;
  from: string;
  subject: string;
  /** ms since epoch, from Summary.date; NaN dates sort last. */
  date: number;
  /** Full effective label, or null. */
  label: string | null;
  /** Slug of `label`, or null. */
  slug: string | null;
  /** Suggested slug, shown faded when `label` is null. */
  suggested: string | null;
  decision: Decision;
  overridden: boolean;
  reason: string;
}

const pct = (p: number) => Math.round(p * 100);

function kindText(kind: PurgeKind, answers: Answers): string {
  const label = PURGE_KINDS.find((k) => k.id === kind)!.label.toLowerCase();
  return `${label} ${pct(answers.kind[kind])}%`;
}

function keptReason(raw: string, suggested: string | null, answers: Answers | null, settings: Settings): string {
  if (raw === "starred") return "Kept: starred";
  if (raw === "attachment") return "Kept: has attachments";
  if (raw === "not judged" || !answers) return "Not judged";
  const protect = PROTECTS.find((p) => p.id === (raw.split(" ")[0] as ProtectId));
  if (protect) return `Kept: ${protect.label.toLowerCase()} ${pct(answers.protect[protect.id])}%`;
  const kind = suggested === null ? null : kindOfSlug(suggested);
  if (kind === null || !settings.purgeKinds.includes(kind)) return "Kept: kind not checked";
  const score = settings.purgeKinds.reduce((sum, k) => sum + answers.kind[k], 0);
  return `Kept: purge score ${pct(score)}%`;
}

function labelReason(slug: string | null, answers: Answers | null, settings: Settings): string {
  if (!answers || slug === null) return "Not judged";
  const kind = kindOfSlug(slug);
  if (kind) return kindText(kind, answers);
  // "maybe" (or an unknown slug): describe the top checked kind.
  let top: PurgeKind | null = null;
  for (const k of PURGE_KINDS) {
    if (!settings.purgeKinds.includes(k.id)) continue;
    if (top === null || answers.kind[k.id] > answers.kind[top]) top = k.id;
  }
  return top === null ? "Unsure" : `Unsure: ${kindText(top, answers)}`;
}

export function buildTableRows(ids: string[], summaries: Map<string, Summary>, answers: Map<string, Answers>, overrides: Map<string, Override>, settings: Settings): TableRow[] {
  const rows: TableRow[] = [];
  for (const id of ids) {
    const summary = summaries.get(id);
    if (!summary) continue;
    const a = answers.get(id) ?? null;
    const override = overrides.get(id);
    const eff = effectiveLabel(summary, a, override, settings);
    const slug = eff.label === null ? null : slugOfLabel(eff.label, settings.labelPrefix);
    const suggested = suggestedSlug(a);
    const reason = override ? "Changed by you" : eff.label === null ? keptReason(eff.reason, suggested, a, settings) : labelReason(slug, a, settings);
    rows.push({ id, from: summary.from, subject: summary.subject, date: Date.parse(summary.date), label: eff.label, slug, suggested, decision: eff.decision, overridden: override !== undefined, reason });
  }
  return rows.sort((x, y) => {
    const xn = Number.isNaN(x.date);
    const yn = Number.isNaN(y.date);
    if (xn !== yn) return xn ? 1 : -1;
    if (!xn && x.date !== y.date) return y.date - x.date;
    return x.id < y.id ? -1 : x.id > y.id ? 1 : 0;
  });
}

export type DecisionFilter = "all" | "purge" | "maybe" | "keep" | "changed";
export interface Filters {
  decision: DecisionFilter;
  slug: string | "all";
  text: string;
}
export const NO_FILTERS: Filters = { decision: "all", slug: "all", text: "" };

function inBucket(r: TableRow, d: DecisionFilter): boolean {
  switch (d) {
    case "all":
      return true;
    case "purge":
      return r.label !== null && r.slug !== MAYBE;
    case "maybe":
      return r.slug === MAYBE;
    case "keep":
      return r.label === null;
    case "changed":
      return r.overridden;
  }
}

export function filterRows(rows: TableRow[], f: Filters): TableRow[] {
  const text = f.text.trim().toLowerCase();
  return rows.filter((r) => {
    if (!inBucket(r, f.decision)) return false;
    if (f.slug !== "all" && (r.label === null ? r.suggested : r.slug) !== f.slug) return false;
    return text === "" || r.from.toLowerCase().includes(text) || r.subject.toLowerCase().includes(text);
  });
}

export interface Selection {
  ids: Set<string>;
  anchor: number | null;
}
export const EMPTY_SELECTION: Selection = { ids: new Set(), anchor: null };

/** Click handling on row `index` of `rows` (the filtered list). */
export function select(sel: Selection, rows: TableRow[], index: number, mods: { shift: boolean; meta: boolean }): Selection {
  const row = rows[index];
  if (!row) return sel;
  if (mods.meta) {
    const ids = new Set(sel.ids);
    if (!ids.delete(row.id)) ids.add(row.id);
    return { ids, anchor: index };
  }
  if (mods.shift && sel.anchor !== null) {
    const ids = new Set(sel.ids);
    const [lo, hi] = sel.anchor < index ? [sel.anchor, index] : [index, sel.anchor];
    for (let i = lo; i <= hi; i++) {
      const r = rows[i];
      if (r) ids.add(r.id);
    }
    return { ids, anchor: sel.anchor };
  }
  return { ids: new Set([row.id]), anchor: index };
}

export function selectAll(rows: TableRow[]): Selection {
  return { ids: new Set(rows.map((r) => r.id)), anchor: null };
}

/** Overrides for "Use suggested label": one per selected row that has a suggestion. */
export function suggestedOverrides(rows: TableRow[], ids: Set<string>, at: number): { list: Override[]; skipped: number } {
  const list: Override[] = [];
  let skipped = 0;
  for (const r of rows) {
    if (!ids.has(r.id)) continue;
    if (r.suggested === null) skipped++;
    else list.push({ id: r.id, slug: r.suggested, at });
  }
  return { list, skipped };
}
