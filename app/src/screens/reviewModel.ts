import type { Settings } from "@core/decide.ts";
import { KIND_SLUGS, MAYBE, needsRescan } from "@core/labels.ts";
import { PURGE_KINDS } from "@core/questions.ts";
import { settingsEqual } from "../scan/reconcile.ts";
import type { ScanRecord } from "../storage/db.ts";

export interface ReviewRow {
  name: string;
  count: number;
  isMaybe: boolean;
}

/** One row per label with mail in it: kinds in PURGE_KINDS order, then maybe. */
export function buildRows(counts: Map<string, number>, prefix: string): ReviewRow[] {
  const rows: ReviewRow[] = [];
  for (const k of PURGE_KINDS) {
    const name = `${prefix}/${KIND_SLUGS[k.id]}`;
    const count = counts.get(name) ?? 0;
    if (count > 0) rows.push({ name, count, isMaybe: false });
  }
  const maybe = `${prefix}/${MAYBE}`;
  const maybeCount = counts.get(maybe) ?? 0;
  if (maybeCount > 0) rows.push({ name: maybe, count: maybeCount, isMaybe: true });
  return rows;
}

export const totalOf = (rows: ReviewRow[]): number => rows.reduce((n, r) => n + r.count, 0);

/**
 * What the user must do before Gmail's labels can be trusted for deleting:
 * - `ok`: labels match the current rules.
 * - `update`: rules changed in a way Update labels can apply, or the last update left changes waiting on Gmail.
 * - `rescan`: the age or a protection checkbox changed; only a new scan finds the right emails.
 * - `scan`: the app doesn't know which rules made the labels (no finished scan, e.g. after Clear scan data).
 *   Update labels must not be offered here: with no candidates it would strip every label.
 */
export type LabelsAction = "ok" | "update" | "rescan" | "scan";

export interface ScanState {
  action: LabelsAction;
  prefixChanged: boolean;
  /** The last reconcile deferred changes because Gmail's lists hadn't caught up. */
  settling: boolean;
}

export function scanState(scan: Pick<ScanRecord, "settingsAtScan" | "deferred"> | null, settings: Settings): ScanState {
  const at = scan?.settingsAtScan;
  if (!at) return { action: "scan", prefixChanged: false, settling: false };
  const prefixChanged = at.labelPrefix !== settings.labelPrefix;
  const settling = (scan?.deferred ?? 0) > 0;
  if (needsRescan(at, settings)) return { action: "rescan", prefixChanged, settling };
  return { action: settling || !settingsEqual(at, settings) ? "update" : "ok", prefixChanged, settling };
}

/** The note shown above the rows when the labels can't be trusted yet, or null when they can. */
export function labelsWarning(state: ScanState): string | null {
  switch (state.action) {
    case "ok":
      return null;
    case "update":
      return "Your labels don't match your current rules yet. Click Update labels before deleting anything in Gmail.";
    case "rescan":
      return "Your labels don't match your current rules yet. Click Rescan before deleting anything in Gmail.";
    case "scan":
      return "The app doesn't know which rules made these labels, so they may not match your current rules. Scan first before deleting anything in Gmail.";
  }
}

export const SETTLING_NOTE = "Some labels are still settling in Gmail. Try Update labels again in a few minutes.";

/** Gmail's #label links use `+` for spaces and `%2F` for the nesting `/`. */
export function gmailLabelUrl(name: string): string {
  return `https://mail.google.com/mail/u/0/#label/${encodeURIComponent(name).replace(/%20/g, "+")}`;
}

export function updateMessage(r: { moved: number; added: number; removed: number }, oldPrefix: string | null): string {
  const base = `Moved ${r.moved}, added ${r.added}, removed ${r.removed}.`;
  return oldPrefix === null ? base : `${base} The old labels under "${oldPrefix}" are now empty. You can delete them in Gmail.`;
}
