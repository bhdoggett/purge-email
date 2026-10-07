import type { Decision } from "@core/decide.ts";

export type Stage = "idle" | "finding" | "judging" | "labeling" | "trashing" | "paused" | "signInExpired" | "done" | "error";

export interface FeedItem {
  id: string;
  from: string;
  subject: string;
  decision: Decision;
  reason: string;
}

export interface Progress {
  stage: Stage;
  job: "scan" | "trash" | "spam" | null;
  done: number;
  total: number;
  counts: { purge: number; keep: number; review: number; failed: number };
  labeled: number;
  recent: FeedItem[];
  rateLimitUntil: number | null;
  costUsd: number;
  etaMs: number | null;
  error: unknown;
}

export const INITIAL_PROGRESS: Progress = {
  stage: "idle",
  job: null,
  done: 0,
  total: 0,
  counts: { purge: 0, keep: 0, review: 0, failed: 0 },
  labeled: 0,
  recent: [],
  rateLimitUntil: null,
  costUsd: 0,
  etaMs: null,
  error: null,
};

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
