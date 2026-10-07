import { type NavTarget, STAGES } from "./Header.tsx";
import { UNAVAILABLE_HINT } from "../stages.ts";
import styles from "./StepNav.module.css";

/** Back and Next buttons that move between the Rules, Scan, Review, and Apply stages. */
export function StepNav({
  screen,
  onNavigate,
  available,
}: {
  screen: NavTarget;
  onNavigate: (target: NavTarget) => void;
  available: Record<NavTarget, boolean>;
}) {
  const i = STAGES.findIndex((s) => s.id === screen);
  const prev = STAGES[i - 1];
  const next = STAGES[i + 1];
  return (
    <nav className={styles.stepNav} aria-label="Stage navigation">
      {prev ? (
        <button type="button" className={styles.button} disabled={!available[prev.id]} onClick={() => onNavigate(prev.id)}>
          ← Back: {prev.label}
        </button>
      ) : (
        <span />
      )}
      <span className={styles.position}>
        Stage {i + 1} of {STAGES.length}: {STAGES[i]!.label}
      </span>
      {next ? (
        <span className={styles.nextGroup}>
          {!available[next.id] && <span className={styles.hint}>{UNAVAILABLE_HINT[next.id]}</span>}
          <button type="button" className={styles.button} disabled={!available[next.id]} onClick={() => onNavigate(next.id)}>
            Next: {next.label} →
          </button>
        </span>
      ) : (
        <span />
      )}
    </nav>
  );
}
