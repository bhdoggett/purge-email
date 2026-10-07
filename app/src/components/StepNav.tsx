import { type NavTarget, STAGES } from "./Header.tsx";
import styles from "./StepNav.module.css";

/** Back and Next buttons that move between the Rules, Scan, and Results stages. */
export function StepNav({ screen, onNavigate }: { screen: NavTarget; onNavigate: (target: NavTarget) => void }) {
  const i = STAGES.findIndex((s) => s.id === screen);
  const prev = STAGES[i - 1];
  const next = STAGES[i + 1];
  return (
    <nav className={styles.stepNav} aria-label="Stage navigation">
      {prev ? (
        <button type="button" className={styles.button} onClick={() => onNavigate(prev.id)}>
          ← Back: {prev.label}
        </button>
      ) : (
        <span />
      )}
      <span className={styles.position}>
        Stage {i + 1} of {STAGES.length}: {STAGES[i]!.label}
      </span>
      {next ? (
        <button type="button" className={styles.button} onClick={() => onNavigate(next.id)}>
          Next: {next.label} →
        </button>
      ) : (
        <span />
      )}
    </nav>
  );
}
