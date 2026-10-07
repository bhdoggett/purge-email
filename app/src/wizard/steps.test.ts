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
  it("removes the Keychain secrets and keeps scan data", async () => {
    const store = await openStore(testKey, `t-${crypto.randomUUID()}`);
    await store.putAnswers("m1", { version: 1 } as never);
    await store.putScan({ ageMonths: 8, candidateIds: ["m1"], repliedThreadIds: [], finished: true, startedAt: 1, settingsAtScan: null, msPerEmail: null });
    await store.putWizard([1, 2, 3, 4, 5, 6]);
    const clearSecrets = vi.fn(async () => {});

    await removeKeys(store, clearSecrets);

    expect(clearSecrets).toHaveBeenCalledOnce();
    expect((await store.allAnswers()).size).toBe(1);
    expect((await store.getScan())?.candidateIds).toEqual(["m1"]);
    expect(await store.getWizard()).toEqual([2, 3, 4]);
  });

  it("still forgets the key steps when removing the secrets fails partway", async () => {
    const store = await openStore(testKey, `t-${crypto.randomUUID()}`);
    await store.putWizard([1, 2, 3, 4, 5, 6]);
    await expect(removeKeys(store, () => Promise.reject(new Error("denied")))).rejects.toThrow("denied");
    expect(await store.getWizard()).toEqual([2, 3, 4]);
  });
});
