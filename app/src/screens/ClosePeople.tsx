import { useEffect, useMemo, useState } from "react";
import { Button } from "../components/Button.tsx";
import { ProgressBar } from "../components/ProgressBar.tsx";
import { RateLimitNote } from "../components/RateLimitNote.tsx";
import type { Services } from "../services.ts";
import type { SenderStats } from "../storage/db.ts";
import { APPLYING_HINT, isApplying, useApplier } from "../useApplier.ts";
import { isCounting, useCounter } from "../useCounter.ts";
import { useProgress } from "../useProgress.ts";
import { closeCount, closeRows, emailsText, PAGE_SIZE } from "./closePeopleModel.ts";
import styles from "./ClosePeople.module.css";

const SCANNING_HINT = "A scan is running. Count after it finishes.";

/** Who the user is close to: counted from Sent mail, then ticked or unticked by hand. */
export function ClosePeople({ services }: { services: Services }) {
  const { store, counter } = services;
  const state = useCounter(counter);
  const counting = isCounting(state);
  const applying = isApplying(useApplier(services.applier));
  useProgress(services.engine);
  const scanning = services.engine.isBusy();
  const [stats, setStats] = useState<SenderStats | null>(null);
  const [choices, setChoices] = useState<Record<string, boolean>>({});
  const [loaded, setLoaded] = useState(false);
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(PAGE_SIZE);
  const [error, setError] = useState<string | null>(null);

  // Reload after every count, including one that finished while this screen was closed.
  useEffect(() => {
    if (counting) return;
    let current = true;
    void Promise.all([store.getSenderStats(), store.getCloseChoices()]).then(([s, c]) => {
      if (!current) return;
      setStats(s);
      setChoices(c);
      setLoaded(true);
    });
    return () => {
      current = false;
    };
  }, [store, counting, state.phase]);

  const rows = useMemo(() => closeRows(stats, choices, query), [stats, choices, query]);
  const total = useMemo(() => closeCount(stats, choices), [stats, choices]);

  const blocked = scanning || applying;
  const hint = scanning ? SCANNING_HINT : applying ? APPLYING_HINT : undefined;

  async function choose(address: string, close: boolean) {
    const before = choices;
    const next = { ...choices, [address]: close };
    setChoices(next);
    setError(null);
    try {
      await store.putCloseChoices(next);
    } catch {
      setChoices(before);
      setError("Couldn't save your change. Try again.");
    }
  }

  const count = () => void counter.start();

  return (
    <section className={styles.panel} aria-labelledby="close-people-heading">
      <h2 id="close-people-heading" className={styles.heading}>Close people</h2>
      <p className={styles.muted}>Mail from close people is always kept.</p>

      {counting ? (
        <div className={styles.progress}>
          <ProgressBar value={state.total ? (state.done ?? 0) / state.total : 0} label="Counting progress" />
          <p className={styles.muted} aria-live="polite">
            Counted {(state.done ?? 0).toLocaleString()} of {(state.total ?? 0).toLocaleString()} sent emails
          </p>
          <RateLimitNote className={styles.muted} />
        </div>
      ) : !loaded ? null : stats === null ? (
        <div className={styles.start}>
          <p>Count who you email most, from your Sent mail. This reads Gmail only; Jev isn't used.</p>
          <Button disabled={blocked} title={hint} onClick={count}>Count my sent mail</Button>
        </div>
      ) : (
        <>
          <div className={styles.toolbar}>
            <p className={styles.summary} role="status">
              {total.toLocaleString()} close {total === 1 ? "person" : "people"}
            </p>
            <input
              type="search"
              className={styles.search}
              placeholder="Search people"
              aria-label="Search people"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setShown(PAGE_SIZE);
              }}
            />
            <Button variant="secondary" disabled={blocked} title={hint} onClick={count}>Recount</Button>
          </div>
          {rows.length === 0 ? (
            <p className={styles.muted}>{query.trim() ? "No one matches." : "No one found in your Sent mail."}</p>
          ) : (
            <ul className={styles.list}>
              {rows.slice(0, shown).map((r) => (
                <li key={r.address} className={styles.row}>
                  <div className={styles.who}>
                    <span className={styles.name}>{r.name || r.address}</span>
                    {r.name && <span className={styles.address}>{r.address}</span>}
                    <span className={styles.muted}>{emailsText(r.sent, r.years)}</span>
                  </div>
                  <label className={styles.close}>
                    <input type="checkbox" checked={r.close} onChange={(e) => void choose(r.address, e.target.checked)} />
                    Close
                    {r.auto && <span className={styles.auto} title="Ticked from how often you write to them">auto</span>}
                  </label>
                </li>
              ))}
            </ul>
          )}
          {rows.length > shown && (
            <Button variant="secondary" onClick={() => setShown((n) => n + PAGE_SIZE)}>Show more</Button>
          )}
        </>
      )}
      {state.phase === "error" && !counting && <p className={styles.error} role="alert">{state.error}</p>}
      {error && <p className={styles.error} role="alert">{error}</p>}
    </section>
  );
}
