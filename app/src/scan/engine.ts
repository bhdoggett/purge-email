import pLimit from "p-limit";
import { decide, type Settings } from "@core/decide.ts";
import { candidateQuery, labelFor, MAYBE, needsRescan } from "@core/labels.ts";
import { type Answers, QUESTIONS_VERSION } from "@core/questions.ts";
import { APIError } from "@typesafe-ai/sdk";
import { AppError, errorAndCause, SignInExpiredError } from "../bridge/errors.ts";
import { GmailError, type Gmail, type Summary } from "../gmail/client.ts";
import type { Judge } from "../jev/client.ts";
import type { LabelRecord, ScanRecord, Store } from "../storage/db.ts";
import { asLabelNameError, reconcile } from "./reconcile.ts";
import { FEED_SIZE, INITIAL_PROGRESS, JEV_USD_PER_TOKEN, Pace, type Progress } from "./progress.ts";

export interface EngineDeps {
  gmail: Gmail;
  judge: Judge;
  store: Store;
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
    // A scan saved without its settings can't be compared, so it gets fresh candidates.
    if (!limit && existing && !existing.finished && existing.settings && !needsRescan(existing.settings, settings)) return existing;
    const { gmail } = this.deps;
    const candidates = await gmail.listIds(candidateQuery(settings), limit);
    const sent = await gmail.listIds(`in:sent older_than:${settings.years}y`);
    const scan: ScanRecord = {
      years: settings.years,
      settings,
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
    const { gmail, judge, store } = this.deps;
    this.progress = { ...INITIAL_PROGRESS, stage: "finding", job: "scan" };
    this.set({});

    try {
      const scan = await this.loadOrCreateScan(settings, opts.limit);
      const replied = new Set(scan.repliedThreadIds);
      const labels = await store.allLabels();
      const pace = new Pace();
      /** Label name → records waiting to be added in Gmail and stored. */
      const pending = new Map<string, LabelRecord[]>();
      const labelIds = new Map<string, Promise<string>>();
      const labelBatch = this.deps.labelBatch ?? LABEL_BATCH;
      let signInExpired = false;
      let fatal: unknown = null;
      let consecutiveFailures = 0;

      const labelIdFor = (name: string): Promise<string> => {
        let id = labelIds.get(name);
        if (!id) {
          id = gmail.ensureLabel(name).catch((err: unknown) => {
            labelIds.delete(name);
            throw asLabelNameError(err);
          });
          labelIds.set(name, id);
        }
        return id;
      };

      const flush = async (name: string) => {
        const records = pending.get(name)?.splice(0) ?? [];
        if (records.length === 0) return;
        try {
          await gmail.addLabel(await labelIdFor(name), records.map((r) => r.id));
          await store.putLabels(records);
        } catch (err) {
          pending.get(name)!.unshift(...records);
          throw err;
        }
        this.set({ labeled: this.progress.labeled + records.length });
      };

      const flushAll = async () => {
        for (const name of pending.keys()) await flush(name);
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
              if (!answers && (summary.attachmentNames.length === 0 || !settings.keepAttachments)) {
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
            const label = labelFor(decision, answers, settings);
            if (label !== null && !labels.has(id)) {
              // One record, so the labeledAt in memory is the one stored at flush.
              const record: LabelRecord = { id, label, labeledAt: this.now(), userRemoved: false, userChosen: false };
              labels.set(id, record);
              const list = pending.get(label) ?? [];
              list.push(record);
              pending.set(label, list);
              if (list.length >= labelBatch) {
                try {
                  await flush(label);
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
              counts: {
                ...this.progress.counts,
                [decision]: this.progress.counts[decision] + 1,
                maybe: this.progress.counts.maybe + (label === `${settings.labelPrefix}/${MAYBE}` ? 1 : 0),
              },
              recent: [{ id, from: summary.from, subject: summary.subject, decision, reason, label }, ...this.progress.recent].slice(0, FEED_SIZE),
              etaMs: msPer === null ? null : msPer * (scan.candidateIds.length - done),
              rateLimitUntil: this.progress.rateLimitUntil && this.progress.rateLimitUntil > this.now() ? this.progress.rateLimitUntil : null,
            });
          }),
        ),
      );

      if (!signInExpired && fatal === null) {
        this.set({ stage: "labeling" });
        await flushAll();
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
        const { deferred } = await reconcile({ gmail, store, now: () => this.now() }, settings);
        await store.putScan({ ...scan, finished: true, settingsAtScan: settings, msPerEmail, deferred });
        this.set({ stage: "done", etaMs: null, rateLimitUntil: null });
        const { purge, maybe } = this.progress.counts;
        this.deps.notify?.("Scan finished", `${purge} to purge and ${maybe} to check, labeled under "${settings.labelPrefix}".`);
      }
    } catch (err) {
      this.set({ stage: isSignInExpired(err) ? "signInExpired" : "error", error: err, etaMs: null });
    } finally {
      this.busy = false;
    }
  }
}
