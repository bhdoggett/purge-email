import styles from "./ProgressBar.module.css";

export function ProgressBar({ value, label }: { value: number; label: string }) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div className={styles.track} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
      <div className={styles.fill} data-pct={pct} ref={(el) => el?.style.setProperty("--pct", `${pct}%`)} />
    </div>
  );
}
