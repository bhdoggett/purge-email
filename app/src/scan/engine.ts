import pLimit from "p-limit";
import { decide, DEFAULT_SETTINGS, type Settings } from "@core/decide.ts";
import { candidateQuery as buildCandidateQuery } from "@core/labels.ts";
import { type Answers, QUESTIONS_VERSION } from "@core/questions.ts";
import { APIError } from "@typesafe-ai/sdk";
import { AppError, errorAndCause, SignInExpiredError } from "../bridge/errors.ts";
import { GmailError, type Gmail, type Summary } from "../gmail/client.ts";
import type { Judge } from "../jev/client.ts";
import type { LabelRecord, ScanRecord, Store } from "../storage/db.ts";
import { syncLabels } from "./syncLabels.ts";
import { FEED_SIZE, INITIAL_PROGRESS, JEV_USD_PER_TOKEN, Pace, type Progress } from "./progress.ts";

export interface EngineDeps {
  gmail: Gmail;
  judge: Judge;
  store: Store;
  labelName: string;
  concurrency?: number;
  labelBatch?: number;
  now?: () => number;
  notify?: (title: string, body: string) => void;
}

const LABEL_BATCH = 500;
const MAX_CONSECUTIVE_FAILURES = 20;

/** Errors that would hit every email (bad credentials, disabled API), so the run must stop. */
export function isRunLevelError(err: unknown): boolean {
  return errorAndCause(err).some((e) => {
    if (e instanceof AppError) return ["NotConfigured", "HostNotAllowed", "Keychain"].includes(e.payload.kind);
    if (e instanceof APIError) return [401, 402, 403].includes(e.status);
    if (e instanceof GmailError) return e.status === 401 || (e.status === 403 && /accessNotConfigured|SERVICE_DISABLED/.test(e.reason));
    return false;
  });
}

function isSignInExpired(err: unknown): boolean {
  return errorAndCause(err).some((e) => e instanceof SignInExpiredError);
}

async function settleAll(tasks: Promise<unknown>[]): Promise<void> {
  const results = await Promise.allSettled(tasks);
  const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed) throw failed.reason;
}

export function candidateQuery(years: number): string {
  return buildCandidateQuery({ ...DEFAULT_SETTINGS, years });
}

export class ScanEngine {
  private progress: Progress = INITIAL_PROGRESS;
  private listeners = new Set<() => void>();
  private busy = false;
  private stopRequested = false;
  private readonly now: () => number;

  constructor(private readonly deps: EngineDeps) {
    this.now = deps.now ?? Date.now;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  getProgress(): Progress {
    return this.progress;
  }

  isBusy(): boolean {
    return this.busy;
  }

  pause(): void {
    this.stopRequested = true;
  }

  noteRateLimit(waitMs: number): void {
    this.set({ rateLimitUntil: this.now() + waitMs });
  }

  private set(patch: Partial<Progress>): void {
    this.progress = { ...this.progress, ...patch };
    for (const fn of this.listeners) fn();
  }

  private async loadOrCreateScan(settings: Settings, limit?: number): Promise<ScanRecord> {
    const existing = await this.deps.store.getScan();
    if (!limit && existing && !existing.finished && existing.years === settings.years) return existing;
    const { gmail } = this.deps;
    const candidates = await gmail.listIds(candidateQuery(settings.years), limit);
    const sent = await gmail.listIds(`in:sent older_than:${settings.years}y`);
    const scan: ScanRecord = {
      years: settings.years,
      candidateIds: candidates.map((c) => c.id),
      repliedThreadIds: [...new Set(sent.map((s) => s.threadId))],
      finished: false,
      startedAt: this.now(),
      settingsAtScan: existing?.settingsAtScan ?? null,
      msPerEmail: existing?.msPerEmail ?? null,
    };
    await this.deps.store.putScan(scan);
    return scan;
  }

  async start(settingsIn: Settings, opts: { limit?: number } = {}): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.stopRequested = false;
    // Snapshot so edits made while the scan runs don't affect it.
    const settings: Settings = structuredClone(settingsIn);
    const { gmail, judge, store, labelName } = this.deps;
    this.progress = { ...INITIAL_PROGRESS, stage: "finding", job: "scan" };
    this.set({});

    try {
      const scan = await this.loadOrCreateScan(settings, opts.limit);
      const replied = new Set(scan.repliedThreadIds);
      const labels = await store.allLabels();
      const labelId = await gmail.ensureLabel(labelName);
      const pace = new Pace();
      const pending: string[] = [];
      const labelBatch = this.deps.labelBatch ?? LABEL_BATCH;
      let signInExpired = false;
      let fatal: unknown = null;
      let consecutiveFailures = 0;

      const flush = async () => {
        if (pending.length === 0) return;
        const ids = pending.splice(0);
        try {
          await gmail.addLabel(labelId, ids);
          await store.putLabels(ids.map((id): LabelRecord => ({ id, label: labelName, labeledAt: this.now(), userRemoved: false, userChosen: false })));
        } catch (err) {
          pending.unshift(...ids);
          throw err;
        }
        this.set({ labeled: this.progress.labeled + ids.length });
      };

      this.set({ stage: "judging", total: scan.candidateIds.length });
      const run = pLimit(this.deps.concurrency ?? 4);

      await settleAll(
        scan.candidateIds.map((id) =>
          run(async () => {
            if (this.stopRequested || signInExpired || fatal !== null) return;
            let summary: Summary | undefined;
            let answers: Answers | null = null;
            let networked = false;
            try {
              summary = await store.getSummary(id);
              if (!summary) {
                summary = await gmail.getSummary(id);
                await store.putSummary(summary);
                networked = true;
              }
              const cached = await store.getAnswers(id);
              answers = cached && cached.version === QUESTIONS_VERSION ? cached : null;
              if (!answers && summary.attachmentNames.length === 0) {
                answers = await judge({ ...summary, ownerReplied: replied.has(summary.threadId) });
                await store.putAnswers(id, answers);
                networked = true;
                this.set({ costUsd: this.progress.costUsd + answers.inputTokens * JEV_USD_PER_TOKEN });
              }
              consecutiveFailures = 0;
            } catch (err) {
              if (isSignInExpired(err)) {
                signInExpired = true;
                return;
              }
              if (isRunLevelError(err)) {
                fatal = err;
                return;
              }
              console.error(`scan failed for ${id}`, err);
              if (++consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) fatal = err;
              const counts = { ...this.progress.counts, review: this.progress.counts.review + 1, failed: this.progress.counts.failed + 1 };
              this.set({ counts, done: this.progress.done + 1 });
              return;
            }

            const { decision, reason } = decide(
              { starred: summary.labels.includes("STARRED"), attachmentCount: summary.attachmentNames.length },
              answers,
              settings,
            );
            if (decision === "purge" && !labels.has(id)) {
              labels.set(id, { id, label: labelName, labeledAt: this.now(), userRemoved: false, userChosen: false });
              pending.push(id);
              if (pending.length >= labelBatch) {
                try {
                  await flush();
                } catch (err) {
                  if (isSignInExpired(err)) signInExpired = true;
                  else fatal = err;
                  return;
                }
              }
            }
            if (networked) pace.mark(this.now());
            const done = this.progress.done + 1;
            const msPer = pace.msPerItem();
            this.set({
              done,
              counts: { ...this.progress.counts, [decision]: this.progress.counts[decision] + 1 },
              recent: [{ id, from: summary.from, subject: summary.subject, decision, reason }, ...this.progress.recent].slice(0, FEED_SIZE),
              etaMs: msPer === null ? null : msPer * (scan.candidateIds.length - done),
              rateLimitUntil: this.progress.rateLimitUntil && this.progress.rateLimitUntil > this.now() ? this.progress.rateLimitUntil : null,
            });
          }),
        ),
      );

      if (!signInExpired && fatal === null) {
        this.set({ stage: "labeling" });
        await flush();
      }

      const msPerEmail = pace.msPerItem() ?? scan.msPerEmail;
      if (signInExpired) {
        await store.putScan({ ...scan, msPerEmail });
        this.set({ stage: "signInExpired", etaMs: null });
      } else if (fatal !== null) {
        await store.putScan({ ...scan, msPerEmail });
        this.set({ stage: "error", error: fatal, etaMs: null });
      } else if (this.stopRequested) {
        await store.putScan({ ...scan, msPerEmail });
        this.set({ stage: "paused", etaMs: null });
      } else {
        // Labels from an earlier scan may no longer match these settings or candidates:
        // reconcile so Gmail holds exactly the current purge decisions.
        await syncLabels({ gmail, store, labelName }, settings);
        await store.putScan({ ...scan, finished: true, settingsAtScan: settings, msPerEmail });
        this.set({ stage: "done", etaMs: null, rateLimitUntil: null });
        this.deps.notify?.("Scan finished", `${this.progress.counts.purge} emails labeled for review.`);
      }
    } catch (err) {
      this.set({ stage: isSignInExpired(err) ? "signInExpired" : "error", error: err, etaMs: null });
    } finally {
      this.busy = false;
    }
  }

  private async trashQuery(q: string, job: "trash" | "spam"): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.stopRequested = false;
    const { gmail } = this.deps;
    this.progress = { ...INITIAL_PROGRESS, stage: "finding", job };
    this.set({});
    try {
      const ids = (await gmail.listIds(q)).map((m) => m.id);
      this.set({ stage: "trashing", total: ids.length });
      const pace = new Pace();
      const run = pLimit(this.deps.concurrency ?? 4);
      let signInExpired = false;
      let fatal: unknown = null;
      let consecutiveFailures = 0;
      await settleAll(
        ids.map((id) =>
          run(async () => {
            if (this.stopRequested || signInExpired || fatal !== null) return;
            let failed = 0;
            try {
              await gmail.trash(id);
              consecutiveFailures = 0;
            } catch (err) {
              if (isSignInExpired(err)) {
                signInExpired = true;
                return;
              }
              if (isRunLevelError(err)) {
                fatal = err;
                return;
              }
              // Already gone (404) counts as done; anything else is a per-message failure.
              if (!(err instanceof GmailError && err.status === 404)) {
                console.error(`trash failed for ${id}`, err);
                failed = 1;
                if (++consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) fatal = err;
              } else {
                consecutiveFailures = 0;
              }
            }
            pace.mark(this.now());
            const done = this.progress.done + 1;
            const msPer = pace.msPerItem();
            this.set({
              done,
              counts: { ...this.progress.counts, failed: this.progress.counts.failed + failed },
              etaMs: msPer === null ? null : msPer * (ids.length - done),
            });
          }),
        ),
      );
      if (signInExpired) this.set({ stage: "signInExpired", etaMs: null });
      else if (fatal !== null) this.set({ stage: "error", error: fatal, etaMs: null });
      else {
        this.set({ stage: this.stopRequested ? "paused" : "done", etaMs: null });
        if (!this.stopRequested) {
          this.deps.notify?.(job === "spam" ? "Spam emptied" : "Moved to Trash", `${this.progress.done} emails processed.`);
        }
      }
    } catch (err) {
      this.set({ stage: isSignInExpired(err) ? "signInExpired" : "error", error: err, etaMs: null });
    } finally {
      this.busy = false;
    }
  }

  trashLabeled(): Promise<void> {
    return this.trashQuery(`label:${this.deps.labelName} -is:starred`, "trash");
  }

  emptySpam(): Promise<void> {
    return this.trashQuery("in:spam", "spam");
  }
}
