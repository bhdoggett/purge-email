import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@core/decide.ts";
import { openStore } from "../storage/db.ts";
import { ScanEngine } from "./engine.ts";
import { createFakeGmail, fakeAnswers, makeSummary } from "./fakes.ts";

async function setup(messages = [makeSummary("promo"), makeSummary("mom"), makeSummary("att", { attachmentNames: ["a.pdf"] })]) {
  const store = await openStore(`t-${crypto.randomUUID()}`);
  const gmail = createFakeGmail(messages);
  const judge = vi.fn(async (f: { subject: string }) =>
    f.subject.includes("mom") ? fakeAnswers({ none: 1 }, { personal: 0.95 }) : fakeAnswers({ promotion: 0.97 }),
  );
  const notify = vi.fn();
  const engine = new ScanEngine({ gmail, judge, store, labelName: "purge-test", notify });
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
    await engine.trashLabeled();
    expect([...gmail.trashed]).toEqual(["a"]);
    expect(engine.getProgress().stage).toBe("done");
  });

  it("moves spam to trash", async () => {
    const { gmail, engine } = await setup([]);
    gmail.spamIds = ["s1", "s2"];
    await engine.emptySpam();
    expect([...gmail.trashed]).toEqual(["s1", "s2"]);
  });
});
