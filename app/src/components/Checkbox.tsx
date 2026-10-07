import { useId } from "react";
import styles from "./Checkbox.module.css";

interface Props {
  checked: boolean;
  onChange?: (checked: boolean) => void;
  label: string;
  description?: string;
  locked?: boolean;
  disabled?: boolean;
}

export function Checkbox({ checked, onChange, label, description, locked, disabled }: Props) {
  const id = useId();
  return (
    <div className={styles.row}>
      <input
        id={id}
        type="checkbox"
        className={styles.input}
        checked={checked}
        disabled={locked || disabled}
        onChange={(e) => onChange?.(e.target.checked)}
        aria-describedby={description ? `${id}-d` : undefined}
      />
      <label htmlFor={id} className={styles.label}>
        {label}
        {locked && <span className={styles.locked}> (always)</span>}
      </label>
      {description && (
        <p id={`${id}-d`} className={styles.description}>
          {description}
        </p>
      )}
    </div>
  );
}
