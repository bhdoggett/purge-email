import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useState } from "react";
import type { Settings } from "@core/decide.ts";
import type { Screen } from "../App.tsx";
import { Button } from "../components/Button.tsx";
import { countByLabel, reconcile, summarize } from "../scan/reconcile.ts";
import type { Services } from "../services.ts";
import {
  buildRows,
  gmailLabelUrl,
  type ReviewRow,
  scanState,
  type ScanState,
  totalOf,
  updateMessage,
} from "./reviewModel.ts";
import styles from "./Review.module.css";

interface Loaded {
  settings: Settings;
  rows: ReviewRow[];
  nothing: boolean;
  state: ScanState;
  oldPrefix: string | null;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function Review({ services, go }: { services: Services; go: (s: Screen) => void }) {
  const { store, gmail, engine } = services;
  const [data, setData] = useState<Loaded | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updating, setUpdating] = useState(false);

  async function load() {
    try {
      const settings = await store.getSettings();
      const scan = await store.getScan();
      const rows = buildRows(await countByLabel(gmail, settings), settings.labelPrefix);
      const kept = await summarize(store, settings);
      const state = scanState(scan, settings);
      setData({
        settings,
        rows,
        nothing: rows.length === 0 && kept.purge === 0 && kept.keep === 0 && kept.review === 0,
        state,
        oldPrefix: state.prefixChanged ? (scan?.settingsAtScan?.labelPrefix ?? null) : null,
      });
      setError(null);
    } catch (e) {
      setError(`Could not load your results from Gmail. ${errorText(e)}`);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function updateLabels() {
    if (!data || updating) return;
    setUpdating(true);
    setMessage(null);
    try {
      const r = await reconcile({ gmail, store }, data.settings);
      setMessage(updateMessage(r, data.oldPrefix));
      await load();
    } catch (e) {
      setError(`Could not update the labels. ${errorText(e)}`);
    } finally {
      setUpdating(false);
    }
  }

  function busyBlocked(): boolean {
    if (!engine.isBusy()) return false;
    setMessage(null);
    setError("Another job is running. Wait for it to finish.");
    return true;
  }

  function rescan() {
    if (!data || busyBlocked()) return;
    void engine.start(data.settings);
    go("scan");
  }

  if (!data) {
    return error ? (
      <section className={styles.review}>
        <p className={styles.error} role="alert">{error}</p>
        <Button onClick={() => void load()}>Try again</Button>
      </section>
    ) : (
      <p className={styles.loading}>Loading results…</p>
    );
  }

  if (data.nothing) {
    return (
      <section className={styles.review}>
        <h1 className={styles.heading}>Nothing to purge</h1>
        <p>No emails matched. Try a shorter age or more kinds on the rules screen.</p>
        <Button onClick={() => go("rules")}>Back to rules</Button>
      </section>
    );
  }

  const { settings, rows, state } = data;

  return (
    <section className={styles.review}>
      <h1 className={styles.heading}>{totalOf(rows).toLocaleString()} emails labeled under "{settings.labelPrefix}"</h1>
      <p className={styles.lede}>
        Look through them in Gmail. Remove the label (or star the email) to keep anything. Jev left the rest unlabeled.
      </p>

      {state.rescan && (
        <div className={styles.notice}>
          <p>You changed the age or what's always kept. Rescan to apply it.</p>
          <Button onClick={rescan}>Rescan</Button>
        </div>
      )}

      <div className={styles.actions}>
        <Button variant="secondary" onClick={() => go("rules")}>Change rules</Button>
        {state.changed && (
          <Button variant="secondary" disabled={updating} onClick={() => void updateLabels()}>
            {updating ? "Updating labels…" : "Update labels to match new rules"}
          </Button>
        )}
      </div>
      {message && <p role="status">{message}</p>}
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

      <h2 className={styles.subheading}>Or delete them in Gmail yourself</h2>
      <p className={styles.muted}>Turn off conversation view first, or deleting a thread also deletes newer replies in it.</p>
      <ol className={styles.steps}>
        <li>In Gmail, open Settings (gear) → See all settings.</li>
        <li>On the General tab, set Conversation view to off and save.</li>
        <li>Open a label above, select all, and delete.</li>
      </ol>

    </section>
  );
}
