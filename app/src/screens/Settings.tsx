import { useState } from "react";
import { clearSecrets, signOut } from "../bridge/tauri.ts";
import { Button } from "../components/Button.tsx";
import type { Services } from "../services.ts";
import { APPLYING_HINT, isApplying, useApplier } from "../useApplier.ts";
import { forgetSteps, removeKeys, SIGN_IN_STEPS } from "../wizard/steps.ts";
import styles from "./Settings.module.css";

export function Settings({ services, email, onChanged, onBack }: { services: Services; email: string | null; onChanged: () => Promise<unknown> | void; onBack: () => void }) {
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [pending, setPending] = useState(false);
  const applying = isApplying(useApplier(services.applier));
  const busy = services.engine.isBusy() || applying || pending;
  const hint = applying ? APPLYING_HINT : undefined;

  async function act(fn: () => Promise<void>, done: string) {
    if (pending) return;
    setPending(true);
    setMessage(null);
    try {
      await fn();
      await onChanged();
      setMessage({ text: done, error: false });
    } catch (e) {
      setMessage({ text: e instanceof Error ? e.message : String(e), error: true });
    } finally {
      setPending(false);
    }
  }

  return (
    <section className={styles.settings}>
      <h1 className={styles.heading}>Settings</h1>
      <div className={styles.row}>
        <div>
          <h2 className={styles.subheading}>Gmail</h2>
          <p className={styles.muted}>{email ? `Signed in as ${email}` : "Not signed in"}</p>
        </div>
        <Button variant="secondary" disabled={!email || busy} title={hint} onClick={() => act(async () => { await signOut(); await forgetSteps(services.store, SIGN_IN_STEPS); }, "Signed out of Gmail.")}>Sign out</Button>
      </div>
      <div className={styles.row}>
        <div>
          <h2 className={styles.subheading}>Saved keys</h2>
          <p className={styles.muted}>Removes the Jev key and Google client from the Keychain and signs you out.</p>
        </div>
        <Button variant="danger" disabled={busy} title={hint} onClick={() => act(() => removeKeys(services.store, clearSecrets), "Keys removed.")}>Remove keys</Button>
      </div>
      <div className={styles.row}>
        <div>
          <h2 className={styles.subheading}>Scan data</h2>
          <p className={styles.muted}>Forgets the saved emails and Jev answers, so the next scan pays for Jev again. Labels in Gmail stay, and the app still remembers which labels you removed so it won't add them back.</p>
        </div>
        <Button variant="secondary" disabled={busy} title={hint} onClick={() => act(() => services.store.clearScanData(), "Scan data cleared.")}>Clear scan data</Button>
      </div>
      {message && <p role={message.error ? "alert" : "status"}>{message.text}</p>}
      <Button variant="secondary" className={styles.back} onClick={onBack}>Back</Button>
    </section>
  );
}
