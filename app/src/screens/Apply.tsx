import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useRef, useState } from "react";
import type { Settings } from "@core/decide.ts";
import { needsRescan } from "@core/labels.ts";
import type { Screen } from "../App.tsx";
import { Button } from "../components/Button.tsx";
import { ProgressBar } from "../components/ProgressBar.tsx";
import { RateLimitNote } from "../components/RateLimitNote.tsx";
import { DEV_SCAN_LIMIT } from "../scan/progress.ts";
import { isPending, type ReadStep } from "../scan/reconcile.ts";
import type { Services } from "../services.ts";
import { buildRows, gmailLabelUrl, previewSummary, SETTLING_NOTE, totalOf } from "./applyModel.ts";
import { APPLYING_HINT, isApplying, useApplier } from "../useApplier.ts";
import { useProgress } from "../useProgress.ts";
import styles from "./Apply.module.css";

type Gate = { kind: "noscan" } | { kind: "rescan"; settings: Settings } | { kind: "ready"; settings: Settings };

/** "Checking Gmail: label 3 of 9 (promotion)…" with just the slug of the label's name. */
function stepText(step: ReadStep | undefined): string {
  if (!step) return "Checking Gmail…";
  return `Checking Gmail: label ${step.index} of ${step.total} (${step.label.slice(step.label.lastIndexOf("/") + 1)})…`;
}

export function Apply({ services, go }: { services: Services; go: (s: Screen) => void }) {
  const { store, engine, applier } = services;
  const [gate, setGate] = useState<Gate | null>(null);
  const [gateError, setGateError] = useState<string | null>(null);
  // The job lives in the runner, so leaving this screen and coming back shows where it is.
  const state = useApplier(applier);
  const working = isApplying(state);
  // Re-render when a scan starts or stops, so the buttons stay current.
  const progress = useProgress(engine);
  const scanning = engine.isBusy();
  const wasScanning = useRef(scanning);
  useEffect(() => {
    // A scan that just finished changed the candidates: check Gmail again.
    if (wasScanning.current && !scanning) void load(true);
    wasScanning.current = scanning;
  }, [scanning, progress.stage]);

  async function load(force = false) {
    try {
      const settings = await store.getSettings();
      const scan = await store.getScan();
      // Without a finished scan there are no candidates, so a preview would strip every label.
      if (!scan?.finished || !scan.settingsAtScan) {
        setGate({ kind: "noscan" });
      } else if (needsRescan(scan.settingsAtScan, settings)) {
        setGate({ kind: "rescan", settings });
      } else {
        setGate({ kind: "ready", settings });
        const current = applier.getState();
        // A finished result with its message is shown as it is; a running job is never disturbed.
        const showResult = current.phase === "done" && current.message !== undefined && !force;
        if (!applier.busy() && !showResult) void applier.check(settings);
      }
      setGateError(null);
    } catch (e) {
      setGateError(`Could not check Gmail. ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  function apply() {
    if (gate?.kind !== "ready" || state.phase !== "done" || !state.preview || working) return;
    void applier.apply(gate.settings, state.preview);
  }

  function rescan() {
    if (gate?.kind !== "rescan" || working) return;
    if (engine.isBusy()) return;
    void engine.start(gate.settings, { limit: DEV_SCAN_LIMIT });
    go("scan");
  }

  if (state.phase === "writing") {
    const done = state.done ?? 0;
    const total = state.total ?? 0;
    return (
      <section className={styles.review}>
        <h1 className={styles.heading} aria-live="polite">Applying labels</h1>
        <ProgressBar value={total ? done / total : 0} label="Apply progress" />
        <p className={styles.muted}>
          Labeling {done.toLocaleString()} of {total.toLocaleString()}
        </p>
        <RateLimitNote className={styles.muted} />
      </section>
    );
  }

  if (!gate) {
    return gateError ? (
      <section className={styles.review}>
        <p className={styles.error} role="alert">{gateError}</p>
        <Button onClick={() => void load()}>Try again</Button>
      </section>
    ) : (
      <p className={styles.loading}>Checking Gmail…</p>
    );
  }

  if (gate.kind === "noscan") {
    return (
      <section className={styles.review}>
        <h1 className={styles.heading}>No scan yet</h1>
        <p className={styles.lede}>Scan your mail first, then review and apply the labels.</p>
        <Button onClick={() => go("rules")}>Back to rules</Button>
      </section>
    );
  }

  if (gate.kind === "rescan") {
    return (
      <section className={styles.review}>
        <h1 className={styles.heading}>Rescan needed</h1>
        <p className={styles.lede}>You lowered the age or turned off a protection under "Always keep", so some emails were never scanned. Only a new scan finds them.</p>
        <Button disabled={scanning || working} title={working ? APPLYING_HINT : undefined} onClick={rescan}>Rescan</Button>
        {state.error && <p className={styles.error} role="alert">{state.error}</p>}
      </section>
    );
  }

  if (state.phase === "checking" || state.phase === "idle") {
    return (
      <section className={styles.review}>
        <p className={styles.loading}>{stepText(state.step)}</p>
        <RateLimitNote className={styles.muted} />
      </section>
    );
  }

  if (state.phase === "error") {
    return (
      <section className={styles.review}>
        <p className={styles.error} role="alert">{state.error}</p>
        <Button onClick={() => void applier.check(gate.settings)}>Try again</Button>
      </section>
    );
  }

  const { message, error } = state;
  const preview = state.preview;
  if (preview && isPending(preview)) {
    const rows = buildRows(preview.totals, gate.settings.labelPrefix);
    return (
      <section className={styles.review}>
        <h1 className={styles.heading}>Ready to label</h1>
        <p className={styles.lede}>{previewSummary(preview)}</p>
        <ul className={styles.rows}>
          {rows.map((r) => (
            <li key={r.name} className={styles.row}>
              <div className={styles.rowInfo}>
                <span className={styles.labelName}>{r.name}</span>
                <span className={styles.count}>{r.count.toLocaleString()}</span>
              </div>
            </li>
          ))}
        </ul>
        {preview.oldPrefixes.length > 0 && (
          <p className={styles.muted}>Labels under "{preview.oldPrefixes.join('", "')}" will be emptied because you renamed the label.</p>
        )}
        {preview.plan.deferred > 0 && <p className={styles.muted}>{SETTLING_NOTE}</p>}
        <div className={styles.actions}>
          <Button disabled={scanning} onClick={apply}>Apply labels</Button>
        </div>
        {message && <p role="status">{message}</p>}
        {error && <p className={styles.error} role="alert">{error}</p>}
      </section>
    );
  }

  const settings = gate.settings;
  const rows = buildRows(state.counts ?? new Map(), settings.labelPrefix);
  const deferred = preview?.plan.deferred ?? 0;
  if (totalOf(rows) === 0) {
    return (
      <section className={styles.review}>
        {deferred > 0 ? (
          <>
            <h1 className={styles.heading}>Labels are still settling</h1>
            <p className={styles.lede}>{SETTLING_NOTE}</p>
          </>
        ) : (
          <>
            <h1 className={styles.heading}>Nothing labeled</h1>
            <p className={styles.lede}>Your review gives no email a label. Go back to Review to change that.</p>
          </>
        )}
        <Button onClick={() => go("review")}>Back to Review</Button>
        {message && <p role="status">{message}</p>}
        {error && <p className={styles.error} role="alert">{error}</p>}
      </section>
    );
  }

  return (
    <section className={styles.review}>
      <h1 className={styles.heading}>{totalOf(rows).toLocaleString()} emails labeled under "{settings.labelPrefix}"</h1>
      <p className={styles.lede}>
        This app only adds labels. It never deletes anything. Look through each label in Gmail. To keep an email, remove its label. Starring it isn't
        enough: selecting all and deleting in Gmail deletes everything under the label, starred mail included. Jev left the rest unlabeled.
      </p>
      {message && <p role="status">{message}</p>}
      {deferred > 0 && <p className={styles.muted}>{SETTLING_NOTE}</p>}
      {error && <p className={styles.error} role="alert">{error}</p>}

      <ul className={styles.rows}>
        {rows.map((r) => (
          <li key={r.name} className={styles.row}>
            <div className={styles.rowInfo}>
              <span className={styles.labelName}>{r.name}</span>
              <span className={styles.count}>{r.count.toLocaleString()}</span>
              {r.isMaybe && <p className={styles.muted}>Jev wasn't sure about these. Look through them before deleting.</p>}
            </div>
            <div className={styles.rowActions}>
              <Button variant="secondary" onClick={() => void openUrl(gmailLabelUrl(r.name))}>Open in Gmail</Button>
            </div>
          </li>
        ))}
      </ul>
      {settings.keepStarred && <p className={styles.muted}>Counts leave out starred emails, but Gmail's select-all still deletes them.</p>}

      <h2 className={styles.subheading}>Delete them in Gmail yourself</h2>
      <p className={styles.muted}>Turn off conversation view first, or deleting a thread also deletes newer replies in it.</p>
      <ol className={styles.steps}>
        <li>In Gmail, open Settings (gear) → See all settings.</li>
        <li>On the General tab, set Conversation view to off and save.</li>
        <li>Open a label above. To keep an email, remove the label from it. Starring it isn't enough.</li>
        <li>Select all and delete. This deletes everything still under the label, including starred mail. Gmail keeps deleted mail in Trash for 30 days.</li>
      </ol>
    </section>
  );
}
