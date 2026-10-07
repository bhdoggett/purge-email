import { APIError } from "@typesafe-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@core/decide.ts";
import { GmailError } from "../gmail/client.ts";
import { openStore } from "../storage/db.ts";
import { ScanEngine } from "./engine.ts";
import { createFakeGmail, fakeAnswers, makeSummary } from "./fakes.ts";

async function setup(messages = [makeSummary("promo"), makeSummary("mom"), makeSummary("att", { attachmentNames: ["a.pdf"] })], extra: { labelBatch?: number; concurrency?: number } = {}) {
  const store = await openStore(`t-${crypto.randomUUID()}`);
  const gmail = createFakeGmail(messages);
  const judge = vi.fn(async (f: { subject: string }) =>
    f.subject.includes("mom") ? fakeAnswers({ none: 1 }, { personal: 0.95 }) : fakeAnswers({ promotion: 0.97 }),
  );
  const notify = vi.fn();
  const engine = new ScanEngine({ gmail, judge, store, labelName: "purge-test", notify, ...extra });
  return { store, gmail, judge, engine, notify };
}

describe("ScanEngine", () => {
  it("labels purge decisions, skips Jev for attachments, and records labels", async () => {
    const { gmail, judge, engine, store, notify } = await setup();
    await engine.start(DEFAULT_SETTINGS);
    const p = engine.getProgress();
    expect(p.stage).toBe("done");
    expect(p.counts).toEqual({ purge: 1, keep: 2, review: 0, failed: 0 });
    expect([...gmail.labeled]).toEqual(["promo"]);
    expect(judge).toHaveBeenCalledTimes(2);
    expect(p.costUsd).toBeCloseTo((2 * 1000 * 0.042) / 1_000_000);
    expect((await store.allLabels()).get("promo")?.labeledByApp).toBe(true);
    expect((await store.getScan())?.finished).toBe(true);
    expect((await store.getScan())?.settingsAtScan).toEqual(DEFAULT_SETTINGS);
    expect(p.recent[0]?.id).toBeDefined();
    expect(notify).toHaveBeenCalledOnce();
  });

  it("counts a failed fetch as review and keeps going", async () => {
    const { gmail, engine } = await setup();
    gmail.failIds.add("mom");
    await engine.start(DEFAULT_SETTINGS);
    expect(engine.getProgress().counts).toEqual({ purge: 1, keep: 1, review: 1, failed: 1 });
  });

  it("pauses when sign-in expires, then resumes without re-judging", async () => {
    const { gmail, judge, engine } = await setup();
    gmail.expireAfter = 1;
    await engine.start({ ...DEFAULT_SETTINGS });
    expect(engine.getProgress().stage).toBe("signInExpired");
    const judgedBefore = judge.mock.calls.length;

    gmail.expireAfter = null;
    await engine.start(DEFAULT_SETTINGS);
    expect(engine.getProgress().stage).toBe("done");
    expect(judgedBefore).toBe(1);
    expect(judge).toHaveBeenCalledTimes(2);
    expect(engine.getProgress().counts.purge).toBe(1);
  });

  it("finishes cleanly with zero candidates", async () => {
    const { engine } = await setup([]);
    await engine.start(DEFAULT_SETTINGS);
    const p = engine.getProgress();
    expect(p.stage).toBe("done");
    expect(p.total).toBe(0);
    expect(p.etaMs).toBeNull();
  });

  it("ignores a second start while running and uses settings captured at start", async () => {
    const { engine, judge } = await setup();
    const settings = { ...DEFAULT_SETTINGS };
    const first = engine.start(settings);
    const second = engine.start({ ...DEFAULT_SETTINGS, purgeKinds: [] });
    settings.purgeKinds = [];
    await Promise.all([first, second]);
    expect(judge).toHaveBeenCalledTimes(2);
    expect(engine.getProgress().counts.purge).toBe(1);
  });

  it("does not re-add a label to an email already recorded as labeled", async () => {
    const { gmail, engine, store } = await setup();
    await store.putLabels([{ id: "promo", labeledByApp: true, userRemoved: true }]);
    await engine.start(DEFAULT_SETTINGS);
    expect(gmail.labeled.has("promo")).toBe(false);
  });

  it("builds a new candidate list when the age setting changed since an unfinished scan", async () => {
    const { engine, store } = await setup();
    await store.putScan({ years: 5, candidateIds: ["stale"], repliedThreadIds: [], finished: false, startedAt: 0, settingsAtScan: null, msPerEmail: null });
    await engine.start({ ...DEFAULT_SETTINGS, years: 10 });
    expect((await store.getScan())?.candidateIds).toEqual(["promo", "mom", "att"]);
  });

  it("stops after pause and finishes on the next start", async () => {
    const { engine, judge } = await setup();
    judge.mockImplementationOnce(async () => {
      engine.pause();
      return fakeAnswers({ promotion: 0.97 });
    });
    await engine.start(DEFAULT_SETTINGS);
    expect(engine.getProgress().stage).toBe("paused");
    await engine.start(DEFAULT_SETTINGS);
    expect(engine.getProgress().stage).toBe("done");
  });

  it("trashes labeled mail message by message, skipping starred", async () => {
    const { gmail, engine } = await setup([makeSummary("a"), makeSummary("b", { labels: ["STARRED"] })]);
    gmail.labeled.add("a");
    gmail.labeled.add("b");
    const listIds = vi.spyOn(gmail, "listIds");
    await engine.trashLabeled();
    expect(listIds).toHaveBeenCalledWith("label:purge-test -is:starred");
    expect([...gmail.trashed]).toEqual(["a"]);
    expect(engine.getProgress().stage).toBe("done");
  });

  it("moves spam to trash", async () => {
    const { gmail, engine } = await setup([]);
    gmail.spamIds = ["s1", "s2"];
    await engine.emptySpam();
    expect([...gmail.trashed]).toEqual(["s1", "s2"]);
  });

  it("stops on a failed label batch: no more work, ids kept, stage error, busy only after settling", async () => {
    const many = Array.from({ length: 6 }, (_, i) => makeSummary(`p${i}`));
    const { gmail, judge, engine, store, notify } = await setup(many, { labelBatch: 1, concurrency: 1 });
    gmail.addLabel = async () => {
      throw new Error("label boom");
    };
    const running = engine.start(DEFAULT_SETTINGS);
    expect(engine.isBusy()).toBe(true);
    await running;
    expect(engine.isBusy()).toBe(false);
    expect(engine.getProgress().stage).toBe("error");
    expect((engine.getProgress().error as Error).message).toBe("label boom");
    const judged = judge.mock.calls.length;
    expect(judged).toBe(1);
    await new Promise((r) => setTimeout(r, 20));
    expect(judge).toHaveBeenCalledTimes(judged);
    expect((await store.getScan())?.finished).toBe(false);
    expect(notify).not.toHaveBeenCalled();
  });

  it("treats a 404 on trash as done and keeps going", async () => {
    const { gmail, engine } = await setup([makeSummary("a"), makeSummary("b"), makeSummary("c")]);
    for (const id of ["a", "b", "c"]) gmail.labeled.add(id);
    gmail.trashErrors.set("b", new GmailError(404, "notFound", "gone"));
    await engine.trashLabeled();
    expect([...gmail.trashed].sort()).toEqual(["a", "c"]);
    const p = engine.getProgress();
    expect(p.stage).toBe("done");
    expect(p.done).toBe(3);
    expect(p.counts.failed).toBe(0);
  });

  it("counts other trash errors as failed and continues", async () => {
    const { gmail, engine } = await setup([makeSummary("a"), makeSummary("b")]);
    gmail.labeled.add("a");
    gmail.labeled.add("b");
    gmail.trashErrors.set("a", new Error("nope"));
    await engine.trashLabeled();
    expect([...gmail.trashed]).toEqual(["b"]);
    expect(engine.getProgress().counts.failed).toBe(1);
    expect(engine.getProgress().stage).toBe("done");
  });

  it("stops the scan as error when Jev rejects the credentials", async () => {
    const many = Array.from({ length: 12 }, (_, i) => makeSummary(`p${i}`));
    const { judge, engine, store, notify } = await setup(many);
    const err = APIError.fromResponse(401, {}, new Headers());
    judge.mockRejectedValue(err);
    await engine.start(DEFAULT_SETTINGS);
    const p = engine.getProgress();
    expect(p.stage).toBe("error");
    expect(p.error).toBe(err);
    expect(judge.mock.calls.length).toBeLessThanOrEqual(4);
    expect((await store.getScan())?.finished).toBe(false);
    expect(notify).not.toHaveBeenCalled();
  });

  it("stops the scan as error when the Gmail API is disabled", async () => {
    const { gmail, engine } = await setup();
    gmail.getSummary = async () => {
      throw new GmailError(403, "SERVICE_DISABLED", "disabled");
    };
    await engine.start(DEFAULT_SETTINGS);
    expect(engine.getProgress().stage).toBe("error");
  });

  it("stops as error after 20 consecutive per-email failures", async () => {
    const many = Array.from({ length: 40 }, (_, i) => makeSummary(`p${i}`));
    const { gmail, engine } = await setup(many);
    for (const m of many) gmail.failIds.add(m.id);
    await engine.start(DEFAULT_SETTINGS);
    const p = engine.getProgress();
    expect(p.stage).toBe("error");
    expect(p.counts.failed).toBeLessThan(40);
  });

  it("always builds a fresh candidate list when a limit is given", async () => {
    const { engine, store } = await setup();
    await store.putScan({ years: DEFAULT_SETTINGS.years, candidateIds: ["promo", "mom", "att"], repliedThreadIds: [], finished: false, startedAt: 0, settingsAtScan: null, msPerEmail: null });
    await engine.start(DEFAULT_SETTINGS, { limit: 1 });
    expect((await store.getScan())?.candidateIds).toHaveLength(1);
  });

  it("removes stale labels when a rescan uses rules that no longer purge them", async () => {
    const { gmail, engine, store } = await setup();
    await engine.start(DEFAULT_SETTINGS);
    expect([...gmail.labeled]).toEqual(["promo"]);

    const narrower = { ...DEFAULT_SETTINGS, purgeKinds: DEFAULT_SETTINGS.purgeKinds.filter((k) => k !== "promotion") };
    await engine.start(narrower);
    expect(engine.getProgress().stage).toBe("done");
    expect([...gmail.labeled]).toEqual([]);
    expect((await store.getScan())?.settingsAtScan).toEqual(narrower);
    expect((await store.allLabels()).has("promo")).toBe(false);

    // The app removed it, not the user, so going back to the old rules labels it again.
    await engine.start(DEFAULT_SETTINGS);
    expect([...gmail.labeled]).toEqual(["promo"]);
  });

  it("removes the label from an earlier-labeled email that the raised age no longer covers", async () => {
    const { gmail, engine, store } = await setup([makeSummary("old"), makeSummary("recent")]);
    gmail.ages.set("old", 15);
    gmail.ages.set("recent", 6);
    await engine.start({ ...DEFAULT_SETTINGS, years: 5 });
    expect([...gmail.labeled].sort()).toEqual(["old", "recent"]);

    await engine.start({ ...DEFAULT_SETTINGS, years: 10 });
    expect((await store.getScan())?.candidateIds).toEqual(["old"]);
    expect([...gmail.labeled]).toEqual(["old"]);
  });

  it("does not re-add a label the user removed between scans", async () => {
    const { gmail, engine, store } = await setup();
    await engine.start(DEFAULT_SETTINGS);
    gmail.labeled.delete("promo");
    await engine.start(DEFAULT_SETTINGS);
    expect(gmail.labeled.has("promo")).toBe(false);
    expect((await store.allLabels()).get("promo")?.userRemoved).toBe(true);
  });
});
