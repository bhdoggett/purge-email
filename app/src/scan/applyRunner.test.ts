import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@core/decide.ts";
import { openStore } from "../storage/db.ts";
import { testKey } from "../test/key.ts";
import { ApplyRunner } from "./applyRunner.ts";
import { ScanEngine } from "./engine.ts";
import { createFakeGmail, fakeAnswers, idsWithLabel, makeSummary } from "./fakes.ts";
import { previewReconcile } from "./reconcile.ts";

const NOW = new Date(2026, 9, 7, 12).getTime();

async function arrange(ids = ["a", "b"], scanning = () => false) {
  const store = await openStore(testKey, `t-${crypto.randomUUID()}`);
  const msgs = ids.map((id) => makeSummary(id));
  const gmail = createFakeGmail(msgs);
  for (const m of msgs) {
    await store.putSummary(m);
    await store.putAnswers(m.id, fakeAnswers({ promotion: 0.97 }));
  }
  await store.putScan({ ageMonths: 120, candidateIds: ids, repliedThreadIds: [], finished: true, startedAt: 0, settingsAtScan: DEFAULT_SETTINGS, msPerEmail: null });
  const runner = new ApplyRunner({ gmail, store, isScanning: scanning, now: () => NOW });
  return { store, gmail, runner };
}

/** Holds Gmail's addLabel until released, so a write can be observed mid-flight. */
function hold(gmail: ReturnType<typeof createFakeGmail>) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const original = gmail.addLabel.bind(gmail);
  const started = new Promise<void>((resolve) => {
    gmail.addLabel = async (label, ids) => {
      resolve();
      await gate;
      return original(label, ids);
    };
  });
  return { release, started };
}

describe("ApplyRunner", () => {
  it("check() finds a pending preview and ends in done", async () => {
    const { runner } = await arrange();
    expect(runner.getState().phase).toBe("idle");
    const steps: number[] = [];
    runner.subscribe(() => {
      const s = runner.getState().step;
      if (s) steps.push(s.index);
    });
    await runner.check(DEFAULT_SETTINGS);
    expect(runner.getState()).toMatchObject({ phase: "done", preview: { added: 2 } });
    expect(steps[0]).toBe(1);
    expect(runner.busy()).toBe(false);
  });

  it("check() with nothing pending counts the labels in Gmail", async () => {
    const { runner } = await arrange([]);
    await runner.check(DEFAULT_SETTINGS);
    expect(runner.getState().counts).toEqual(new Map());
    expect(runner.getState().phase).toBe("done");
  });

  it("apply() writes, re-checks, and ends in done with totals and the applied message", async () => {
    const { runner, gmail } = await arrange();
    await runner.check(DEFAULT_SETTINGS);
    const seen: number[] = [];
    runner.subscribe(() => {
      const s = runner.getState();
      if (s.phase === "writing") seen.push(s.done!);
    });
    await runner.apply(DEFAULT_SETTINGS, runner.getState().preview!);
    expect(idsWithLabel(gmail, "purge/promotion")).toEqual(["a", "b"]);
    const s = runner.getState();
    expect(s.phase).toBe("done");
    expect(s.message).toBe("Added 2, moved 0, removed 0.");
    expect(s.counts?.get("purge/promotion")).toBe(2);
    expect(seen).toContain(2);
    expect(runner.busy()).toBe(false);
  });

  it("a later check() finds new changes and keeps the last applied message", async () => {
    const { runner, store } = await arrange();
    await runner.check(DEFAULT_SETTINGS);
    await runner.apply(DEFAULT_SETTINGS, runner.getState().preview!);
    expect(runner.getState().message).toBe("Added 2, moved 0, removed 0.");
    await store.putOverrides(["a"], null, NOW + 1);
    await runner.check(DEFAULT_SETTINGS);
    expect(runner.getState()).toMatchObject({ phase: "done", message: "Added 2, moved 0, removed 0.", preview: { removed: 1 } });
  });

  it("check() during a write returns without previewing or saving", async () => {
    const { runner, gmail, store } = await arrange();
    await runner.check(DEFAULT_SETTINGS);
    const putLabels = vi.spyOn(store, "putLabels");
    const h = hold(gmail);
    const writing = runner.apply(DEFAULT_SETTINGS, runner.getState().preview!);
    await h.started;
    expect(runner.getState().phase).toBe("writing");
    expect(runner.busy()).toBe(true);
    const listIds = vi.spyOn(gmail, "listIds");
    const before = runner.getState();
    expect(await runner.check(DEFAULT_SETTINGS)).toBe(before);
    expect(listIds).not.toHaveBeenCalled();
    expect(putLabels).not.toHaveBeenCalled();
    h.release();
    await writing;
  });

  it("refuses a second apply() while one runs, even during its re-check", async () => {
    const { runner, gmail } = await arrange();
    await runner.check(DEFAULT_SETTINGS);
    const shown = runner.getState().preview!;
    const h = hold(gmail);
    const addLabel = vi.spyOn(gmail, "addLabel");
    const first = runner.apply(DEFAULT_SETTINGS, shown);
    // Still in its first re-preview: already counts as running.
    expect(runner.busy()).toBe(true);
    await runner.apply(DEFAULT_SETTINGS, shown);
    await h.started;
    await runner.apply(DEFAULT_SETTINGS, shown);
    h.release();
    await first;
    expect(addLabel).toHaveBeenCalledTimes(1);
  });

  it("refuses apply() while a scan runs", async () => {
    let scanning = true;
    const { runner, gmail } = await arrange(["a"], () => scanning);
    scanning = false;
    await runner.check(DEFAULT_SETTINGS);
    scanning = true;
    const addLabel = vi.spyOn(gmail, "addLabel");
    await runner.apply(DEFAULT_SETTINGS, runner.getState().preview!);
    expect(addLabel).not.toHaveBeenCalled();
    expect(runner.getState().error).toBe("A scan is running. Apply after it finishes.");
    expect(runner.busy()).toBe(false);
  });

  it("neither checks nor applies while sent mail is being counted", async () => {
    const { runner, gmail, store } = await arrange(["a"]);
    await runner.check(DEFAULT_SETTINGS);
    let counting = true;
    const blocked = new ApplyRunner({ gmail, store, isScanning: () => false, isCounting: () => counting, now: () => NOW });
    const findLabelId = vi.spyOn(gmail, "findLabelId");
    await blocked.check(DEFAULT_SETTINGS);
    expect(findLabelId).not.toHaveBeenCalled();
    const addLabel = vi.spyOn(gmail, "addLabel");
    await blocked.apply(DEFAULT_SETTINGS, runner.getState().preview!);
    expect(addLabel).not.toHaveBeenCalled();
    expect(blocked.getState().error).toBe("Your sent mail is being counted. Apply after it finishes.");
    counting = false;
    await blocked.check(DEFAULT_SETTINGS);
    expect(blocked.getState().phase).toBe("done");
  });

  it("shows the new numbers instead of writing when Gmail changed", async () => {
    const { runner, gmail, store } = await arrange();
    const stale = await previewReconcile({ gmail, store, now: () => NOW }, DEFAULT_SETTINGS);
    await store.putAnswers("b", fakeAnswers({ none: 1 }, { personal: 0.95 }));
    const addLabel = vi.spyOn(gmail, "addLabel");
    await runner.apply(DEFAULT_SETTINGS, stale);
    expect(addLabel).not.toHaveBeenCalled();
    expect(runner.getState()).toMatchObject({ phase: "done", message: "Gmail changed since this screen opened. Check the new numbers, then apply.", preview: { added: 1 } });
  });

  it("ends in error, not busy, when Gmail fails", async () => {
    const { runner, gmail } = await arrange();
    await runner.check(DEFAULT_SETTINGS);
    gmail.addLabel = async () => {
      throw new Error("boom");
    };
    await runner.apply(DEFAULT_SETTINGS, runner.getState().preview!);
    expect(runner.getState()).toMatchObject({ phase: "error", error: "Could not apply the labels. boom" });
    expect(runner.busy()).toBe(false);
    const failing = await arrange();
    vi.spyOn(failing.gmail, "findLabelId").mockRejectedValue(new Error("down"));
    await failing.runner.check(DEFAULT_SETTINGS);
    expect(failing.runner.getState()).toMatchObject({ phase: "error", error: "Could not check Gmail. down" });
  });
});

describe("ScanEngine while labels are being applied", () => {
  it("does not start", async () => {
    const store = await openStore(testKey, `t-${crypto.randomUUID()}`);
    const gmail = createFakeGmail([makeSummary("a")]);
    const judge = vi.fn(async () => fakeAnswers({ promotion: 0.97 }));
    const judgeSignificance = vi.fn(async () => ({ meaningful: 0.5, inputTokens: 1 }));
    const engine = new ScanEngine({ gmail, judge, judgeSignificance, store, isBlocked: () => true });
    await engine.start(DEFAULT_SETTINGS);
    expect(engine.isBusy()).toBe(false);
    expect(engine.getProgress().stage).toBe("idle");
    expect(judge).not.toHaveBeenCalled();
  });
});
