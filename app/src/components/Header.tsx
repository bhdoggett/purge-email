import { useEffect, useState } from "react";
import type { Progress } from "../scan/progress.ts";
import { currentTheme, otherTheme, setTheme } from "../theme.ts";
import styles from "./Header.module.css";

const ACTIVE = new Set(["finding", "judging", "labeling"]);

export function Header({ progress, email, onSettings }: { progress: Progress; email: string | null; onSettings: () => void }) {
  const active = ACTIVE.has(progress.stage);
  const [theme, setThemeState] = useState(currentTheme);
  // With no stored choice the theme follows the system, so keep the toggle's label in step with it.
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const sync = () => setThemeState(currentTheme());
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);
  const toggleTheme = () => {
    const next = otherTheme(theme);
    setTheme(next);
    setThemeState(next);
  };
  const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
  return (
    <header className={styles.header}>
      <span className={styles.title}>Purge Email</span>
      {active && (
        <span className={styles.status} aria-live="polite">
          Scanning {progress.total ? `${pct}%` : "…"}
        </span>
      )}
      <span className={styles.spacer} />
      {email && <span className={styles.email}>{email}</span>}
      <button type="button" className={styles.settings} onClick={toggleTheme}>
        {theme === "dark" ? "Light mode" : "Dark mode"}
      </button>
      <button type="button" className={styles.settings} onClick={onSettings}>
        Settings
      </button>
    </header>
  );
}
