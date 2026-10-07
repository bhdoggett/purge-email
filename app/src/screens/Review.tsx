import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { APPLYING_HINT, isApplying, useApplier } from "../useApplier.ts";
import { COUNTING_HINT, isCounting, useCounter } from "../useCounter.ts";
import type { Answers } from "@core/questions.ts";
import type { Settings } from "@core/decide.ts";
import { MAYBE, needsRescan, SLUG_NAMES } from "@core/labels.ts";
import type { Screen } from "../App.tsx";
import { AgeInput } from "../components/AgeInput.tsx";
import { Button } from "../components/Button.tsx";
import type { Summary } from "../gmail/client.ts";
import { loadCloseSet } from "../scan/closeness.ts";
import { DEV_SCAN_LIMIT } from "../scan/progress.ts";
import type { Services } from "../services.ts";
import type { Override } from "../storage/db.ts";
import {
  buildTableRows,
  type DecisionFilter,
  EMPTY_SELECTION,
  type AttachmentFilter,
  type Filters,
  filterRows,
  NO_FILTERS,
  pruneSelection,
  selectAll,
  type Selection,
  suggestedOverrides,
} from "./reviewTable.ts";
import { ReviewTable } from "./ReviewTable.tsx";
import styles from "./Review.module.css";

interface Loaded {
  settings: Settings;
  /** When the scan was loaded: the moment ages are measured from, so rows don't shift while the screen is open. */
  now: number;
  /** No finished scan, e.g. after Settings → Clear scan data. */
  noscan: boolean;
  rescan: boolean;
  ids: string[];
  summaries: Map<string, Summary>;
  answers: Map<string, Answers>;
  /** The user's close people when the scan was loaded. */
  close: Set<string>;
}

const DECISIONS: { id: DecisionFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "purge", label: "Purge" },
  { id: "maybe", label: "Maybe" },
  { id: "keep", label: "Keep" },
  { id: "changed", label: "Changed by you" },
];

/** Categories for the filter and "Move to": the kinds, then trivial personal mail. */
const KINDS = SLUG_NAMES;

const SAVE_FAILED = "Couldn't save your change. Try again.";

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** True when keys typed now go into a text field, where Cmd-A should select its text. */
function typingInField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  return target instanceof HTMLInputElement && target.type !== "checkbox";
}

export function Review({ services, go, onNext }: { services: Services; go: (s: Screen) => void; onNext: () => void }) {
  const { store, engine } = services;
  const applying = isApplying(useApplier(services.applier));
  const counting = isCounting(useCounter(services.counter));
  const [data, setData] = useState<Loaded | null>(null);
  const [overrides, setOverrides] = useState<Map<string, Override>>(new Map());
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoadError(null);
    try {
      const settings = await store.getSettings();
      const scan = await store.getScan();
      const [summaries, answers, saved, close] = await Promise.all([store.allSummaries(), store.allAnswers(), store.allOverrides(), loadCloseSet(store)]);
      setOverrides(saved);
      setData({
        settings,
        now: Date.now(),
        noscan: !scan?.finished || !scan.settingsAtScan,
        rescan: !!scan?.settingsAtScan && needsRescan(scan.settingsAtScan, settings),
        ids: scan?.candidateIds ?? [],
        summaries,
        answers,
        close,
      });
    } catch (e) {
      setLoadError(`Could not load your scan. ${errorText(e)}`);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const rows = useMemo(() => (data ? buildTableRows(data.ids, data.summaries, data.answers, overrides, data.settings, data.now, data.close) : []), [data, overrides]);
  const filtered = useMemo(() => filterRows(rows, filters, data?.now ?? Date.now()), [rows, filters, data]);
  // An action can move selected rows out of the filtered list (e.g. "Undo my change" under "Changed by you").
  // Drop them before paint so the next action never changes an email the person can't see.
  // Filter changes already clear the selection, so this only bites after an action rebuilds the rows.
  useLayoutEffect(() => {
    setSelection((s) => pruneSelection(s, filtered));
  }, [filtered]);

  // Cmd/Ctrl-A selects every email shown, wherever focus is on this screen, except in a text field.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "a" || typingInField(e.target)) return;
      e.preventDefault();
      setSelection(selectAll(filtered));
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [filtered]);

  function changeFilters(next: Partial<Filters>) {
    setFilters((f) => ({ ...f, ...next }));
    setSelection(EMPTY_SELECTION);
  }

  /** Saves overrides, then applies `update` to the in-memory map. On failure the table stays as it was. */
  async function save(write: () => Promise<void>, update: (m: Map<string, Override>) => void, done: string | null = null) {
    if (saving) return;
    setSaving(true);
    setStatus(null);
    setError(null);
    try {
      await write();
      setOverrides((prev) => {
        const next = new Map(prev);
        update(next);
        return next;
      });
      setStatus(done);
    } catch {
      setError(SAVE_FAILED);
    } finally {
      setSaving(false);
    }
  }

  function setSlug(slug: string | null) {
    const ids = [...selection.ids];
    const at = Date.now();
    void save(
      () => store.putOverrides(ids, slug, at),
      (m) => {
        for (const id of ids) m.set(id, { id, slug, at });
      },
    );
  }

  function applySuggested() {
    const { list, skipped } = suggestedOverrides(rows, selection.ids, Date.now());
    void save(
      () => store.putOverrideList(list),
      (m) => {
        for (const o of list) m.set(o.id, o);
      },
      skipped > 0 ? `${skipped.toLocaleString()} had no suggestion and were left as they were.` : null,
    );
  }

  function undo() {
    const ids = [...selection.ids];
    void save(
      () => store.deleteOverrides(ids),
      (m) => {
        for (const id of ids) m.delete(id);
      },
    );
  }

  function rescan() {
    if (!data) return;
    if (engine.isBusy() || services.counter.busy()) {
      setError("Another job is running. Wait for it to finish.");
      return;
    }
    void engine.start(data.settings, { limit: DEV_SCAN_LIMIT });
    go("scan");
  }

  if (!data) {
    return loadError ? (
      <section className={styles.review}>
        <p className={styles.error} role="alert">{loadError}</p>
        <Button onClick={() => void load()}>Try again</Button>
      </section>
    ) : (
      <p className={styles.loading}>Loading your scan…</p>
    );
  }

  if (data.noscan) {
    return (
      <section className={styles.review}>
        <h1 className={styles.heading}>No scan yet</h1>
        <p className={styles.lede}>Scan your mail first.</p>
        <Button onClick={() => go("rules")}>Back to rules</Button>
      </section>
    );
  }

  if (data.rescan) {
    return (
      <section className={styles.review}>
        <h1 className={styles.heading}>Rescan needed</h1>
        <p className={styles.lede}>You lowered the age or turned off a protection under "Always keep", so some emails were never scanned. Only a new scan finds them.</p>
        <Button disabled={applying || counting} title={applying ? APPLYING_HINT : counting ? COUNTING_HINT : undefined} onClick={rescan}>Rescan</Button>
        {error && <p className={styles.error} role="alert">{error}</p>}
      </section>
    );
  }

  const count = selection.ids.size;

  return (
    <section className={styles.review}>
      <h1 className={styles.heading}>Review before labeling</h1>
      <p className={styles.lede}>Changes here stay on this computer until you apply them. Change any label here, then go to Apply. Changes cost nothing and don't run Jev again.</p>

      <div className={styles.filters}>
        <div className={styles.segmented} role="group" aria-label="Decision">
          {DECISIONS.map((d) => (
            <button key={d.id} type="button" className={styles.segment} aria-pressed={filters.decision === d.id} onClick={() => changeFilters({ decision: d.id })}>
              {d.label}
            </button>
          ))}
        </div>
        <select className={styles.control} aria-label="Category" value={filters.slug} onChange={(e) => changeFilters({ slug: e.target.value })}>
          <option value="all">All categories</option>
          {KINDS.map((k) => (
            <option key={k.slug} value={k.slug}>{k.label}</option>
          ))}
        </select>
        <select className={styles.control} aria-label="Attachments" value={filters.attachments} onChange={(e) => changeFilters({ attachments: e.target.value as AttachmentFilter })}>
          <option value="all">With or without attachments</option>
          <option value="with">With attachments</option>
          <option value="without">Without attachments</option>
        </select>
        <input
          type="search"
          className={`${styles.control} ${styles.search}`}
          placeholder="Search sender, subject or file name"
          aria-label="Search sender, subject or file name"
          value={filters.text}
          onChange={(e) => changeFilters({ text: e.target.value })}
        />
        <AgeInput className={styles.ageFilter} months={filters.olderThanMonths} zero="placeholder" onChange={(olderThanMonths) => changeFilters({ olderThanMonths })} />
        <p className={styles.count} role="status">
          Showing {filtered.length.toLocaleString()} of {rows.length.toLocaleString()}
        </p>
      </div>

      {count > 0 && (
        <div className={styles.actionBar} role="toolbar" aria-label="Change the selected emails">
          <span className={styles.selectedCount}>{count.toLocaleString()} selected</span>
          <Button variant="secondary" disabled={saving} onClick={applySuggested}>Use suggested label</Button>
          <select
            className={styles.control}
            aria-label="Move to"
            value=""
            disabled={saving}
            onChange={(e) => {
              if (e.target.value) setSlug(e.target.value);
            }}
          >
            <option value="">Move to…</option>
            {KINDS.map((k) => (
              <option key={k.slug} value={k.slug}>{k.label}</option>
            ))}
          </select>
          <Button variant="secondary" disabled={saving} onClick={() => setSlug(MAYBE)}>Maybe</Button>
          <Button variant="secondary" disabled={saving} onClick={() => setSlug(null)}>Keep (no label)</Button>
          <Button variant="secondary" disabled={saving} onClick={undo}>Undo my change</Button>
          <Button variant="secondary" onClick={() => setSelection(EMPTY_SELECTION)}>Clear selection</Button>
        </div>
      )}
      {status && <p className={styles.status} role="status">{status}</p>}
      {error && <p className={styles.error} role="alert">{error}</p>}

      <ReviewTable rows={filtered} selection={selection} onSelectionChange={setSelection} />

      <div className={styles.next}>
        <Button onClick={onNext}>Next: Apply labels</Button>
      </div>
    </section>
  );
}
