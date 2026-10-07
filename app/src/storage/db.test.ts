import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@core/decide.ts";
import { QUESTIONS_VERSION } from "@core/questions.ts";
import { openDB } from "idb";
import { openStore } from "./db.ts";
import { randomKeyBase64, testKey } from "../test/key.ts";
import { encryptJson, importDataKey } from "./crypto.ts";

const summary = { id: "m1", threadId: "t1", from: "a", to: "b", cc: "", subject: "s", date: "d", snippet: "x", labels: [], hasListUnsubscribe: false, attachmentNames: [] };
const answers = { version: QUESTIONS_VERSION, kind: { newsletter: 1, promotion: 0, social: 0, securityAlert: 0, shipping: 0, scam: 0, work: 0, automated: 0, none: 0 }, protect: { personal: 0, financial: 0, accountLegal: 0 }, inputTokens: 700 };

describe("store", () => {
  it("round-trips summaries, answers, labels, settings, scan, and wizard progress", async () => {
    const store = await openStore(testKey, `t-${crypto.randomUUID()}`);
    expect(await store.getSettings()).toEqual(DEFAULT_SETTINGS);
    expect(await store.getScan()).toBeNull();

    await store.putSummary(summary);
    await store.putAnswers("m1", answers);
    await store.putLabels([{ id: "m1", label: "purge/promotion", labeledAt: 5, userRemoved: false, userChosen: false }]);
    await store.putSettings({ ...DEFAULT_SETTINGS, ageMonths: 8 });
    await store.putScan({ ageMonths: 8, candidateIds: ["m1"], repliedThreadIds: [], finished: false, startedAt: 1, settingsAtScan: null, msPerEmail: null });
    await store.putWizard([1, 2]);

    expect(await store.getSummary("m1")).toEqual(summary);
    expect((await store.allAnswers()).get("m1")).toEqual(answers);
    expect((await store.allLabels()).get("m1")?.label).toBe("purge/promotion");
    expect((await store.getSettings()).ageMonths).toBe(8);
    expect((await store.getScan())?.candidateIds).toEqual(["m1"]);
    expect(await store.getWizard()).toEqual([1, 2]);

    await store.deleteLabels(["m1"]);
    expect((await store.allLabels()).size).toBe(0);
  });

  it("clearScanData keeps settings, wizard progress, and label records", async () => {
    const store = await openStore(testKey, `t-${crypto.randomUUID()}`);
    await store.putSummary(summary);
    await store.putAnswers("m1", answers);
    await store.putLabels([{ id: "m1", label: "purge/promotion", labeledAt: 5, userRemoved: true, userChosen: false }]);
    await store.putSettings({ ...DEFAULT_SETTINGS, ageMonths: 7 });
    await store.putWizard([1]);
    await store.clearScanData();
    expect(await store.getSummary("m1")).toBeUndefined();
    expect((await store.allAnswers()).size).toBe(0);
    expect(await store.getScan()).toBeNull();
    expect((await store.allLabels()).get("m1")?.userRemoved).toBe(true);
    expect((await store.getSettings()).ageMonths).toBe(7);
    expect(await store.getWizard()).toEqual([1]);
  });

  it("fills settings missing from older stored records with defaults", async () => {
    const store = await openStore(testKey, `t-${crypto.randomUUID()}`);
    await store.putSettings({ purgeKinds: ["scam"], protects: [], years: 10, strictness: "balanced" } as never);
    const s = await store.getSettings();
    expect(s.purgeKinds).toEqual(["scam"]);
    expect(s.labelPrefix).toBe(DEFAULT_SETTINGS.labelPrefix);
    expect(s.keepAttachments).toBe(DEFAULT_SETTINGS.keepAttachments);
    expect(s.keepStarred).toBe(DEFAULT_SETTINGS.keepStarred);
    expect(s.ageMonths).toBe(120);
    expect("years" in s).toBe(false);
  });

  it("converts years in stored settings and scans to months", async () => {
    const store = await openStore(testKey, `t-${crypto.randomUUID()}`);
    const { ageMonths: _, ...rest } = DEFAULT_SETTINGS;
    const old = { ...rest, years: 3 };
    await store.putSettings(old as never);
    await store.putScan({ years: 5, settings: { ...old, years: 5 }, candidateIds: ["m1"], repliedThreadIds: [], finished: true, startedAt: 1, settingsAtScan: { ...old, years: 5 }, msPerEmail: null } as never);
    expect((await store.getSettings()).ageMonths).toBe(36);
    const scan = (await store.getScan())!;
    expect(scan.ageMonths).toBe(60);
    expect("years" in scan).toBe(false);
    expect(scan.settings).toEqual({ ...DEFAULT_SETTINGS, ageMonths: 60 });
    expect(scan.settingsAtScan).toEqual({ ...DEFAULT_SETTINGS, ageMonths: 60 });
  });

  it("leaves a missing scan settings snapshot missing", async () => {
    const store = await openStore(testKey, `t-${crypto.randomUUID()}`);
    await store.putScan({ years: 2, candidateIds: [], repliedThreadIds: [], finished: false, startedAt: 1, settingsAtScan: null, msPerEmail: null } as never);
    const scan = (await store.getScan())!;
    expect(scan.settings).toBeUndefined();
    expect(scan.settingsAtScan).toBeNull();
    expect(scan.ageMonths).toBe(24);
  });

  it("uses the supplied defaults when nothing is stored", async () => {
    const store = await openStore(testKey, `t-${crypto.randomUUID()}`, { ...DEFAULT_SETTINGS, labelPrefix: "purge-test" });
    expect((await store.getSettings()).labelPrefix).toBe("purge-test");
  });

  it("upgrades v1 to v2 by clearing old label records and keeping summaries", async () => {
    const name = `t-${crypto.randomUUID()}`;
    const old = await openDB(name, 1, {
      upgrade(db) {
        db.createObjectStore("summaries", { keyPath: "id" });
        db.createObjectStore("answers");
        db.createObjectStore("labels", { keyPath: "id" });
        db.createObjectStore("kv");
      },
    });
    await old.put("summaries", summary);
    await old.put("labels", { id: "m1", labeledByApp: true, userRemoved: false });
    old.close();
    const store = await openStore(testKey, name);
    expect((await store.allLabels()).size).toBe(0);
    expect(await store.getSummary("m1")).toEqual(summary);
  });

  it("saves, reads and deletes overrides", async () => {
    const store = await openStore(testKey, `t-${crypto.randomUUID()}`);
    await store.putOverrides(["a", "b"], "promotion", 5);
    await store.putOverrideList([{ id: "c", slug: null, at: 6 }]);
    expect(await store.allOverrides()).toEqual(
      new Map([
        ["a", { id: "a", slug: "promotion", at: 5 }],
        ["b", { id: "b", slug: "promotion", at: 5 }],
        ["c", { id: "c", slug: null, at: 6 }],
      ]),
    );
    await store.deleteOverrides(["a", "c"]);
    expect([...(await store.allOverrides()).keys()]).toEqual(["b"]);
  });

  it("keeps overrides when scan data is cleared", async () => {
    const store = await openStore(testKey, `t-${crypto.randomUUID()}`);
    await store.putOverrides(["a"], "maybe", 1);
    await store.clearScanData();
    expect((await store.allOverrides()).get("a")?.slug).toBe("maybe");
  });

  it("upgrades a version 2 database without losing labels or answers", async () => {
    const name = `t-${crypto.randomUUID()}`;
    const { openDB } = await import("idb");
    const v2 = await openDB(name, 2, {
      upgrade(db) {
        db.createObjectStore("summaries", { keyPath: "id" });
        db.createObjectStore("answers");
        db.createObjectStore("labels", { keyPath: "id" });
        db.createObjectStore("kv");
      },
    });
    await v2.put("labels", { id: "x", label: "purge/promotion", labeledAt: 1, userRemoved: false, userChosen: false });
    await v2.put("answers", { version: 2 }, "x");
    v2.close();
    const store = await openStore(testKey, name);
    expect((await store.allLabels()).get("x")?.label).toBe("purge/promotion");
    expect(await store.getAnswers("x")).toEqual({ version: 2 });
    expect((await store.allOverrides()).size).toBe(0);
  });
});

const secretSummary = { ...summary, id: "m9", subject: "Your biopsy results", snippet: "Dear Pat, the results", from: "clinic@example.com" };

async function rawRecord(name: string, store: "summaries" | "answers", id: string) {
  const db = await openDB(name);
  try {
    return (await db.get(store, id)) as Record<string, unknown> | undefined;
  } finally {
    db.close();
  }
}

/** A database exactly as version 3 left it, with plaintext summaries and answers. */
async function makeV3(name: string, ids: string[], seal?: { key: CryptoKey; ids: Set<string> }) {
  const v3 = await openDB(name, 3, {
    upgrade(db) {
      db.createObjectStore("summaries", { keyPath: "id" });
      db.createObjectStore("answers");
      db.createObjectStore("labels", { keyPath: "id" });
      db.createObjectStore("kv");
      db.createObjectStore("overrides", { keyPath: "id" });
    },
  });
  for (const id of ids) {
    const s = { ...secretSummary, id, subject: `subject ${id}` };
    const a = { ...answers, inputTokens: ids.indexOf(id) };
    if (seal?.ids.has(id)) {
      const { id: _, ...rest } = s;
      await v3.put("summaries", { id, ...(await encryptJson(seal.key, rest, id)) });
      await v3.put("answers", await encryptJson(seal.key, a, id), id);
    } else {
      await v3.put("summaries", s);
      await v3.put("answers", a, id);
    }
  }
  await v3.put("labels", { id: "m1", label: "purge/promotion", labeledAt: 1, userRemoved: false, userChosen: false });
  await v3.put("overrides", { id: "m1", slug: "promotion", at: 2 });
  await v3.put("kv", [1, 2], "wizard");
  v3.close();
}

describe("encryption at rest", () => {
  it("stores summaries and answers as iv + ciphertext only", async () => {
    const name = `t-${crypto.randomUUID()}`;
    const store = await openStore(testKey, name);
    await store.putSummary(secretSummary);
    await store.putAnswers("m9", answers);

    const s = (await rawRecord(name, "summaries", "m9"))!;
    expect(Object.keys(s).sort()).toEqual(["data", "id", "iv"]);
    expect(s.id).toBe("m9");
    expect(s.iv).toBeInstanceOf(Uint8Array);
    expect(s.data).toBeInstanceOf(ArrayBuffer);
    const text = JSON.stringify(s) + new TextDecoder("latin1").decode(s.data as ArrayBuffer);
    expect(text).not.toContain("biopsy");
    expect(text).not.toContain("clinic@example.com");

    const a = (await rawRecord(name, "answers", "m9"))!;
    expect(Object.keys(a).sort()).toEqual(["data", "iv"]);
    expect(JSON.stringify(a)).not.toContain("newsletter");

    expect(await store.getSummary("m9")).toEqual(secretSummary);
    expect(await store.getAnswers("m9")).toEqual(answers);
    expect((await store.allSummaries()).get("m9")).toEqual(secretSummary);
    expect((await store.allAnswers()).get("m9")).toEqual(answers);
  });

  it("encrypts a version 3 database in place on open, keeping everything else", async () => {
    const name = `t-${crypto.randomUUID()}`;
    const ids = Array.from({ length: 1234 }, (_, i) => `m${i}`);
    await makeV3(name, ids);
    const store = await openStore(testKey, name);

    for (const id of ["m0", "m617", "m1233"]) {
      const s = (await rawRecord(name, "summaries", id))!;
      expect(Object.keys(s).sort()).toEqual(["data", "id", "iv"]);
      expect(Object.keys((await rawRecord(name, "answers", id))!).sort()).toEqual(["data", "iv"]);
    }
    const all = await store.allSummaries();
    expect(all.size).toBe(1234);
    expect(all.get("m617")).toEqual({ ...secretSummary, id: "m617", subject: "subject m617" });
    expect((await store.allAnswers()).get("m617")?.inputTokens).toBe(617);
    expect((await store.allLabels()).get("m1")?.label).toBe("purge/promotion");
    expect((await store.allOverrides()).get("m1")?.slug).toBe("promotion");
    expect(await store.getWizard()).toEqual([1, 2]);

    const db = await openDB(name);
    expect(db.version).toBe(4);
    expect(await db.get("kv", "encrypted")).toBe(true);
    db.close();
  });

  it("does not rescan once the migration is marked done", async () => {
    const name = `t-${crypto.randomUUID()}`;
    await openStore(testKey, name);
    const db = await openDB(name);
    await db.put("summaries", { ...secretSummary, id: "late" });
    db.close();
    const store = await openStore(testKey, name);
    expect(Object.keys((await rawRecord(name, "summaries", "late"))!)).toContain("subject");
    // A leftover plaintext record is still readable rather than lost.
    expect((await store.getSummary("late"))?.subject).toBe(secretSummary.subject);
  });

  it("finishes a migration that was interrupted halfway", async () => {
    const name = `t-${crypto.randomUUID()}`;
    const key = await testKey();
    const ids = ["a", "b", "c", "d"];
    await makeV3(name, ids, { key, ids: new Set(["a", "b"]) });
    const store = await openStore(testKey, name);
    for (const id of ids) {
      expect(Object.keys((await rawRecord(name, "summaries", id))!).sort()).toEqual(["data", "id", "iv"]);
      expect(await store.getSummary(id)).toEqual({ ...secretSummary, id, subject: `subject ${id}` });
      expect((await store.getAnswers(id))?.inputTokens).toBe(ids.indexOf(id));
    }
  });

  it("treats records it cannot decrypt as missing, without throwing", async () => {
    const name = `t-${crypto.randomUUID()}`;
    const store = await openStore(testKey, name);
    await store.putSummary(summary);
    await store.putAnswers("m1", answers);
    // A record sealed with some other key, as after a partial restore.
    const other = await importDataKey(randomKeyBase64());
    const { id: _, ...rest } = secretSummary;
    const db = await openDB(name);
    await db.put("summaries", { id: "m9", ...(await encryptJson(other, rest, "m9")) });
    await db.put("answers", await encryptJson(other, answers, "m9"), "m9");
    db.close();

    const fresh = await openStore(testKey, name);
    expect(await fresh.getSummary("m9")).toBeUndefined();
    expect(await fresh.getAnswers("m9")).toBeUndefined();
    expect([...(await fresh.allSummaries()).keys()]).toEqual(["m1"]);
    expect([...(await fresh.allAnswers()).keys()]).toEqual(["m1"]);
    // Re-saving a lost record replaces it with one the current key can read.
    await fresh.putSummary(secretSummary);
    expect(await fresh.getSummary("m9")).toEqual(secretSummary);
  });

  it("binds each record to its id, so swapped ciphertexts read as missing", async () => {
    const name = `t-${crypto.randomUUID()}`;
    const store = await openStore(testKey, name);
    await store.putSummary(summary);
    await store.putSummary(secretSummary);
    await store.putAnswers("m1", answers);
    await store.putAnswers("m9", { ...answers, inputTokens: 9 });
    const db = await openDB(name);
    const [s1, s9] = [await db.get("summaries", "m1"), await db.get("summaries", "m9")];
    const [a1, a9] = [await db.get("answers", "m1"), await db.get("answers", "m9")];
    await db.put("summaries", { ...s9, id: "m1" });
    await db.put("summaries", { ...s1, id: "m9" });
    await db.put("answers", a9, "m1");
    await db.put("answers", a1, "m9");
    db.close();

    const fresh = await openStore(testKey, name);
    expect(await fresh.getSummary("m1")).toBeUndefined();
    expect(await fresh.getSummary("m9")).toBeUndefined();
    expect(await fresh.getAnswers("m1")).toBeUndefined();
    expect((await fresh.allSummaries()).size).toBe(0);
    expect((await fresh.allAnswers()).size).toBe(0);
  });

  it("binds migrated records to their ids too", async () => {
    const name = `t-${crypto.randomUUID()}`;
    await makeV3(name, ["a", "b"]);
    await openStore(testKey, name);
    const db = await openDB(name);
    const [sa, sb] = [await db.get("summaries", "a"), await db.get("summaries", "b")];
    await db.put("summaries", { ...sb, id: "a" });
    await db.put("summaries", { ...sa, id: "b" });
    db.close();
    const fresh = await openStore(testKey, name);
    expect(await fresh.getSummary("a")).toBeUndefined();
    expect((await fresh.allSummaries()).size).toBe(0);
  });

  it("clears scan data saved under a different key instead of leaving a finished scan with nothing readable", async () => {
    const name = `t-${crypto.randomUUID()}`;
    const a = await openStore(await importDataKey(randomKeyBase64()), name);
    await a.putSummary(secretSummary);
    await a.putAnswers("m9", answers);
    await a.putScan({ ageMonths: 8, candidateIds: ["m9"], repliedThreadIds: [], finished: true, startedAt: 1, settingsAtScan: DEFAULT_SETTINGS, msPerEmail: null });
    await a.putOverrides(["m9"], "promotion", 1);
    await a.putLabels([{ id: "m9", label: "purge/promotion", labeledAt: 1, userRemoved: false, userChosen: false }]);
    await a.putWizard([1]);

    const b = await openStore(await importDataKey(randomKeyBase64()), name);
    expect(await b.getScan()).toBeNull();
    expect(await rawRecord(name, "summaries", "m9")).toBeUndefined();
    expect(await rawRecord(name, "answers", "m9")).toBeUndefined();
    // The user's choices and settings are not encrypted and stay.
    expect((await b.allOverrides()).get("m9")?.slug).toBe("promotion");
    expect((await b.allLabels()).get("m9")?.label).toBe("purge/promotion");
    expect(await b.getWizard()).toEqual([1]);

    // The new key is recorded: data saved now survives the next open with it.
    await b.putSummary(summary);
    await b.putScan({ ageMonths: 8, candidateIds: ["m1"], repliedThreadIds: [], finished: true, startedAt: 2, settingsAtScan: DEFAULT_SETTINGS, msPerEmail: null });
  });

  it("keeps scan data when reopened with the same key", async () => {
    const name = `t-${crypto.randomUUID()}`;
    const a = await openStore(testKey, name);
    await a.putSummary(summary);
    await a.putScan({ ageMonths: 8, candidateIds: ["m1"], repliedThreadIds: [], finished: true, startedAt: 1, settingsAtScan: DEFAULT_SETTINGS, msPerEmail: null });
    const b = await openStore(testKey, name);
    expect((await b.getScan())?.candidateIds).toEqual(["m1"]);
    expect(await b.getSummary("m1")).toEqual(summary);
  });

  it("checks a key the provider swaps in later and clears data the new key can't read", async () => {
    let key = importDataKey(randomKeyBase64());
    const store = await openStore(() => key, `t-${crypto.randomUUID()}`);
    await store.putSummary(summary);
    await store.putScan({ ageMonths: 8, candidateIds: ["m1"], repliedThreadIds: [], finished: true, startedAt: 1, settingsAtScan: DEFAULT_SETTINGS, msPerEmail: null });
    expect((await store.allSummaries()).size).toBe(1);
    key = importDataKey(randomKeyBase64());
    expect(await store.getSummary("m1")).toBeUndefined();
    expect(await store.getScan()).toBeNull();
    expect((await store.allSummaries()).size).toBe(0);
    await store.putSummary(summary);
    expect(await store.getSummary("m1")).toEqual(summary);
  });

  it("decrypts everything once, then serves allSummaries and allAnswers from memory", async () => {
    const name = `t-${crypto.randomUUID()}`;
    const store = await openStore(testKey, name);
    await store.putSummary(summary);
    await store.putSummary(secretSummary);
    await store.putAnswers("m1", answers);
    const decrypt = vi.spyOn(crypto.subtle, "decrypt");
    try {
      expect((await store.allSummaries()).size).toBe(2);
      expect((await store.allAnswers()).size).toBe(1);
      const first = decrypt.mock.calls.length;
      expect(first).toBe(3);
      await store.allSummaries();
      await store.allAnswers();
      expect(decrypt.mock.calls.length).toBe(first);

      // Puts keep the cache current without decrypting again.
      const changed = { ...summary, subject: "changed" };
      await store.putSummary(changed);
      await store.putAnswers("m9", { ...answers, inputTokens: 9 });
      expect((await store.allSummaries()).get("m1")).toEqual(changed);
      expect((await store.allAnswers()).get("m9")?.inputTokens).toBe(9);
      expect(decrypt.mock.calls.length).toBe(first);

      // Callers can't change the cache.
      const map = await store.allSummaries();
      map.delete("m1");
      expect(() => {
        map.get("m9")!.subject = "mutated";
      }).toThrow(TypeError);
      expect(() => (map.get("m9")!.labels as string[]).push("x")).toThrow(TypeError);
      // Nor can a caller change a saved value afterwards through its own object.
      const mine = { ...summary, id: "m5", labels: ["INBOX"] };
      await store.putSummary(mine);
      mine.labels.push("changed");
      expect((await store.allSummaries()).get("m5")?.labels).toEqual(["INBOX"]);
      expect((await store.allSummaries()).get("m1")).toEqual(changed);
      expect((await store.allSummaries()).get("m9")).toEqual(secretSummary);
      expect(decrypt.mock.calls.length).toBe(first);

      await store.clearScanData();
      expect((await store.allSummaries()).size).toBe(0);
      expect((await store.allAnswers()).size).toBe(0);
    } finally {
      decrypt.mockRestore();
    }
  });

  it("loads 30,000 encrypted summaries quickly", { timeout: 120_000 }, async () => {
    const name = `t-${crypto.randomUUID()}`;
    const store = await openStore(testKey, name);
    const key = await testKey();
    const n = 30_000;
    const records = await Promise.all(
      Array.from({ length: n }, async (_, i) => {
        const { id: _id, ...rest } = { ...secretSummary, subject: `A fairly typical marketing subject line number ${i}`, snippet: "x".repeat(200) };
        return { id: `m${i}`, ...(await encryptJson(key, rest, `m${i}`)) };
      }),
    );
    const db = await openDB(name);
    const tx = db.transaction("summaries", "readwrite");
    await Promise.all([...records.map((r) => tx.store.put(r)), tx.done]);
    db.close();

    const start = performance.now();
    const all = await store.allSummaries();
    const ms = performance.now() - start;
    console.log(`allSummaries decrypted ${n} summaries in ${Math.round(ms)} ms`);
    expect(all.size).toBe(n);
    expect(ms).toBeLessThan(30_000);
  });
});
