import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useRef, useState } from "react";
import type { Settings } from "@core/decide.ts";
import { needsRescan } from "@core/labels.ts";
import type { Screen } from "../App.tsx";
import { Button } from "../components/Button.tsx";
import { DEV_SCAN_LIMIT } from "../scan/progress.ts";
import { applyPreview, countByLabel, isPending, type Preview, previewReconcile } from "../scan/reconcile.ts";
import type { Services } from "../services.ts";
import { appliedMessage, type ApplyRow, buildRows, gmailLabelUrl, previewSummary, SETTLING_NOTE, totalOf } from "./applyModel.ts";
import { useProgress } from "../useProgress.ts";
import styles from "./Apply.module.css";

type Loaded =
  | { kind: "noscan" }
  | { kind: "rescan"; settings: Settings }
  | { kind: "pending"; settings: Settings; preview: Preview }
  | { kind: "done"; settings: Settings; rows: ApplyRow[]; deferred: number };

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function Apply({ services, go }: { services: Services; go: (s: Screen) => void }) {
  const { store, gmail, engine } = services;
  const [data, setData] = useState<Loaded | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  // Re-render when a scan starts or stops, so the busy note and buttons stay current.
  const progress = useProgress(engine);
  const scanning = engine.isBusy();
  const wasScanning = useRef(scanning);
  useEffect(() => {
    // A scan that just finished changed the candidates: check Gmail again.
    if (wasScanning.current && !scanning) void load();
    wasScanning.current = scanning;
  }, [scanning, progress.stage]);

  async function load() {
    try {
      const settings = await store.getSettings();
      const scan = await store.getScan();
      // Without a finished scan there are no candidates, so a preview would strip every label.
      if (!scan?.settingsAtScan) {
        setData({ kind: "noscan" });
      } else if (needsRescan(scan.settingsAtScan, settings)) {
        setData({ kind: "rescan", settings });
      } else {
        setData(null);
        const preview = await previewReconcile({ gmail, store }, settings);
        if (isPending(preview)) {
          setData({ kind: "pending", settings, preview });
        } else {
          const rows = buildRows(await countByLabel(gmail, settings), settings.labelPrefix);
          setData({ kind: "done", settings, rows, deferred: preview.plan.deferred });
        }
      }
      setError(null);
    } catch (e) {
      setError(`Could not check Gmail. ${errorText(e)}`);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function apply() {
    if (!data || data.kind !== "pending" || applying) return;
    if (engine.isBusy()) {
      setMessage(null);
      setError("A scan is running. Apply after it finishes.");
      return;
    }
    setApplying(true);
    setMessage(null);
    try {
      await applyPreview({ gmail, store }, data.settings, data.preview);
      setMessage(appliedMessage(data.preview, data.preview.oldPrefixes));
      await load();
    } catch (e) {
      setError(`Could not apply the labels. ${errorText(e)}`);
    } finally {
      setApplying(false);
    }
  }

  function rescan() {
    if (!data || data.kind !== "rescan") return;
    if (engine.isBusy()) {
      setMessage(null);
      setError("Another job is running. Wait for it to finish.");
      return;
    }
    void engine.start(data.settings, { limit: DEV_SCAN_LIMIT });
    go("scan");
  }

  if (!data) {
    return error ? (
      <section className={styles.review}>
        <p className={styles.error} role="alert">{error}</p>
        <Button onClick={() => void load()}>Try again</Button>
      </section>
    ) : (
      <p className={styles.loading}>Checking Gmail…</p>
    );
  }

  if (data.kind === "noscan") {
    return (
      <section className={styles.review}>
        <h1 className={styles.heading}>No scan yet</h1>
        <p className={styles.lede}>Scan your mail first, then review and apply the labels.</p>
        <Button onClick={() => go("rules")}>Back to rules</Button>
      </section>
    );
  }

  if (data.kind === "rescan") {
    return (
      <section className={styles.review}>
        <h1 className={styles.heading}>Rescan needed</h1>
        <p className={styles.lede}>You changed the age or what's always kept. Only a new scan finds the right emails.</p>
        <Button disabled={scanning} onClick={rescan}>Rescan</Button>
        {error && <p className={styles.error} role="alert">{error}</p>}
      </section>
    );
  }

  if (data.kind === "pending") {
    const { preview } = data;
    const rows = buildRows(preview.totals, data.settings.labelPrefix);
    return (
      <section className={styles.review}>
        <h1 className={styles.heading}>Ready to label</h1>
        <p className={styles.lede}>{previewSummary(preview)}</p>
        {scanning && (
          <p className={styles.note} role="status">
            A scan is running, so these numbers may change.{" "}
            <button type="button" className={styles.linkButton} onClick={() => go("scan")}>
              See progress
            </button>
          </p>
        )}
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
          <Button disabled={applying || scanning} onClick={() => void apply()}>
            {applying ? "Applying labels…" : "Apply labels"}
          </Button>
        </div>
        {message && <p role="status">{message}</p>}
        {error && <p className={styles.error} role="alert">{error}</p>}
      </section>
    );
  }

  const { settings, rows } = data;
  if (totalOf(rows) === 0) {
    return (
      <section className={styles.review}>
        <h1 className={styles.heading}>Nothing labeled</h1>
        <p className={styles.lede}>Your review gives no email a label. Go back to Review to change that.</p>
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

      {scanning && (
        <p className={styles.note} role="status">
          A scan is running, so these numbers may change.{" "}
          <button type="button" className={styles.linkButton} onClick={() => go("scan")}>
            See progress
          </button>
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {data.deferred > 0 && <p className={styles.muted}>{SETTLING_NOTE}</p>}
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
