import { useEffect, useRef, useState } from "react";
import type { Screen, WizardTarget } from "../App.tsx";
import { Button } from "../components/Button.tsx";
import { Feed } from "../components/Feed.tsx";
import { RateLimitNote } from "../components/RateLimitNote.tsx";
import { ProgressBar } from "../components/ProgressBar.tsx";
import { formatDuration, formatUsd } from "../format.ts";
import { scanCounts } from "../scan/reconcile.ts";
import type { ScanRecord } from "../storage/db.ts";
import type { Services } from "../services.ts";
import { APPLYING_HINT, isApplying, useApplier } from "../useApplier.ts";
import { useProgress } from "../useProgress.ts";
import { errorToStep } from "../wizard/errorToStep.ts";
import styles from "./Scan.module.css";

const STAGE_COPY: Record<string, string> = {
  finding: "Finding emails to purge…",
  paused: "Paused",
  signInExpired: "Paused: Google sign-in expired",
  done: "Finished",
  error: "Stopped by an error",
};

export function Scan({ services, go, openWizard }: { services: Services; go: (s: Screen) => void; openWizard: (t: WizardTarget) => void }) {
  const p = useProgress(services.engine);
  const applying = isApplying(useApplier(services.applier));
  const running = services.engine.isBusy();
  const stage = p.stage === "judging" ? `Reading and judging ${p.done.toLocaleString()} of ${p.total.toLocaleString()}` : (STAGE_COPY[p.stage] ?? "");
  const mapped = p.error ? errorToStep(p.error) : null;

  // A scan that finishes while this screen is open goes straight to Review. Opening Scan after a finished scan does not.
  const lastStage = useRef(p.stage);
  useEffect(() => {
    if (p.stage === "done" && lastStage.current !== "done") go("review");
    lastStage.current = p.stage;
  }, [p.stage]);

  // With nothing running this session, show the last saved scan instead of an empty screen.
  const [last, setLast] = useState<{ scan: ScanRecord; counts: { purge: number; keep: number; review: number } | null } | null>(null);
  useEffect(() => {
    if (p.stage !== "idle") return;
    void (async () => {
      const scan = await services.store.getScan();
      if (!scan) return setLast(null);
      // Counts follow the current rules, like Review and Apply; rules the scan doesn't cover get none.
      const counts = await scanCounts(services.store, scan, await services.store.getSettings());
      setLast({ scan, counts });
    })();
  }, [p.stage, services.store]);

  if (p.stage === "idle") {
    return (
      <section className={styles.scan}>
        {last?.scan.finished ? (
          <>
            <h1 className={styles.heading}>Last scan finished</h1>
            <p className={styles.eta}>
              Started {new Date(last.scan.startedAt).toLocaleString()} · {last.scan.candidateIds.length.toLocaleString()} emails checked
            </p>
            {!last.counts && <p className={styles.eta}>Your rules changed since this scan. Rescan to see counts.</p>}
            {last.counts && (
              <dl className={styles.counts}>
                <div><dt>To purge</dt><dd className={styles.purge}>{last.counts.purge.toLocaleString()}</dd></div>
                <div><dt>To check or unjudged</dt><dd className={styles.review}>{last.counts.review.toLocaleString()}</dd></div>
                <div><dt>Kept</dt><dd className={styles.keep}>{last.counts.keep.toLocaleString()}</dd></div>
              </dl>
            )}
            <div className={styles.actions}>
              <Button onClick={() => go("review")}>Review results</Button>
              <Button variant="secondary" onClick={() => go("rules")}>New scan</Button>
            </div>
          </>
        ) : last ? (
          <>
            <h1 className={styles.heading}>A scan was left unfinished</h1>
            <p className={styles.eta}>Resume it from Rules. Emails already checked won't be checked again.</p>
            <div className={styles.actions}>
              <Button onClick={() => go("rules")}>Go to Rules</Button>
            </div>
          </>
        ) : (
          <>
            <h1 className={styles.heading}>No scan yet</h1>
            <p className={styles.eta}>Set your rules, then click Start scan.</p>
            <div className={styles.actions}>
              <Button onClick={() => go("rules")}>Go to Rules</Button>
            </div>
          </>
        )}
      </section>
    );
  }

  async function resume() {
    const settings = await services.store.getSettings();
    void services.engine.start(settings);
  }

  return (
    <section className={styles.scan}>
      <h1 className={styles.heading} aria-live="polite">{stage}</h1>
      <ProgressBar value={p.total ? p.done / p.total : 0} label="Scan progress" />
      {p.etaMs !== null && running && <p className={styles.eta}>About {formatDuration(p.etaMs)} left</p>}
      <RateLimitNote className={styles.eta} />

      {p.job === "scan" && (
        <dl className={styles.counts}>
          <div><dt>To purge</dt><dd className={styles.purge}>{p.counts.purge.toLocaleString()}</dd></div>
          <div><dt>To check (maybe)</dt><dd className={styles.review}>{p.counts.maybe.toLocaleString()}</dd></div>
          <div><dt>Kept</dt><dd className={styles.keep}>{p.counts.keep.toLocaleString()}</dd></div>
          <div><dt>Failed</dt><dd>{p.counts.failed.toLocaleString()}</dd></div>
          <div><dt>Jev cost so far</dt><dd>{formatUsd(p.costUsd)}</dd></div>
        </dl>
      )}

      {p.job === "scan" && <Feed items={p.recent} />}

      {p.stage === "error" && (
        <p className={styles.error} role="alert">
          {mapped ? mapped.message : String(p.error instanceof Error ? p.error.message : p.error)}
        </p>
      )}

      <div className={styles.actions}>
        {running && <Button variant="secondary" onClick={() => services.engine.pause()}>Pause</Button>}
        {!running && p.job === "scan" && p.stage === "paused" && <Button disabled={applying} title={applying ? APPLYING_HINT : undefined} onClick={() => void resume()}>Resume</Button>}
        {!running && p.stage === "signInExpired" && (
          <Button
            onClick={() =>
              openWizard({
                startAt: 6,
                message: p.job === "scan" ? "Your Google sign-in expired. Sign in again and the scan picks up where it stopped." : "Your Google sign-in expired. Sign in again to continue.",
                resumeScan: p.job === "scan",
              })
            }
          >
            Sign in again
          </Button>
        )}
        {!running && p.stage === "done" && <Button onClick={() => go("review")}>Review results</Button>}
        {!running && mapped && <Button variant="secondary" onClick={() => openWizard({ startAt: mapped.step, message: mapped.message })}>Fix setup</Button>}
        {!running && <Button variant="secondary" onClick={() => go("rules")}>Back to rules</Button>}
      </div>
    </section>
  );
}
