import { createStore, useStore } from "./externalStore.ts";

/** When Gmail's shared rate-limit pause ends (ms since epoch), or null once requests get through again. */
export const rateLimit = createStore<number | null>(null);

export const useRateLimit = (): number | null => useStore(rateLimit);
