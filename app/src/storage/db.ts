import { type DBSchema, type IDBPDatabase, openDB } from "idb";
import { DEFAULT_SETTINGS, normalizeSettings, type Settings } from "@core/decide.ts";
import type { Answers } from "@core/questions.ts";
import type { Summary } from "../gmail/client.ts";
import { decryptJson, encryptJson, isSealed, type Sealed } from "./crypto.ts";

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

/** A summary at rest: everything but the id is encrypted. */
type SealedSummary = Sealed & { id: string };

/** The AES-GCM key for summaries and answers, or a function that returns the current one. */
export type KeySource = CryptoKey | (() => Promise<CryptoKey>);

interface PurgeDB extends DBSchema {
  /** Plaintext `Summary` records only exist until the version 4 migration rewrites them. */
  summaries: { key: string; value: SealedSummary | Summary };
  answers: { key: string; value: Sealed | Answers };
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

/** Records read, encrypted, and written per transaction by the plaintext migration. */
const MIGRATION_BATCH = 500;
/** Records decrypted concurrently when loading everything. */
const DECRYPT_CHUNK = 2000;

/** Decrypts a stored record; a record the key can't open counts as missing. Plaintext is passed through. */
async function unseal<T>(key: CryptoKey, stored: Sealed | T | undefined): Promise<T | undefined> {
  if (stored === undefined || !isSealed(stored)) return stored;
  try {
    return await decryptJson<T>(key, stored);
  } catch {
    return undefined;
  }
}

async function unsealSummary(key: CryptoKey, stored: SealedSummary | Summary | undefined): Promise<Summary | undefined> {
  if (!isSealed(stored)) return stored;
  const rest = await unseal<Omit<Summary, "id">>(key, stored);
  return rest && ({ id: stored.id, ...rest } as Summary);
}

async function sealSummary(key: CryptoKey, s: Summary): Promise<SealedSummary> {
  const { id, ...rest } = s;
  return { id, ...(await encryptJson(key, rest)) };
}

/** Decrypts in chunks of concurrent WebCrypto calls, dropping records that can't be read. */
async function unsealAll<S, T>(items: [string, S][], open: (s: S) => Promise<T | undefined>): Promise<Map<string, T>> {
  const map = new Map<string, T>();
  for (let i = 0; i < items.length; i += DECRYPT_CHUNK) {
    const chunk = items.slice(i, i + DECRYPT_CHUNK);
    const values = await Promise.all(chunk.map(([, s]) => open(s)));
    values.forEach((v, j) => v !== undefined && map.set(chunk[j]![0], v));
  }
  return map;
}

/**
 * Rewrites plaintext summaries and answers (from version 3 and earlier) encrypted, a batch per
 * transaction. WebCrypto can't run inside the upgrade transaction, so this runs after open.
 * Each batch commits on its own, so an interrupted run leaves a mix that the next run finishes.
 */
async function encryptPlaintext(db: IDBPDatabase<PurgeDB>, key: CryptoKey) {
  if ((await db.get("kv", "encrypted")) === true) return;
  for (const name of ["summaries", "answers"] as const) {
    let after: string | undefined;
    for (let finished = false; !finished; ) {
      const plain: [string, Summary | Answers][] = [];
      const read = db.transaction(name);
      let cursor = await read.store.openCursor(after === undefined ? undefined : IDBKeyRange.lowerBound(after, true));
      for (; cursor && plain.length < MIGRATION_BATCH; cursor = await cursor.continue()) {
        after = cursor.key;
        if (!isSealed(cursor.value)) plain.push([cursor.key, cursor.value]);
      }
      finished = !cursor;
      await read.done;
      if (plain.length === 0) continue;
      if (name === "summaries") {
        const sealed = await Promise.all(plain.map(([, v]) => sealSummary(key, v as Summary)));
        const tx = db.transaction("summaries", "readwrite");
        await Promise.all([...sealed.map((r) => tx.store.put(r)), tx.done]);
      } else {
        const sealed = await Promise.all(plain.map(([, v]) => encryptJson(key, v)));
        const tx = db.transaction("answers", "readwrite");
        await Promise.all([...sealed.map((r, i) => tx.store.put(r, plain[i]![0])), tx.done]);
      }
    }
  }
  await db.put("kv", true, "encrypted");
}

export async function openStore(key: KeySource, name = "purge-email", defaults: Settings = DEFAULT_SETTINGS): Promise<Store> {
  const getKey = typeof key === "function" ? key : () => Promise.resolve(key);
  const db = await openDB<PurgeDB>(name, 4, {
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
      // Version 4 encrypts summaries and answers; encryptPlaintext does it once the database is open.
    },
  });
  await encryptPlaintext(db, await getKey());

  async function allAnswers() {
    const tx = db.transaction("answers");
    const items: [string, Sealed | Answers][] = [];
    for (let cursor = await tx.store.openCursor(); cursor; cursor = await cursor.continue()) {
      items.push([cursor.key, cursor.value]);
    }
    const k = await getKey();
    return unsealAll(items, (a) => unseal<Answers>(k, a));
  }

  return {
    getSummary: async (id) => unsealSummary(await getKey(), await db.get("summaries", id)),
    putSummary: async (s) => void (await db.put("summaries", await sealSummary(await getKey(), s))),
    getAnswers: async (id) => unseal<Answers>(await getKey(), await db.get("answers", id)),
    putAnswers: async (id, a) => void (await db.put("answers", await encryptJson(await getKey(), a), id)),
    async allSummaries() {
      const items = (await db.getAll("summaries")).map((s): [string, SealedSummary | Summary] => [s.id, s]);
      const k = await getKey();
      return unsealAll(items, (s) => unsealSummary(k, s));
    },
    allAnswers,
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
