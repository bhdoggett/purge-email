import { KIND_SLUGS, MAYBE, PERSONAL_SLUG } from "@core/labels.ts";
import { PURGE_KINDS } from "@core/questions.ts";
import type { LabelBreakdown } from "../scan/reconcile.ts";

export interface ApplyRow {
  name: string;
  count: number;
  isMaybe: boolean;
}

/** One row per label with mail in it: kinds in PURGE_KINDS order, trivial personal mail, then maybe. */
export function buildRows(totals: Map<string, number>, prefix: string): ApplyRow[] {
  const rows: ApplyRow[] = [];
  for (const k of PURGE_KINDS) {
    const name = `${prefix}/${KIND_SLUGS[k.id]}`;
    const count = totals.get(name) ?? 0;
    if (count > 0) rows.push({ name, count, isMaybe: false });
  }
  const personal = `${prefix}/${PERSONAL_SLUG}`;
  const personalCount = totals.get(personal) ?? 0;
  if (personalCount > 0) rows.push({ name: personal, count: personalCount, isMaybe: false });
  const maybe = `${prefix}/${MAYBE}`;
  const maybeCount = totals.get(maybe) ?? 0;
  if (maybeCount > 0) rows.push({ name: maybe, count: maybeCount, isMaybe: true });
  return rows;
}

export const totalOf = (rows: ApplyRow[]): number => rows.reduce((n, r) => n + r.count, 0);

export const SETTLING_NOTE = "Some labels are still settling in Gmail. Click Check again in a few minutes.";

/** Gmail's #label links use `+` for spaces and `%2F` for the nesting `/`. */
export function gmailLabelUrl(name: string): string {
  return `https://mail.google.com/mail/u/0/#label/${encodeURIComponent(name).replace(/%20/g, "+")}`;
}

export interface PreviewCounts {
  added: number;
  moved: number;
  removed: number;
}

export function previewSummary(p: PreviewCounts): string {
  const parts = [
    p.added > 0 ? `Add ${p.added.toLocaleString("en-US")} labels` : null,
    p.moved > 0 ? `Move ${p.moved.toLocaleString("en-US")}` : null,
    p.removed > 0 ? `Remove ${p.removed.toLocaleString("en-US")}` : null,
  ].filter((x): x is string => x !== null);
  return parts.length > 0 ? parts.join(" · ") : "Gmail already matches your review.";
}

/**
 * How the emails Review labels split up in Gmail, e.g. "515 emails get a label from your review: 88 to add,
 * 300 already labeled, 120 in Trash or Spam." Null when every one of them is simply to add or already labeled
 * this run, since the counts above already say that.
 */
export function breakdownText(b: LabelBreakdown): string | null {
  if (b.inTrash + b.changedInGmail + b.waiting === 0 && (b.toAdd === 0 || b.already === 0)) return null;
  const n = (x: number) => x.toLocaleString("en-US");
  const parts = [
    b.toAdd > 0 ? `${n(b.toAdd)} to add` : null,
    b.already > 0 ? `${n(b.already)} already labeled` : null,
    b.inTrash > 0 ? `${n(b.inTrash)} in Trash or Spam` : null,
    b.changedInGmail > 0 ? `${n(b.changedInGmail)} you unlabeled or relabeled in Gmail` : null,
    b.waiting > 0 ? `${n(b.waiting)} waiting on Gmail` : null,
  ].filter((x): x is string => x !== null);
  const head = `${n(b.wanted)} ${b.wanted === 1 ? "email gets" : "emails get"} a label from your review`;
  return `${head}: ${parts.join(", ")}.`;
}

/** Why some emails from Review aren't labeled, shown only for the reasons that apply. */
export function skippedNotes(b: LabelBreakdown): string[] {
  return [
    b.inTrash > 0 ? "The app never labels mail in Trash or Spam." : null,
    b.changedInGmail > 0 ? "Mail whose label you removed or changed in Gmail is left the way you set it. Choose a label for it in Review to override." : null,
  ].filter((x): x is string => x !== null);
}

export function appliedMessage(p: PreviewCounts, oldPrefixes: string[]): string {
  const base = `Added ${p.added}, moved ${p.moved}, removed ${p.removed}.`;
  return oldPrefixes.length === 0 ? base : `${base} The old labels under "${oldPrefixes.join('", "')}" are now empty. You can delete them in Gmail.`;
}

/** "Checked 3:05 PM" (or "Checked Oct 7, 3:05 PM" on another day): when Apply last read Gmail, in local time. */
export function checkedText(at: number, now: number = Date.now()): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === new Date(now).toDateString()) return `Checked ${time}`;
  return `Checked ${d.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}
