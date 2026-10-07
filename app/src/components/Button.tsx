import type { ButtonHTMLAttributes } from "react";
import styles from "./Button.module.css";

type Props = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "danger" };

export function Button({ variant = "primary", className, ...rest }: Props) {
  return <button {...rest} className={[styles.button, styles[variant], className].filter(Boolean).join(" ")} />;
}
