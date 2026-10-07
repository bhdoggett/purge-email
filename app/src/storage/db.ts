import { type DBSchema, openDB } from "idb";
import { DEFAULT_SETTINGS, type Settings } from "@core/decide.ts";
import type { Answers } from "@core/questions.ts";
import type { Summary } from "../gmail/client.ts";

export interface LabelRecord {
  id: string;
  labeledByApp: true;
  userRemoved: boolean;
}

export interface ScanRecord {
  years: number;
  candidateIds: string[];
  repliedThreadIds: string[];
  finished: boolean;
  startedAt: number;
  /** Settings the labels currently in Gmail were computed with; null until a scan finishes. */
  settingsAtScan: Settings | null;
  /** Measured average ms per email for emails that needed Gmail and Jev calls. */
  msPerEmail: number | null;
}

interface PurgeDB extends DBSchema {
  summaries: { key: string; value: Summary };
  answers: { key: string; value: Answers };
  labels: { key: string; value: LabelRecord };
  kv: { key: string; value: unknown };
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
  getSettings(): Promise<Settings>;
  putSettings(s: Settings): Promise<void>;
  getScan(): Promise<ScanRecord | null>;
  putScan(s: ScanRecord): Promise<void>;
  getWizard(): Promise<number[]>;
  putWizard(done: number[]): Promise<void>;
  clearScanData(): Promise<void>;
}

export async function openStore(name = "purge-email"): Promise<Store> {
  const db = await openDB<PurgeDB>(name, 1, {
    upgrade(db) {
      db.createObjectStore("summaries", { keyPath: "id" });
      db.createObjectStore("answers");
      db.createObjectStore("labels", { keyPath: "id" });
      db.createObjectStore("kv");
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
    getSettings: async () => ((await db.get("kv", "settings")) as Settings | undefined) ?? DEFAULT_SETTINGS,
    putSettings: async (s) => void (await db.put("kv", s, "settings")),
    getScan: async () => ((await db.get("kv", "scan")) as ScanRecord | undefined) ?? null,
    putScan: async (s) => void (await db.put("kv", s, "scan")),
    getWizard: async () => ((await db.get("kv", "wizard")) as number[] | undefined) ?? [],
    putWizard: async (done) => void (await db.put("kv", done, "wizard")),
    async clearScanData() {
      const tx = db.transaction(["summaries", "answers", "labels", "kv"], "readwrite");
      await Promise.all([
        tx.objectStore("summaries").clear(),
        tx.objectStore("answers").clear(),
        tx.objectStore("labels").clear(),
        tx.objectStore("kv").delete("scan"),
        tx.done,
      ]);
    },
  };
}
