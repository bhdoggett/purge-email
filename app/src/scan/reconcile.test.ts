import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type Settings } from "@core/decide.ts";
import type { Answers } from "@core/questions.ts";
import type { Summary } from "../gmail/client.ts";
import { type LabelRecord, openStore } from "../storage/db.ts";
import { createFakeGmail, fakeAnswers, idsWithLabel, makeSummary } from "./fakes.ts";
import { countByLabel, planReconcile, type ReconcileInput, reconcile, settingsEqual, summarize, USER_CHANGE_GRACE_MS } from "./reconcile.ts";

const NOW = 10_000_000;
const OLD = NOW - USER_CHANGE_GRACE_MS;

function rec(id: string, label: string, overrides: Partial<LabelRecord> = {}): LabelRecord {
  return { id, label, labeledAt: OLD, userRemoved: false, userChosen: false, ...overrides };
}

/** One candidate per entry in `answers`, each with a summary. */
function input(answers: Record<string, Answers>, rest: Partial<ReconcileInput> = {}): ReconcileInput {
  const ids = Object.keys(answers);
  return {
    now: NOW,
    settings: DEFAULT_SETTINGS,
    candidates: ids,
    summaries: new Map<string, Summary>(ids.map((id) => [id, makeSummary(id)])),
    answers: new Map(Object.entries(answers)),
    records: new Map(),
    anywhere: new Map(),
    live: new Set(),
    ...rest,
  };
}

/** Gmail state where every id carries its label outside Trash and Spam. */
function labeled(entries: Record<string, string>) {
  return { anywhere: new Map(Object.entries(entries)), live: new Set(Object.keys(entries)) };
}

const empty = (plan: ReturnType<typeof planReconcile>) => plan.add.size === 0 && plan.remove.size === 0 && plan.put.length === 0 && plan.del.length === 0;

describe("planReconcile", () => {
  it("adds the desired label and a record for a new candidate", () => {
    const plan = planReconcile(input({ a: fakeAnswers({ newsletter: 0.95 }) }));
    expect(plan.add).toEqual(new Map([["purge/newsletter", ["a"]]]));
    expect(plan.remove.size).toBe(0);
    expect(plan.put).toEqual([{ id: "a", label: "purge/newsletter", labeledAt: NOW, userRemoved: false, userChosen: false }]);
  });

  it("moves an email from purge/maybe to purge/promotion when strictness changes", () => {
    const answers = { a: fakeAnswers({ promotion: 0.7 }) };
    const before = planReconcile(input(answers));
    expect(before.add).toEqual(new Map([["purge/maybe", ["a"]]]));

    const plan = planReconcile(
      input(answers, { settings: { ...DEFAULT_SETTINGS, strictness: "aggressive" }, records: new Map([["a", rec("a", "purge/maybe")]]), ...labeled({ a: "purge/maybe" }) }),
    );
    expect(plan.remove).toEqual(new Map([["purge/maybe", ["a"]]]));
    expect(plan.add).toEqual(new Map([["purge/promotion", ["a"]]]));
    expect(plan.put).toEqual([{ id: "a", label: "purge/promotion", labeledAt: NOW, userRemoved: false, userChosen: false }]);
    expect(plan.del).toEqual([]);
  });

  it("changes nothing when Gmail already matches", () => {
    const plan = planReconcile(input({ a: fakeAnswers({ newsletter: 0.95 }) }, { records: new Map([["a", rec("a", "purge/newsletter")]]), ...labeled({ a: "purge/newsletter" }) }));
    expect(empty(plan)).toBe(true);
  });

  it("records a candidate that already carries its desired label", () => {
    const plan = planReconcile(input({ a: fakeAnswers({ newsletter: 0.95 }) }, labeled({ a: "purge/newsletter" })));
    expect(plan.add.size).toBe(0);
    expect(plan.remove.size).toBe(0);
    expect(plan.put).toEqual([{ id: "a", label: "purge/newsletter", labeledAt: NOW, userRemoved: false, userChosen: false }]);
  });

  it("removes the label and deletes the record for an app-labeled id outside the candidates", () => {
    const plan = planReconcile(input({}, { records: new Map([["gone", rec("gone", "purge/scam")]]), ...labeled({ gone: "purge/scam" }) }));
    expect(plan.remove).toEqual(new Map([["purge/scam", ["gone"]]]));
    expect(plan.add.size).toBe(0);
    expect(plan.del).toEqual(["gone"]);
    expect(plan.put).toEqual([]);
  });

  it("removes an app label without a record from an id outside the candidates", () => {
    const plan = planReconcile(input({}, labeled({ stray: "purge/maybe" })));
    expect(plan.remove).toEqual(new Map([["purge/maybe", ["stray"]]]));
    expect(plan.del).toEqual([]);
  });

  it("marks user-removed after the grace window and never re-adds", () => {
    const answers = { a: fakeAnswers({ newsletter: 0.95 }) };
    const plan = planReconcile(input(answers, { records: new Map([["a", rec("a", "purge/newsletter")]]) }));
    expect(plan.userRemoved).toBe(1);
    expect(plan.add.size).toBe(0);
    expect(plan.remove.size).toBe(0);
    expect(plan.put).toEqual([rec("a", "purge/newsletter", { userRemoved: true })]);

    // Next run: the record is user-removed and stays that way, even under other settings.
    const again = planReconcile(
      input(answers, { settings: { ...DEFAULT_SETTINGS, strictness: "aggressive" }, records: new Map([["a", rec("a", "purge/newsletter", { userRemoved: true })]]) }),
    );
    expect(again.userRemoved).toBe(0);
    expect(empty(again)).toBe(true);
  });

  it("does not mark user-removed inside the grace window, and leaves the email alone", () => {
    const records = new Map([["a", rec("a", "purge/newsletter", { labeledAt: NOW - 1000 })]]);
    const plan = planReconcile(input({ a: fakeAnswers({ newsletter: 0.95 }) }, { records }));
    expect(plan.userRemoved).toBe(0);
    expect(empty(plan)).toBe(true);

    // Even when the desired label changed, a just-labeled email missing from Gmail's lists is not touched.
    const changed = planReconcile(input({ a: fakeAnswers({ newsletter: 0.95 }) }, { records, settings: { ...DEFAULT_SETTINGS, purgeKinds: [] } }));
    expect(empty(changed)).toBe(true);
  });

  it("marks user-chosen when Gmail shows a different app label and leaves it untouched afterwards", () => {
    const answers = { a: fakeAnswers({ newsletter: 0.95 }) };
    const plan = planReconcile(input(answers, { records: new Map([["a", rec("a", "purge/newsletter")]]), ...labeled({ a: "purge/work" }) }));
    expect(plan.userChosen).toBe(1);
    expect(plan.add.size).toBe(0);
    expect(plan.remove.size).toBe(0);
    expect(plan.put).toEqual([rec("a", "purge/work", { userChosen: true })]);

    // Next run: the record matches Gmail, and the app still keeps its hands off, even when the id stops being a candidate.
    const chosen = new Map([["a", rec("a", "purge/work", { userChosen: true })]]);
    const again = planReconcile(input(answers, { records: chosen, ...labeled({ a: "purge/work" }) }));
    expect(again.userChosen).toBe(0);
    expect(empty(again)).toBe(true);
    const dropped = planReconcile(input({}, { records: chosen, ...labeled({ a: "purge/work" }) }));
    expect(empty(dropped)).toBe(true);
  });

  it("does not mark user-chosen inside the grace window", () => {
    const records = new Map([["a", rec("a", "purge/newsletter", { labeledAt: NOW - 1000 })]]);
    const plan = planReconcile(input({ a: fakeAnswers({ newsletter: 0.95 }) }, { records, ...labeled({ a: "purge/work" }) }));
    expect(plan.userChosen).toBe(0);
  });

  it("moves labels to the new prefix", () => {
    const settings: Settings = { ...DEFAULT_SETTINGS, labelPrefix: "old" };
    const plan = planReconcile(input({ a: fakeAnswers({ scam: 0.95 }) }, { settings, records: new Map([["a", rec("a", "purge/scam")]]), ...labeled({ a: "purge/scam" }) }));
    expect(plan.userChosen).toBe(0);
    expect(plan.remove).toEqual(new Map([["purge/scam", ["a"]]]));
    expect(plan.add).toEqual(new Map([["old/scam", ["a"]]]));
    expect(plan.put).toEqual([{ id: "a", label: "old/scam", labeledAt: NOW, userRemoved: false, userChosen: false }]);
  });

  it("never changes or marks an id that is only in Trash or Spam", () => {
    const records = new Map([["t", rec("t", "purge/newsletter")]]);
    const trashed = { anywhere: new Map([["t", "purge/newsletter"]]), live: new Set<string>() };
    // Still a candidate with a different desired label.
    const plan = planReconcile(input({ t: fakeAnswers({ promotion: 0.95 }) }, { records, ...trashed }));
    expect(plan.userRemoved + plan.userChosen).toBe(0);
    expect(empty(plan)).toBe(true);
    // No longer a candidate.
    expect(empty(planReconcile(input({}, { records, ...trashed })))).toBe(true);
    // A candidate with no record, in Trash with an app label: no label is added.
    expect(empty(planReconcile(input({ t: fakeAnswers({ promotion: 0.95 }) }, trashed)))).toBe(true);
  });

  it("removes the label from a candidate with no summary", () => {
    const i = input({ a: fakeAnswers({ newsletter: 0.95 }) }, { records: new Map([["a", rec("a", "purge/newsletter")]]), ...labeled({ a: "purge/newsletter" }) });
    i.summaries.clear();
    const plan = planReconcile(i);
    expect(plan.remove).toEqual(new Map([["purge/newsletter", ["a"]]]));
    expect(plan.add.size).toBe(0);
    expect(plan.del).toEqual(["a"]);
  });

  it("removes labels from candidates that are now kept", () => {
    const starred = makeSummary("s", { labels: ["STARRED"] });
    const i = input({ s: fakeAnswers({ promotion: 0.95 }) }, { records: new Map([["s", rec("s", "purge/promotion")]]), ...labeled({ s: "purge/promotion" }) });
    i.summaries.set("s", starred);
    const plan = planReconcile(i);
    expect(plan.remove).toEqual(new Map([["purge/promotion", ["s"]]]));
    expect(plan.del).toEqual(["s"]);
  });
});

describe("reconcile", () => {
  it("moves labels in Gmail to match changed purge kinds and saves the records", async () => {
    const store = await openStore(`t-${crypto.randomUUID()}`);
    const msgs = [makeSummary("news"), makeSummary("promo")];
    const gmail = createFakeGmail(msgs);
    for (const m of msgs) await store.putSummary(m);
    await store.putAnswers("news", fakeAnswers({ newsletter: 0.95 }));
    await store.putAnswers("promo", fakeAnswers({ promotion: 0.35, social: 0.3, newsletter: 0.2 }));
    await store.putScan({ years: 10, candidateIds: ["news", "promo"], repliedThreadIds: [], finished: true, startedAt: 0, settingsAtScan: DEFAULT_SETTINGS, msPerEmail: 100 });

    const first = await reconcile({ gmail, store, now: () => NOW }, DEFAULT_SETTINGS);
    expect(first).toEqual({ added: 2, removed: 0, moved: 0, userRemoved: 0, userChosen: 0 });
    expect(gmail.labelsOf.get("news")).toEqual(new Set(["purge/newsletter"]));
    expect(gmail.labelsOf.get("promo")).toEqual(new Set(["purge/promotion"]));

    // Without promotion the promo email drops below the purge bar (0.5) and moves to maybe.
    const settings: Settings = { ...DEFAULT_SETTINGS, purgeKinds: DEFAULT_SETTINGS.purgeKinds.filter((k) => k !== "promotion") };
    const later = NOW + USER_CHANGE_GRACE_MS;
    const second = await reconcile({ gmail, store, now: () => later }, settings);
    expect(second).toEqual({ added: 0, removed: 0, moved: 1, userRemoved: 0, userChosen: 0 });
    expect(gmail.labelsOf.get("news")).toEqual(new Set(["purge/newsletter"]));
    expect(gmail.labelsOf.get("promo")).toEqual(new Set(["purge/maybe"]));
    expect(idsWithLabel(gmail, "purge/promotion")).toEqual([]);

    const records = await store.allLabels();
    expect(records.get("news")?.labeledAt).toBe(NOW);
    expect(records.get("promo")).toEqual({ id: "promo", label: "purge/maybe", labeledAt: later, userRemoved: false, userChosen: false });
    expect((await store.getScan())?.settingsAtScan).toEqual(settings);
  });

  it("leaves a trashed labeled email alone and detects a user removal", async () => {
    const store = await openStore(`t-${crypto.randomUUID()}`);
    const msgs = [makeSummary("trashed"), makeSummary("removed")];
    const gmail = createFakeGmail(msgs);
    for (const m of msgs) {
      await store.putSummary(m);
      await store.putAnswers(m.id, fakeAnswers({ newsletter: 0.95 }));
    }
    await store.putScan({ years: 10, candidateIds: ["trashed", "removed"], repliedThreadIds: [], finished: true, startedAt: 0, settingsAtScan: DEFAULT_SETTINGS, msPerEmail: 100 });
    await store.putLabels([rec("trashed", "purge/newsletter"), rec("removed", "purge/newsletter")]);
    gmail.labelsOf.set("trashed", new Set(["purge/newsletter"]));
    gmail.trashed.add("trashed");

    const r = await reconcile({ gmail, store, now: () => NOW }, { ...DEFAULT_SETTINGS, purgeKinds: ["promotion"] });
    expect(r).toEqual({ added: 0, removed: 0, moved: 0, userRemoved: 1, userChosen: 0 });
    expect(gmail.labelsOf.get("trashed")).toEqual(new Set(["purge/newsletter"]));
    expect(gmail.labelsOf.has("removed")).toBe(false);
    const records = await store.allLabels();
    expect(records.get("removed")?.userRemoved).toBe(true);
    expect(records.get("trashed")).toEqual(rec("trashed", "purge/newsletter"));
  });
});

describe("countByLabel", () => {
  it("counts app labels with mail, skipping starred mail only when it is protected", async () => {
    const gmail = createFakeGmail([makeSummary("a"), makeSummary("b", { labels: ["STARRED"] }), makeSummary("c")]);
    gmail.labelsOf.set("a", new Set(["purge/promotion"]));
    gmail.labelsOf.set("b", new Set(["purge/promotion"]));
    gmail.labelsOf.set("c", new Set(["other/scam"]));
    expect(await countByLabel(gmail, DEFAULT_SETTINGS)).toEqual(new Map([["purge/promotion", 1]]));
    expect(await countByLabel(gmail, { ...DEFAULT_SETTINGS, keepStarred: false })).toEqual(new Map([["purge/promotion", 2]]));
  });
});

describe("summarize", () => {
  it("counts decisions over scanned candidates", async () => {
    const store = await openStore(`t-${crypto.randomUUID()}`);
    for (const id of ["news", "promo", "other"]) await store.putSummary(makeSummary(id));
    await store.putAnswers("news", fakeAnswers({ newsletter: 0.95 }));
    await store.putAnswers("promo", fakeAnswers({ promotion: 0.95 }));
    await store.putAnswers("other", fakeAnswers({ promotion: 0.95 }));
    await store.putScan({ years: 10, candidateIds: ["news", "promo", "other"], repliedThreadIds: [], finished: true, startedAt: 0, settingsAtScan: DEFAULT_SETTINGS, msPerEmail: 100 });
    expect(await summarize(store, { ...DEFAULT_SETTINGS, purgeKinds: ["newsletter"] })).toEqual({ purge: 1, keep: 2, review: 0 });
  });

  it("uses the starred setting", async () => {
    const store = await openStore(`t-${crypto.randomUUID()}`);
    await store.putSummary(makeSummary("s", { labels: ["STARRED"] }));
    await store.putAnswers("s", fakeAnswers({ promotion: 0.95 }));
    await store.putScan({ years: 10, candidateIds: ["s"], repliedThreadIds: [], finished: true, startedAt: 0, settingsAtScan: DEFAULT_SETTINGS, msPerEmail: 100 });
    expect(await summarize(store, DEFAULT_SETTINGS)).toEqual({ purge: 0, keep: 1, review: 0 });
    expect(await summarize(store, { ...DEFAULT_SETTINGS, keepStarred: false })).toEqual({ purge: 1, keep: 0, review: 0 });
  });
});

describe("settingsEqual", () => {
  it("ignores checkbox order", () => {
    expect(settingsEqual({ ...DEFAULT_SETTINGS, purgeKinds: ["work", "scam"] }, { ...DEFAULT_SETTINGS, purgeKinds: ["scam", "work"] })).toBe(true);
    expect(settingsEqual({ ...DEFAULT_SETTINGS, protects: ["personal", "financial"] }, { ...DEFAULT_SETTINGS, protects: ["financial", "personal"] })).toBe(true);
    expect(settingsEqual(DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS, strictness: "careful" })).toBe(false);
  });

  it("compares the label prefix and protection checkboxes", () => {
    expect(settingsEqual(DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS, labelPrefix: "other" })).toBe(false);
    expect(settingsEqual(DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS, keepAttachments: false })).toBe(false);
    expect(settingsEqual(DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS, keepStarred: false })).toBe(false);
    expect(settingsEqual(DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS, years: 5 })).toBe(false);
  });
});
