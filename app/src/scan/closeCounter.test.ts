import { describe, expect, it, vi } from "vitest";
import { openStore } from "../storage/db.ts";
import { testKey } from "../test/key.ts";
import { CloseCounter } from "./closeCounter.ts";
import { createFakeGmail } from "./fakes.ts";

async function setup(isBlocked = () => false) {
  const store = await openStore(testKey, `t-${crypto.randomUUID()}`);
  const gmail = createFakeGmail([]);
  gmail.sent.set("s1", { to: "Ann <ann@x.com>, me@gmail.com", cc: "", date: "Mon, 01 Jan 2018 10:00:00 +0000" });
  gmail.sent.set("s2", { to: "ann@x.com", cc: "", date: "Mon, 01 Jan 2019 10:00:00 +0000" });
  const counter = new CloseCounter({ gmail, store, isBlocked });
  return { store, gmail, counter };
}

describe("CloseCounter", () => {
  it("counts sent mail for the signed-in account and reports progress", async () => {
    const { counter, store } = await setup();
    const states: string[] = [];
    counter.subscribe(() => states.push(`${counter.getState().phase} ${counter.getState().done ?? ""}/${counter.getState().total ?? ""}`));
    await counter.start();
    expect(counter.getState().phase).toBe("done");
    expect(states).toContain("counting 0/2");
    expect(states).toContain("counting 2/2");
    const stats = (await store.getSenderStats())!;
    expect(stats.ownAddress).toBe("me@gmail.com");
    expect(stats.people.map((p) => p.address)).toEqual(["ann@x.com"]);
    expect(counter.busy()).toBe(false);
  });

  it("does not start while a scan or Apply runs", async () => {
    const { counter, gmail } = await setup(() => true);
    const listIds = vi.spyOn(gmail, "listIds");
    await counter.start();
    expect(counter.getState().phase).toBe("idle");
    expect(listIds).not.toHaveBeenCalled();
  });

  it("is busy while counting and ignores a second start", async () => {
    const { counter, gmail } = await setup();
    const getHeaders = vi.spyOn(gmail, "getHeaders");
    const first = counter.start();
    expect(counter.busy()).toBe(true);
    await counter.start();
    await first;
    expect(getHeaders).toHaveBeenCalledTimes(2);
  });

  it("shows an error and keeps what was counted", async () => {
    const { counter, gmail } = await setup();
    gmail.getHeaders = async () => {
      throw new Error("down");
    };
    await counter.start();
    expect(counter.getState()).toMatchObject({ phase: "error", error: "Couldn't count your sent mail. down" });
    expect(counter.busy()).toBe(false);
  });
});
