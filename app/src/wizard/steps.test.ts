import { describe, expect, it, vi } from "vitest";
import { openStore } from "../storage/db.ts";
import { testKey } from "../test/key.ts";
import { forgetSteps, initialStep, KEY_STEPS, removeKeys, SIGN_IN_STEPS } from "./steps.ts";

describe("initialStep", () => {
  it("opens where the wizard was sent", () => {
    expect(initialStep([1, 2, 3, 4, 5, 6], 3)).toBe(3);
    expect(initialStep([], 6)).toBe(6);
  });

  it("opens on the first unfinished step", () => {
    expect(initialStep([])).toBe(1);
    expect(initialStep([1, 2, 4])).toBe(3);
  });

  it("opens on sign-in when every step is done", () => {
    expect(initialStep([1, 2, 3, 4, 5, 6])).toBe(6);
  });
});

describe("forgetSteps", () => {
  it("clears the key steps on Remove keys and only sign-in on Sign out", async () => {
    const store = await openStore(testKey, `t-${crypto.randomUUID()}`);
    await store.putWizard([1, 2, 3, 4, 5, 6]);
    await forgetSteps(store, SIGN_IN_STEPS);
    expect(await store.getWizard()).toEqual([1, 2, 3, 4, 5]);
    await forgetSteps(store, KEY_STEPS);
    expect(await store.getWizard()).toEqual([2, 3, 4]);
  });
});

describe("removeKeys", () => {
  it("removes the Keychain secrets, forgets the data key, and clears scan data encrypted with it", async () => {
    const store = await openStore(testKey, `t-${crypto.randomUUID()}`);
    const summary = { id: "m1", threadId: "t1", from: "a", to: "b", cc: "", subject: "s", date: "d", snippet: "x", labels: [], hasListUnsubscribe: false, attachmentNames: [] };
    await store.putSummary(summary);
    await store.putAnswers("m1", { version: 1 } as never);
    await store.putScan({ ageMonths: 8, candidateIds: ["m1"], repliedThreadIds: [], finished: true, startedAt: 1, settingsAtScan: null, msPerEmail: null });
    await store.putOverrides(["m1"], "promotion", 1);
    await store.putWizard([1, 2, 3, 4, 5, 6]);
    const calls: string[] = [];
    const clearSecrets = vi.fn(async () => void calls.push("clearSecrets"));
    const forgetDataKey = vi.fn(() => void calls.push("forgetDataKey"));

    await removeKeys(store, { clearSecrets, forgetDataKey });

    expect(calls).toEqual(["clearSecrets", "forgetDataKey"]);
    expect(await store.getSummary("m1")).toBeUndefined();
    expect((await store.allAnswers()).size).toBe(0);
    expect(await store.getScan()).toBeNull();
    expect((await store.allOverrides()).get("m1")?.slug).toBe("promotion");
    expect(await store.getWizard()).toEqual([2, 3, 4]);
  });

  it("keeps scan data when the Keychain secrets could not be removed", async () => {
    const store = await openStore(testKey, `t-${crypto.randomUUID()}`);
    await store.putAnswers("m1", { version: 1 } as never);
    const forgetDataKey = vi.fn();
    await expect(removeKeys(store, { clearSecrets: () => Promise.reject(new Error("denied")), forgetDataKey })).rejects.toThrow("denied");
    expect(forgetDataKey).not.toHaveBeenCalled();
    expect((await store.allAnswers()).size).toBe(1);
  });
});
