import type { Decision } from "@core/decide.ts";

export type Stage = "idle" | "finding" | "judging" | "paused" | "signInExpired" | "done" | "error";

export interface FeedItem {
  id: string;
  from: string;
  subject: string;
  decision: Decision;
  reason: string;
  /** App label the email got, or null when it got none. */
  label: string | null;
}

export interface Progress {
  stage: Stage;
  job: "scan" | null;
  done: number;
  total: number;
  /** `maybe` counts the review decisions that got the maybe label; they are also in `review`. */
  counts: { purge: number; keep: number; review: number; maybe: number; failed: number };
  recent: FeedItem[];
  costUsd: number;
  etaMs: number | null;
  error: unknown;
}

export const INITIAL_PROGRESS: Progress = {
  stage: "idle",
  job: null,
  done: 0,
  total: 0,
  counts: { purge: 0, keep: 0, review: 0, maybe: 0, failed: 0 },
  recent: [],
  costUsd: 0,
  etaMs: null,
  error: null,
};

/** Development builds scan only this many emails unless the Rules screen's dev field changes it. */
export const DEV_SCAN_LIMIT: number | undefined = import.meta.env.DEV ? 20 : undefined;

export const JEV_USD_PER_TOKEN = 0.042 / 1_000_000;
export const FEED_SIZE = 8;

/** Pace over the most recent completions, so ETA tracks current speed. */
export class Pace {
  private stamps: number[] = [];
  constructor(private readonly window = 200) {}

  mark(now: number): void {
    this.stamps.push(now);
    if (this.stamps.length > this.window) this.stamps.shift();
  }

  msPerItem(): number | null {
    if (this.stamps.length < 2) return null;
    return (this.stamps[this.stamps.length - 1]! - this.stamps[0]!) / (this.stamps.length - 1);
  }
}
