import { cutoff, type Decision, type Settings } from "@core/decide.ts";
import { ageText, kindOfSlug, MAYBE, PERSONAL_SLUG, slugOfLabel, suggestedSlug } from "@core/labels.ts";
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
  /** File names of the email's attachments; empty when it has none. */
  attachmentNames: string[];
}

const pct = (p: number) => Math.round(p * 100);

function kindText(kind: PurgeKind, answers: Answers): string {
  const label = PURGE_KINDS.find((k) => k.id === kind)!.label.toLowerCase();
  return `${label} ${pct(answers.kind[kind])}%`;
}

function keptReason(raw: string, suggested: string | null, answers: Answers | null, settings: Settings): string {
  if (raw === "starred") return "Kept: starred";
  if (raw === "attachment") return "Kept: has attachments";
  if (raw === "too new") return `Kept: newer than ${ageText(settings.ageMonths)}`;
  if (raw === "no date") return "Kept: date unknown";
  if (raw === "not judged" || !answers) return "Not judged";
  if (raw === "close person") return "Kept: close person";
  if (raw === "personal unchecked") return "Kept: personal, not checked yet";
  if (raw.startsWith("meaningful ") && answers.significance !== undefined) return `Kept: meaningful ${pct(answers.significance)}%`;
  const protect = PROTECTS.find((p) => p.id === (raw.split(" ")[0] as ProtectId));
  if (protect) return `Kept: ${protect.label.toLowerCase()} ${pct(answers.protect[protect.id])}%`;
  const kind = suggested === null ? null : kindOfSlug(suggested);
  if (kind === null || !settings.purgeKinds.includes(kind)) return "Kept: kind not checked";
  const score = settings.purgeKinds.reduce((sum, k) => sum + answers.kind[k], 0);
  return `Kept: purge score ${pct(score)}%`;
}

function labelReason(slug: string | null, answers: Answers | null, settings: Settings): string {
  if (!answers || slug === null) return "Not judged";
  if (slug === PERSONAL_SLUG) return answers.significance === undefined ? "Trivial personal mail" : `personal, trivial ${pct(1 - answers.significance)}%`;
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

/** `close` holds the user's close people (lowercase addresses). */
export function buildTableRows(ids: string[], summaries: Map<string, Summary>, answers: Map<string, Answers>, overrides: Map<string, Override>, settings: Settings, now: number, close: ReadonlySet<string>): TableRow[] {
  const rows: TableRow[] = [];
  for (const id of ids) {
    const summary = summaries.get(id);
    if (!summary) continue;
    const a = answers.get(id) ?? null;
    const override = overrides.get(id);
    const eff = effectiveLabel(summary, a, override, settings, now, close);
    const slug = eff.label === null ? null : slugOfLabel(eff.label, settings.labelPrefix);
    const suggested = suggestedSlug(a);
    const reason = override ? "Changed by you" : eff.label === null ? keptReason(eff.reason, suggested, a, settings) : labelReason(slug, a, settings);
    rows.push({ id, from: summary.from, subject: summary.subject, date: Date.parse(summary.date), label: eff.label, slug, suggested, decision: eff.decision, overridden: override !== undefined, reason, attachmentNames: summary.attachmentNames });
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
export type AttachmentFilter = "all" | "with" | "without";
export interface Filters {
  decision: DecisionFilter;
  slug: string | "all";
  text: string;
  /** Show only emails at least this many months old; 0 is off. */
  olderThanMonths: number;
  attachments: AttachmentFilter;
}
export const NO_FILTERS: Filters = { decision: "all", slug: "all", text: "", olderThanMonths: 0, attachments: "all" };

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

export function filterRows(rows: TableRow[], f: Filters, now: number): TableRow[] {
  const text = f.text.trim().toLowerCase();
  const before = f.olderThanMonths > 0 ? cutoff(now, f.olderThanMonths) : null;
  return rows.filter((r) => {
    if (!inBucket(r, f.decision)) return false;
    // NaN dates fail this comparison, so an email with no readable date is left out while the filter is on.
    if (before !== null && !(r.date <= before)) return false;
    if (f.slug !== "all" && (r.label === null ? r.suggested : r.slug) !== f.slug) return false;
    if (f.attachments !== "all" && (r.attachmentNames.length > 0) !== (f.attachments === "with")) return false;
    return (
      text === "" ||
      r.from.toLowerCase().includes(text) ||
      r.subject.toLowerCase().includes(text) ||
      r.attachmentNames.some((n) => n.toLowerCase().includes(text))
    );
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

/** Keeps only selected ids still in `rows`, so an action never touches a row the person can't see. */
export function pruneSelection(sel: Selection, rows: TableRow[]): Selection {
  const shown = new Set(rows.map((r) => r.id));
  const ids = new Set([...sel.ids].filter((id) => shown.has(id)));
  // A dropped row shifts indexes, so the Shift-click anchor can no longer be trusted.
  return ids.size === sel.ids.size ? sel : { ids, anchor: null };
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
