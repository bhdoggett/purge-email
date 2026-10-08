import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../components/Button.tsx";
import { ProgressBar } from "../components/ProgressBar.tsx";
import { RateLimitNote } from "../components/RateLimitNote.tsx";
import type { Services } from "../services.ts";
import { type CloseRule, DEFAULT_CLOSE_RULE, type SenderStats } from "../storage/db.ts";
import { APPLYING_HINT, isApplying, useApplier } from "../useApplier.ts";
import { isCounting, useCounter } from "../useCounter.ts";
import { useProgress } from "../useProgress.ts";
import { currentAccount } from "../scan/closeness.ts";
import { type CloseShow, type CloseSort, closeCount, closeRows, countStatus, emailsText, PAGE_SIZE } from "./closePeopleModel.ts";
import styles from "./ClosePeople.module.css";

const SCANNING_HINT = "A scan is running. Count after it finishes.";

const SHOW_OPTIONS: { id: CloseShow; label: string }[] = [
  { id: "close", label: "Close only" },
  { id: "everyone", label: "Everyone" },
];

const wholeNumber = (raw: string, min: number, max: number) => Math.min(max, Math.max(min, Math.round(Number(raw) || min)));

/** Who the user is close to: counted from Sent mail, then ticked or unticked by hand. */
export function ClosePeople({ services }: { services: Services }) {
  const { store, counter } = services;
  const state = useCounter(counter);
  const counting = isCounting(state);
  const applying = isApplying(useApplier(services.applier));
  useProgress(services.engine);
  const scanning = services.engine.isBusy();
  const [stats, setStats] = useState<SenderStats | null>(null);
  const [account, setAccount] = useState<string | null>(null);
  const [choices, setChoices] = useState<Record<string, boolean>>({});
  // The latest choices, and a count of changes made, so a slow reload never overwrites a newer tick.
  const choicesRef = useRef<Record<string, boolean>>({});
  const changes = useRef(0);
  const [rule, setRule] = useState<CloseRule>(DEFAULT_CLOSE_RULE);
  // The choices the list was last built from (see `rows` below).
  const [viewChoices, setViewChoices] = useState<Record<string, boolean>>({});
  const [loaded, setLoaded] = useState(false);
  const [query, setQuery] = useState("");
  const [show, setShow] = useState<CloseShow>("close");
  const [sort, setSort] = useState<CloseSort>("most");
  const [shown, setShown] = useState(PAGE_SIZE);
  const [error, setError] = useState<string | null>(null);

  // Reload after every count, including one that finished while this screen was closed.
  useEffect(() => {
    if (counting) return;
    let current = true;
    const changesAtStart = changes.current;
    void Promise.all([store.getSenderStats(), store.getCloseChoices(), currentAccount(services.gmail), store.getCloseRule()]).then(([s, c, a, r]) => {
      if (!current) return;
      setStats(s);
      setRule(r);
      setAccount(a);
      if (changes.current === changesAtStart) {
        choicesRef.current = c;
        setChoices(c);
        setViewChoices(c);
      }
      setLoaded(true);
    });
    return () => {
      current = false;
    };
  }, [store, services.gmail, counting, state.phase]);

  const status = countStatus(stats, account);
  // Counts from another account are never shown or used.
  const shownStats = status === "none" ? null : stats;
  // Unticking someone in "Close only" would make them vanish under the pointer, so the list is built
  // from the choices as they were when the view last changed; newer ticks still show in each checkbox.
  useEffect(() => setViewChoices(choicesRef.current), [show, sort, query, rule, shownStats]);
  const rows = useMemo(
    () => closeRows(shownStats, viewChoices, query, rule, { show, sort }).map((r) => ({ ...r, close: choices[r.address] ?? r.close, auto: r.auto && choices[r.address] === undefined })),
    [shownStats, viewChoices, choices, query, rule, show, sort],
  );
  const total = useMemo(() => closeCount(shownStats, choices, rule), [shownStats, choices, rule]);

  const blocked = scanning || applying;
  const hint = scanning ? SCANNING_HINT : applying ? APPLYING_HINT : undefined;

  async function choose(address: string, close: boolean) {
    changes.current++;
    const before = choicesRef.current[address];
    const next = { ...choicesRef.current, [address]: close };
    choicesRef.current = next;
    setChoices(next);
    setError(null);
    try {
      await store.putCloseChoices(next);
    } catch {
      // Undo only this tick, keeping any made since.
      const undone = { ...choicesRef.current };
      if (before === undefined) delete undone[address];
      else undone[address] = before;
      choicesRef.current = undone;
      setChoices(undone);
      setError("Couldn't save your change. Try again.");
    }
  }

  async function changeRule(patch: Partial<CloseRule>) {
    const next = { ...rule, ...patch };
    setRule(next);
    setError(null);
    try {
      await store.putCloseRule(next);
    } catch {
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
      ) : !loaded ? null : status === "none" ? (
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
            <div className={styles.segmented} role="group" aria-label="Show">
              {SHOW_OPTIONS.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  className={styles.segment}
                  aria-pressed={show === o.id}
                  onClick={() => {
                    setShow(o.id);
                    setShown(PAGE_SIZE);
                  }}
                >
                  {o.label}
                </button>
              ))}
            </div>
            <select
              className={styles.sort}
              aria-label="Sort"
              value={sort}
              onChange={(e) => {
                setSort(e.target.value as CloseSort);
                setShown(PAGE_SIZE);
              }}
            >
              <option value="most">Most emailed</option>
              <option value="name">Name, A to Z</option>
              <option value="recent">Most recently emailed</option>
            </select>
            <Button variant={status === "partial" ? "primary" : "secondary"} disabled={blocked} title={hint} onClick={count}>
              {status === "partial" ? "Continue counting" : "Recount"}
            </Button>
          </div>
          {status === "partial" && (
            <p className={styles.muted}>Counting stopped before the end. Until it finishes, personal mail is kept and Jev isn't asked about it.</p>
          )}
          <p className={styles.rule}>
            <label>
              Auto-tick people I&apos;ve emailed at least{" "}
              <input
                type="number"
                className={styles.number}
                min={1}
                max={10000}
                value={rule.minSent}
                onChange={(e) => void changeRule({ minSent: wholeNumber(e.target.value, 1, 10000) })}
              />{" "}
              times
            </label>{" "}
            <label>
              over{" "}
              <input
                type="number"
                className={styles.number}
                min={1}
                max={50}
                value={rule.minYears}
                onChange={(e) => void changeRule({ minYears: wholeNumber(e.target.value, 1, 50) })}
              />{" "}
              or more different years.
            </label>{" "}
            Your own ticks and unticks always win.
          </p>
          {rows.length === 0 ? (
            <p className={styles.muted}>{query.trim() ? "No one matches." : show === "close" ? "No close people yet. Choose Everyone to tick people." : "No one found in your Sent mail."}</p>
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
          {rows.length > 0 && (
            <p className={styles.muted}>
              Showing {Math.min(shown, rows.length).toLocaleString()} of {rows.length.toLocaleString()}
              {show === "close" ? " close people" : " people"}
            </p>
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
