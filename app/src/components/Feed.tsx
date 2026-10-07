import { displaySubject } from "../format.ts";
import type { FeedItem } from "../scan/progress.ts";
import styles from "./Feed.module.css";

const LABEL = { purge: "purge", keep: "kept", review: "review" } as const;

export function Feed({ items }: { items: FeedItem[] }) {
  if (items.length === 0) return null;
  return (
    <ul className={styles.feed} aria-label="Latest decisions">
      {items.map((item) => (
        <li key={item.id} className={styles.item}>
          <span className={styles.who}>{item.from.replace(/<.*>/, "").trim() || "(unknown sender)"}</span>
          <span className={styles.subject}>{displaySubject(item.subject)}</span>
          <span className={[styles.decision, styles[item.decision]].join(" ")}>
            {item.label ? `→ ${item.label}` : LABEL[item.decision]} <span className={styles.reason}>({item.reason})</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
