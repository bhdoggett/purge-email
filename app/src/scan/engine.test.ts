import { APIConnectionError, APIError } from "@typesafe-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@core/decide.ts";
import type { EmailFacts } from "@core/questions.ts";
import { AppError } from "../bridge/errors.ts";
import { GmailError } from "../gmail/client.ts";
import { openStore, type Store } from "../storage/db.ts";
import { testKey } from "../test/key.ts";
import { isRunLevelError, ScanEngine } from "./engine.ts";
import { createFakeGmail, fakeAnswers, makeSummary } from "./fakes.ts";

async function setup(messages = [makeSummary("promo"), makeSummary("mom"), makeSummary("att", { attachmentNames: ["a.pdf"] })], extra: { concurrency?: number; now?: () => number } = {}) {
  const store = await openStore(testKey, `t-${crypto.randomUUID()}`);
  const gmail = createFakeGmail(messages);
  const judge = vi.fn(async (f: { subject: string }) => {
    if (f.subject.includes("mom")) return fakeAnswers({ none: 1 }, { personal: 0.95 });
    if (f.subject.includes("news")) return fakeAnswers({ newsletter: 0.97 });
    if (f.subject.includes("unsure")) return fakeAnswers({ promotion: 0.6, none: 0.4 });
    return fakeAnswers({ promotion: 0.97 });
  });
  const notify = vi.fn();
  const judgeSignificance = vi.fn(async (_facts: EmailFacts) => ({ meaningful: 0.1, inputTokens: 500 }));
  const engine = new ScanEngine({ gmail, judge, judgeSignificance, store, notify, ...extra });
  return { store, gmail, judge, judgeSignificance, engine, notify };
}

describe("ScanEngine", () => {
  it("sends email previews to Jev only when the setting allows it, and keeps none locally when it doesn't", async () => {
    const msgs = () => [makeSummary("promo", { snippet: "Your code is 123456" })];
    const on = await setup(msgs());
    await on.engine.start({ ...DEFAULT_SETTINGS, sendPreviews: true });
    expect(on.judge.mock.calls[0]![0]).toMatchObject({ snippet: "Your code is 123456" });
    expect((await on.store.getSummary("promo"))?.snippet).toBe("Your code is 123456");

    const off = await setup(msgs());
    await off.engine.start({ ...DEFAULT_SETTINGS, sendPreviews: false });
    expect(off.judge.mock.calls[0]![0]).toMatchObject({ snippet: "" });
    expect((await off.store.getSummary("promo"))?.snippet).toBe("");
  });

  it("judges candidates, skips Jev for attachments, and writes nothing to Gmail", async () => {
    const { gmail, judge, engine, store, notify } = await setup();
    const addLabel = vi.spyOn(gmail, "addLabel");
    const removeLabel = vi.spyOn(gmail, "removeLabel");
    const ensureLabel = vi.spyOn(gmail, "ensureLabel");
    await engine.start(DEFAULT_SETTINGS);
    const p = engine.getProgress();
    expect(p.stage).toBe("done");
    expect(p.counts).toEqual({ purge: 1, keep: 2, review: 0, maybe: 0, failed: 0 });
    expect(judge).toHaveBeenCalledTimes(2);
    expect(p.costUsd).toBeCloseTo((2 * 1000 * 0.042) / 1_000_000);
    expect(addLabel).not.toHaveBeenCalled();
    expect(removeLabel).not.toHaveBeenCalled();
    expect(ensureLabel).not.toHaveBeenCalled();
    expect((await store.allLabels()).size).toBe(0);
    const scan = await store.getScan();
    expect(scan?.finished).toBe(true);
    expect(scan?.settingsAtScan).toEqual(DEFAULT_SETTINGS);
    expect(p.recent.find((r) => r.id === "promo")?.label).toBe("purge/promotion");
    expect(p.recent.find((r) => r.id === "mom")?.label).toBeNull();
    expect(notify).toHaveBeenCalledWith("Scan finished", "1 to purge and 0 to check. Review them, then apply labels.");
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

  it("builds a new candidate list when the age setting changed since an unfinished scan", async () => {
    const { engine, store } = await setup();
    await store.putScan({ ageMonths: 60, candidateIds: ["stale"], repliedThreadIds: [], finished: false, startedAt: 0, settingsAtScan: null, msPerEmail: null });
    await engine.start({ ...DEFAULT_SETTINGS, ageMonths: 120 });
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
    await store.putScan({ ageMonths: DEFAULT_SETTINGS.ageMonths, candidateIds: ["promo", "mom", "att"], repliedThreadIds: [], finished: false, startedAt: 0, settingsAtScan: null, msPerEmail: null });
    await engine.start(DEFAULT_SETTINGS, { limit: 1 });
    expect((await store.getScan())?.candidateIds).toHaveLength(1);
  });

  it("scans mail of any age when ageMonths is 0", async () => {
    const { engine, store, gmail } = await setup([makeSummary("new"), makeSummary("old")]);
    gmail.ages.set("new", 0);
    const listIds = vi.spyOn(gmail, "listIds");
    await engine.start({ ...DEFAULT_SETTINGS, ageMonths: 0 });
    expect(engine.getProgress().stage).toBe("done");
    expect((await store.getScan())?.candidateIds).toEqual(["new", "old"]);
    expect(listIds.mock.calls.map(([q]) => q).filter((q) => q.includes("older_than"))).toEqual([]);
    expect(listIds).toHaveBeenCalledWith("in:sent");
  });

  it("asks Gmail for candidates and sent mail in months", async () => {
    const { engine, gmail } = await setup();
    const listIds = vi.spyOn(gmail, "listIds");
    await engine.start({ ...DEFAULT_SETTINGS, ageMonths: 6 });
    const queries = listIds.mock.calls.map(([q]) => q);
    expect(queries).toContain("in:sent older_than:6m");
    expect(queries.some((q) => q.startsWith("older_than:6m "))).toBe(true);
  });

  it("lists only mail as old as the age, and keeps mail whose date is too new", async () => {
    const now = new Date(2026, 9, 7, 12).getTime();
    const recent = makeSummary("recent", { date: new Date(2026, 7, 1).toUTCString() });
    const young = makeSummary("young", { date: new Date(2026, 9, 1).toUTCString() });
    const { engine, gmail, store } = await setup([makeSummary("promo"), recent, young], { now: () => now });
    gmail.ages.set("young", 0);
    // Gmail lists "recent" as 3 months old, but its Date header says 2: decide() keeps it.
    gmail.ages.set("recent", 3);
    await engine.start({ ...DEFAULT_SETTINGS, ageMonths: 3 });
    expect((await store.getScan())?.candidateIds).toEqual(["promo", "recent"]);
    const p = engine.getProgress();
    expect(p.recent.find((r) => r.id === "recent")).toMatchObject({ decision: "keep", reason: "too new", label: null });
    expect(p.recent.find((r) => r.id === "promo")?.label).toBe("purge/promotion");
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

    it("gives each purge email its category label under the prefix", async () => {
      const { engine } = await setup([makeSummary("news"), makeSummary("promo")]);
      await engine.start(T);
      const p = engine.getProgress();
      expect(p.stage).toBe("done");
      expect(p.recent.find((r) => r.id === "news")?.label).toBe("purge-test/newsletter");
      expect(p.recent.find((r) => r.id === "promo")?.label).toBe("purge-test/promotion");
    });

    it("gives an uncertain email the maybe label and counts it as review and maybe", async () => {
      const { engine, notify } = await setup([makeSummary("unsure"), makeSummary("promo")]);
      await engine.start(T);
      const p = engine.getProgress();
      expect(p.counts).toEqual({ purge: 1, keep: 0, review: 1, maybe: 1, failed: 0 });
      expect(p.recent.find((r) => r.id === "unsure")?.label).toBe("purge-test/maybe");
      expect(notify).toHaveBeenCalledWith("Scan finished", "1 to purge and 1 to check. Review them, then apply labels.");
    });

    it("judges attachments only when keepAttachments is off", async () => {
      const att = makeSummary("att", { attachmentNames: ["deal.pdf"] });
      const on = await setup([att]);
      await on.engine.start(T);
      expect(on.judge).not.toHaveBeenCalled();

      const off = await setup([att]);
      await off.engine.start({ ...T, keepAttachments: false });
      expect(off.judge).toHaveBeenCalledOnce();
      expect(off.engine.getProgress().recent[0]?.label).toBe("purge-test/promotion");
    });

    it("gives a starred promotion a label when keepStarred is off", async () => {
      const { engine } = await setup([makeSummary("promo", { labels: ["STARRED"] })]);
      await engine.start({ ...T, keepStarred: false });
      expect(engine.getProgress().recent[0]?.label).toBe("purge-test/promotion");
    });

    it("builds a fresh candidate list when resuming with a different keepStarred", async () => {
      const { engine, store } = await setup([makeSummary("promo"), makeSummary("star", { labels: ["STARRED"] })]);
      await store.putScan({ ageMonths: T.ageMonths, settings: T, candidateIds: ["stale"], repliedThreadIds: [], finished: false, startedAt: 0, settingsAtScan: null, msPerEmail: null });
      await engine.start({ ...T, keepStarred: false });
      expect((await store.getScan())?.candidateIds).toEqual(["promo", "star"]);
      expect((await store.getScan())?.settings).toEqual({ ...T, keepStarred: false });
    });

    it("resumes an unfinished scan whose settings need no rescan", async () => {
      const { engine, store } = await setup([makeSummary("promo")]);
      await store.putScan({ ageMonths: T.ageMonths, settings: T, candidateIds: ["promo"], repliedThreadIds: [], finished: false, startedAt: 0, settingsAtScan: null, msPerEmail: null });
      await engine.start({ ...T, labelPrefix: "other" });
      expect((await store.getScan())?.startedAt).toBe(0);
    });

    it("reuses an unfinished scan saved under wider rules when starting with narrower ones", async () => {
      const { engine, store } = await setup([makeSummary("promo"), makeSummary("other")]);
      const wide = { ...T, ageMonths: 0, keepStarred: false };
      const narrow = { ...T, ageMonths: 60 };
      await store.putScan({ ageMonths: 0, settings: wide, candidateIds: ["promo"], repliedThreadIds: [], finished: false, startedAt: 0, settingsAtScan: null, msPerEmail: null });
      await engine.start(narrow);
      const scan = (await store.getScan())!;
      expect(scan.startedAt).toBe(0);
      expect(scan.candidateIds).toEqual(["promo"]);
      expect(scan.finished).toBe(true);
      expect(scan.settingsAtScan).toEqual(narrow);
    });

    it("builds a fresh candidate list for an unfinished scan saved without settings", async () => {
      const { engine, store } = await setup([makeSummary("promo")]);
      await store.putScan({ ageMonths: T.ageMonths, candidateIds: ["stale"], repliedThreadIds: [], finished: false, startedAt: 0, settingsAtScan: null, msPerEmail: null });
      await engine.start(T);
      expect((await store.getScan())?.candidateIds).toEqual(["promo"]);
    });
  });

  describe("trivial personal mail", () => {
    const on = { ...DEFAULT_SETTINGS, trivialPersonal: true };
    const mail = () => [
      makeSummary("mom", { from: "Mom <mom@x.com>", snippet: "see you at 5" }),
      makeSummary("mom2", { from: "Old Friend <pal@x.com>", subject: "subject mom pal", snippet: "ok thanks" }),
      makeSummary("promo"),
      makeSummary("star", { from: "Mom <mom@x.com>", subject: "subject mom starred", labels: ["STARRED"] }),
    ];

    /** Sent mail counted, so the app knows who is close. */
    const counted = (store: Store) => store.putSenderStats({ ownAddress: "me@gmail.com", counted: [], people: [] });

    it("asks only personal emails from people who aren't close, labels the trivial ones, and adds the cost", async () => {
      const { engine, store, judge, judgeSignificance } = await setup(mail());
      await counted(store);
      await store.putCloseChoices({ "mom@x.com": true });
      await engine.start(on);
      // Starred mail is judged too (it can be labeled when starred mail isn't kept), but is never asked.
      expect(judge).toHaveBeenCalledTimes(4);
      expect(judgeSignificance).toHaveBeenCalledTimes(1);
      expect(judgeSignificance.mock.calls[0]![0]).toMatchObject({ from: "Old Friend <pal@x.com>" });
      expect((await store.getAnswers("mom2"))?.significance).toBe(0.1);
      expect((await store.getAnswers("mom"))?.significance).toBeUndefined();
      const p = engine.getProgress();
      expect(p.recent.find((r) => r.id === "mom2")).toMatchObject({ decision: "purge", label: "purge/personal", reason: "personal trivial 0.90" });
      expect(p.recent.find((r) => r.id === "mom")).toMatchObject({ decision: "keep", label: null, reason: "close person" });
      expect(p.costUsd).toBeCloseTo(((4 * 1000 + 500) * 0.042) / 1_000_000);
    });

    it("asks nothing, keeping personal mail, until sent mail has been counted", async () => {
      const { engine, store, judgeSignificance } = await setup(mail());
      await engine.start(on);
      expect(judgeSignificance).not.toHaveBeenCalled();
      expect(engine.getProgress().recent.find((r) => r.id === "mom2")).toMatchObject({ decision: "keep", label: null, reason: "personal unchecked" });
      await counted(store);
      await engine.start(on);
      expect(judgeSignificance).toHaveBeenCalledTimes(2);
    });

    it("never asks when the setting is off", async () => {
      const { engine, judgeSignificance } = await setup(mail());
      await engine.start(DEFAULT_SETTINGS);
      expect(judgeSignificance).not.toHaveBeenCalled();
    });

    it("asks already-judged emails without asking the main questions again, and only once", async () => {
      const { engine, store, judge, judgeSignificance } = await setup(mail());
      await counted(store);
      await engine.start(DEFAULT_SETTINGS);
      expect(judge).toHaveBeenCalledTimes(4);
      await engine.start(on);
      expect(judge).toHaveBeenCalledTimes(4);
      expect(judgeSignificance).toHaveBeenCalledTimes(2);
      expect((await store.getAnswers("mom"))?.significance).toBe(0.1);
      await engine.start(on);
      expect(judgeSignificance).toHaveBeenCalledTimes(2);
    });

    it("leaves the email kept and unchecked when the question fails", async () => {
      const { engine, store, judgeSignificance } = await setup([mail()[1]!]);
      await counted(store);
      judgeSignificance.mockRejectedValueOnce(new Error("busy"));
      await engine.start(on);
      expect((await store.getAnswers("mom2"))?.significance).toBeUndefined();
      expect(engine.getProgress().counts.failed).toBe(1);
      await engine.start(on);
      expect((await store.getAnswers("mom2"))?.significance).toBe(0.1);
    });

    it("strips the preview when previews are off, even from a summary saved with one", async () => {
      const { engine, store, judgeSignificance } = await setup([mail()[1]!]);
      await counted(store);
      await engine.start(DEFAULT_SETTINGS);
      await engine.start({ ...on, sendPreviews: false });
      expect(judgeSignificance.mock.calls[0]![0]).toMatchObject({ snippet: "" });

      const sends = await setup([mail()[1]!]);
      await counted(sends.store);
      await sends.engine.start(on);
      expect(sends.judgeSignificance.mock.calls[0]![0]).toMatchObject({ snippet: "ok thanks" });
    });
  });
});

