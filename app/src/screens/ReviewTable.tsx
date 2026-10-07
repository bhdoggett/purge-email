import { type KeyboardEvent, type MouseEvent, useLayoutEffect, useRef, useState } from "react";
import { MAYBE } from "@core/labels.ts";
import { EMPTY_SELECTION, select, selectAll, type Selection, type TableRow } from "./reviewTable.ts";
import styles from "./ReviewTable.module.css";

const ROW_HEIGHT = 40;
/** Extra rows rendered above and below the visible ones, so fast scrolling doesn't flash blank space. */
const OVERSCAN = 10;
/** Rows assumed visible before the container has been measured. */
const FALLBACK_VISIBLE = 15;

function formatDate(ms: number): string {
  return Number.isNaN(ms) ? "—" : new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short" });
}

function LabelCell({ row }: { row: TableRow }) {
  return (
    <>
      {row.slug === null ? (
        <>
          <span className={styles.keep}>Keep</span>
          {row.suggested !== null && <span className={styles.suggested}> · {row.suggested}?</span>}
        </>
      ) : (
        <span className={row.slug === MAYBE ? styles.maybe : styles.purge}>{row.slug}</span>
      )}
      {row.overridden && <span className={styles.changed}>changed</span>}
    </>
  );
}

interface Props {
  /** The filtered rows, in display order. */
  rows: TableRow[];
  selection: Selection;
  onSelectionChange: (next: Selection) => void;
}

export function ReviewTable({ rows, selection, onSelectionChange }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewHeight, setViewHeight] = useState(FALLBACK_VISIBLE * ROW_HEIGHT);
  const hasRows = rows.length > 0;

  // The scroll container only exists while there are rows, so measure again when it appears.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setViewHeight(el.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasRows]);

  // A shorter list can clamp the scroll position without a scroll event: read it back.
  useLayoutEffect(() => {
    if (scroller.current) setScrollTop(scroller.current.scrollTop);
  }, [rows]);

  const visibleCount = Math.ceil(viewHeight / ROW_HEIGHT);
  const first = Math.floor(scrollTop / ROW_HEIGHT);
  const start = Math.max(0, first - OVERSCAN);
  const end = Math.min(rows.length, first + visibleCount + OVERSCAN);
  const slice = rows.slice(start, end);

  const allSelected = rows.length > 0 && rows.every((r) => selection.ids.has(r.id));

  function onRowClick(e: MouseEvent, index: number) {
    onSelectionChange(select(selection, rows, index, { shift: e.shiftKey, meta: e.metaKey || e.ctrlKey }));
  }

  function onKeyDown(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") {
      e.preventDefault();
      onSelectionChange(selectAll(rows));
    }
  }

  return (
    <div className={styles.table} role="grid" aria-multiselectable="true" aria-rowcount={rows.length + 1} onKeyDown={onKeyDown}>
      <div className={`${styles.row} ${styles.head}`} role="row" aria-rowindex={1}>
        <span className={styles.check} role="columnheader">
          <input
            type="checkbox"
            className={styles.checkbox}
            aria-label="Select every email shown"
            checked={allSelected}
            disabled={rows.length === 0}
            onChange={() => onSelectionChange(allSelected ? EMPTY_SELECTION : selectAll(rows))}
          />
        </span>
        <span className={styles.cell} role="columnheader">Sender</span>
        <span className={styles.cell} role="columnheader">Subject</span>
        <span className={`${styles.cell} ${styles.date}`} role="columnheader">Date</span>
        <span className={styles.cell} role="columnheader">Label</span>
        <span className={`${styles.cell} ${styles.reason}`} role="columnheader">Reason</span>
      </div>

      {!hasRows ? (
        <p className={styles.empty}>No emails match these filters.</p>
      ) : (
        <div ref={scroller} className={styles.scroller} tabIndex={0} aria-label="Scanned emails" onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
          <div className={styles.spacer} style={{ height: rows.length * ROW_HEIGHT }}>
            <div style={{ transform: `translateY(${start * ROW_HEIGHT}px)` }}>
              {slice.map((row, i) => {
                const index = start + i;
                const selected = selection.ids.has(row.id);
                return (
                  <div
                    key={row.id}
                    className={`${styles.row} ${selected ? styles.selected : ""}`}
                    role="row"
                    aria-rowindex={index + 2}
                    aria-selected={selected}
                    onMouseDown={(e) => {
                      if (e.shiftKey) e.preventDefault();
                    }}
                    onClick={(e) => onRowClick(e, index)}
                  >
                    <span className={styles.check} role="gridcell">
                      <input
                        type="checkbox"
                        className={styles.checkbox}
                        aria-label={`Select email from ${row.from}`}
                        checked={selected}
                        onClick={(e) => e.stopPropagation()}
                        onChange={() => onSelectionChange(select(selection, rows, index, { shift: false, meta: true }))}
                      />
                    </span>
                    <span className={`${styles.cell} ${styles.from}`} role="gridcell" title={row.from}>{row.from}</span>
                    <span className={styles.cell} role="gridcell" title={row.subject}>{row.subject}</span>
                    <span className={`${styles.cell} ${styles.date}`} role="gridcell">{formatDate(row.date)}</span>
                    <span className={styles.cell} role="gridcell"><LabelCell row={row} /></span>
                    <span className={`${styles.cell} ${styles.reason} ${styles.muted}`} role="gridcell" title={row.reason}>{row.reason}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
