import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "@core/decide.ts";
import { openStore } from "../storage/db.ts";
import { createFakeGmail, fakeAnswers, makeSummary } from "./fakes.ts";
import { settingsEqual, summarize, syncLabels } from "./syncLabels.ts";

async function seeded() {
  const store = await openStore(`t-${crypto.randomUUID()}`);
  const msgs = [makeSummary("news"), makeSummary("promo"), makeSummary("removed")];
  const gmail = createFakeGmail(msgs);
  for (const m of msgs) await store.putSummary(m);
  await store.putAnswers("news", fakeAnswers({ newsletter: 0.95 }));
  await store.putAnswers("promo", fakeAnswers({ promotion: 0.95 }));
  await store.putAnswers("removed", fakeAnswers({ promotion: 0.95 }));
  await store.putScan({ years: 10, candidateIds: ["news", "promo", "removed"], repliedThreadIds: [], finished: true, startedAt: 0, settingsAtScan: DEFAULT_SETTINGS, msPerEmail: 100 });
  // The app labeled all three; the user removed the label from "removed" in Gmail.
  await store.putLabels(["news", "promo", "removed"].map((id) => ({ id, labeledByApp: true as const, userRemoved: false })));
  gmail.labeled.add("news");
  gmail.labeled.add("promo");
  return { store, gmail };
}

describe("syncLabels", () => {
  it("detects user removals, never re-adds them, and removes labels whose decision changed", async () => {
    const { store, gmail } = await seeded();
    const settings = { ...DEFAULT_SETTINGS, purgeKinds: ["promotion" as const] };
    const result = await syncLabels({ gmail, store, labelName: "purge-test" }, settings);
    expect(result).toEqual({ added: 0, removed: 1, userRemoved: 1 });
    expect([...gmail.labeled]).toEqual(["promo"]);
    expect((await store.allLabels()).get("removed")?.userRemoved).toBe(true);
    expect((await store.getScan())?.settingsAtScan).toEqual(settings);
  });

  it("does not mark a labeled message userRemoved after the app trashed it", async () => {
    const { store, gmail } = await seeded();
    gmail.trashed.add("news");
    const result = await syncLabels({ gmail, store, labelName: "purge-test" }, DEFAULT_SETTINGS);
    expect(result.userRemoved).toBe(1); // only "removed"
    const labels = await store.allLabels();
    expect(labels.get("news")?.userRemoved).toBe(false);
    expect(labels.get("removed")?.userRemoved).toBe(true);
  });

  it("adds labels for newly matching emails", async () => {
    const { store, gmail } = await seeded();
    gmail.labeled.clear();
    await store.putLabels([]);
    const s = await openStore(`t-${crypto.randomUUID()}`);
    for (const m of await store.allSummaries().then((x) => [...x.values()])) await s.putSummary(m);
    for (const [id, a] of await store.allAnswers()) await s.putAnswers(id, a);
    await s.putScan((await store.getScan())!);
    const result = await syncLabels({ gmail, store: s, labelName: "purge-test" }, DEFAULT_SETTINGS);
    expect(result.added).toBe(3);
  });
});

describe("summarize", () => {
  it("counts decisions over scanned candidates", async () => {
    const { store } = await seeded();
    expect(await summarize(store, { ...DEFAULT_SETTINGS, purgeKinds: ["newsletter"] })).toEqual({ purge: 1, keep: 2, review: 0 });
  });
});

describe("settingsEqual", () => {
  it("ignores checkbox order", () => {
    expect(settingsEqual({ ...DEFAULT_SETTINGS, purgeKinds: ["work", "scam"] }, { ...DEFAULT_SETTINGS, purgeKinds: ["scam", "work"] })).toBe(true);
    expect(settingsEqual(DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS, strictness: "careful" })).toBe(false);
  });
});
