import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "@core/decide.ts";
import { QUESTIONS_VERSION } from "@core/questions.ts";
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
    await store.putLabels([{ id: "m1", labeledByApp: true, userRemoved: false }]);
    await store.putSettings({ ...DEFAULT_SETTINGS, years: 8 });
    await store.putScan({ years: 8, candidateIds: ["m1"], repliedThreadIds: [], finished: false, startedAt: 1, settingsAtScan: null, msPerEmail: null });
    await store.putWizard([1, 2]);

    expect(await store.getSummary("m1")).toEqual(summary);
    expect((await store.allAnswers()).get("m1")).toEqual(answers);
    expect((await store.allLabels()).get("m1")?.labeledByApp).toBe(true);
    expect((await store.getSettings()).years).toBe(8);
    expect((await store.getScan())?.candidateIds).toEqual(["m1"]);
    expect(await store.getWizard()).toEqual([1, 2]);

    await store.deleteLabels(["m1"]);
    expect((await store.allLabels()).size).toBe(0);
  });

  it("clearScanData keeps settings and wizard progress", async () => {
    const store = await openStore(`t-${crypto.randomUUID()}`);
    await store.putSummary(summary);
    await store.putSettings({ ...DEFAULT_SETTINGS, years: 7 });
    await store.putWizard([1]);
    await store.clearScanData();
    expect(await store.getSummary("m1")).toBeUndefined();
    expect((await store.getSettings()).years).toBe(7);
    expect(await store.getWizard()).toEqual([1]);
  });
});
