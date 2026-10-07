import { useEffect, useState } from "react";
import { type Settings, type Strictness } from "@core/decide.ts";
import { needsRescan, validatePrefix } from "@core/labels.ts";
import { PROTECTS, PURGE_KINDS } from "@core/questions.ts";
import { AgeInput } from "../components/AgeInput.tsx";
import { Button } from "../components/Button.tsx";
import { Checkbox } from "../components/Checkbox.tsx";
import { formatDuration, formatUsd, labelPreview } from "../format.ts";
import { estimate } from "../scan/estimate.ts";
import { DEV_SCAN_LIMIT } from "../scan/progress.ts";
import { prefixInUseByUser } from "../scan/reconcile.ts";
import type { ScanRecord } from "../storage/db.ts";
import type { Services } from "../services.ts";
import { useProgress } from "../useProgress.ts";
import type { Screen } from "../App.tsx";
import styles from "./Rules.module.css";

const STRICTNESS_COPY: { id: Strictness; label: string; description: string }[] = [
  { id: "careful", label: "Careful", description: "Only label mail Jev is very sure about. Protects anything that might matter." },
  { id: "balanced", label: "Balanced", description: "The default." },
  { id: "aggressive", label: "Aggressive", description: "Label more. Protect only what is clearly worth keeping." },
];

export function Rules({ services, go }: { services: Services; go: (s: Screen) => void }) {
  const progress = useProgress(services.engine);
  const busy = services.engine.isBusy();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [scan, setScan] = useState<ScanRecord | null>(null);
  const [est, setEst] = useState<Awaited<ReturnType<typeof estimate>> | null>(null);
  const [estError, setEstError] = useState<string | null>(null);
  const [prefixDraft, setPrefixDraft] = useState<string | null>(null);
  const [limit, setLimit] = useState<number | undefined>(DEV_SCAN_LIMIT);
  const [foreignPrefix, setForeignPrefix] = useState(false);

  useEffect(() => {
    void services.store.getSettings().then(setSettings);
    void services.store.getScan().then(setScan);
  }, [services.store, progress.stage]);

  useEffect(() => {
    if (!settings) return;
    setEst(null);
    setEstError(null);
    estimate(services, settings, limit).then(setEst, (e) => setEstError(e instanceof Error ? e.message : String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [services, settings?.ageMonths, settings?.keepAttachments, settings?.keepStarred, limit]);

  // Warn when the chosen name's labels already hold mail the app didn't label. Waits for typing to pause.
  useEffect(() => {
    if (!settings) return;
    const prefix = settings.labelPrefix;
    let current = true;
    setForeignPrefix(false);
    const timer = setTimeout(() => {
      services.store
        .allLabels()
        .then((records) => prefixInUseByUser(services.gmail, records, prefix))
        .then((inUse) => current && setForeignPrefix(inUse))
        .catch(() => {});
    }, 400);
    return () => {
      current = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [services, settings?.labelPrefix]);

  if (!settings) return null;

  const update = (patch: Partial<Settings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    void services.store.putSettings(next);
  };
  const prefixText = prefixDraft ?? settings.labelPrefix;
  const prefixError = validatePrefix(prefixText);
  const changePrefix = (value: string) => {
    setPrefixDraft(value);
    if (validatePrefix(value) === null) update({ labelPrefix: value.trim() });
  };
  const toggle = <T,>(list: T[], item: T, on: boolean) => (on ? [...list, item] : list.filter((x) => x !== item));
  // A limited scan always builds a fresh candidate list, so it never resumes.
  const resumable = !limit && !!scan && !scan.finished && !!scan.settings && !needsRescan(scan.settings, settings);

  const startScan = () => {
    void services.engine.start(settings, { limit });
    go("scan");
  };

  return (
    <section className={styles.rules}>
      <h1 className={styles.heading}>What should Jev label?</h1>
      {busy && (
        <p className={styles.note}>
          A scan is running, so rules are locked. <button type="button" className={styles.linkButton} onClick={() => go("scan")}>See progress</button>
        </p>
      )}

      <div className={styles.columns}>
        <fieldset className={styles.group} disabled={busy}>
          <legend className={styles.legend}>Label these for purging</legend>
          {PURGE_KINDS.map((k) => (
            <Checkbox key={k.id} label={k.label} description={k.examples} checked={settings.purgeKinds.includes(k.id)} onChange={(on) => update({ purgeKinds: toggle(settings.purgeKinds, k.id, on) })} />
          ))}
        </fieldset>

        <fieldset className={styles.group} disabled={busy}>
          <legend className={styles.legend}>Always keep</legend>
          {PROTECTS.map((p) => (
            <Checkbox key={p.id} label={p.label} description={p.examples} checked={settings.protects.includes(p.id)} onChange={(on) => update({ protects: toggle(settings.protects, p.id, on) })} />
          ))}
          <Checkbox label="Emails with attachments" checked={settings.keepAttachments} onChange={(on) => update({ keepAttachments: on })} />
          {!settings.keepAttachments && <p className={styles.choiceNote}>Jev will also judge these. File names are sent, never the files.</p>}
          <Checkbox label="Starred emails" checked={settings.keepStarred} onChange={(on) => update({ keepStarred: on })} />
          {!settings.keepStarred && <p className={styles.choiceNote}>Starred emails can be labeled too.</p>}
        </fieldset>
      </div>

      <fieldset className={styles.group} disabled={busy}>
        <legend className={styles.legend}>How sure should Jev be?</legend>
        <div className={styles.segmented} role="radiogroup">
          {STRICTNESS_COPY.map((s) => (
            <label key={s.id} className={[styles.segment, settings.strictness === s.id && styles.segmentOn].filter(Boolean).join(" ")}>
              <input type="radio" name="strictness" value={s.id} checked={settings.strictness === s.id} onChange={() => update({ strictness: s.id })} />
              <span className={styles.segmentLabel}>{s.label}</span>
              <span className={styles.segmentDescription}>{s.description}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className={styles.labelName}>
        <label className={styles.labelNameField}>
          Label name
          <input
            type="text"
            value={prefixText}
            disabled={busy}
            maxLength={80}
            aria-invalid={prefixError !== null}
            aria-describedby="label-name-help"
            onChange={(e) => changePrefix(e.target.value)}
          />
        </label>
        <div id="label-name-help">
          {prefixError && <p className={styles.fieldError} role="alert">{prefixError}</p>}
          {!prefixError && <p className={styles.preview}>{labelPreview(prefixText)}</p>}
          {!prefixError && foreignPrefix && (
            <p className={styles.fieldError} role="alert">
              Labels under '{settings.labelPrefix}' already exist in your Gmail. Pick a different name so the app doesn't mix with your own labels.
            </p>
          )}
        </div>
      </div>

      <div className={styles.footer}>
        <AgeInput months={settings.ageMonths} disabled={busy} onChange={(ageMonths) => update({ ageMonths })} />
        {import.meta.env.DEV && (
          <label className={styles.age}>
            Limit (dev)
            <input type="number" min={1} value={limit ?? ""} onChange={(e) => setLimit(e.target.value ? Number(e.target.value) : undefined)} />
          </label>
        )}
        <p className={styles.estimate} aria-live="polite">
          {estError
            ? `Couldn't estimate: ${estError}`
            : est
              ? `${est.count.toLocaleString()} emails · about ${formatUsd(est.costUsd)} · about ${formatDuration(est.ms)}`
              : "Counting emails…"}
        </p>
        <Button disabled={busy || est?.count === 0 || prefixError !== null} onClick={startScan}>
          {resumable ? "Resume scan" : "Start scan"}
        </Button>
      </div>
    </section>
  );
}
