import type { Gmail } from "../gmail/client.ts";
import type { Store } from "../storage/db.ts";
import { countSent } from "./closeness.ts";

export interface CountState {
  phase: "idle" | "counting" | "done" | "error";
  /** Sent emails counted so far and in all, while counting. */
  done?: number;
  total?: number;
  error?: string;
}

export interface CloseCounterDeps {
  gmail: Gmail;
  store: Store;
  /** True while a scan or Apply runs; counting never runs alongside them. */
  isBlocked: () => boolean;
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Owns counting the user's Sent mail, so it keeps running when the Rules screen is left. */
export class CloseCounter {
  private state: CountState = { phase: "idle" };
  private listeners = new Set<() => void>();
  private running = false;

  constructor(private readonly deps: CloseCounterDeps) {}

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };

  getState = (): CountState => this.state;

  busy(): boolean {
    return this.running;
  }

  private set(state: CountState): void {
    this.state = state;
    for (const fn of this.listeners) fn();
  }

  /** Counts sent mail not counted before. Does nothing while a scan or Apply runs, or a count is already running. */
  async start(): Promise<void> {
    if (this.running || this.deps.isBlocked()) return;
    this.running = true;
    const { gmail, store } = this.deps;
    try {
      this.set({ phase: "counting", done: 0, total: 0 });
      const own = (await gmail.getProfile()).emailAddress.toLowerCase();
      await countSent(gmail, store, own, (done, total) => this.set({ phase: "counting", done, total }));
      this.set({ phase: "done" });
    } catch (e) {
      this.set({ phase: "error", error: `Couldn't count your sent mail. ${errorText(e)}` });
    } finally {
      this.running = false;
    }
  }
}
