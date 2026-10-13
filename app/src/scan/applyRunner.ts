import type { Settings } from "@core/decide.ts";
import type { Gmail } from "../gmail/client.ts";
import type { Store } from "../storage/db.ts";
import { appliedMessage } from "../screens/applyModel.ts";
import { currentAccount } from "./closeness.ts";
import { applyPreview, isPending, type Preview, previewReconcile, type ReadStep, USER_CHANGE_GRACE_MS } from "./reconcile.ts";

/** A shown plan younger than this, with the store unchanged since, is written without reading Gmail again. */
export const FRESH_MS = 5 * 60_000;

export interface ApplyState {
  phase: "idle" | "checking" | "writing" | "done" | "error";
  /** The label being read, while checking. */
  step?: ReadStep;
  /** Label operations written so far and in all, while writing. */
  done?: number;
  total?: number;
  /**
   * The latest plan: pending changes when `isPending`, otherwise nothing to do. Its `totals` are the
   * emails per label once applied; after Apply it is the applied plan with nothing left pending.
   */
  preview?: Preview | null;
  /** The store revision this result matches; `visit` keeps the result while the store is still at it. Missing when unknown. */
  revision?: number;
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

/** `p` with the records it planned at its check stamped `at` instead, so they carry the moment of writing. */
function restamp(p: Preview, at: number): Preview {
  const put = p.plan.put.map((r) => (r.labeledAt === p.checkedAt ? { ...r, labeledAt: at } : r));
  return { ...p, plan: { ...p.plan, put } };
}

/** `p` once written: the same totals, with nothing left to add, move or remove. */
function applied(p: Preview): Preview {
  const b = p.plan.breakdown;
  const breakdown = { ...b, toAdd: 0, already: b.already + b.toAdd };
  return { ...p, plan: { ...p.plan, add: new Map(), remove: new Map(), put: [], del: [], breakdown }, added: 0, removed: 0, moved: 0, oldPrefixes: [] };
}

/** Owns the Apply job (checking Gmail, writing labels) so it keeps running when the screen is left. */
export class ApplyRunner {
  private state: ApplyState = { phase: "idle" };
  private listeners = new Set<() => void>();
  private running = false;
  /** What the last Apply wrote, shown until the next one. */
  private lastApplied: string | undefined;

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

  /** Reads Gmail and plans. When nothing is pending, saves the plan's store-only changes. */
  async check(settings: Settings): Promise<ApplyState> {
    if (this.running || this.deps.isScanning() || this.deps.isCounting?.()) return this.state;
    this.running = true;
    try {
      // The last applied message stays until the next apply; a refusal does not.
      await this.checkInner(settings, this.lastApplied);
    } finally {
      this.running = false;
    }
    return this.state;
  }

  /**
   * Keeps the last result while nothing that changes the plan was saved since, the same account is signed
   * in (one profile read), and no settling labels have had their grace window pass; otherwise checks Gmail.
   */
  async visit(settings: Settings): Promise<ApplyState> {
    if (this.running) return this.state;
    const s = this.state;
    const now = (this.deps.now ?? Date.now)();
    const settled = !s.preview || s.preview.plan.deferred === 0 || now - s.preview.checkedAt < USER_CHANGE_GRACE_MS;
    if (s.phase === "done" && s.preview && settled && s.revision !== undefined && s.revision === this.deps.store.revision()) {
      const account = await currentAccount(this.deps.gmail);
      if (this.state !== s) return this.state; // something else ran meanwhile
      // An unknown account (either read failed) never counts as the same one.
      if (account !== null && account === s.preview.account) {
        // An old refusal (a scan was running) no longer applies.
        if (s.error !== undefined) this.set({ ...s, error: undefined });
        return this.state;
      }
    }
    return this.check(settings);
  }

  /** Forgets the last result (sign-out, removed keys), so the next visit checks Gmail. Leaves a running job alone. */
  reset(): void {
    if (this.running) return;
    this.lastApplied = undefined;
    this.set({ phase: "idle" });
  }

  private async checkInner(settings: Settings, message: string | undefined): Promise<void> {
    this.set({ phase: "checking", message });
    try {
      const preview = await previewReconcile(this.previewDeps(), settings, { onStep: (step) => this.set({ phase: "checking", step, message }) });
      await this.show(preview, message);
    } catch (e) {
      this.set({ phase: "error", error: `Could not check Gmail. ${errorText(e)}`, message });
    }
  }

  /** Shows a fresh plan. With nothing pending in Gmail, first saves the plan's store-only changes. */
  private async show(preview: Preview, message: string | undefined): Promise<void> {
    if (isPending(preview)) {
      this.set({ phase: "done", preview, revision: preview.revision, message });
      return;
    }
    let revision: number | undefined = preview.revision;
    // Nothing to change in Gmail, but the plan may still stamp records (e.g. an override already in effect).
    if (preview.plan.put.length > 0 || preview.plan.del.length > 0) {
      // Unsaved records (a scan started) leave the result unmatched, so the next visit checks again.
      revision = this.deps.isScanning() ? undefined : ((await applyPreview(this.deps, preview)) ?? undefined);
    }
    this.set({ phase: "done", preview, revision, message });
  }

  /** Writes a pending plan, then shows it as applied without reading Gmail again. */
  private async write(preview: Preview): Promise<void> {
    this.set({ phase: "writing", done: 0, total: 0, preview });
    let revision: number | null;
    try {
      revision = await applyPreview(this.deps, preview, { onProgress: (done, total) => this.set({ phase: "writing", done, total, preview }) });
    } catch (e) {
      this.set({ phase: "error", error: `Could not apply the labels. ${errorText(e)}` });
      return;
    }
    this.lastApplied = appliedMessage(preview, preview.oldPrefixes);
    this.set({ phase: "done", preview: applied(preview), revision: revision ?? undefined, message: this.lastApplied });
  }

  /**
   * Writes `shown`. When it was planned under 5 minutes ago and nothing was saved since, it is written as
   * shown, its records stamped with this moment. Otherwise plans again and writes only if the numbers
   * still match `shown`.
   */
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
      const now = (this.deps.now ?? Date.now)();
      if (
        isPending(shown) &&
        now - shown.checkedAt < FRESH_MS &&
        shown.revision === this.deps.store.revision() &&
        shown.account !== null &&
        // An unknown account (the read failed) never counts as the same one.
        (await currentAccount(this.deps.gmail)) === shown.account &&
        // Again: something may have been saved while the account was read.
        shown.revision === this.deps.store.revision()
      ) {
        await this.write(restamp(shown, now));
        return this.state;
      }
      this.set({ phase: "checking" });
      let fresh: Preview;
      try {
        fresh = await previewReconcile(this.previewDeps(), settings, { onStep: (step) => this.set({ phase: "checking", step }) });
      } catch (e) {
        this.set({ phase: "error", error: `Could not apply the labels. ${errorText(e)}` });
        return this.state;
      }
      if (!isPending(fresh)) {
        await this.show(fresh, undefined).catch((e: unknown) => this.set({ phase: "error", error: `Could not check Gmail. ${errorText(e)}` }));
        return this.state;
      }
      if (fresh.added !== shown.added || fresh.moved !== shown.moved || fresh.removed !== shown.removed) {
        this.set({ phase: "done", preview: fresh, message: "Gmail changed since this screen opened. Check the new numbers, then apply." });
        return this.state;
      }
      await this.write(fresh);
    } finally {
      this.running = false;
    }
    return this.state;
  }
}
