import { APIConnectionError, APIError } from "@typesafe-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@core/decide.ts";
import { AppError } from "../bridge/errors.ts";
import { GmailError } from "../gmail/client.ts";
import { openStore } from "../storage/db.ts";
import { isRunLevelError, ScanEngine } from "./engine.ts";
import { createFakeGmail, fakeAnswers, idsWithLabel, makeSummary } from "./fakes.ts";
import { USER_CHANGE_GRACE_MS } from "./reconcile.ts";

async function setup(messages = [makeSummary("promo"), makeSummary("mom"), makeSummary("att", { attachmentNames: ["a.pdf"] })], extra: { labelBatch?: number; concurrency?: number; now?: () => number } = {}) {
  const store = await openStore(`t-${crypto.randomUUID()}`);
  const gmail = createFakeGmail(messages);
  const judge = vi.fn(async (f: { subject: string }) => {
    if (f.subject.includes("mom")) return fakeAnswers({ none: 1 }, { personal: 0.95 });
    if (f.subject.includes("news")) return fakeAnswers({ newsletter: 0.97 });
    if (f.subject.includes("unsure")) return fakeAnswers({ promotion: 0.6, none: 0.4 });
    return fakeAnswers({ promotion: 0.97 });
  });
  const notify = vi.fn();
  const engine = new ScanEngine({ gmail, judge, store, notify, ...extra });
  return { store, gmail, judge, engine, notify };
}

describe("ScanEngine", () => {
  it("labels purge decisions, skips Jev for attachments, and records labels", async () => {
    const { gmail, judge, engine, store, notify } = await setup();
    await engine.start(DEFAULT_SETTINGS);
    const p = engine.getProgress();
    expect(p.stage).toBe("done");
    expect(p.counts).toEqual({ purge: 1, keep: 2, review: 0, maybe: 0, failed: 0 });
    expect(idsWithLabel(gmail, "purge/promotion")).toEqual(["promo"]);
    expect(judge).toHaveBeenCalledTimes(2);
    expect(p.costUsd).toBeCloseTo((2 * 1000 * 0.042) / 1_000_000);
    expect((await store.allLabels()).get("promo")?.label).toBe("purge/promotion");
    expect((await store.getScan())?.finished).toBe(true);
    expect((await store.getScan())?.settingsAtScan).toEqual(DEFAULT_SETTINGS);
    expect((await store.getScan())?.deferred).toBe(0);
    expect(p.recent.find((r) => r.id === "promo")?.label).toBe("purge/promotion");
    expect(p.recent.find((r) => r.id === "mom")?.label).toBeNull();
    expect(notify).toHaveBeenCalledWith("Scan finished", '1 to purge and 0 to check, labeled under "purge".');
  });

  it("counts a failed fetch as review and keeps going", async () => {
    const { gmail, engine } = await setup();
    gmail.failIds.add("mom");
    await engine.start(DEFAULT_SETTINGS);
    expect(engine.getProgress().counts).toEqual({ purge: 1, keep: 1, review: 1, maybe: 0, failed: 1 });
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
    await store.putLabels([{ id: "promo", label: "purge", labeledAt: 0, userRemoved: true, userChosen: false }]);
    await engine.start(DEFAULT_SETTINGS);
    expect(idsWithLabel(gmail, "purge/promotion").includes("promo")).toBe(false);
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
    expect(idsWithLabel(gmail, "purge/promotion")).toEqual(["promo"]);

    const narrower = { ...DEFAULT_SETTINGS, purgeKinds: DEFAULT_SETTINGS.purgeKinds.filter((k) => k !== "promotion") };
    await engine.start(narrower);
    expect(engine.getProgress().stage).toBe("done");
    expect(idsWithLabel(gmail, "purge/promotion")).toEqual([]);
    expect((await store.getScan())?.settingsAtScan).toEqual(narrower);
    expect((await store.allLabels()).has("promo")).toBe(false);

    // The app removed it, not the user, so going back to the old rules labels it again.
    await engine.start(DEFAULT_SETTINGS);
    expect(idsWithLabel(gmail, "purge/promotion")).toEqual(["promo"]);
  });

  it("removes the label from an earlier-labeled email that the raised age no longer covers", async () => {
    const { gmail, engine, store } = await setup([makeSummary("old"), makeSummary("recent")]);
    gmail.ages.set("old", 15);
    gmail.ages.set("recent", 6);
    await engine.start({ ...DEFAULT_SETTINGS, years: 5 });
    expect(idsWithLabel(gmail, "purge/promotion").sort()).toEqual(["old", "recent"]);

    await engine.start({ ...DEFAULT_SETTINGS, years: 10 });
    expect((await store.getScan())?.candidateIds).toEqual(["old"]);
    expect(idsWithLabel(gmail, "purge/promotion")).toEqual(["old"]);
  });

  it("scans mail of any age when years is 0", async () => {
    const { engine, store, gmail } = await setup([makeSummary("new"), makeSummary("old")]);
    gmail.ages.set("new", 0);
    const listIds = vi.spyOn(gmail, "listIds");
    await engine.start({ ...DEFAULT_SETTINGS, years: 0 });
    expect(engine.getProgress().stage).toBe("done");
    expect((await store.getScan())?.candidateIds).toEqual(["new", "old"]);
    expect(listIds.mock.calls.map(([q]) => q).filter((q) => q.includes("older_than"))).toEqual([]);
    expect(listIds).toHaveBeenCalledWith("in:sent");
  });

  it("does not re-add a label the user removed between scans", async () => {
    let now = 0;
    const { gmail, engine, store } = await setup(undefined, { now: () => now });
    await engine.start(DEFAULT_SETTINGS);
    gmail.labelsOf.delete("promo");
    now += USER_CHANGE_GRACE_MS;
    await engine.start(DEFAULT_SETTINGS);
    expect(idsWithLabel(gmail, "purge/promotion").includes("promo")).toBe(false);
    expect((await store.allLabels()).get("promo")?.userRemoved).toBe(true);
  });

  it("classifies an SDK connection error by the AppError it wraps", () => {
    const wrap = (cause: unknown) => new APIConnectionError("Connection error.", { cause });
    expect(isRunLevelError(wrap(new AppError({ kind: "NotConfigured", detail: "jev" })))).toBe(true);
    expect(isRunLevelError(wrap(new AppError({ kind: "Keychain", detail: "locked" })))).toBe(true);
    expect(isRunLevelError(wrap(new AppError({ kind: "Network", detail: "reset" })))).toBe(false);
    expect(isRunLevelError(new APIConnectionError("Connection error."))).toBe(false);
  });

  it("stops the scan as error when Jev's SDK wraps a missing-key error", async () => {
    const many = Array.from({ length: 12 }, (_, i) => makeSummary(`p${i}`));
    const { judge, engine } = await setup(many);
    judge.mockRejectedValue(new APIConnectionError("Connection error.", { cause: new AppError({ kind: "NotConfigured", detail: "jev" }) }));
    await engine.start(DEFAULT_SETTINGS);
    expect(engine.getProgress().stage).toBe("error");
    expect(judge.mock.calls.length).toBeLessThanOrEqual(4);
  });

  describe("category labels", () => {
    const T = { ...DEFAULT_SETTINGS, labelPrefix: "purge-test" };

    it("labels each purge email with its category under the prefix", async () => {
      const { gmail, engine, store } = await setup([makeSummary("news"), makeSummary("promo")]);
      await engine.start(T);
      expect(engine.getProgress().stage).toBe("done");
      expect(idsWithLabel(gmail, "purge-test/newsletter")).toEqual(["news"]);
      expect(idsWithLabel(gmail, "purge-test/promotion")).toEqual(["promo"]);
      const records = await store.allLabels();
      expect(records.get("news")?.label).toBe("purge-test/newsletter");
      expect(records.get("promo")?.label).toBe("purge-test/promotion");
      expect(engine.getProgress().labeled).toBe(2);
    });

    it("labels an uncertain email maybe and counts it as review and maybe", async () => {
      const { gmail, engine, notify } = await setup([makeSummary("unsure"), makeSummary("promo")]);
      await engine.start(T);
      const p = engine.getProgress();
      expect(idsWithLabel(gmail, "purge-test/maybe")).toEqual(["unsure"]);
      expect(p.counts).toEqual({ purge: 1, keep: 0, review: 1, maybe: 1, failed: 0 });
      expect(p.recent.find((r) => r.id === "unsure")?.label).toBe("purge-test/maybe");
      expect(notify).toHaveBeenCalledWith("Scan finished", '1 to purge and 1 to check, labeled under "purge-test".');
    });

    it("uses one labeledAt per new record, in memory and in the store", async () => {
      let now = 1_000;
      const { store, engine } = await setup([makeSummary("promo")], { now: () => (now += 7) });
      const putLabels = vi.spyOn(store, "putLabels");
      await engine.start(T);
      const flushed = putLabels.mock.calls[0]![0][0]!;
      expect(flushed.id).toBe("promo");
      expect((await store.allLabels()).get("promo")?.labeledAt).toBe(flushed.labeledAt);
    });

    it("judges and labels attachments only when keepAttachments is off", async () => {
      const att = makeSummary("att", { attachmentNames: ["deal.pdf"] });
      const on = await setup([att]);
      await on.engine.start(T);
      expect(on.judge).not.toHaveBeenCalled();
      expect(idsWithLabel(on.gmail, "purge-test/promotion")).toEqual([]);

      const off = await setup([att]);
      await off.engine.start({ ...T, keepAttachments: false });
      expect(off.judge).toHaveBeenCalledOnce();
      expect(idsWithLabel(off.gmail, "purge-test/promotion")).toEqual(["att"]);
    });

    it("labels a starred promotion when keepStarred is off", async () => {
      const { gmail, engine } = await setup([makeSummary("promo", { labels: ["STARRED"] })]);
      await engine.start({ ...T, keepStarred: false });
      expect(idsWithLabel(gmail, "purge-test/promotion")).toEqual(["promo"]);
    });

    it("removes a category's labels on a rescan after it is unchecked, keeping the others", async () => {
      const { gmail, engine } = await setup([makeSummary("news"), makeSummary("promo")]);
      await engine.start(T);
      await engine.start({ ...T, purgeKinds: T.purgeKinds.filter((k) => k !== "promotion") });
      expect(engine.getProgress().stage).toBe("done");
      expect(idsWithLabel(gmail, "purge-test/promotion")).toEqual([]);
      expect(idsWithLabel(gmail, "purge-test/newsletter")).toEqual(["news"]);
    });

    it("stops with an Invalid error when Gmail rejects the label name", async () => {
      const { gmail, engine, store } = await setup([makeSummary("promo")]);
      gmail.ensureLabel = async () => {
        throw new GmailError(400, "invalidArgument", "Invalid label name");
      };
      await engine.start(T);
      const p = engine.getProgress();
      expect(p.stage).toBe("error");
      expect(p.error).toBeInstanceOf(AppError);
      expect((p.error as AppError).payload).toEqual({ kind: "Invalid", detail: "Gmail didn't accept that label name. Try another on the Rules screen." });
      expect((await store.getScan())?.finished).toBe(false);
    });

    it("builds a fresh candidate list when resuming with a different keepStarred", async () => {
      const { engine, store } = await setup([makeSummary("promo"), makeSummary("star", { labels: ["STARRED"] })]);
      await store.putScan({ years: T.years, settings: T, candidateIds: ["stale"], repliedThreadIds: [], finished: false, startedAt: 0, settingsAtScan: null, msPerEmail: null });
      await engine.start({ ...T, keepStarred: false });
      expect((await store.getScan())?.candidateIds).toEqual(["promo", "star"]);
      expect((await store.getScan())?.settings).toEqual({ ...T, keepStarred: false });
    });

    it("resumes an unfinished scan whose settings need no rescan", async () => {
      const { engine, store } = await setup([makeSummary("promo")]);
      await store.putScan({ years: T.years, settings: T, candidateIds: ["promo"], repliedThreadIds: [], finished: false, startedAt: 0, settingsAtScan: null, msPerEmail: null });
      await engine.start({ ...T, labelPrefix: "other" });
      expect((await store.getScan())?.startedAt).toBe(0);
    });

    it("builds a fresh candidate list for an unfinished scan saved without settings", async () => {
      const { engine, store } = await setup([makeSummary("promo")]);
      await store.putScan({ years: T.years, candidateIds: ["stale"], repliedThreadIds: [], finished: false, startedAt: 0, settingsAtScan: null, msPerEmail: null });
      await engine.start(T);
      expect((await store.getScan())?.candidateIds).toEqual(["promo"]);
    });
  });
});
