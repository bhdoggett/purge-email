import { Button } from "../components/Button.tsx";
import styles from "./Welcome.module.css";

export function Welcome({ onStart }: { onStart: () => void }) {
  return (
    <section className={styles.welcome}>
      <h1 className={styles.heading}>Clear out years of old email</h1>
      <p className={styles.lede}>
        Purge Email reads your old Gmail with Jev, an AI model that sorts each email into kinds like newsletters,
        promotions, or personal mail. You choose which kinds to clear. It labels them in Gmail so you can look before
        anything goes.
      </p>
      <ul className={styles.promises}>
        <li>It only adds labels and never deletes anything. Any deleting is up to you, in Gmail.</li>
        <li>Your keys stay in your Mac's Keychain, never in a file.</li>
        <li>A typical mailbox costs about $2 in Jev usage.</li>
      </ul>
      <Button onClick={onStart}>Set up</Button>
    </section>
  );
}
