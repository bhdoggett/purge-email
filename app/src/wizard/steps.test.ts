import { describe, expect, it } from "vitest";
import { openStore } from "../storage/db.ts";
import { forgetSteps, initialStep, KEY_STEPS, SIGN_IN_STEPS } from "./steps.ts";

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
    const store = await openStore(`t-${crypto.randomUUID()}`);
    await store.putWizard([1, 2, 3, 4, 5, 6]);
    await forgetSteps(store, SIGN_IN_STEPS);
    expect(await store.getWizard()).toEqual([1, 2, 3, 4, 5]);
    await forgetSteps(store, KEY_STEPS);
    expect(await store.getWizard()).toEqual([2, 3, 4]);
  });
});
