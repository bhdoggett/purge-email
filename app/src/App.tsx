import { useCallback, useEffect, useState } from "react";
import { type SecretsStatus, secretsStatus } from "./bridge/tauri.ts";
import { Button } from "./components/Button.tsx";
import { Header } from "./components/Header.tsx";
import { Review } from "./screens/Review.tsx";
import { Rules } from "./screens/Rules.tsx";
import { Scan } from "./screens/Scan.tsx";
import { Settings } from "./screens/Settings.tsx";
import { Welcome } from "./screens/Welcome.tsx";
import { Wizard } from "./screens/Wizard.tsx";
import { getServices, type Services } from "./services.ts";
import { useProgress } from "./useProgress.ts";
import type { Step } from "./wizard/steps.ts";
import styles from "./App.module.css";

export type Screen = "welcome" | "wizard" | "rules" | "scan" | "review" | "settings";

/** Where to open the wizard and what to do once sign-in succeeds. */
export interface WizardTarget {
  startAt?: Step;
  message?: string;
  /** Return to the scan and resume it after a successful sign-in. */
  resumeScan?: boolean;
}

function hasCredentials(s: SecretsStatus): boolean {
  return Boolean(s.jev && s.googleClient && s.gmailEmail);
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function StartupError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <section className={styles.error} role="alert">
      <h1 className={styles.errorHeading}>Purge Email could not start</h1>
      <p className={styles.errorMessage}>{message}</p>
      <Button onClick={onRetry}>Try again</Button>
    </section>
  );
}

function Shell({ services }: { services: Services }) {
  const progress = useProgress(services.engine);
  const [status, setStatus] = useState<SecretsStatus | null>(null);
  const [screen, setScreen] = useState<Screen | null>(null);
  const [previous, setPrevious] = useState<Screen>("rules");
  const [wizardTarget, setWizardTarget] = useState<WizardTarget>({});
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const refresh = useCallback(async () => {
    const s = await secretsStatus();
    setStatus(s);
    return s;
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        setError(null);
        const s = await refresh();
        const wizard = await services.store.getWizard();
        const ready = hasCredentials(s);
        const scan = ready ? await services.store.getScan() : null;
        setScreen(ready ? (scan?.finished ? "review" : "rules") : wizard.length ? "wizard" : "welcome");
      } catch (e) {
        setError(errorText(e));
      }
    })();
  }, [refresh, services.store, attempt]);

  const go = (next: Screen) => {
    if (next === "settings" && screen && screen !== "settings") setPrevious(screen);
    if (next === "wizard") setWizardTarget({});
    setScreen(next);
  };

  const openWizard = (target: WizardTarget) => {
    setWizardTarget(target);
    setScreen("wizard");
  };

  const wizardDone = async () => {
    await refresh();
    if (wizardTarget.resumeScan) {
      const settings = await services.store.getSettings();
      void services.engine.start(settings);
      go("scan");
    } else {
      go("rules");
    }
  };

  const back = () => go(status && !hasCredentials(status) ? "wizard" : previous);

  if (error) return <StartupError message={error} onRetry={() => setAttempt((n) => n + 1)} />;
  if (!screen || !status) return null;

  return (
    <div className={styles.app}>
      <Header progress={progress} email={status.gmailEmail} onSettings={() => go("settings")} />
      <main className={styles.main}>
        {screen === "welcome" && <Welcome onStart={() => go("wizard")} />}
        {screen === "settings" && <Settings services={services} email={status.gmailEmail} onChanged={refresh} onBack={back} />}
        {screen === "wizard" && (
          <Wizard services={services} startAt={wizardTarget.startAt} message={wizardTarget.message} onDone={wizardDone} />
        )}
        {screen === "rules" && <Rules services={services} go={go} />}
        {screen === "scan" && <Scan services={services} go={go} openWizard={openWizard} />}
        {screen === "review" && <Review services={services} go={go} />}
      </main>
    </div>
  );
}

export function App() {
  const [services, setServices] = useState<Services | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    setError(null);
    getServices().then(setServices, (e: unknown) => setError(errorText(e)));
  }, [attempt]);
  if (error) return <StartupError message={error} onRetry={() => setAttempt((n) => n + 1)} />;
  return services ? <Shell services={services} /> : null;
}
