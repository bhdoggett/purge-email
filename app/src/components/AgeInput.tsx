import { useId, useState } from "react";
import { ageFromInput, type AgeUnit, initialUnit, MAX_MONTHS, MAX_YEARS, shownNumber, switchUnit } from "./ageUnits.ts";
import styles from "./AgeInput.module.css";

interface Props {
  /** Age in months; 0 means any age. */
  months: number;
  onChange: (months: number) => void;
  disabled?: boolean;
  /** How 0 is shown: as " (any age)" after the control, or as an empty field with an "any age" placeholder. */
  zero?: "suffix" | "placeholder";
  className?: string;
}

/** "Older than [number] [months|years]". The unit is display only: the value is always months. */
export function AgeInput({ months, onChange, disabled, zero = "suffix", className }: Props) {
  const id = useId();
  const [unit, setUnit] = useState<AgeUnit>(() => initialUnit(months));
  const empty = zero === "placeholder" && months === 0;

  const changeUnit = (next: AgeUnit) => {
    setUnit(next);
    const converted = switchUnit(months, next);
    if (converted !== months) onChange(converted);
  };

  return (
    <div className={[styles.age, className].filter(Boolean).join(" ")}>
      <label htmlFor={id}>Older than</label>
      <input
        id={id}
        type="number"
        className={styles.control}
        min={0}
        max={unit === "years" ? MAX_YEARS : MAX_MONTHS}
        step={1}
        value={empty ? "" : shownNumber(months, unit)}
        placeholder={zero === "placeholder" ? "any age" : undefined}
        disabled={disabled}
        onChange={(e) => onChange(ageFromInput(e.target.value, unit))}
      />
      <select className={styles.control} aria-label="Age unit" value={unit} disabled={disabled} onChange={(e) => changeUnit(e.target.value as AgeUnit)}>
        <option value="months">months</option>
        <option value="years">years</option>
      </select>
      {zero === "suffix" && months === 0 && <span className={styles.any}>(any age)</span>}
    </div>
  );
}
