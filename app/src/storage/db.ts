import { type DBSchema, openDB } from "idb";
import { DEFAULT_SETTINGS, normalizeSettings, type Settings } from "@core/decide.ts";
import type { Answers } from "@core/questions.ts";
import type { Summary } from "../gmail/client.ts";

export interface LabelRecord {
  id: string;
  label: string;
  labeledAt: number;
  userRemoved: boolean;
  userChosen: boolean;
}

/** The user's own label choice for one email, made on the Review screen. `slug` null means keep, no label. */
export interface Override {
  id: string;
  slug: string | null;
  at: number;
}

export interface ScanRecord {
  ageMonths: number;
  /** Settings the candidate list was built with; missing on scans saved before category labels. */
  settings?: Settings;
  candidateIds: string[];
  repliedThreadIds: string[];
  finished: boolean;
  startedAt: number;
  /** Rules the finished scan's candidate list covers; set only when a scan finishes, null until then. */
  settingsAtScan: Settings | null;
  /** Measured average ms per email for emails that needed Gmail and Jev calls. */
  msPerEmail: number | null;
}

interface PurgeDB extends DBSchema {
  summaries: { key: string; value: Summary };
  answers: { key: string; value: Answers };
  labels: { key: string; value: LabelRecord };
  kv: { key: string; value: unknown };
  overrides: { key: string; value: Override };
}

export interface Store {
  getSummary(id: string): Promise<Summary | undefined>;
  putSummary(s: Summary): Promise<void>;
  getAnswers(id: string): Promise<Answers | undefined>;
  putAnswers(id: string, a: Answers): Promise<void>;
  allSummaries(): Promise<Map<string, Summary>>;
  allAnswers(): Promise<Map<string, Answers>>;
  allLabels(): Promise<Map<string, LabelRecord>>;
  putLabels(recs: LabelRecord[]): Promise<void>;
  deleteLabels(ids: string[]): Promise<void>;
  getSettings(): Promise<Settings>;
  putSettings(s: Settings): Promise<void>;
  getScan(): Promise<ScanRecord | null>;
  putScan(s: ScanRecord): Promise<void>;
  getWizard(): Promise<number[]>;
  putWizard(done: number[]): Promise<void>;
  allOverrides(): Promise<Map<string, Override>>;
  putOverrides(ids: string[], slug: string | null, at: number): Promise<void>;
  putOverrideList(list: Override[]): Promise<void>;
  deleteOverrides(ids: string[]): Promise<void>;
  /** Forgets summaries, Jev answers, and the scan. Keeps label records and overrides so the user's choices are remembered. */
  clearScanData(): Promise<void>;
}

type StoredSettings = Partial<Settings> & { years?: number };
/** A scan as saved by any version; older ones carry `years` instead of `ageMonths`. */
type StoredScan = Omit<ScanRecord, "ageMonths" | "settings" | "settingsAtScan"> & {
  ageMonths?: number;
  years?: number;
  settings?: StoredSettings;
  settingsAtScan: StoredSettings | null;
};

function normalizeScan(raw: StoredScan, defaults: Settings): ScanRecord {
  const { years, ageMonths, settings, settingsAtScan, ...rest } = raw;
  const scan: ScanRecord = {
    ...rest,
    ageMonths: ageMonths ?? (typeof years === "number" ? years * 12 : defaults.ageMonths),
    settingsAtScan: settingsAtScan ? normalizeSettings(settingsAtScan, defaults) : null,
  };
  if (settings) scan.settings = normalizeSettings(settings, defaults);
  return scan;
}

export async function openStore(name = "purge-email", defaults: Settings = DEFAULT_SETTINGS): Promise<Store> {
  const db = await openDB<PurgeDB>(name, 3, {
    async upgrade(db, oldVersion, _newVersion, tx) {
      if (oldVersion < 1) {
        db.createObjectStore("summaries", { keyPath: "id" });
        db.createObjectStore("answers");
        db.createObjectStore("labels", { keyPath: "id" });
        db.createObjectStore("kv");
      } else if (oldVersion < 2) {
        // v1 records have no `label`; they only exist from development, so drop them.
        await tx.objectStore("labels").clear();
      }
      if (oldVersion < 3) db.createObjectStore("overrides", { keyPath: "id" });
    },
  });

  async function allAsMap<K extends "answers">(store: K) {
    const tx = db.transaction(store);
    const map = new Map<string, PurgeDB[K]["value"]>();
    for (let cursor = await tx.store.openCursor(); cursor; cursor = await cursor.continue()) {
      map.set(cursor.key as string, cursor.value);
    }
    return map;
  }

  return {
    getSummary: (id) => db.get("summaries", id),
    putSummary: async (s) => void (await db.put("summaries", s)),
    getAnswers: (id) => db.get("answers", id),
    putAnswers: async (id, a) => void (await db.put("answers", a, id)),
    allSummaries: async () => new Map((await db.getAll("summaries")).map((s) => [s.id, s])),
    allAnswers: () => allAsMap("answers"),
    allLabels: async () => new Map((await db.getAll("labels")).map((l) => [l.id, l])),
    async putLabels(recs) {
      const tx = db.transaction("labels", "readwrite");
      await Promise.all([...recs.map((r) => tx.store.put(r)), tx.done]);
    },
    async deleteLabels(ids) {
      const tx = db.transaction("labels", "readwrite");
      await Promise.all([...ids.map((id) => tx.store.delete(id)), tx.done]);
    },
    getSettings: async () => normalizeSettings(((await db.get("kv", "settings")) as StoredSettings | undefined) ?? {}, defaults),
    putSettings: async (s) => void (await db.put("kv", s, "settings")),
    getScan: async () => {
      const raw = (await db.get("kv", "scan")) as StoredScan | undefined;
      return raw ? normalizeScan(raw, defaults) : null;
    },
    putScan: async (s) => void (await db.put("kv", s, "scan")),
    getWizard: async () => ((await db.get("kv", "wizard")) as number[] | undefined) ?? [],
    putWizard: async (done) => void (await db.put("kv", done, "wizard")),
    allOverrides: async () => new Map((await db.getAll("overrides")).map((o) => [o.id, o])),
    async putOverrides(ids, slug, at) {
      const tx = db.transaction("overrides", "readwrite");
      await Promise.all([...ids.map((id) => tx.store.put({ id, slug, at })), tx.done]);
    },
    async putOverrideList(list) {
      const tx = db.transaction("overrides", "readwrite");
      await Promise.all([...list.map((o) => tx.store.put(o)), tx.done]);
    },
    async deleteOverrides(ids) {
      const tx = db.transaction("overrides", "readwrite");
      await Promise.all([...ids.map((id) => tx.store.delete(id)), tx.done]);
    },
    async clearScanData() {
      const tx = db.transaction(["summaries", "answers", "kv"], "readwrite");
      await Promise.all([
        tx.objectStore("summaries").clear(),
        tx.objectStore("answers").clear(),
        tx.objectStore("kv").delete("scan"),
        tx.done,
      ]);
    },
  };
}
