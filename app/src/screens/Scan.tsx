import { useEffect, useState } from "react";
import type { Screen, WizardTarget } from "../App.tsx";
import { Button } from "../components/Button.tsx";
import { Feed } from "../components/Feed.tsx";
import { ProgressBar } from "../components/ProgressBar.tsx";
import { formatDuration, formatUsd } from "../format.ts";
import type { Services } from "../services.ts";
import { useProgress } from "../useProgress.ts";
import { errorToStep } from "../wizard/errorToStep.ts";
import styles from "./Scan.module.css";

function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

const STAGE_COPY: Record<string, string> = {
  finding: "Finding old emails…",
  labeling: "Adding labels in Gmail…",
  trashing: "Moving emails to Trash",
  paused: "Paused",
  signInExpired: "Paused: Google sign-in expired",
  done: "Finished",
  error: "Stopped by an error",
};

export function Scan({ services, go, openWizard }: { services: Services; go: (s: Screen) => void; openWizard: (t: WizardTarget) => void }) {
  const p = useProgress(services.engine);
  const now = useNow(p.rateLimitUntil !== null);
  const waiting = p.rateLimitUntil !== null && p.rateLimitUntil > now;
  const running = services.engine.isBusy();
  const stage = p.stage === "judging" ? `Reading and judging ${p.done.toLocaleString()} of ${p.total.toLocaleString()}` : (STAGE_COPY[p.stage] ?? "");
  const mapped = p.error ? errorToStep(p.error) : null;

  async function resume() {
    const settings = await services.store.getSettings();
    void services.engine.start(settings);
  }

  return (
    <section className={styles.scan}>
      <h1 className={styles.heading} aria-live="polite">{stage}</h1>
      <ProgressBar value={p.total ? p.done / p.total : 0} label="Scan progress" />
      <p className={styles.eta}>
        {p.etaMs !== null && running ? `About ${formatDuration(p.etaMs)} left` : " "}
        {waiting && ` · Gmail asked us to slow down. Continuing in ${Math.ceil((p.rateLimitUntil! - now) / 1000)}s.`}
      </p>

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
        {!running && p.job === "scan" && p.stage === "paused" && <Button onClick={() => void resume()}>Resume</Button>}
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
