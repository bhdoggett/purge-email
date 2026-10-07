import { useSyncExternalStore } from "react";
import type { ApplyRunner, ApplyState } from "./scan/applyRunner.ts";

export function useApplier(applier: ApplyRunner): ApplyState {
  return useSyncExternalStore(applier.subscribe, applier.getState);
}

/** True while Apply is checking Gmail or writing labels. */
export const isApplying = (s: ApplyState): boolean => s.phase === "checking" || s.phase === "writing";

export const APPLYING_HINT = "Labels are being applied. Wait for it to finish.";
