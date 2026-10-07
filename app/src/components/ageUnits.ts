export type AgeUnit = "months" | "years";

export const MAX_YEARS = 30;
export const MAX_MONTHS = MAX_YEARS * 12;

/** Years when the months divide evenly by 12, otherwise months. */
export function initialUnit(months: number): AgeUnit {
  return months % 12 === 0 ? "years" : "months";
}

export function shownNumber(months: number, unit: AgeUnit): number {
  return unit === "years" ? months / 12 : months;
}

/** Whole months from what was typed in `unit`, between 0 and MAX_MONTHS. */
export function ageFromInput(text: string, unit: AgeUnit): number {
  const n = Math.max(0, Math.round(Number(text) || 0));
  return Math.min(MAX_MONTHS, unit === "years" ? n * 12 : n);
}

/**
 * Months to store after switching the unit. Unchanged when they fit the new unit; otherwise the
 * nearest whole year, never below one year, so a set age doesn't become "any age".
 */
export function switchUnit(months: number, unit: AgeUnit): number {
  if (unit === "months" || months % 12 === 0) return months;
  return Math.max(1, Math.round(months / 12)) * 12;
}
