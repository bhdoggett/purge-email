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

/** How often the user wrote to one address, counted from their Sent mail. */
export interface SenderStat {
  /** Lowercase email address. */
  address: string;
  /** The newest non-empty display name seen for the address. */
  name: string;
  /** Date (ms) of the email `name` came from; 0 when unknown. */
  nameAt: number;
  /** Sent emails addressed to them (To or Cc). */
  sent: number;
  /** Distinct calendar years those emails were sent in, ascending. */
  years: number[];
}

/** Counts from the user's Sent mail. Stored encrypted, with the ids already counted so a recount only reads new mail. */
export interface SenderStats {
  /** The account the counts belong to, lowercase. */
  ownAddress: string;
  counted: string[];
  people: SenderStat[];
  /** Every sent email was counted at least once; false while a first count is unfinished. */
  complete: boolean;
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
  /** Counts from Sent mail, or null when never counted (or unreadable). */
  getSenderStats(): Promise<SenderStats | null>;
  putSenderStats(s: SenderStats): Promise<void>;
  /** The user's own Close ticks: address → close or not. Empty when none (or unreadable). */
  getCloseChoices(): Promise<Record<string, boolean>>;
  putCloseChoices(c: Record<string, boolean>): Promise<void>;
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
/** kv entry holding "ok" sealed with the key the saved scan data was written with. */
const KEY_CHECK = "keyCheck";
/** kv entries sealed with the data key; not scan data, so only a key change clears them. */
const SENDER_STATS = "senderStats";
const CLOSE_CHOICES = "closeChoices";

/**
 * Decrypts a stored record bound to `id`; a record the key can't open (wrong key, or moved to
 * another id) counts as missing. Plaintext from before encryption is passed through.
 */
async function unseal<T>(key: CryptoKey, id: string, stored: Sealed | T | undefined): Promise<T | undefined> {
  if (stored === undefined || !isSealed(stored)) return stored;
  try {
    return await decryptJson<T>(key, stored, id);
  } catch {
    return undefined;
  }
}

async function unsealSummary(key: CryptoKey, stored: SealedSummary | Summary | undefined): Promise<Summary | undefined> {
  if (!isSealed(stored)) return stored;
  const rest = await unseal<Omit<Summary, "id">>(key, stored.id, stored);
  return rest && ({ id: stored.id, ...rest } as Summary);
}

async function sealSummary(key: CryptoKey, s: Summary): Promise<SealedSummary> {
  const { id, ...rest } = s;
  return { id, ...(await encryptJson(key, rest, id)) };
}

/** Freezes `value` and everything in it, so a cached value can't be changed by a caller. */
function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

/** Decrypts in chunks of concurrent WebCrypto calls, dropping records that can't be read. */
async function unsealAll<S, T>(items: [string, S][], open: (id: string, s: S) => Promise<T | undefined>): Promise<Map<string, T>> {
  const map = new Map<string, T>();
  for (let i = 0; i < items.length; i += DECRYPT_CHUNK) {
    const chunk = items.slice(i, i + DECRYPT_CHUNK);
    const values = await Promise.all(chunk.map(([id, s]) => open(id, s)));
    values.forEach((v, j) => v !== undefined && map.set(chunk[j]![0], deepFreeze(v)));
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
        const sealed = await Promise.all(plain.map(([id, v]) => encryptJson(key, v, id)));
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

  // Decrypted summaries and answers, loaded on first use and kept current by every write.
  let summaryCache: Promise<Map<string, Summary>> | null = null;
  let answerCache: Promise<Map<string, Answers>> | null = null;

  async function cacheSet<T>(cache: Promise<Map<string, T>> | null, id: string, value: T) {
    if (!cache) return;
    try {
      (await cache).set(id, value);
    } catch {
      // A failed load is dropped and retried by the next read.
    }
  }

  /**
   * Removes summaries, answers and the scan in one transaction; with `check` (a new key), also the
   * close people data, and records the key the data will be written with from now on.
   */
  async function clearScan(check?: Sealed) {
    const tx = db.transaction(["summaries", "answers", "kv"], "readwrite");
    await Promise.all([
      tx.objectStore("summaries").clear(),
      tx.objectStore("answers").clear(),
      tx.objectStore("kv").delete("scan"),
      // A new key can't read the close people data either, so it goes with the scan data.
      ...(check ? [tx.objectStore("kv").put(check, KEY_CHECK), tx.objectStore("kv").delete(SENDER_STATS), tx.objectStore("kv").delete(CLOSE_CHOICES)] : []),
      tx.done,
    ]);
    summaryCache = null;
    answerCache = null;
  }

  /**
   * Makes sure saved scan data belongs to `k`. Data saved under another key (a Keychain reset, or a
   * data folder restored without its key) can never be read again, and a finished scan that points
   * at it would show an empty Review and plan to strip labels, so it is cleared and the scan redone.
   * A database with no check yet (new, or from before encryption) keeps its data.
   */
  async function checkKey(k: CryptoKey) {
    const stored = await db.get("kv", KEY_CHECK);
    let ok = false;
    if (isSealed(stored)) ok = (await unseal<string>(k, KEY_CHECK, stored)) === "ok";
    if (!ok) {
      const check = await encryptJson(k, "ok", KEY_CHECK);
      if (stored === undefined) await db.put("kv", check, KEY_CHECK);
      else await clearScan(check);
    }
    checked = k;
  }

  let checked: CryptoKey | null = null;
  let checking: Promise<void> = Promise.resolve();
  /** The current key, checked against the saved data whenever the provider returns a new one. */
  async function ready(): Promise<CryptoKey> {
    const k = await getKey();
    if (k !== checked) {
      checking = checking.catch(() => {}).then(() => (k === checked ? undefined : checkKey(k)));
      await checking;
    }
    return k;
  }

  await encryptPlaintext(db, await ready());

  function loadSummaries(): Promise<Map<string, Summary>> {
    const load = (async () => {
      const k = await ready();
      const items = (await db.getAll("summaries")).map((s): [string, SealedSummary | Summary] => [s.id, s]);
      return unsealAll(items, (_id, s) => unsealSummary(k, s));
    })();
    load.catch(() => {
      if (summaryCache === load) summaryCache = null;
    });
    return load;
  }

  function loadAnswers(): Promise<Map<string, Answers>> {
    const load = (async () => {
      const k = await ready();
      const tx = db.transaction("answers");
      const items: [string, Sealed | Answers][] = [];
      for (let cursor = await tx.store.openCursor(); cursor; cursor = await cursor.continue()) {
        items.push([cursor.key, cursor.value]);
      }
      return unsealAll(items, (id, a) => unseal<Answers>(k, id, a));
    })();
    load.catch(() => {
      if (answerCache === load) answerCache = null;
    });
    return load;
  }

  /** A kv value sealed with the data key under its own name; missing, plaintext or unreadable reads as undefined. */
  async function getSealedKv<T>(name: string): Promise<T | undefined> {
    const k = await ready();
    const stored = await db.get("kv", name);
    return isSealed(stored) ? unseal<T>(k, name, stored) : undefined;
  }

  async function putSealedKv(name: string, value: unknown): Promise<void> {
    const k = await ready();
    await db.put("kv", await encryptJson(k, value, name), name);
  }

  return {
    getSummary: async (id) => unsealSummary(await ready(), await db.get("summaries", id)),
    async putSummary(s) {
      const k = await ready();
      const value = deepFreeze(structuredClone(s));
      await db.put("summaries", await sealSummary(k, value));
      await cacheSet(summaryCache, value.id, value);
    },
    getAnswers: async (id) => unseal<Answers>(await ready(), id, await db.get("answers", id)),
    async putAnswers(id, a) {
      const k = await ready();
      const value = deepFreeze(structuredClone(a));
      await db.put("answers", await encryptJson(k, value, id), id);
      await cacheSet(answerCache, id, value);
    },
    async allSummaries() {
      await ready();
      summaryCache ??= loadSummaries();
      return new Map(await summaryCache);
    },
    async allAnswers() {
      await ready();
      answerCache ??= loadAnswers();
      return new Map(await answerCache);
    },
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
      await ready(); // a scan saved under a lost key is cleared with its data
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
    getSenderStats: async () => (await getSealedKv<SenderStats>(SENDER_STATS)) ?? null,
    putSenderStats: (s) => putSealedKv(SENDER_STATS, s),
    getCloseChoices: async () => (await getSealedKv<Record<string, boolean>>(CLOSE_CHOICES)) ?? {},
    putCloseChoices: (c) => putSealedKv(CLOSE_CHOICES, c),
    clearScanData: () => clearScan(),
  };
}
