import { useSyncExternalStore } from "react";
import type { ScanEngine } from "./scan/engine.ts";
import type { Progress } from "./scan/progress.ts";

export function useProgress(engine: ScanEngine): Progress {
  return useSyncExternalStore(
    (fn) => engine.subscribe(fn),
    () => engine.getProgress(),
  );
}
