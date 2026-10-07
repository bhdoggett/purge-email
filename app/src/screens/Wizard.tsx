import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useState } from "react";
import { googleSignIn, saveSecret } from "../bridge/tauri.ts";
import { Button } from "../components/Button.tsx";
import { createJudge } from "../jev/client.ts";
import type { Services } from "../services.ts";
import { errorToStep } from "../wizard/errorToStep.ts";
import { initialStep, type Step } from "../wizard/steps.ts";
import styles from "./Wizard.module.css";
const STEPS: { n: Step; title: string }[] = [
  { n: 1, title: "Add your Jev key" },
  { n: 2, title: "Create a Google Cloud project" },
  { n: 3, title: "Turn on the Gmail API" },
  { n: 4, title: "Add yourself as a test user" },
  { n: 5, title: "Create a Desktop OAuth client" },
  { n: 6, title: "Sign in with Google" },
];

const TEST_EMAIL = { from: "Example Store <deals@example.com>", to: "me", cc: "", subject: "Weekend sale", date: "2014", snippet: "50% off everything", ownerReplied: false, hasListUnsubscribe: true, labels: [], attachmentNames: [] };

export interface WizardProps {
  services: Services;
  onDone: () => void | Promise<void>;
  /** Step to open on. Without it the wizard opens on the first unfinished step. */
  startAt?: Step;
  /** Explains why the wizard was opened, such as an expired sign-in. */
  message?: string;
}

export function Wizard({ services, onDone, startAt, message }: WizardProps) {
  const [done, setDone] = useState<Step[]>([]);
  const [current, setCurrent] = useState<Step>(startAt ?? 1);
  const [error, setError] = useState<string | null>(message ?? null);
  const [working, setWorking] = useState(false);
  const [jevKey, setJevKey] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [address, setAddress] = useState("");

  useEffect(() => {
    void services.store.getWizard().then((saved) => {
      setDone(saved as Step[]);
      setCurrent(initialStep(saved, startAt));
    });
  }, [services.store, startAt]);

  async function complete(step: Step) {
    const next = [...new Set([...done, step])].sort() as Step[];
    setDone(next);
    await services.store.putWizard(next);
    setError(null);
    if (step === 6) await onDone();
    else setCurrent((step + 1) as Step);
  }

  async function attempt(step: Step, fn: () => Promise<void>) {
    setWorking(true);
    setError(null);
    try {
      await fn();
      await complete(step);
    } catch (err) {
      const mapped = errorToStep(err);
      if (mapped) {
        setCurrent(mapped.step);
        setError(mapped.message);
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setWorking(false);
    }
  }

  const link = (url: string, text: string) => (
    <Button variant="secondary" type="button" onClick={() => void openUrl(url)}>
      {text}
    </Button>
  );

  return (
    <section className={styles.wizard}>
      <ol className={styles.rail} aria-label="Setup steps">
        {STEPS.map((s) => (
          <li key={s.n}>
            <button
              type="button"
              className={[styles.railItem, s.n === current && styles.current, done.includes(s.n) && styles.done].filter(Boolean).join(" ")}
              onClick={() => { setCurrent(s.n); setError(null); }}
              aria-current={s.n === current ? "step" : undefined}
            >
              <span className={styles.railMark}>{done.includes(s.n) ? "✓" : s.n}</span>
              {s.title}
            </button>
          </li>
        ))}
      </ol>

      <div className={styles.panel}>
        <p className={styles.counter}>Step {current} of 6</p>
        <h1 className={styles.heading}>{STEPS[current - 1]!.title}</h1>

        {current === 1 && (
          <>
            <ol className={styles.instructions}>
              <li>Open the TypeSafe dashboard and create an API key.</li>
              <li>Paste it below. The app tests it with one tiny Jev request (well under a cent).</li>
            </ol>
            {link("https://typesafe.ai", "Open TypeSafe")}
            <label className={styles.field}>
              Jev key
              <input type="password" value={jevKey} onChange={(e) => setJevKey(e.target.value)} autoComplete="off" />
            </label>
            <Button disabled={!jevKey || working} onClick={() => attempt(1, async () => { await saveSecret("jev", jevKey); await createJudge()(TEST_EMAIL); setJevKey(""); })}>
              {working ? "Testing…" : "Save and test key"}
            </Button>
          </>
        )}

        {current === 2 && (
          <>
            <ol className={styles.instructions}>
              <li>Open Google Cloud and sign in with the Gmail account you want to clean up.</li>
              <li>Create a new project. Any name works, such as "Purge Email".</li>
              <li>Make sure the new project is selected at the top of the page.</li>
            </ol>
            {link("https://console.cloud.google.com/projectcreate", "Open Google Cloud")}
            <Button onClick={() => void complete(2)}>I've created the project</Button>
          </>
        )}

        {current === 3 && (
          <>
            <ol className={styles.instructions}>
              <li>Open the Gmail API page for your project.</li>
              <li>Click Enable. It can take a minute or two to take effect.</li>
            </ol>
            {link("https://console.cloud.google.com/apis/library/gmail.googleapis.com", "Open Gmail API page")}
            <Button onClick={() => void complete(3)}>I've turned it on</Button>
          </>
        )}

        {current === 4 && (
          <>
            <label className={styles.field}>
              Your Gmail address
              <input type="email" value={address} onChange={(e) => setAddress(e.target.value)} />
            </label>
            <ol className={styles.instructions}>
              <li>Open Google Auth Platform. If asked, click Get started and fill in an app name and your email. Choose External.</li>
              <li>Go to Audience. Leave the app in Testing; don't publish it.</li>
              <li>Under Test users, click Add users and add {address || "your Gmail address"}.</li>
            </ol>
            {link("https://console.cloud.google.com/auth/audience", "Open Audience settings")}
            <Button onClick={() => void complete(4)}>I've added myself</Button>
          </>
        )}

        {current === 5 && (
          <>
            <ol className={styles.instructions}>
              <li>Open Clients and click Create client.</li>
              <li>Choose Desktop app as the application type. Other types won't work.</li>
              <li>Copy the client ID and client secret into the fields below.</li>
            </ol>
            {link("https://console.cloud.google.com/auth/clients/create", "Open Clients")}
            <label className={styles.field}>
              Client ID
              <input value={clientId} onChange={(e) => setClientId(e.target.value)} autoComplete="off" />
            </label>
            <label className={styles.field}>
              Client secret
              <input type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} autoComplete="off" />
            </label>
            <Button
              disabled={!clientId || !clientSecret || working}
              onClick={() => attempt(5, async () => { await saveSecret("google_client", JSON.stringify({ client_id: clientId.trim(), client_secret: clientSecret.trim() })); setClientSecret(""); })}
            >
              Save client
            </Button>
          </>
        )}

        {current === 6 && (
          <>
            <ol className={styles.instructions}>
              <li>Click Sign in. Your browser opens Google's sign-in page.</li>
              <li>Google warns that it hasn't verified the app. That's expected for your own project: click Continue.</li>
              <li>Allow the access Google asks for, then come back here. The app only uses it to read and label email. It never deletes anything.</li>
            </ol>
            <Button disabled={working} onClick={() => attempt(6, async () => { await googleSignIn(); })}>
              {working ? "Waiting for Google…" : "Sign in with Google"}
            </Button>
          </>
        )}

        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
