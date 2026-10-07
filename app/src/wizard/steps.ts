import type { Store } from "../storage/db.ts";

export type Step = 1 | 2 | 3 | 4 | 5 | 6;
export const ALL_STEPS: Step[] = [1, 2, 3, 4, 5, 6];

/** Where the wizard opens: where it was sent, else the first unfinished step, else sign-in. */
export function initialStep(saved: number[], startAt?: Step): Step {
  if (startAt) return startAt;
  return ALL_STEPS.find((n) => !saved.includes(n)) ?? 6;
}

/** Clears saved checkmarks for steps whose saved credential was just removed. */
export async function forgetSteps(store: Store, steps: Step[]): Promise<void> {
  const saved = await store.getWizard();
  await store.putWizard(saved.filter((n) => !steps.includes(n as Step)));
}

/** Steps backed by a Keychain secret: the Jev key, the Google client, and the sign-in. */
export const KEY_STEPS: Step[] = [1, 5, 6];
export const SIGN_IN_STEPS: Step[] = [6];

/** Settings → Remove keys. Scan data stays: its encryption key is kept, so it remains readable. */
export async function removeKeys(store: Store, clearSecrets: () => Promise<void>): Promise<void> {
  try {
    await clearSecrets();
  } finally {
    // Some secrets may be gone even if a later step failed, so their checkmarks must not stay.
    await forgetSteps(store, KEY_STEPS);
  }
}
