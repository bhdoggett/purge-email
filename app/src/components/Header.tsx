import type { Progress } from "../scan/progress.ts";
import styles from "./Header.module.css";

const ACTIVE = new Set(["finding", "judging", "labeling", "trashing"]);

export function Header({ progress, email, onSettings }: { progress: Progress; email: string | null; onSettings: () => void }) {
  const active = ACTIVE.has(progress.stage);
  const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
  const verb = progress.job === "scan" ? "Scanning" : "Moving to Trash";
  return (
    <header className={styles.header}>
      <span className={styles.title}>Purge Email</span>
      {active && (
        <span className={styles.status} aria-live="polite">
          {verb} {progress.total ? `${pct}%` : "…"}
        </span>
      )}
      <span className={styles.spacer} />
      {email && <span className={styles.email}>{email}</span>}
      <button type="button" className={styles.settings} onClick={onSettings}>
        Settings
      </button>
    </header>
  );
}
