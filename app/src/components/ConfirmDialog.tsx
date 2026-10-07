import { useEffect, useRef } from "react";
import { Button } from "./Button.tsx";
import styles from "./ConfirmDialog.module.css";

interface Props {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({ open, title, body, confirmLabel, onConfirm, onCancel }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (open && !ref.current?.open) ref.current?.showModal();
    if (!open && ref.current?.open) ref.current.close();
  }, [open]);
  return (
    <dialog ref={ref} className={styles.dialog} onCancel={onCancel}>
      <h2 className={styles.title}>{title}</h2>
      <p>{body}</p>
      <div className={styles.actions}>
        <Button variant="secondary" onClick={onCancel}>Cancel</Button>
        <Button variant="danger" onClick={onConfirm}>{confirmLabel}</Button>
      </div>
    </dialog>
  );
}
