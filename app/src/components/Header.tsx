import { useEffect, useState } from "react";
import type { Progress } from "../scan/progress.ts";
import { currentTheme, otherTheme, setTheme } from "../theme.ts";
import styles from "./Header.module.css";

const ACTIVE = new Set(["finding", "judging", "labeling"]);

export type NavTarget = "rules" | "scan" | "review";

const NAV: { id: NavTarget; label: string }[] = [
  { id: "rules", label: "Rules" },
  { id: "scan", label: "Scan" },
  { id: "review", label: "Results" },
];

interface Props {
  progress: Progress;
  email: string | null;
  /** The screen being shown, used to mark the current tab. */
  screen: string;
  /** Null hides the tabs, e.g. before setup is finished. */
  onNavigate: ((target: NavTarget) => void) | null;
  onSettings: () => void;
}

export function Header({ progress, email, screen, onNavigate, onSettings }: Props) {
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
      {onNavigate ? (
        <button type="button" className={styles.title} onClick={() => onNavigate("rules")}>
          Purge Email
        </button>
      ) : (
        <span className={styles.title}>Purge Email</span>
      )}
      {onNavigate && (
        <nav className={styles.nav} aria-label="Main">
          {NAV.map((item) => (
            <button
              key={item.id}
              type="button"
              className={[styles.tab, screen === item.id && styles.current].filter(Boolean).join(" ")}
              aria-current={screen === item.id ? "page" : undefined}
              onClick={() => onNavigate(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>
      )}
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
