import { useCallback, useEffect, useState } from "react";
import { type SecretsStatus, secretsStatus } from "./bridge/tauri.ts";
import { Header } from "./components/Header.tsx";
import { Settings } from "./screens/Settings.tsx";
import { Welcome } from "./screens/Welcome.tsx";
import { getServices, type Services } from "./services.ts";
import { useProgress } from "./useProgress.ts";
import styles from "./App.module.css";

export type Screen = "welcome" | "wizard" | "rules" | "scan" | "review" | "settings";

function Shell({ services }: { services: Services }) {
  const progress = useProgress(services.engine);
  const [status, setStatus] = useState<SecretsStatus | null>(null);
  const [screen, setScreen] = useState<Screen | null>(null);
  const [previous, setPrevious] = useState<Screen>("rules");

  const refresh = useCallback(async () => {
    const s = await secretsStatus();
    setStatus(s);
    return s;
  }, []);

  useEffect(() => {
    void (async () => {
      const s = await refresh();
      const ready = s.jev && s.googleClient && s.gmailEmail;
      const wizard = await services.store.getWizard();
      setScreen(ready ? "rules" : wizard.length ? "wizard" : "welcome");
    })();
  }, [refresh, services.store]);

  const go = (next: Screen) => {
    if (next === "settings" && screen) setPrevious(screen);
    setScreen(next);
  };

  if (!screen || !status) return null;

  return (
    <div className={styles.app}>
      <Header progress={progress} email={status.gmailEmail} onSettings={() => go("settings")} />
      <main className={styles.main}>
        {screen === "welcome" && <Welcome onStart={() => go("wizard")} />}
        {screen === "settings" && <Settings services={services} email={status.gmailEmail} onChanged={refresh} onBack={() => go(previous)} />}
        {screen === "wizard" && <p>wizard</p>}
        {screen === "rules" && <p>rules</p>}
        {screen === "scan" && <p>scan</p>}
        {screen === "review" && <p>review</p>}
      </main>
    </div>
  );
}

export function App() {
  const [services, setServices] = useState<Services | null>(null);
  useEffect(() => {
    void getServices().then(setServices);
  }, []);
  return services ? <Shell services={services} /> : null;
}
