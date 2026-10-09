import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@core/decide.ts";
import { openStore } from "../storage/db.ts";
import { testKey } from "../test/key.ts";
import { ApplyRunner } from "./applyRunner.ts";
import { ScanEngine } from "./engine.ts";
import { createFakeGmail, fakeAnswers, idsWithLabel, makeSummary } from "./fakes.ts";
import { applyPreview, isPending, previewReconcile, USER_CHANGE_GRACE_MS } from "./reconcile.ts";

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

  it("check() with nothing pending takes the label totals from the plan", async () => {
    const { runner } = await arrange([]);
    await runner.check(DEFAULT_SETTINGS);
    expect(runner.getState().preview?.totals).toEqual(new Map());
    expect(runner.getState().phase).toBe("done");
  });

  it("apply() writes and ends in done with totals and the applied message", async () => {
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
    expect(s.preview?.totals.get("purge/promotion")).toBe(2);
    expect(isPending(s.preview!)).toBe(false);
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

/** Spies on the label reads a plan makes; `profile` counts account lookups apart. */
function reads(gmail: ReturnType<typeof createFakeGmail>) {
  const spies = [vi.spyOn(gmail, "listIds"), vi.spyOn(gmail, "findLabelId")];
  const profile = vi.spyOn(gmail, "getProfile");
  return {
    count: () => spies.reduce((n, s) => n + s.mock.calls.length, 0),
    profile: () => profile.mock.calls.length,
    clear: () => [...spies, profile].forEach((s) => s.mockClear()),
  };
}

describe("ApplyRunner cached result", () => {
  async function arrangeAt(ids = ["a", "b"]) {
    const a = await arrange(ids);
    let now = NOW;
    const runner = new ApplyRunner({ gmail: a.gmail, store: a.store, isScanning: () => false, now: () => now });
    return { ...a, runner, setNow: (t: number) => (now = t) };
  }

  it("check() records when it ran and the store revision it planned from", async () => {
    const { runner, store } = await arrangeAt();
    await runner.check(DEFAULT_SETTINGS);
    expect(runner.getState().preview).toMatchObject({ checkedAt: NOW, revision: store.revision() });
  });

  it("visit() keeps the result without reading Gmail while nothing changed", async () => {
    const { runner, gmail } = await arrangeAt();
    await runner.visit(DEFAULT_SETTINGS);
    const first = runner.getState();
    expect(first.phase).toBe("done");
    const r = reads(gmail);
    await runner.visit(DEFAULT_SETTINGS);
    expect(r.count()).toBe(0);
    // Only the account is looked up, to catch a switch to another Gmail account.
    expect(r.profile()).toBe(1);
    expect(runner.getState()).toBe(first);
  });

  it("check() records the account it read", async () => {
    const { runner } = await arrangeAt();
    await runner.check(DEFAULT_SETTINGS);
    expect(runner.getState().preview?.account).toBe("me@gmail.com");
  });

  it("visit() checks again when the signed-in account changed", async () => {
    const { runner, gmail } = await arrangeAt();
    await runner.visit(DEFAULT_SETTINGS);
    vi.spyOn(gmail, "getProfile").mockResolvedValue({ emailAddress: "other@gmail.com" });
    const r = reads(gmail);
    await runner.visit(DEFAULT_SETTINGS);
    expect(r.count()).toBeGreaterThan(0);
    expect(runner.getState().preview?.account).toBe("other@gmail.com");
  });

  it("an unknown account never reuses or fast-applies a cached plan", async () => {
    for (const failAt of ["plan", "click"] as const) {
      for (const path of ["visit", "apply"] as const) {
        const { runner, gmail } = await arrangeAt();
        const profile = vi.spyOn(gmail, "getProfile");
        if (failAt === "plan") profile.mockRejectedValue(new Error("offline"));
        await runner.check(DEFAULT_SETTINGS);
        expect(runner.getState().preview?.account, `${failAt} ${path}`).toBe(failAt === "plan" ? null : "me@gmail.com");
        profile.mockRejectedValue(new Error("offline"));
        const r = reads(gmail);
        if (path === "visit") await runner.visit(DEFAULT_SETTINGS);
        else await runner.apply(DEFAULT_SETTINGS, runner.getState().preview!);
        // Plans again from Gmail instead of trusting the cached plan.
        expect(r.count(), `${failAt} ${path}`).toBeGreaterThan(0);
      }
    }
  });

  it("reset() drops the cached result, so the next visit checks Gmail", async () => {
    const { runner, gmail } = await arrangeAt();
    await runner.visit(DEFAULT_SETTINGS);
    runner.reset();
    expect(runner.getState().phase).toBe("idle");
    const r = reads(gmail);
    await runner.visit(DEFAULT_SETTINGS);
    expect(r.count()).toBeGreaterThan(0);
  });

  it("visit() checks a settling result again once the grace window has passed", async () => {
    const { runner, gmail, store, setNow } = await arrangeAt();
    // Labeled just now as newsletter, which Gmail doesn't show yet: deferred.
    await store.putLabels([{ id: "a", label: "purge/newsletter", labeledAt: NOW - 1000, userRemoved: false, userChosen: false }]);
    await runner.visit(DEFAULT_SETTINGS);
    expect(runner.getState().preview?.plan.deferred).toBe(1);
    const r = reads(gmail);
    setNow(NOW + USER_CHANGE_GRACE_MS - 1);
    await runner.visit(DEFAULT_SETTINGS);
    expect(r.count()).toBe(0);
    setNow(NOW + USER_CHANGE_GRACE_MS);
    await runner.visit(DEFAULT_SETTINGS);
    expect(r.count()).toBeGreaterThan(0);
  });

  it("check() keeps the applied message but not a refusal", async () => {
    const { runner, store } = await arrangeAt();
    await runner.check(DEFAULT_SETTINGS);
    const shown = runner.getState().preview!;
    await store.putOverrides(["b"], null, NOW + 1);
    await runner.apply(DEFAULT_SETTINGS, shown);
    expect(runner.getState().message).toMatch(/^Gmail changed/);
    await runner.check(DEFAULT_SETTINGS);
    expect(runner.getState().message).toBeUndefined();
  });

  it("visit() keeps a nothing-pending result whose store-only changes were saved", async () => {
    const { runner, gmail, store } = await arrangeAt(["a"]);
    const labelId = await gmail.ensureLabel("purge/promotion");
    await gmail.addLabel(labelId, ["a"]);
    await store.putLabels([{ id: "a", label: "purge/promotion", labeledAt: NOW - 600_000, userRemoved: false, userChosen: false }]);
    await store.putOverrides(["a"], "promotion", NOW - 1);
    await runner.check(DEFAULT_SETTINGS);
    expect(isPending(runner.getState().preview!)).toBe(false);
    const r = reads(gmail);
    await runner.visit(DEFAULT_SETTINGS);
    expect(r.count()).toBe(0);
  });

  it("visit() checks again after an override, settings, close rule or scan change", async () => {
    const { runner, gmail, store } = await arrangeAt();
    const changes: [string, () => Promise<void>][] = [
      ["override", () => store.putOverrides(["a"], null, NOW + 1)],
      ["settings", () => store.putSettings(DEFAULT_SETTINGS)],
      ["close rule", () => store.putCloseRule({ minSent: 5, minYears: 1 })],
      ["scan", async () => store.putScan((await store.getScan())!)],
    ];
    await runner.visit(DEFAULT_SETTINGS);
    for (const [name, change] of changes) {
      await change();
      const r = reads(gmail);
      await runner.visit(DEFAULT_SETTINGS);
      expect(r.count(), name).toBeGreaterThan(0);
      r.clear();
      await runner.visit(DEFAULT_SETTINGS);
      expect(r.count(), name).toBe(0);
    }
  });

  it("visit() checks again after an error", async () => {
    const { runner, gmail } = await arrangeAt();
    const spy = vi.spyOn(gmail, "findLabelId").mockRejectedValueOnce(new Error("down"));
    await runner.visit(DEFAULT_SETTINGS);
    expect(runner.getState().phase).toBe("error");
    spy.mockClear();
    await runner.visit(DEFAULT_SETTINGS);
    expect(spy).toHaveBeenCalled();
    expect(runner.getState().phase).toBe("done");
  });

  it("apply() within 5 minutes of the check, with nothing changed, writes the shown plan without reading Gmail", async () => {
    const { runner, gmail, store, setNow } = await arrangeAt();
    await runner.check(DEFAULT_SETTINGS);
    const shown = runner.getState().preview!;
    setNow(NOW + 4 * 60_000);
    const r = reads(gmail);
    await runner.apply(DEFAULT_SETTINGS, shown);
    expect(r.count()).toBe(0);
    expect(r.profile()).toBe(1);
    expect(idsWithLabel(gmail, "purge/promotion")).toEqual(["a", "b"]);
    const s = runner.getState();
    expect(s).toMatchObject({ phase: "done", message: "Added 2, moved 0, removed 0." });
    expect(s.preview?.totals).toEqual(new Map([["purge/promotion", 2]]));
    expect(isPending(s.preview!)).toBe(false);
    // The records carry the moment of writing, not of the check.
    expect((await store.allLabels()).get("a")?.labeledAt).toBe(NOW + 4 * 60_000);
  });

  it("apply() within 5 minutes plans again when the signed-in account changed", async () => {
    const { runner, gmail } = await arrangeAt();
    await runner.check(DEFAULT_SETTINGS);
    const shown = runner.getState().preview!;
    vi.spyOn(gmail, "getProfile").mockResolvedValue({ emailAddress: "other@gmail.com" });
    const r = reads(gmail);
    await runner.apply(DEFAULT_SETTINGS, shown);
    expect(r.count()).toBeGreaterThan(0);
  });

  it("apply() records its own writes, so the next visit keeps the done result", async () => {
    const { runner, gmail } = await arrangeAt();
    await runner.check(DEFAULT_SETTINGS);
    await runner.apply(DEFAULT_SETTINGS, runner.getState().preview!);
    const done = runner.getState();
    const r = reads(gmail);
    await runner.visit(DEFAULT_SETTINGS);
    expect(r.count()).toBe(0);
    expect(runner.getState()).toBe(done);
  });

  it("a change saved while Apply writes makes the next visit check again", async () => {
    const { runner, gmail, store } = await arrangeAt();
    await runner.check(DEFAULT_SETTINGS);
    const h = hold(gmail);
    const writing = runner.apply(DEFAULT_SETTINGS, runner.getState().preview!);
    await h.started;
    await store.putOverrides(["a"], null, NOW + 1);
    h.release();
    await writing;
    const r = reads(gmail);
    await runner.visit(DEFAULT_SETTINGS);
    expect(r.count()).toBeGreaterThan(0);
    expect(runner.getState().preview).toMatchObject({ removed: 1 });
  });

  it("apply() more than 5 minutes after the check plans again before writing", async () => {
    const { runner, gmail, setNow } = await arrangeAt();
    await runner.check(DEFAULT_SETTINGS);
    const shown = runner.getState().preview!;
    setNow(NOW + 5 * 60_000);
    const r = reads(gmail);
    const firstWrite = vi.spyOn(gmail, "addLabel");
    await runner.apply(DEFAULT_SETTINGS, shown);
    expect(r.count()).toBeGreaterThan(0);
    expect(firstWrite).toHaveBeenCalled();
  });

  it("apply() after a store change plans again and refuses when the numbers differ", async () => {
    const { runner, gmail, store } = await arrangeAt();
    await runner.check(DEFAULT_SETTINGS);
    const shown = runner.getState().preview!;
    await store.putOverrides(["b"], null, NOW + 1);
    const addLabel = vi.spyOn(gmail, "addLabel");
    await runner.apply(DEFAULT_SETTINGS, shown);
    expect(addLabel).not.toHaveBeenCalled();
    expect(runner.getState()).toMatchObject({ phase: "done", message: "Gmail changed since this screen opened. Check the new numbers, then apply.", preview: { added: 1 } });
  });

  it("reads nothing from Gmail after the write", async () => {
    const { runner, gmail, setNow } = await arrangeAt();
    await runner.check(DEFAULT_SETTINGS);
    setNow(NOW + 10 * 60_000);
    const after: string[] = [];
    let wrote = false;
    const add = gmail.addLabel.bind(gmail);
    gmail.addLabel = async (l, ids) => {
      wrote = true;
      return add(l, ids);
    };
    const list = gmail.listIds.bind(gmail);
    gmail.listIds = async (q, limit, opts) => {
      if (wrote) after.push("listIds");
      return list(q, limit, opts);
    };
    await runner.apply(DEFAULT_SETTINGS, runner.getState().preview!);
    expect(wrote).toBe(true);
    expect(after).toEqual([]);
    expect(runner.getState().preview?.totals).toEqual(new Map([["purge/promotion", 2]]));
  });
});

describe("applyPreview and the store revision", () => {
  it("returns the revision after its own writes, or null when another write was running", async () => {
    const { store, gmail } = await arrange();
    const clean = await previewReconcile({ gmail, store, now: () => NOW }, DEFAULT_SETTINGS);
    expect(await applyPreview({ gmail, store }, clean)).toBe(store.revision());

    const { store: store2, gmail: gmail2 } = await arrange();
    // Starts before the plan reads the store and ends after: the plan may not have seen it.
    const inFlight = store2.putOverrides(["a"], null, NOW + 1);
    const preview = await previewReconcile({ gmail: gmail2, store: store2, now: () => NOW }, DEFAULT_SETTINGS);
    await inFlight;
    expect(await applyPreview({ gmail: gmail2, store: store2 }, preview)).toBeNull();
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
