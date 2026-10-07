import { createStore, useStore } from "./externalStore.ts";

export interface ApplyProgress {
  done: number;
  total: number;
}

/** Set while labels are being written to Gmail, null otherwise. Lets the header show it on any screen. */
export const applyProgress = createStore<ApplyProgress | null>(null);

export const useApplyProgress = (): ApplyProgress | null => useStore(applyProgress);

export function applyPercent(p: ApplyProgress): number {
  return p.total ? Math.round((p.done / p.total) * 100) : 0;
}
