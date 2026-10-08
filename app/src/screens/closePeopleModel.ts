import { type CloseRule, closeSet, isAutoClose } from "../scan/closeness.ts";
import type { SenderStats } from "../storage/db.ts";

/** Rows shown at a time; "Show more" adds this many. */
export const PAGE_SIZE = 100;

export interface CloseRow {
  address: string;
  name: string;
  sent: number;
  /** Distinct years the user wrote to them. */
  years: number;
  close: boolean;
  /** Ticked by the automatic rule, not by the user. */
  auto: boolean;
}

/** People from the counts matching `query` (name or address), most emailed first. */
export function closeRows(stats: SenderStats | null, choices: Record<string, boolean>, query: string, rule: CloseRule): CloseRow[] {
  const q = query.trim().toLowerCase();
  return (stats?.people ?? [])
    .filter((p) => q === "" || p.address.includes(q) || p.name.toLowerCase().includes(q))
    .map((p) => {
      const chosen = choices[p.address];
      const auto = chosen === undefined && isAutoClose(p, rule);
      return { address: p.address, name: p.name, sent: p.sent, years: p.years.length, close: chosen ?? auto, auto };
    })
    .sort((a, b) => b.sent - a.sent || (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
}

export const closeCount = (stats: SenderStats | null, choices: Record<string, boolean>, rule: CloseRule): number => closeSet(stats, choices, rule).size;

/** "214 emails over 12 years"; the years are left out when no date could be read. */
export function emailsText(sent: number, years: number): string {
  const emails = `${sent.toLocaleString("en-US")} email${sent === 1 ? "" : "s"}`;
  return years > 0 ? `${emails} over ${years} year${years === 1 ? "" : "s"}` : emails;
}

/**
 * Where counting stands for `account` (the signed-in address): none (never counted, or counted for
 * another account), partial (stopped before the end), or done.
 */
export function countStatus(stats: SenderStats | null, account: string | null): "none" | "partial" | "done" {
  if (!stats || account === null || stats.ownAddress !== account.toLowerCase()) return "none";
  return stats.complete ? "done" : "partial";
}
