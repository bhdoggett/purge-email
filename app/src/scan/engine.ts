import pLimit from "p-limit";
import { decide, needsSignificance, type Settings } from "@core/decide.ts";
import { candidateQuery, labelFor, MAYBE, needsRescan, olderThan } from "@core/labels.ts";
import { type Answers, QUESTIONS_VERSION } from "@core/questions.ts";
import { APIError } from "@typesafe-ai/sdk";
import { AppError, errorAndCause, SignInExpiredError } from "../bridge/errors.ts";
import { GmailError, type Gmail, type Summary } from "../gmail/client.ts";
import type { Judge, SignificanceJudge } from "../jev/client.ts";
import { currentAccount, loadCloseContext } from "./closeness.ts";
import { flagsOf } from "./effective.ts";
import type { ScanRecord, Store } from "../storage/db.ts";
import { FEED_SIZE, INITIAL_PROGRESS, JEV_USD_PER_TOKEN, Pace, type Progress } from "./progress.ts";

export interface EngineDeps {
  gmail: Gmail;
  judge: Judge;
  /** Asks whether personal mail is meaningful; used only when trivial personal mail is on. */
  judgeSignificance: SignificanceJudge;
  store: Store;
  concurrency?: number;
  now?: () => number;
  notify?: (title: string, body: string) => void;
  /** True while something else (writing labels) must finish before a scan starts. */
  isBlocked?: () => boolean;
}

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
    const sent = await gmail.listIds(["in:sent", olderThan(settings.ageMonths)].filter(Boolean).join(" "));
    const scan: ScanRecord = {
      ageMonths: settings.ageMonths,
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
    if (this.busy || this.deps.isBlocked?.()) return;
    this.busy = true;
    this.stopRequested = false;
    // Snapshot so edits made while the scan runs don't affect it.
    const settings: Settings = structuredClone(settingsIn);
    const { gmail, judge, judgeSignificance, store } = this.deps;
    this.progress = { ...INITIAL_PROGRESS, stage: "finding", job: "scan" };
    this.set({});

    try {
      const scan = await this.loadOrCreateScan(settings, opts.limit);
      // Loaded once per run. Until Sent mail is fully counted for this account, nobody is known to be
      // close: personal mail stays unchecked (kept) and Jev isn't asked about it.
      const close = await loadCloseContext(store, await currentAccount(gmail));
      const replied = new Set(scan.repliedThreadIds);
      const pace = new Pace();
      let signInExpired = false;
      let fatal: unknown = null;
      let consecutiveFailures = 0;

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
                // With previews off, the body preview is neither kept on this computer nor sent to Jev.
                if (!settings.sendPreviews) summary = { ...summary, snippet: "" };
                await store.putSummary(summary);
                networked = true;
              }
              const cached = await store.getAnswers(id);
              answers = cached && cached.version === QUESTIONS_VERSION ? cached : null;
              // A summary saved while previews were on still has its preview: strip it before Jev sees it.
              const facts = { ...(settings.sendPreviews ? summary : { ...summary, snippet: "" }), ownerReplied: replied.has(summary.threadId) };
              if (!answers && (summary.attachmentNames.length === 0 || !settings.keepAttachments)) {
                answers = await judge(facts);
                await store.putAnswers(id, answers);
                networked = true;
                this.set({ costUsd: this.progress.costUsd + answers.inputTokens * JEV_USD_PER_TOKEN });
              }
              // Personal mail from someone not close gets one more question; everything else is never asked.
              if (answers && needsSignificance(flagsOf(summary, close), answers, settings, this.now())) {
                try {
                  const s = await judgeSignificance(facts);
                  answers = { ...answers, significance: s.meaningful };
                  await store.putAnswers(id, answers);
                  this.set({ costUsd: this.progress.costUsd + s.inputTokens * JEV_USD_PER_TOKEN });
                } catch (err) {
                  if (isSignInExpired(err) || isRunLevelError(err)) throw err;
                  // The email stays kept as unchecked; the next scan asks again.
                  console.error(`significance check failed for ${id}`, err);
                }
                networked = true;
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

            const { decision, reason, slug } = decide(flagsOf(summary, close), answers, settings, this.now());
            const label = labelFor(decision, answers, settings, slug);
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
            });
          }),
        ),
      );

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
        await store.putScan({ ...scan, finished: true, settingsAtScan: settings, msPerEmail });
        this.set({ stage: "done", etaMs: null });
        const { purge, maybe } = this.progress.counts;
        this.deps.notify?.("Scan finished", `${purge} to purge and ${maybe} to check. Review them, then apply labels.`);
      }
    } catch (err) {
      this.set({ stage: isSignInExpired(err) ? "signInExpired" : "error", error: err, etaMs: null });
    } finally {
      this.busy = false;
    }
  }
}
