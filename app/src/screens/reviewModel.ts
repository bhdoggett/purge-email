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

export interface ScanState {
  rescan: boolean;
  changed: boolean;
  prefixChanged: boolean;
}

export function scanState(scan: Pick<ScanRecord, "settingsAtScan"> | null, settings: Settings): ScanState {
  const at = scan?.settingsAtScan;
  if (!at) return { rescan: false, changed: false, prefixChanged: false };
  const rescan = needsRescan(at, settings);
  return { rescan, changed: !rescan && !settingsEqual(at, settings), prefixChanged: at.labelPrefix !== settings.labelPrefix };
}

export function gmailLabelUrl(name: string): string {
  return `https://mail.google.com/mail/u/0/#label/${encodeURIComponent(name)}`;
}

export function updateMessage(r: { moved: number; added: number; removed: number }, oldPrefix: string | null): string {
  const base = `Moved ${r.moved}, added ${r.added}, removed ${r.removed}.`;
  return oldPrefix === null ? base : `${base} The old labels under "${oldPrefix}" are now empty. You can delete them in Gmail.`;
}
