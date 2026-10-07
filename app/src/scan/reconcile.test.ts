import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type Settings } from "@core/decide.ts";
import { needsRescan } from "@core/labels.ts";
import type { Answers } from "@core/questions.ts";
import type { Summary } from "../gmail/client.ts";
import { type LabelRecord, openStore } from "../storage/db.ts";
import { testKey } from "../test/key.ts";
import { NO_CLOSE } from "./closeness.ts";
import { createFakeGmail, fakeAnswers, idsWithLabel, knownClose, makeSummary } from "./fakes.ts";
import { AppError } from "../bridge/errors.ts";
import { GmailError } from "../gmail/client.ts";
import { appLabelNames } from "@core/labels.ts";
import { applyPreview, countByLabel, readGmailState, scanCounts, isPending, labelTotalsAfter, planReconcile, prefixInUseByUser, previewReconcile, type ReconcileInput, reconcile, summarize, USER_CHANGE_GRACE_MS } from "./reconcile.ts";

/** A real date, so mail dated 2014 (the makeSummary default) is old enough for the default age. */
const NOW = new Date(2026, 9, 7, 12).getTime();
const OLD = NOW - USER_CHANGE_GRACE_MS;
/** Labeled one second before NOW: inside the grace window. */
const JUST = NOW - 1000;
/** NOW once the grace window for a JUST record has passed. */
const AFTER = JUST + USER_CHANGE_GRACE_MS;

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
    overrides: new Map(),
    close: NO_CLOSE,
    ...rest,
  };
}

/** Gmail state where every id carries its label outside Trash and Spam. */
function labeled(entries: Record<string, string>) {
  return { anywhere: new Map(Object.entries(entries)), live: new Set(Object.keys(entries)) };
}

const empty = (plan: ReturnType<typeof planReconcile>) => plan.add.size === 0 && plan.remove.size === 0 && plan.put.length === 0 && plan.del.length === 0;

describe("planReconcile", () => {
  it("leaves the label alone on a candidate whose summary is missing", () => {
    const plan = planReconcile(input({ a: fakeAnswers({ newsletter: 0.95 }) }, { summaries: new Map(), records: new Map([["a", rec("a", "purge/newsletter")]]), ...labeled({ a: "purge/newsletter" }) }));
    expect(empty(plan)).toBe(true);
  });

  it("adds no label to a candidate whose summary is missing", () => {
    const plan = planReconcile(input({ a: fakeAnswers({ newsletter: 0.95 }) }, { summaries: new Map() }));
    expect(empty(plan)).toBe(true);
  });

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

  it("records an app-named label it has no record of as the user's own, even when it matches the rules", () => {
    const plan = planReconcile(input({ a: fakeAnswers({ newsletter: 0.95 }) }, labeled({ a: "purge/newsletter" })));
    expect(plan.add.size).toBe(0);
    expect(plan.remove.size).toBe(0);
    expect(plan.put).toEqual([{ id: "a", label: "purge/newsletter", labeledAt: NOW, userRemoved: false, userChosen: true }]);
  });

  it("removes the label and deletes the record for an app-labeled id outside the candidates", () => {
    const plan = planReconcile(input({}, { records: new Map([["gone", rec("gone", "purge/scam")]]), ...labeled({ gone: "purge/scam" }) }));
    expect(plan.remove).toEqual(new Map([["purge/scam", ["gone"]]]));
    expect(plan.add.size).toBe(0);
    expect(plan.del).toEqual(["gone"]);
    expect(plan.put).toEqual([]);
  });

  it("never removes or moves an app-named label it has no record of", () => {
    // Outside the candidates: the label stays and is recorded as the user's.
    const stray = planReconcile(input({}, labeled({ stray: "purge/maybe" })));
    expect(stray.remove.size + stray.add.size).toBe(0);
    expect(stray.del).toEqual([]);
    expect(stray.put).toEqual([{ id: "stray", label: "purge/maybe", labeledAt: NOW, userRemoved: false, userChosen: true }]);

    // A candidate whose desired label differs: still untouched.
    const other = planReconcile(input({ a: fakeAnswers({ promotion: 0.95 }) }, labeled({ a: "purge/newsletter" })));
    expect(other.remove.size + other.add.size).toBe(0);
    expect(other.put).toEqual([{ id: "a", label: "purge/newsletter", labeledAt: NOW, userRemoved: false, userChosen: true }]);

    // Next run, with the record written: still untouched, inside and after the grace window.
    const records = new Map(stray.put.map((r) => [r.id, r]));
    expect(empty(planReconcile(input({}, { records, ...labeled({ stray: "purge/maybe" }) })))).toBe(true);
    expect(empty(planReconcile(input({}, { now: NOW + USER_CHANGE_GRACE_MS, records, ...labeled({ stray: "purge/maybe" }) })))).toBe(true);
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

  describe("inside the grace window", () => {
    const newsletter = { a: fakeAnswers({ newsletter: 0.95 }) };
    const just = (label: string) => new Map([["a", rec("a", label, { labeledAt: JUST })]]);

    it("leaves a just-labeled email alone while Gmail's lists don't show it and its label is unchanged", () => {
      const plan = planReconcile(input(newsletter, { records: just("purge/newsletter") }));
      expect(plan.userRemoved + plan.deferred).toBe(0);
      expect(empty(plan)).toBe(true);
    });

    it("follows the rules when Gmail's lists confirm the recorded label", () => {
      const plan = planReconcile(input({ a: fakeAnswers({ promotion: 0.95 }) }, { records: just("purge/newsletter"), ...labeled({ a: "purge/newsletter" }) }));
      expect(plan.deferred).toBe(0);
      expect(plan.remove).toEqual(new Map([["purge/newsletter", ["a"]]]));
      expect(plan.add).toEqual(new Map([["purge/promotion", ["a"]]]));
    });

    it("defers, without undoing anything, a just-labeled email not in Gmail's lists whose desired label is now none", () => {
      const records = just("purge/newsletter");
      const none = { ...DEFAULT_SETTINGS, purgeKinds: [] };
      const plan = planReconcile(input(newsletter, { records, settings: none }));
      expect(plan.deferred).toBe(1);
      expect(plan.userRemoved).toBe(0);
      expect(empty(plan)).toBe(true);

      // Once the window passes and Gmail shows the label, it comes off and the record goes.
      const shown = planReconcile(input(newsletter, { now: AFTER, records, settings: none, ...labeled({ a: "purge/newsletter" }) }));
      expect(shown.deferred).toBe(0);
      expect(shown.remove).toEqual(new Map([["purge/newsletter", ["a"]]]));
      expect(shown.del).toEqual(["a"]);
      // If Gmail still doesn't show it, the user took it off: nothing is left to remove and it is never re-added.
      const gone = planReconcile(input(newsletter, { now: AFTER, records, settings: none }));
      expect(gone.userRemoved).toBe(1);
      expect(gone.add.size + gone.remove.size).toBe(0);
    });

    it("defers a just-labeled email not in Gmail's lists whose desired kind changed, then moves it once confirmed", () => {
      const records = just("purge/promotion");
      const answers = { a: fakeAnswers({ promotion: 0.4, newsletter: 0.55 }) };
      const plan = planReconcile(input(answers, { records }));
      expect(plan.deferred).toBe(1);
      expect(empty(plan)).toBe(true);

      const later = planReconcile(input(answers, { now: AFTER, records, ...labeled({ a: "purge/promotion" }) }));
      expect(later.deferred).toBe(0);
      expect(later.remove).toEqual(new Map([["purge/promotion", ["a"]]]));
      expect(later.add).toEqual(new Map([["purge/newsletter", ["a"]]]));
      expect(later.put).toEqual([{ id: "a", label: "purge/newsletter", labeledAt: AFTER, userRemoved: false, userChosen: false }]);
    });

    it("defers a prefix change for a just-labeled email not in Gmail's lists, then renames it once confirmed", () => {
      const records = just("purge/scam");
      const answers = { a: fakeAnswers({ scam: 0.95 }) };
      const settings = { ...DEFAULT_SETTINGS, labelPrefix: "old" };
      const plan = planReconcile(input(answers, { records, settings }));
      expect(plan.deferred).toBe(1);
      expect(plan.userRemoved + plan.userChosen).toBe(0);
      expect(empty(plan)).toBe(true);

      const later = planReconcile(input(answers, { now: AFTER, records, settings, ...labeled({ a: "purge/scam" }) }));
      expect(later.remove).toEqual(new Map([["purge/scam", ["a"]]]));
      expect(later.add).toEqual(new Map([["old/scam", ["a"]]]));
    });

    it("defers a just-labeled email that left the candidates, and leaves it alone in Trash or Spam", () => {
      const records = just("purge/newsletter");
      const plan = planReconcile(input({}, { records }));
      expect(plan.deferred).toBe(1);
      expect(empty(plan)).toBe(true);
      const trashed = planReconcile(input({}, { records, anywhere: new Map([["a", "purge/newsletter"]]), live: new Set() }));
      expect(trashed.deferred).toBe(0);
      expect(empty(trashed)).toBe(true);

      const later = planReconcile(input({}, { now: AFTER, records, ...labeled({ a: "purge/newsletter" }) }));
      expect(later.remove).toEqual(new Map([["purge/newsletter", ["a"]]]));
      expect(later.del).toEqual(["a"]);
    });

    it("defers when Gmail shows a different app label, then marks it user-chosen", () => {
      const records = just("purge/newsletter");
      const plan = planReconcile(input(newsletter, { records, ...labeled({ a: "purge/work" }) }));
      expect(plan.deferred).toBe(1);
      expect(plan.userChosen).toBe(0);
      expect(empty(plan)).toBe(true);

      const later = planReconcile(input(newsletter, { now: AFTER, records, ...labeled({ a: "purge/work" }) }));
      expect(later.userChosen).toBe(1);
      expect(later.add.size + later.remove.size).toBe(0);
    });
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

  it("removes labels from candidates that are now kept", () => {
    const starred = makeSummary("s", { labels: ["STARRED"] });
    const i = input({ s: fakeAnswers({ promotion: 0.95 }) }, { records: new Map([["s", rec("s", "purge/promotion")]]), ...labeled({ s: "purge/promotion" }) });
    i.summaries.set("s", starred);
    const plan = planReconcile(i);
    expect(plan.remove).toEqual(new Map([["purge/promotion", ["s"]]]));
    expect(plan.del).toEqual(["s"]);
  });
});

describe("planReconcile with overrides", () => {
  const promo = fakeAnswers({ promotion: 0.97 });
  const ov = (id: string, slug: string | null, at = NOW - 1) => new Map([[id, { id, slug, at }]]);

  it("adds the override's label to an email Jev kept", () => {
    const plan = planReconcile(input({ a: fakeAnswers({ none: 1 }) }, { overrides: ov("a", "promotion") }));
    expect(plan.add.get("purge/promotion")).toEqual(["a"]);
  });

  it("moves an email to the override's label", () => {
    const plan = planReconcile(input({ a: promo }, { ...labeled({ a: "purge/promotion" }), records: new Map([["a", rec("a", "purge/promotion")]]), overrides: ov("a", "maybe") }));
    expect(plan.remove.get("purge/promotion")).toEqual(["a"]);
    expect(plan.add.get("purge/maybe")).toEqual(["a"]);
  });

  it("removes the label for a keep override", () => {
    const plan = planReconcile(input({ a: promo }, { ...labeled({ a: "purge/promotion" }), records: new Map([["a", rec("a", "purge/promotion")]]), overrides: ov("a", null) }));
    expect(plan.remove.get("purge/promotion")).toEqual(["a"]);
    expect(plan.del).toEqual(["a"]);
  });

  it("an override newer than a user removal wins and resets the flags", () => {
    const records = new Map([["a", rec("a", "purge/promotion", { userRemoved: true })]]);
    const plan = planReconcile(input({ a: promo }, { records, overrides: ov("a", "promotion", OLD + 1) }));
    expect(plan.add.get("purge/promotion")).toEqual(["a"]);
    expect(plan.put).toContainEqual({ id: "a", label: "purge/promotion", labeledAt: NOW, userRemoved: false, userChosen: false });
    expect(plan.userRemoved).toBe(0);
  });

  it("an override newer than a user's Gmail move wins", () => {
    const records = new Map([["a", rec("a", "purge/social", { userChosen: true })]]);
    const plan = planReconcile(input({ a: promo }, { ...labeled({ a: "purge/social" }), records, overrides: ov("a", "work", OLD + 1) }));
    expect(plan.remove.get("purge/social")).toEqual(["a"]);
    expect(plan.add.get("purge/work")).toEqual(["a"]);
  });

  it("a Gmail change made after the override wins", () => {
    // Applied at OLD (after the override at OLD - 1), then the user removed the label in Gmail.
    const records = new Map([["a", rec("a", "purge/work")]]);
    const plan = planReconcile(input({ a: promo }, { records, overrides: ov("a", "work", OLD - 1) }));
    expect(plan.userRemoved).toBe(1);
    expect(plan.add.size).toBe(0);
  });

  it("does not claim an unrecorded app label as the user's when an override exists", () => {
    const plan = planReconcile(input({ a: promo }, { ...labeled({ a: "purge/social" }), overrides: ov("a", "work") }));
    expect(plan.remove.get("purge/social")).toEqual(["a"]);
    expect(plan.add.get("purge/work")).toEqual(["a"]);
    expect(plan.put.some((r) => r.userChosen)).toBe(false);
  });

  it("moves overridden emails to the new prefix", () => {
    const settings = { ...DEFAULT_SETTINGS, labelPrefix: "new" };
    const plan = planReconcile(input({ a: promo }, { settings, ...labeled({ a: "purge/work" }), records: new Map([["a", rec("a", "purge/work")]]), overrides: ov("a", "work", OLD - 1) }));
    expect(plan.remove.get("purge/work")).toEqual(["a"]);
    expect(plan.add.get("new/work")).toEqual(["a"]);
  });

  it("ignores an override for an id that is not a candidate", () => {
    expect(empty(planReconcile(input({}, { overrides: ov("gone", "promotion") })))).toBe(true);
  });

  it("never touches an overridden email in Trash or Spam", () => {
    const plan = planReconcile(input({ a: promo }, { anywhere: new Map([["a", "purge/promotion"]]), live: new Set(), records: new Map([["a", rec("a", "purge/promotion")]]), overrides: ov("a", null) }));
    expect(empty(plan)).toBe(true);
  });

  it("ignores a stale override on a non-candidate the user took over", () => {
    const records = new Map([["x", rec("x", "purge/social", { userChosen: true })]]);
    expect(empty(planReconcile(input({}, { records, ...labeled({ x: "purge/social" }), overrides: ov("x", "work", OLD + 1) })))).toBe(true);
  });

  it("ignores an override on a non-candidate with an unrecorded live app label", () => {
    // As without an override: the label is only recorded as the user's own, never added or removed.
    const plan = planReconcile(input({}, { ...labeled({ x: "purge/social" }), overrides: ov("x", "work") }));
    expect(plan.add.size + plan.remove.size + plan.del.length).toBe(0);
    expect(plan.put).toEqual([{ id: "x", label: "purge/social", labeledAt: NOW, userRemoved: false, userChosen: true }]);
  });

  describe("an applied override yields to later Gmail changes", () => {
    const later = NOW + 2 * USER_CHANGE_GRACE_MS;
    const apply = (records: Map<string, LabelRecord>, puts: LabelRecord[]) => new Map([...records, ...puts.map((r) => [r.id, r] as const)]);
    const promo = fakeAnswers({ promotion: 0.97 });

    it("re-adding is not forced after the user removes a satisfied override's label", () => {
      const overrides = ov("a", "promotion", OLD + 1);
      const records = new Map([["a", rec("a", "purge/promotion")]]);
      const run1 = planReconcile(input({ a: promo }, { records, ...labeled({ a: "purge/promotion" }), overrides }));
      const run2 = planReconcile(input({ a: promo }, { now: later, records: apply(records, run1.put), overrides }));
      expect(run2.userRemoved).toBe(1);
      expect(run2.add.size).toBe(0);
    });

    it("leaves a label the user added by hand after a keep override on a user-removed record", () => {
      const overrides = ov("a", null, OLD + 1);
      const records = new Map([["a", rec("a", "purge/promotion", { userRemoved: true })]]);
      const run1 = planReconcile(input({ a: promo }, { records, overrides }));
      const run2 = planReconcile(input({ a: promo }, { now: later, records: apply(records, run1.put), ...labeled({ a: "purge/work" }), overrides }));
      expect(run2.remove.size).toBe(0);
      expect(run2.add.size).toBe(0);
    });

    it("records an unrecorded live label that already matches the override, so a later removal sticks", () => {
      const overrides = ov("a", "promotion");
      const run1 = planReconcile(input({ a: promo }, { ...labeled({ a: "purge/promotion" }), overrides }));
      const run2 = planReconcile(input({ a: promo }, { now: later, records: apply(new Map(), run1.put), overrides }));
      expect(run2.userRemoved).toBe(1);
      expect(run2.add.size).toBe(0);
    });
  });
});

describe("planReconcile: narrower rules without a rescan", () => {
  const yearOld = makeSummary("a", { date: new Date(2025, 9, 7).toUTCString() });
  const promo = { a: fakeAnswers({ promotion: 0.97 }) };

  it("removes a recorded label from mail that is now too new after the age is raised", () => {
    // Scanned at any age (0) and labeled; the age is now 60 months, so a 1-year-old email is kept.
    const plan = planReconcile(
      input(promo, { summaries: new Map([["a", yearOld]]), settings: { ...DEFAULT_SETTINGS, ageMonths: 60 }, records: new Map([["a", rec("a", "purge/promotion")]]), ...labeled({ a: "purge/promotion" }) }),
    );
    expect(plan.remove).toEqual(new Map([["purge/promotion", ["a"]]]));
    expect(plan.add.size).toBe(0);
    expect(plan.del).toEqual(["a"]);
  });

  it("keeps an override on mail that is too new", () => {
    const plan = planReconcile(
      input(promo, {
        summaries: new Map([["a", yearOld]]),
        settings: { ...DEFAULT_SETTINGS, ageMonths: 60 },
        records: new Map([["a", rec("a", "purge/promotion")]]),
        overrides: new Map([["a", { id: "a", slug: "promotion", at: NOW - 1 }]]),
        ...labeled({ a: "purge/promotion" }),
      }),
    );
    expect(plan.remove.size).toBe(0);
    expect(plan.del).toEqual([]);
  });

  it("adds no label to new mail that is too new", () => {
    const plan = planReconcile(input(promo, { summaries: new Map([["a", yearOld]]), settings: { ...DEFAULT_SETTINGS, ageMonths: 60 } }));
    expect(plan.add.size).toBe(0);
  });

  it("uses the age it is given at 0 months and labels mail of any age", () => {
    const plan = planReconcile(input(promo, { summaries: new Map([["a", yearOld]]), settings: { ...DEFAULT_SETTINGS, ageMonths: 0 } }));
    expect(plan.add).toEqual(new Map([["purge/promotion", ["a"]]]));
  });

  it("removes a recorded label from starred mail once starred mail is kept again", () => {
    const starred = makeSummary("a", { labels: ["STARRED"] });
    const plan = planReconcile(input(promo, { summaries: new Map([["a", starred]]), records: new Map([["a", rec("a", "purge/promotion")]]), ...labeled({ a: "purge/promotion" }) }));
    expect(plan.remove).toEqual(new Map([["purge/promotion", ["a"]]]));
  });
});

describe("reconcile", () => {
  it("moves labels in Gmail to match changed purge kinds and saves the records", async () => {
    const store = await openStore(testKey, `t-${crypto.randomUUID()}`);
    const msgs = [makeSummary("news"), makeSummary("promo")];
    const gmail = createFakeGmail(msgs);
    for (const m of msgs) await store.putSummary(m);
    await store.putAnswers("news", fakeAnswers({ newsletter: 0.95 }));
    await store.putAnswers("promo", fakeAnswers({ promotion: 0.35, social: 0.3, newsletter: 0.2 }));
    await store.putScan({ ageMonths: 120, candidateIds: ["news", "promo"], repliedThreadIds: [], finished: true, startedAt: 0, settingsAtScan: DEFAULT_SETTINGS, msPerEmail: 100 });

    const first = await reconcile({ gmail, store, now: () => NOW }, DEFAULT_SETTINGS);
    expect(first).toEqual({ added: 2, removed: 0, moved: 0, userRemoved: 0, userChosen: 0, deferred: 0 });
    expect(gmail.labelsOf.get("news")).toEqual(new Set(["purge/newsletter"]));
    expect(gmail.labelsOf.get("promo")).toEqual(new Set(["purge/promotion"]));

    // Without promotion the promo email drops below the purge bar (0.5) and moves to maybe.
    const settings: Settings = { ...DEFAULT_SETTINGS, purgeKinds: DEFAULT_SETTINGS.purgeKinds.filter((k) => k !== "promotion") };
    const later = NOW + USER_CHANGE_GRACE_MS;
    const second = await reconcile({ gmail, store, now: () => later }, settings);
    expect(second).toEqual({ added: 0, removed: 0, moved: 1, userRemoved: 0, userChosen: 0, deferred: 0 });
    expect(gmail.labelsOf.get("news")).toEqual(new Set(["purge/newsletter"]));
    expect(gmail.labelsOf.get("promo")).toEqual(new Set(["purge/maybe"]));
    expect(idsWithLabel(gmail, "purge/promotion")).toEqual([]);

    const records = await store.allLabels();
    expect(records.get("news")?.labeledAt).toBe(NOW);
    expect(records.get("promo")).toEqual({ id: "promo", label: "purge/maybe", labeledAt: later, userRemoved: false, userChosen: false });
    // Apply never changes which rules the scan's candidate list covers.
    expect((await store.getScan())?.settingsAtScan).toEqual(DEFAULT_SETTINGS);
  });

  it("defers a just-labeled email whose label is gone from Gmail, then marks it user-removed", async () => {
    const store = await openStore(testKey, `t-${crypto.randomUUID()}`);
    const gmail = createFakeGmail([makeSummary("a")]);
    await store.putSummary(makeSummary("a"));
    await store.putAnswers("a", fakeAnswers({ newsletter: 0.95 }));
    await store.putScan({ ageMonths: 120, candidateIds: ["a"], repliedThreadIds: [], finished: true, startedAt: 0, settingsAtScan: DEFAULT_SETTINGS, msPerEmail: 100 });
    // Just labeled purge/promotion, but that label no longer exists in Gmail.
    await store.putLabels([rec("a", "purge/promotion", { labeledAt: JUST })]);
    const addLabel = vi.spyOn(gmail, "addLabel");
    const removeLabel = vi.spyOn(gmail, "removeLabel");

    const r = await reconcile({ gmail, store, now: () => NOW }, DEFAULT_SETTINGS);
    expect(r).toEqual({ added: 0, removed: 0, moved: 0, userRemoved: 0, userChosen: 0, deferred: 1 });
    expect(addLabel).not.toHaveBeenCalled();
    expect(removeLabel).not.toHaveBeenCalled();
    expect((await store.allLabels()).get("a")).toEqual(rec("a", "purge/promotion", { labeledAt: JUST }));

    const later = await reconcile({ gmail, store, now: () => AFTER }, DEFAULT_SETTINGS);
    expect(later).toEqual({ added: 0, removed: 0, moved: 0, userRemoved: 1, userChosen: 0, deferred: 0 });
    expect(addLabel).not.toHaveBeenCalled();
    expect(gmail.labelsOf.has("a")).toBe(false);
  });

  it("keeps an app-named label it has no record of and records it as the user's", async () => {
    const store = await openStore(testKey, `t-${crypto.randomUUID()}`);
    const gmail = createFakeGmail([makeSummary("mine")]);
    await store.putScan({ ageMonths: 120, candidateIds: [], repliedThreadIds: [], finished: true, startedAt: 0, settingsAtScan: DEFAULT_SETTINGS, msPerEmail: 100 });
    gmail.labelsOf.set("mine", new Set(["purge/work"]));
    const r = await reconcile({ gmail, store, now: () => NOW }, DEFAULT_SETTINGS);
    expect(r).toMatchObject({ added: 0, removed: 0, moved: 0 });
    expect(gmail.labelsOf.get("mine")).toEqual(new Set(["purge/work"]));
    expect((await store.allLabels()).get("mine")).toEqual({ id: "mine", label: "purge/work", labeledAt: NOW, userRemoved: false, userChosen: true });
  });

  it("reports a label name Gmail rejects as a plain Invalid error", async () => {
    const store = await openStore(testKey, `t-${crypto.randomUUID()}`);
    const gmail = createFakeGmail([makeSummary("a")]);
    await store.putSummary(makeSummary("a"));
    await store.putAnswers("a", fakeAnswers({ newsletter: 0.95 }));
    await store.putScan({ ageMonths: 120, candidateIds: ["a"], repliedThreadIds: [], finished: true, startedAt: 0, settingsAtScan: DEFAULT_SETTINGS, msPerEmail: 100 });
    for (const status of [400, 409]) {
      gmail.ensureLabel = async () => {
        throw new GmailError(status, "invalidArgument", "Invalid label name");
      };
      const err = await reconcile({ gmail, store, now: () => NOW }, DEFAULT_SETTINGS).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).payload).toEqual({ kind: "Invalid", detail: "Gmail didn't accept that label name. Try another on the Rules screen." });
    }
    gmail.ensureLabel = async () => {
      throw new GmailError(500, "backendError", "boom");
    };
    await expect(reconcile({ gmail, store, now: () => NOW }, DEFAULT_SETTINGS)).rejects.toBeInstanceOf(GmailError);
  });

  it("leaves a trashed labeled email alone and detects a user removal", async () => {
    const store = await openStore(testKey, `t-${crypto.randomUUID()}`);
    const msgs = [makeSummary("trashed"), makeSummary("removed")];
    const gmail = createFakeGmail(msgs);
    for (const m of msgs) {
      await store.putSummary(m);
      await store.putAnswers(m.id, fakeAnswers({ newsletter: 0.95 }));
    }
    await store.putScan({ ageMonths: 120, candidateIds: ["trashed", "removed"], repliedThreadIds: [], finished: true, startedAt: 0, settingsAtScan: DEFAULT_SETTINGS, msPerEmail: 100 });
    await store.putLabels([rec("trashed", "purge/newsletter"), rec("removed", "purge/newsletter")]);
    gmail.labelsOf.set("trashed", new Set(["purge/newsletter"]));
    gmail.trashed.add("trashed");

    const r = await reconcile({ gmail, store, now: () => NOW }, { ...DEFAULT_SETTINGS, purgeKinds: ["promotion"] });
    expect(r).toEqual({ added: 0, removed: 0, moved: 0, userRemoved: 1, userChosen: 0, deferred: 0 });
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

  it("reads by label id with no search text, subtracting the label-and-STARRED list", async () => {
    const gmail = createFakeGmail([makeSummary("a"), makeSummary("b", { labels: ["STARRED"] })]);
    gmail.labelsOf.set("a", new Set(["purge/promotion"]));
    gmail.labelsOf.set("b", new Set(["purge/promotion"]));
    gmail.labelsOf.set("s", new Set(["purge/scam"]));
    const listIds = vi.spyOn(gmail, "listIds");
    await countByLabel(gmail, DEFAULT_SETTINGS);
    expect(listIds.mock.calls.every(([q]) => q === "")).toBe(true);
    expect(listIds).toHaveBeenCalledWith("", Infinity, { labelIds: ["purge/promotion"] });
    expect(listIds).toHaveBeenCalledWith("", Infinity, { labelIds: ["purge/promotion", "STARRED"] });

    // A label holding only starred mail is left out when starred mail is protected.
    gmail.labelsOf.set("a", new Set());
    expect(await countByLabel(gmail, DEFAULT_SETTINGS)).toEqual(new Map([["purge/scam", 1]]));
  });
});

describe("prefixInUseByUser", () => {
  it("is true when labels under the prefix hold mail and the app has no records under it", async () => {
    const gmail = createFakeGmail([makeSummary("a"), makeSummary("b")]);
    gmail.labelsOf.set("a", new Set(["mine/work"]));
    expect(await prefixInUseByUser(gmail, new Map(), "mine")).toBe(true);
    expect(await prefixInUseByUser(gmail, new Map(), "other")).toBe(false);
    // The parent label alone counts too.
    gmail.labelsOf.set("b", new Set(["box"]));
    expect(await prefixInUseByUser(gmail, new Map(), "box")).toBe(true);
    // A record reconcile wrote for a label it found there (user-chosen) doesn't make it the app's.
    expect(await prefixInUseByUser(gmail, new Map([["a", rec("a", "mine/work", { userChosen: true })]]), "mine")).toBe(true);
  });

  it("is false when the app has its own records under the prefix, in any case", async () => {
    const gmail = createFakeGmail([makeSummary("a")]);
    gmail.labelsOf.set("a", new Set(["purge/promotion"]));
    expect(await prefixInUseByUser(gmail, new Map([["a", rec("a", "Purge/promotion")]]), "purge")).toBe(false);
    expect(await prefixInUseByUser(gmail, new Map([["x", rec("x", "purge/maybe", { userRemoved: true })]]), "purge")).toBe(false);
  });
});

describe("summarize", () => {
  it("counts decisions over scanned candidates", async () => {
    const store = await openStore(testKey, `t-${crypto.randomUUID()}`);
    for (const id of ["news", "promo", "other"]) await store.putSummary(makeSummary(id));
    await store.putAnswers("news", fakeAnswers({ newsletter: 0.95 }));
    await store.putAnswers("promo", fakeAnswers({ promotion: 0.95 }));
    await store.putAnswers("other", fakeAnswers({ promotion: 0.95 }));
    await store.putScan({ ageMonths: 120, candidateIds: ["news", "promo", "other"], repliedThreadIds: [], finished: true, startedAt: 0, settingsAtScan: DEFAULT_SETTINGS, msPerEmail: 100 });
    expect(await summarize(store, { ...DEFAULT_SETTINGS, purgeKinds: ["newsletter"] })).toEqual({ purge: 1, keep: 2, review: 0 });
  });

  it("uses the starred setting", async () => {
    const store = await openStore(testKey, `t-${crypto.randomUUID()}`);
    await store.putSummary(makeSummary("s", { labels: ["STARRED"] }));
    await store.putAnswers("s", fakeAnswers({ promotion: 0.95 }));
    await store.putScan({ ageMonths: 120, candidateIds: ["s"], repliedThreadIds: [], finished: true, startedAt: 0, settingsAtScan: DEFAULT_SETTINGS, msPerEmail: 100 });
    expect(await summarize(store, DEFAULT_SETTINGS)).toEqual({ purge: 0, keep: 1, review: 0 });
    expect(await summarize(store, { ...DEFAULT_SETTINGS, keepStarred: false })).toEqual({ purge: 1, keep: 0, review: 0 });
  });

  it("counts mail newer than the age as keep", async () => {
    const store = await openStore(testKey, `t-${crypto.randomUUID()}`);
    await store.putSummary(makeSummary("a", { date: new Date(2025, 9, 7).toUTCString() }));
    await store.putAnswers("a", fakeAnswers({ promotion: 0.95 }));
    await store.putScan({ ageMonths: 0, candidateIds: ["a"], repliedThreadIds: [], finished: true, startedAt: 0, settingsAtScan: DEFAULT_SETTINGS, msPerEmail: 100 });
    expect(await summarize(store, { ...DEFAULT_SETTINGS, ageMonths: 60 }, NOW)).toEqual({ purge: 0, keep: 1, review: 0 });
    expect(await summarize(store, { ...DEFAULT_SETTINGS, ageMonths: 6 }, NOW)).toEqual({ purge: 1, keep: 0, review: 0 });
  });

  it("counts overrides by their label: no label is keep, maybe is review, any other is purge", async () => {
    const store = await openStore(testKey, `t-${crypto.randomUUID()}`);
    for (const id of ["a", "b", "c"]) {
      await store.putSummary(makeSummary(id));
      await store.putAnswers(id, fakeAnswers({ promotion: 0.95 }));
    }
    await store.putScan({ ageMonths: 120, candidateIds: ["a", "b", "c"], repliedThreadIds: [], finished: true, startedAt: 0, settingsAtScan: DEFAULT_SETTINGS, msPerEmail: 100 });
    await store.putOverrideList([
      { id: "a", slug: null, at: 1 },
      { id: "b", slug: "maybe", at: 1 },
    ]);
    expect(await summarize(store, DEFAULT_SETTINGS)).toEqual({ purge: 1, keep: 1, review: 1 });
  });
});

describe("scanCounts", () => {
  async function arrange() {
    const store = await openStore(testKey, `t-${crypto.randomUUID()}`);
    for (const id of ["news", "promo"]) await store.putSummary(makeSummary(id));
    await store.putAnswers("news", fakeAnswers({ newsletter: 0.95 }));
    await store.putAnswers("promo", fakeAnswers({ promotion: 0.95 }));
    await store.putScan({ ageMonths: 120, candidateIds: ["news", "promo"], repliedThreadIds: [], finished: true, startedAt: 0, settingsAtScan: DEFAULT_SETTINGS, msPerEmail: 100 });
    return store;
  }

  it("counts under the current rules when the scan covers them", async () => {
    const store = await arrange();
    const settings = { ...DEFAULT_SETTINGS, purgeKinds: DEFAULT_SETTINGS.purgeKinds.filter((k) => k !== "promotion") };
    expect(await scanCounts(store, (await store.getScan())!, settings)).toEqual({ purge: 1, keep: 1, review: 0 });
  });

  it("gives no counts when the rules widened since the scan", async () => {
    const store = await arrange();
    expect(await scanCounts(store, (await store.getScan())!, { ...DEFAULT_SETTINGS, ageMonths: 6 })).toBeNull();
    expect(await scanCounts(store, (await store.getScan())!, { ...DEFAULT_SETTINGS, keepStarred: false })).toBeNull();
  });

  it("gives no counts for a scan that never finished", async () => {
    const store = await arrange();
    expect(await scanCounts(store, { ...(await store.getScan())!, settingsAtScan: null }, DEFAULT_SETTINGS)).toBeNull();
  });
});

describe("labelTotalsAfter", () => {
  it("counts live labels after adds and removes", () => {
    const plan = planReconcile(
      input(
        { a: fakeAnswers({ newsletter: 0.95 }), b: fakeAnswers({ promotion: 0.95 }) },
        { ...labeled({ a: "purge/promotion", c: "purge/promotion" }), records: new Map([["a", rec("a", "purge/promotion")]]) },
      ),
    );
    // a (recorded) moves promotion → newsletter, b gains promotion, c is unrecorded so it's the user's and stays.
    expect(labelTotalsAfter(new Set(["a", "c"]), new Map([["a", "purge/promotion"], ["c", "purge/promotion"]]), plan)).toEqual(
      new Map([["purge/promotion", 2], ["purge/newsletter", 1]]),
    );
  });
});

describe("previewReconcile", () => {
  async function arrange() {
    const store = await openStore(testKey, `t-${crypto.randomUUID()}`);
    const gmail = createFakeGmail([makeSummary("a")]);
    await store.putSummary(makeSummary("a"));
    await store.putAnswers("a", fakeAnswers({ promotion: 0.97 }));
    await store.putScan({ ageMonths: 120, settings: DEFAULT_SETTINGS, candidateIds: ["a"], repliedThreadIds: [], finished: true, startedAt: 0, settingsAtScan: DEFAULT_SETTINGS, msPerEmail: null });
    return { store, gmail };
  }

  it("plans without writing, and applyPreview writes the plan", async () => {
    const { store, gmail } = await arrange();
    const preview = await previewReconcile({ gmail, store, now: () => NOW }, DEFAULT_SETTINGS);
    expect(preview).toMatchObject({ added: 1, removed: 0, moved: 0 });
    expect(preview.totals).toEqual(new Map([["purge/promotion", 1]]));
    expect(idsWithLabel(gmail, "purge/promotion")).toEqual([]);
    expect((await store.allLabels()).size).toBe(0);

    await applyPreview({ gmail, store }, preview);
    expect(idsWithLabel(gmail, "purge/promotion")).toEqual(["a"]);
    expect((await store.allLabels()).get("a")?.label).toBe("purge/promotion");
  });

  it("leaves the scan's coverage alone when applying narrower rules", async () => {
    const { store, gmail } = await arrange();
    const anyAge = { ...DEFAULT_SETTINGS, ageMonths: 0 };
    await store.putScan({ ...(await store.getScan())!, ageMonths: 0, settings: anyAge, settingsAtScan: anyAge });
    const narrower = { ...DEFAULT_SETTINGS, ageMonths: 60 };
    await applyPreview({ gmail, store }, await previewReconcile({ gmail, store, now: () => NOW }, narrower));
    const scan = (await store.getScan())!;
    expect(scan.settingsAtScan).toEqual(anyAge);
    expect(needsRescan(scan.settingsAtScan!, anyAge)).toBe(false);
  });

  it("names the old prefix whose labels a rename empties", async () => {
    const { store, gmail } = await arrange();
    const oldId = await gmail.ensureLabel("purge/promotion");
    await gmail.addLabel(oldId, ["a"]);
    await store.putLabels([rec("a", "purge/promotion")]);
    const preview = await previewReconcile({ gmail, store, now: () => NOW }, { ...DEFAULT_SETTINGS, labelPrefix: "new" });
    expect(preview.oldPrefixes).toEqual(["purge"]);
    expect(preview.moved).toBe(1);
  });

  it("names no old prefix for an emptied label without a slash", async () => {
    const { store, gmail } = await arrange();
    const oldId = await gmail.ensureLabel("oldlabel");
    await gmail.addLabel(oldId, ["a"]);
    await store.putLabels([rec("a", "oldlabel")]);
    const preview = await previewReconcile({ gmail, store, now: () => NOW }, DEFAULT_SETTINGS);
    expect(preview.plan.remove.get("oldlabel")).toEqual(["a"]);
    expect(preview.oldPrefixes).toEqual([]);
  });

  it("rejects without calling Gmail when the scan has not finished", async () => {
    for (const scan of [{ finished: false }, { finished: true, settingsAtScan: null }]) {
      const { store, gmail } = await arrange();
      await store.putScan({ ...(await store.getScan())!, ...scan });
      const calls = (["findLabelId", "listIds", "ensureLabel", "addLabel", "removeLabel"] as const).map((m) => vi.spyOn(gmail, m));
      const err = await previewReconcile({ gmail, store, now: () => NOW }, DEFAULT_SETTINGS).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).payload).toEqual({ kind: "Invalid", detail: "Scan your mail first." });
      for (const spy of calls) expect(spy).not.toHaveBeenCalled();
    }
    const store = await openStore(testKey, `t-${crypto.randomUUID()}`);
    await expect(previewReconcile({ gmail: createFakeGmail([]), store, now: () => NOW }, DEFAULT_SETTINGS)).rejects.toBeInstanceOf(AppError);
  });

  it("saves a store-only plan without Gmail writes, so a later Gmail removal of an override's label sticks", async () => {
    const { store, gmail } = await arrange();
    // Labeled by an earlier Apply, then overridden to the same label on the Review screen.
    const labelId = await gmail.ensureLabel("purge/promotion");
    await gmail.addLabel(labelId, ["a"]);
    await store.putLabels([rec("a", "purge/promotion")]);
    await store.putOverrides(["a"], "promotion", OLD + 1);

    const preview = await previewReconcile({ gmail, store, now: () => NOW }, DEFAULT_SETTINGS);
    expect(isPending(preview)).toBe(false);
    expect(preview.plan.put.length).toBeGreaterThan(0);
    const writes = (["ensureLabel", "addLabel", "removeLabel"] as const).map((m) => vi.spyOn(gmail, m));
    await applyPreview({ gmail, store }, preview);
    for (const spy of writes) expect(spy).not.toHaveBeenCalled();

    // The user takes the label off in Gmail; once the grace window passes, that removal is theirs.
    await gmail.removeLabel(labelId, ["a"]);
    const later = await previewReconcile({ gmail, store, now: () => NOW + USER_CHANGE_GRACE_MS }, DEFAULT_SETTINGS);
    expect(later.plan.add.size).toBe(0);
    expect(later.plan.userRemoved).toBe(1);
  });
});

describe("progress reporting", () => {
  async function arrange(ids: string[]) {
    const store = await openStore(testKey, `t-${crypto.randomUUID()}`);
    const msgs = ids.map((id) => makeSummary(id));
    const gmail = createFakeGmail(msgs);
    for (const m of msgs) {
      await store.putSummary(m);
      await store.putAnswers(m.id, fakeAnswers({ promotion: 0.97 }));
    }
    await store.putScan({ ageMonths: 120, candidateIds: ids, repliedThreadIds: [], finished: true, startedAt: 0, settingsAtScan: DEFAULT_SETTINGS, msPerEmail: null });
    return { store, gmail };
  }

  it("reports each label as readGmailState starts reading it", async () => {
    const gmail = createFakeGmail([]);
    const steps: { index: number; total: number; label: string }[] = [];
    await readGmailState(gmail, DEFAULT_SETTINGS, new Map(), (s) => steps.push(s));
    const names = appLabelNames(DEFAULT_SETTINGS.labelPrefix);
    expect(steps.map((s) => s.label)).toEqual(names);
    expect(steps.map((s) => s.index)).toEqual(names.map((_, i) => i + 1));
    expect(new Set(steps.map((s) => s.total))).toEqual(new Set([names.length]));
  });

  it("counts recorded labels outside the current prefix in the total", async () => {
    const gmail = createFakeGmail([]);
    const steps: { index: number; total: number; label: string }[] = [];
    await readGmailState(gmail, DEFAULT_SETTINGS, new Map([["a", rec("a", "old/newsletter")]]), (s) => steps.push(s));
    const total = appLabelNames(DEFAULT_SETTINGS.labelPrefix).length + 1;
    expect(steps).toHaveLength(total);
    expect(steps.at(-1)).toEqual({ index: total, total, label: "old/newsletter" });
  });

  it("passes onStep through previewReconcile", async () => {
    const { store, gmail } = await arrange(["a"]);
    const steps: number[] = [];
    await previewReconcile({ gmail, store, now: () => NOW }, DEFAULT_SETTINGS, { onStep: (s) => steps.push(s.index) });
    expect(steps).toEqual(appLabelNames(DEFAULT_SETTINGS.labelPrefix).map((_, i) => i + 1));
  });

  it("reports apply progress from 0 to total, once per batch of up to 1000 ids", async () => {
    const ids = Array.from({ length: 2500 }, (_, i) => `m${i}`);
    const { store, gmail } = await arrange(ids);
    const preview = await previewReconcile({ gmail, store, now: () => NOW }, DEFAULT_SETTINGS);
    const addLabel = vi.spyOn(gmail, "addLabel");
    const calls: [number, number][] = [];
    await applyPreview({ gmail, store }, preview, { onProgress: (done, total) => calls.push([done, total]) });
    expect(calls).toEqual([[0, 2500], [1000, 2500], [2000, 2500], [2500, 2500]]);
    expect(addLabel.mock.calls.map(([, chunk]) => chunk.length)).toEqual([1000, 1000, 500]);
    expect(idsWithLabel(gmail, "purge/promotion")).toHaveLength(2500);
  });

  it("counts adds and removes together and does all adds first", async () => {
    const { store, gmail } = await arrange(["a", "b"]);
    const oldId = await gmail.ensureLabel("purge/newsletter");
    await gmail.addLabel(oldId, ["a"]);
    await store.putLabels([rec("a", "purge/newsletter")]);
    const preview = await previewReconcile({ gmail, store, now: () => NOW }, DEFAULT_SETTINGS);
    const order: string[] = [];
    vi.spyOn(gmail, "addLabel").mockImplementation(async () => void order.push("add"));
    vi.spyOn(gmail, "removeLabel").mockImplementation(async () => void order.push("remove"));
    const calls: [number, number][] = [];
    await applyPreview({ gmail, store }, preview, { onProgress: (d, t) => calls.push([d, t]) });
    expect(order).toEqual(["add", "remove"]);
    expect(calls).toEqual([[0, 3], [2, 3], [3, 3]]);
  });

  it("reports (0, 0) when there is nothing to write", async () => {
    const { store, gmail } = await arrange([]);
    const preview = await previewReconcile({ gmail, store, now: () => NOW }, DEFAULT_SETTINGS);
    const calls: [number, number][] = [];
    await applyPreview({ gmail, store }, preview, { onProgress: (d, t) => calls.push([d, t]) });
    expect(calls[0]).toEqual([0, 0]);
    expect(calls.at(-1)).toEqual([0, 0]);
  });

  it("counts a removal on a label the user deleted as one step, with no Gmail call", async () => {
    const { store, gmail } = await arrange(["a"]);
    const preview = await previewReconcile({ gmail, store, now: () => NOW }, DEFAULT_SETTINGS);
    // A label Gmail no longer has is absent from preview.gmail.labelIds: its removal is already done.
    preview.plan.remove.set("gone/label", ["a"]);
    const removeLabel = vi.spyOn(gmail, "removeLabel");
    const calls: [number, number][] = [];
    await applyPreview({ gmail, store }, preview, { onProgress: (d, t) => calls.push([d, t]) });
    expect(removeLabel).not.toHaveBeenCalled();
    expect(calls.at(-1)).toEqual([2, 2]);
  });
});

describe("trivial personal mail and close people", () => {
  const on: Settings = { ...DEFAULT_SETTINGS, trivialPersonal: true };
  const trivial = { ...fakeAnswers({ none: 1 }, { personal: 0.9 }), significance: 0.1 };
  const summaries = new Map([["a", makeSummary("a", { from: "Ann <ann@x.com>" })]]);

  it("labels a trivial personal email from someone not close purge/personal", () => {
    const plan = planReconcile(input({ a: trivial }, { settings: on, summaries, close: knownClose() }));
    expect(plan.add).toEqual(new Map([["purge/personal", ["a"]]]));
  });

  it("removes that label on the next plan once the sender is close, with no rescan", () => {
    const plan = planReconcile(input({ a: trivial }, { settings: on, summaries, records: new Map([["a", rec("a", "purge/personal")]]), ...labeled({ a: "purge/personal" }), close: knownClose(["ann@x.com"]) }));
    expect(plan.remove).toEqual(new Map([["purge/personal", ["a"]]]));
    expect(plan.add.size).toBe(0);
    expect(plan.del).toEqual(["a"]);
  });

  it("reads the close set from the store in summarize and previewReconcile, for the signed-in account only", async () => {
    const store = await openStore(testKey, `t-${crypto.randomUUID()}`);
    const gmail = createFakeGmail([summaries.get("a")!]);
    await store.putSummary(summaries.get("a")!);
    await store.putAnswers("a", trivial);
    await store.putScan({ ageMonths: 120, settings: on, candidateIds: ["a"], repliedThreadIds: [], finished: true, startedAt: 1, settingsAtScan: on, msPerEmail: null });
    // Not counted yet: personal mail is kept.
    expect(await summarize(store, on, NOW, "me@gmail.com")).toEqual({ purge: 0, keep: 1, review: 0 });
    expect((await previewReconcile({ gmail, store, now: () => NOW }, on)).plan.add.size).toBe(0);

    await store.putSenderStats({ ownAddress: "me@gmail.com", counted: [], people: [], complete: true });
    expect(await summarize(store, on, NOW, "me@gmail.com")).toEqual({ purge: 1, keep: 0, review: 0 });
    expect((await previewReconcile({ gmail, store, now: () => NOW }, on)).plan.add).toEqual(new Map([["purge/personal", ["a"]]]));
    // Counts from another account count as none.
    expect(await summarize(store, on, NOW, "other@gmail.com")).toEqual({ purge: 0, keep: 1, review: 0 });
    expect(await summarize(store, on, NOW)).toEqual({ purge: 0, keep: 1, review: 0 });

    await store.putCloseChoices({ "ann@x.com": true });
    expect(await summarize(store, on, NOW, "me@gmail.com")).toEqual({ purge: 0, keep: 1, review: 0 });
    expect((await previewReconcile({ gmail, store, now: () => NOW }, on)).plan.add.size).toBe(0);
  });

  it("keeps everything personal when the counts are from another account", async () => {
    const store = await openStore(testKey, `t-${crypto.randomUUID()}`);
    const gmail = createFakeGmail([summaries.get("a")!]);
    await store.putSummary(summaries.get("a")!);
    await store.putAnswers("a", trivial);
    await store.putScan({ ageMonths: 120, settings: on, candidateIds: ["a"], repliedThreadIds: [], finished: true, startedAt: 1, settingsAtScan: on, msPerEmail: null });
    await store.putSenderStats({ ownAddress: "other@gmail.com", counted: [], people: [], complete: true });
    expect((await previewReconcile({ gmail, store, now: () => NOW }, on)).plan.add.size).toBe(0);
  });

  it("reads the personal label back from Gmail", async () => {
    expect(appLabelNames("purge")).toContain("purge/personal");
  });
});

