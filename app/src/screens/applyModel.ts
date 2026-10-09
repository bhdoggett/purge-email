import { KIND_SLUGS, MAYBE, PERSONAL_SLUG } from "@core/labels.ts";
import { PURGE_KINDS } from "@core/questions.ts";

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
