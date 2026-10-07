import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useState } from "react";
import type { Settings } from "@core/decide.ts";
import type { Screen } from "../App.tsx";
import { Button } from "../components/Button.tsx";
import { ConfirmDialog } from "../components/ConfirmDialog.tsx";
import { reconcile, settingsEqual, summarize } from "../scan/reconcile.ts";
import type { Services } from "../services.ts";
import styles from "./Review.module.css";

type Pending = null | "trash" | "spam";

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function Review({ services, go }: { services: Services; go: (s: Screen) => void }) {
  const { store, gmail, engine, labelName } = services;
  const [counts, setCounts] = useState<{ purge: number; keep: number; review: number } | null>(null);
  const [labeledNow, setLabeledNow] = useState<number | null>(null);
  const [spamCount, setSpamCount] = useState<number | null>(null);
  const [changed, setChanged] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updating, setUpdating] = useState(false);

  async function load() {
    try {
      const s = await store.getSettings();
      const scan = await store.getScan();
      setSettings(s);
      setCounts(await summarize(store, s));
      setChanged(!!scan?.settingsAtScan && !settingsEqual(scan.settingsAtScan, s));
      setLabeledNow((await gmail.listIds(`label:${labelName} -is:starred`)).length);
      setSpamCount((await gmail.listIds("in:spam")).length);
      setError(null);
    } catch (e) {
      setError(`Could not load your results from Gmail. ${errorText(e)}`);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function updateLabels() {
    if (!settings || updating) return;
    setUpdating(true);
    setMessage(null);
    try {
      const r = await reconcile({ gmail, store }, settings);
      setMessage(`Moved ${r.moved}, added ${r.added}, removed ${r.removed}.`);
      await load();
    } catch (e) {
      setError(`Could not update the labels. ${errorText(e)}`);
    } finally {
      setUpdating(false);
    }
  }

  function confirm() {
    const job = pending;
    setPending(null);
    if (engine.isBusy()) {
      setMessage(null);
      setError("Another job is running. Wait for it to finish.");
      return;
    }
    void (job === "trash" ? engine.trashLabeled() : engine.emptySpam());
    go("scan");
  }

  if (!counts) {
    return error ? (
      <section className={styles.review}>
        <p className={styles.error} role="alert">{error}</p>
        <Button onClick={() => void load()}>Try again</Button>
      </section>
    ) : (
      <p className={styles.loading}>Loading results…</p>
    );
  }

  if (counts.purge === 0 && counts.keep === 0 && counts.review === 0) {
    return (
      <section className={styles.review}>
        <h1 className={styles.heading}>Nothing to purge</h1>
        <p>No emails matched. Try a shorter age or more kinds on the rules screen.</p>
        <Button onClick={() => go("rules")}>Back to rules</Button>
      </section>
    );
  }

  return (
    <section className={styles.review}>
      <h1 className={styles.heading}>{labeledNow?.toLocaleString() ?? "…"} emails are labeled "{labelName}"</h1>
      <p className={styles.lede}>
        Look through them in Gmail. Remove the label (or star the email) to keep anything. Jev also kept {counts.keep.toLocaleString()} and left {counts.review.toLocaleString()} unlabeled because it wasn't sure.
      </p>

      <div className={styles.actions}>
        <Button onClick={() => void openUrl(`https://mail.google.com/mail/u/0/#label/${encodeURIComponent(labelName)}`)}>Open in Gmail</Button>
        <Button variant="secondary" onClick={() => go("rules")}>Change rules</Button>
        {changed && (
          <Button variant="secondary" disabled={updating} onClick={() => void updateLabels()}>
            {updating ? "Updating labels…" : "Update labels to match new rules"}
          </Button>
        )}
      </div>
      {message && <p role="status">{message}</p>}
      {error && <p className={styles.error} role="alert">{error}</p>}

      <h2 className={styles.subheading}>When you're done reviewing</h2>
      <div className={styles.choice}>
        <div>
          <h3 className={styles.choiceTitle}>Move labeled emails to Trash here</h3>
          <p className={styles.muted}>Moves each labeled email on its own, so replies in the same thread stay. Trash empties itself after 30 days.</p>
          <Button variant="danger" disabled={!labeledNow} onClick={() => setPending("trash")}>Move {labeledNow?.toLocaleString() ?? ""} to Trash</Button>
        </div>
        <div>
          <h3 className={styles.choiceTitle}>Or delete them in Gmail yourself</h3>
          <p className={styles.muted}>Turn off conversation view first, or deleting a thread also deletes newer replies in it.</p>
          <ol className={styles.steps}>
            <li>In Gmail, open Settings (gear) → See all settings.</li>
            <li>On the General tab, set Conversation view to off and save.</li>
            <li>Search <code>label:{labelName}</code>, select all, and delete.</li>
          </ol>
        </div>
      </div>

      <h2 className={styles.subheading}>Spam folder</h2>
      <p className={styles.muted}>{spamCount === null ? "Counting spam…" : `${spamCount.toLocaleString()} emails in spam.`}</p>
      <Button variant="secondary" disabled={!spamCount} onClick={() => setPending("spam")}>Empty spam folder</Button>

      <ConfirmDialog
        open={pending !== null}
        title={pending === "spam" ? "Empty the spam folder?" : "Move labeled emails to Trash?"}
        body={pending === "spam" ? `${spamCount ?? 0} spam emails will move to Trash.` : `${labeledNow ?? 0} emails labeled "${labelName}" will move to Trash. Starred emails are skipped. You can restore them from Trash for 30 days.`}
        confirmLabel="Move to Trash"
        onConfirm={confirm}
        onCancel={() => setPending(null)}
      />
    </section>
  );
}
