import { useSyncExternalStore } from "react";
import type { CloseCounter, CountState } from "./scan/closeCounter.ts";

export function useCounter(counter: CloseCounter): CountState {
  return useSyncExternalStore(counter.subscribe, counter.getState);
}

/** True while sent mail is being counted for close people. */
export const isCounting = (s: CountState): boolean => s.phase === "counting";

export const COUNTING_HINT = "Your sent mail is being counted. Wait for it to finish.";
