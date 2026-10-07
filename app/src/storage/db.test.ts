import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "@core/decide.ts";
import { QUESTIONS_VERSION } from "@core/questions.ts";
import { openDB } from "idb";
import { openStore } from "./db.ts";

const summary = { id: "m1", threadId: "t1", from: "a", to: "b", cc: "", subject: "s", date: "d", snippet: "x", labels: [], hasListUnsubscribe: false, attachmentNames: [] };
const answers = { version: QUESTIONS_VERSION, kind: { newsletter: 1, promotion: 0, social: 0, securityAlert: 0, shipping: 0, scam: 0, work: 0, automated: 0, none: 0 }, protect: { personal: 0, financial: 0, accountLegal: 0 }, inputTokens: 700 };

describe("store", () => {
  it("round-trips summaries, answers, labels, settings, scan, and wizard progress", async () => {
    const store = await openStore(`t-${crypto.randomUUID()}`);
    expect(await store.getSettings()).toEqual(DEFAULT_SETTINGS);
    expect(await store.getScan()).toBeNull();

    await store.putSummary(summary);
    await store.putAnswers("m1", answers);
    await store.putLabels([{ id: "m1", label: "purge/promotion", labeledAt: 5, userRemoved: false, userChosen: false }]);
    await store.putSettings({ ...DEFAULT_SETTINGS, years: 8 });
    await store.putScan({ years: 8, candidateIds: ["m1"], repliedThreadIds: [], finished: false, startedAt: 1, settingsAtScan: null, msPerEmail: null });
    await store.putWizard([1, 2]);

    expect(await store.getSummary("m1")).toEqual(summary);
    expect((await store.allAnswers()).get("m1")).toEqual(answers);
    expect((await store.allLabels()).get("m1")?.label).toBe("purge/promotion");
    expect((await store.getSettings()).years).toBe(8);
    expect((await store.getScan())?.candidateIds).toEqual(["m1"]);
    expect(await store.getWizard()).toEqual([1, 2]);

    await store.deleteLabels(["m1"]);
    expect((await store.allLabels()).size).toBe(0);
  });

  it("clearScanData keeps settings, wizard progress, and label records", async () => {
    const store = await openStore(`t-${crypto.randomUUID()}`);
    await store.putSummary(summary);
    await store.putAnswers("m1", answers);
    await store.putLabels([{ id: "m1", label: "purge/promotion", labeledAt: 5, userRemoved: true, userChosen: false }]);
    await store.putSettings({ ...DEFAULT_SETTINGS, years: 7 });
    await store.putWizard([1]);
    await store.clearScanData();
    expect(await store.getSummary("m1")).toBeUndefined();
    expect((await store.allAnswers()).size).toBe(0);
    expect(await store.getScan()).toBeNull();
    expect((await store.allLabels()).get("m1")?.userRemoved).toBe(true);
    expect((await store.getSettings()).years).toBe(7);
    expect(await store.getWizard()).toEqual([1]);
  });

  it("fills settings missing from older stored records with defaults", async () => {
    const store = await openStore(`t-${crypto.randomUUID()}`);
    await store.putSettings({ purgeKinds: ["scam"], protects: [], years: 10, strictness: "balanced" } as never);
    const s = await store.getSettings();
    expect(s.purgeKinds).toEqual(["scam"]);
    expect(s.labelPrefix).toBe(DEFAULT_SETTINGS.labelPrefix);
    expect(s.keepAttachments).toBe(DEFAULT_SETTINGS.keepAttachments);
    expect(s.keepStarred).toBe(DEFAULT_SETTINGS.keepStarred);
  });

  it("uses the supplied defaults when nothing is stored", async () => {
    const store = await openStore(`t-${crypto.randomUUID()}`, { ...DEFAULT_SETTINGS, labelPrefix: "purge-test" });
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
    const store = await openStore(name);
    expect((await store.allLabels()).size).toBe(0);
    expect(await store.getSummary("m1")).toEqual(summary);
  });

  it("saves, reads and deletes overrides", async () => {
    const store = await openStore(`t-${crypto.randomUUID()}`);
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
    const store = await openStore(`t-${crypto.randomUUID()}`);
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
    const store = await openStore(name);
    expect((await store.allLabels()).get("x")?.label).toBe("purge/promotion");
    expect(await store.getAnswers("x")).toEqual({ version: 2 });
    expect((await store.allOverrides()).size).toBe(0);
  });
});
