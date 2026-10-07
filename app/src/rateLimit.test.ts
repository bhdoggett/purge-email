import { describe, expect, it, vi } from "vitest";
import { createGmail } from "./gmail/client.ts";
import { createStore } from "./externalStore.ts";

describe("rate-limit store", () => {
  it("holds the value, notifies subscribers, and stops after unsubscribe", () => {
    const s = createStore<number | null>(null);
    const fn = vi.fn();
    expect(s.get()).toBeNull();
    const off = s.subscribe(fn);
    s.set(5000);
    expect(s.get()).toBe(5000);
    expect(fn).toHaveBeenCalledTimes(1);
    off();
    s.set(null);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("follows the Gmail client: set on a 429, cleared by onRateLimit(null)", async () => {
    const { rateLimit } = await import("./rateLimit.ts");
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const limited = () => json(429, { error: { code: 429, message: "Quota", errors: [{ reason: "rateLimitExceeded" }] } });
    const seen: (number | null)[] = [];
    const off = rateLimit.subscribe(() => seen.push(rateLimit.get()));
    const fetch = vi.fn().mockResolvedValueOnce(limited()).mockResolvedValue(json(200, { emailAddress: "a" }));
    let t = 0;
    const gmail = createGmail({ fetch, sleep: async (ms) => void (t += ms), now: () => t, onRateLimit: (u) => rateLimit.set(u), random: () => 0.5 });
    await gmail.getProfile();
    expect(seen[0]).toBeTypeOf("number");
    expect(rateLimit.get()).toBeNull();
    off();
  });
});
