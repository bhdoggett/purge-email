import type { Settings } from "@core/decide.ts";
import type { Gmail } from "../gmail/client.ts";
import type { Store } from "../storage/db.ts";
import { appliedMessage } from "../screens/applyModel.ts";
import { applyPreview, countByLabel, isPending, type Preview, previewReconcile, type ReadStep } from "./reconcile.ts";

export interface ApplyState {
  phase: "idle" | "checking" | "writing" | "done" | "error";
  /** The label being read, while checking. */
  step?: ReadStep;
  /** Label operations written so far and in all, while writing. */
  done?: number;
  total?: number;
  /** The latest plan: pending changes when `isPending`, otherwise nothing to do. */
  preview?: Preview | null;
  /** Message count per label in Gmail, once a check finds nothing pending. */
  counts?: Map<string, number>;
  message?: string;
  error?: string;
}

export interface ApplyRunnerDeps {
  gmail: Gmail;
  store: Store;
  /** True while a scan is running; Apply and a scan never run together. */
  isScanning: () => boolean;
  /** True while sent mail is being counted for close people; Apply waits for it too. */
  isCounting?: () => boolean;
  now?: () => number;
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Owns the Apply job (checking Gmail, writing labels) so it keeps running when the screen is left. */
export class ApplyRunner {
  private state: ApplyState = { phase: "idle" };
  private listeners = new Set<() => void>();
  private running = false;

  constructor(private readonly deps: ApplyRunnerDeps) {}

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };

  getState = (): ApplyState => this.state;

  /** True while checking or writing. */
  busy(): boolean {
    return this.running;
  }

  private set(state: ApplyState): void {
    this.state = state;
    for (const fn of this.listeners) fn();
  }

  private previewDeps() {
    return { gmail: this.deps.gmail, store: this.deps.store, now: this.deps.now };
  }

  /** Reads Gmail and plans. When nothing is pending, saves the plan's store-only changes and counts the labels. */
  async check(settings: Settings): Promise<ApplyState> {
    if (this.running || this.deps.isScanning() || this.deps.isCounting?.()) return this.state;
    this.running = true;
    try {
      // The last applied message stays until the next apply.
      await this.checkInner(settings, this.state.phase === "done" ? this.state.message : undefined);
    } finally {
      this.running = false;
    }
    return this.state;
  }

  private async checkInner(settings: Settings, message: string | undefined): Promise<void> {
    const { gmail, store } = this.deps;
    this.set({ phase: "checking", message });
    try {
      const preview = await previewReconcile(this.previewDeps(), settings, { onStep: (step) => this.set({ phase: "checking", step, message }) });
      if (isPending(preview)) {
        this.set({ phase: "done", preview, message });
        return;
      }
      // Nothing to change in Gmail, but the plan may still stamp records (e.g. an override already in effect).
      if ((preview.plan.put.length > 0 || preview.plan.del.length > 0) && !this.deps.isScanning()) await applyPreview({ gmail, store }, preview);
      this.set({ phase: "done", preview, counts: await countByLabel(gmail, settings), message });
    } catch (e) {
      this.set({ phase: "error", error: `Could not check Gmail. ${errorText(e)}`, message });
    }
  }

  /** Plans again (so the records carry this moment), writes the plan if it still matches `shown`, then checks again. */
  async apply(settings: Settings, shown: Preview): Promise<ApplyState> {
    if (this.running) return this.state;
    if (this.deps.isScanning()) {
      this.set({ ...this.state, error: "A scan is running. Apply after it finishes." });
      return this.state;
    }
    if (this.deps.isCounting?.()) {
      this.set({ ...this.state, error: "Your sent mail is being counted. Apply after it finishes." });
      return this.state;
    }
    this.running = true;
    try {
      this.set({ phase: "checking" });
      let fresh: Preview;
      try {
        fresh = await previewReconcile(this.previewDeps(), settings, { onStep: (step) => this.set({ phase: "checking", step }) });
      } catch (e) {
        this.set({ phase: "error", error: `Could not apply the labels. ${errorText(e)}` });
        return this.state;
      }
      if (!isPending(fresh)) {
        await this.checkInner(settings, undefined);
        return this.state;
      }
      if (fresh.added !== shown.added || fresh.moved !== shown.moved || fresh.removed !== shown.removed) {
        this.set({ phase: "done", preview: fresh, message: "Gmail changed since this screen opened. Check the new numbers, then apply." });
        return this.state;
      }
      this.set({ phase: "writing", done: 0, total: 0, preview: fresh });
      try {
        await applyPreview(this.deps, fresh, { onProgress: (done, total) => this.set({ phase: "writing", done, total, preview: fresh }) });
      } catch (e) {
        this.set({ phase: "error", error: `Could not apply the labels. ${errorText(e)}` });
        return this.state;
      }
      await this.checkInner(settings, appliedMessage(fresh, fresh.oldPrefixes));
    } finally {
      this.running = false;
    }
    return this.state;
  }
}
