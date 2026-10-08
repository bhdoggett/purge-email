import { describe, expect, it, vi } from "vitest";
import { openStore } from "../storage/db.ts";
import { testKey } from "../test/key.ts";
import { closeSet, DEFAULT_CLOSE_RULE, countSent, loadCloseContext, parseAddresses, senderAddress, type SenderStats } from "./closeness.ts";
import { createFakeGmail } from "./fakes.ts";

describe("parseAddresses", () => {
  it("reads quoted names with commas", () => {
    expect(parseAddresses('"Smith, Ann" <Ann@Example.com>, "Lee, Bo" <bo@example.com>')).toEqual([
      { address: "ann@example.com", name: "Smith, Ann" },
      { address: "bo@example.com", name: "Lee, Bo" },
    ]);
  });
  it("reads several recipients with and without names", () => {
    expect(parseAddresses("Ann <ann@x.com>, bo@y.org,Cy Doe <cy@z.net>")).toEqual([
      { address: "ann@x.com", name: "Ann" },
      { address: "bo@y.org", name: "" },
      { address: "cy@z.net", name: "Cy Doe" },
    ]);
  });
  it("reads a bare address and lowercases it", () => {
    expect(parseAddresses("  BOB@Example.COM ")).toEqual([{ address: "bob@example.com", name: "" }]);
  });
  it("unescapes quotes in names", () => {
    expect(parseAddresses('"Ann \\"Annie\\" Lee" <ann@x.com>')).toEqual([{ address: "ann@x.com", name: 'Ann "Annie" Lee' }]);
  });
  it("skips empty and invalid entries", () => {
    expect(parseAddresses("")).toEqual([]);
    expect(parseAddresses("undisclosed-recipients:;")).toEqual([]);
    expect(parseAddresses("Ann <not an address>, , bo@y.org")).toEqual([{ address: "bo@y.org", name: "" }]);
  });
  it("skips no-reply addresses", () => {
    expect(parseAddresses("noreply@x.com, No Reply <no-reply@y.com>, donotreply@z.com, NoReply-team@q.com, ann@x.com")).toEqual([{ address: "ann@x.com", name: "" }]);
  });
  it("skips the owner's own address", () => {
    expect(parseAddresses("Me <ME@gmail.com>, ann@x.com", "me@gmail.com")).toEqual([{ address: "ann@x.com", name: "" }]);
  });
});

describe("senderAddress", () => {
  it("reads the From address, no-reply included", () => {
    expect(senderAddress("No Reply <NoReply@Shop.com>")).toBe("noreply@shop.com");
    expect(senderAddress('"Lee, Ann" <ann@x.com>')).toBe("ann@x.com");
  });
  it("is null when no address can be read", () => {
    expect(senderAddress("")).toBeNull();
    expect(senderAddress("Mom")).toBeNull();
  });
});

describe("loadCloseContext", () => {
  const person = { address: "ann@x.com", name: "", nameAt: 0, sent: 30, years: [2018, 2019, 2020] };
  async function withStats(s: Partial<SenderStats> | null, choices: Record<string, boolean> = {}) {
    const store = await openStore(testKey, `t-${crypto.randomUUID()}`);
    if (s) await store.putSenderStats({ ownAddress: "me@gmail.com", counted: [], people: [person], complete: true, ...s });
    await store.putCloseChoices(choices);
    return store;
  }

  it("is known with the close set and own address once the signed-in account's counts are complete", async () => {
    const ctx = await loadCloseContext(await withStats({}, { "bo@x.com": true }), "Me@Gmail.com");
    expect(ctx).toEqual({ close: new Set(["ann@x.com", "bo@x.com"]), own: "me@gmail.com", known: true });
  });
  it("is unknown and empty while counting is incomplete", async () => {
    expect(await loadCloseContext(await withStats({ complete: false }), "me@gmail.com")).toEqual({ close: new Set(), own: null, known: false });
  });
  it("is unknown and empty for another account's counts, or no account", async () => {
    expect(await loadCloseContext(await withStats({ ownAddress: "other@gmail.com" }), "me@gmail.com")).toEqual({ close: new Set(), own: null, known: false });
    expect((await loadCloseContext(await withStats({}), null)).known).toBe(false);
  });
  it("applies the saved auto-close rule", async () => {
    const store = await withStats({});
    await store.putCloseRule({ minSent: 40, minYears: 3 });
    expect((await loadCloseContext(store, "me@gmail.com")).close).toEqual(new Set());
    await store.putCloseRule({ minSent: 30, minYears: 3 });
    expect((await loadCloseContext(store, "me@gmail.com")).close).toEqual(new Set(["ann@x.com"]));
  });
  it("is unknown with no counts, even with choices", async () => {
    expect((await loadCloseContext(await withStats(null, { "bo@x.com": true }), "me@gmail.com")).known).toBe(false);
  });
});

describe("closeSet", () => {
  const stats = (people: SenderStats["people"]): SenderStats => ({ ownAddress: "me@gmail.com", counted: [], people, complete: true });
  const person = (address: string, sent: number, years: number[]) => ({ address, name: "", nameAt: 0, sent, years });

  it("counts someone close after 25 emails over 3 or more years by default", () => {
    expect(DEFAULT_CLOSE_RULE).toEqual({ minSent: 25, minYears: 3 });
    const s = stats([person("a@x.com", 25, [2018, 2019, 2020]), person("b@x.com", 24, [2018, 2019, 2020]), person("c@x.com", 90, [2019, 2020])]);
    expect([...closeSet(s, {})]).toEqual(["a@x.com"]);
  });
  it("uses the rule it is given", () => {
    const s = stats([person("a@x.com", 10, [2019, 2020]), person("b@x.com", 60, [2016, 2017, 2018, 2019])]);
    expect([...closeSet(s, {}, { minSent: 10, minYears: 2 })].sort()).toEqual(["a@x.com", "b@x.com"]);
    expect([...closeSet(s, {}, { minSent: 50, minYears: 4 })]).toEqual(["b@x.com"]);
  });
  it("lets an explicit choice win either way", () => {
    const s = stats([person("a@x.com", 10, [2019, 2020]), person("b@x.com", 1, [2019])]);
    expect([...closeSet(s, { "a@x.com": false, "b@x.com": true, "new@x.com": true })].sort()).toEqual(["b@x.com", "new@x.com"]);
  });
  it("works with no counts yet", () => {
    expect([...closeSet(null, { "a@x.com": true, "b@x.com": false })]).toEqual(["a@x.com"]);
    expect(closeSet(null, {}).size).toBe(0);
  });
});

describe("countSent", () => {
  async function setup() {
    const store = await openStore(testKey, `t-${crypto.randomUUID()}`);
    const gmail = createFakeGmail([]);
    gmail.sent.set("s1", { to: '"Doe, Ann" <ann@x.com>, me@gmail.com', cc: "bo@y.org", date: "Mon, 01 Jan 2018 10:00:00 +0000" });
    gmail.sent.set("s2", { to: "Annie <ANN@x.com>", cc: "", date: "Tue, 01 Jan 2019 10:00:00 +0000" });
    gmail.sent.set("s3", { to: "ann@x.com, noreply@shop.com", cc: "", date: "Wed, 02 Jan 2019 10:00:00 +0000" });
    return { store, gmail };
  }

  it("counts emails and distinct years per address, skipping the owner and no-reply", async () => {
    const { store, gmail } = await setup();
    const stats = await countSent(gmail, store, "me@gmail.com");
    const ann = stats.people.find((p) => p.address === "ann@x.com")!;
    expect(ann).toMatchObject({ address: "ann@x.com", name: "Annie", sent: 3, years: [2018, 2019] });
    expect(stats.people.find((p) => p.address === "bo@y.org")).toMatchObject({ sent: 1, years: [2018] });
    expect(stats.people.map((p) => p.address).sort()).toEqual(["ann@x.com", "bo@y.org"]);
    expect(stats.complete).toBe(true);
    expect(await store.getSenderStats()).toEqual(stats);
  });

  it("keeps the newest non-empty name", async () => {
    const { store, gmail } = await setup();
    gmail.sent.set("s4", { to: "Old Name <ann@x.com>", cc: "", date: "Sun, 01 Jan 2012 10:00:00 +0000" });
    const stats = await countSent(gmail, store, "me@gmail.com");
    expect(stats.people.find((p) => p.address === "ann@x.com")!.name).toBe("Annie");
  });

  it("only fetches new sent mail on a recount", async () => {
    const { store, gmail } = await setup();
    await countSent(gmail, store, "me@gmail.com");
    gmail.sent.set("s5", { to: "ann@x.com", cc: "", date: "Thu, 01 Jan 2020 10:00:00 +0000" });
    const getHeaders = vi.spyOn(gmail, "getHeaders");
    const stats = await countSent(gmail, store, "me@gmail.com");
    expect(getHeaders.mock.calls.map(([id]) => id)).toEqual(["s5"]);
    expect(stats.people.find((p) => p.address === "ann@x.com")).toMatchObject({ sent: 4, years: [2018, 2019, 2020] });
  });

  it("starts over when the counts belong to another account", async () => {
    const { store, gmail } = await setup();
    await countSent(gmail, store, "other@gmail.com");
    const getHeaders = vi.spyOn(gmail, "getHeaders");
    const stats = await countSent(gmail, store, "me@gmail.com");
    expect(getHeaders).toHaveBeenCalledTimes(3);
    expect(stats.ownAddress).toBe("me@gmail.com");
    expect(stats.people.find((p) => p.address === "ann@x.com")!.sent).toBe(3);
  });

  it("reports progress as done of total, counting earlier work", async () => {
    const { store, gmail } = await setup();
    const first = vi.fn();
    await countSent(gmail, store, "me@gmail.com", first);
    expect(first.mock.calls[0]).toEqual([0, 3]);
    expect(first.mock.calls.at(-1)).toEqual([3, 3]);
    gmail.sent.set("s5", { to: "ann@x.com", cc: "", date: "" });
    const again = vi.fn();
    await countSent(gmail, store, "me@gmail.com", again);
    expect(again.mock.calls[0]).toEqual([3, 4]);
    expect(again.mock.calls.at(-1)).toEqual([4, 4]);
  });

  it("saves after each batch, so an interrupted count resumes", async () => {
    const { store, gmail } = await setup();
    for (let i = 0; i < 250; i++) gmail.sent.set(`b${i}`, { to: "cy@z.net", cc: "", date: "Mon, 01 Jan 2018 10:00:00 +0000" });
    let calls = 0;
    const real = gmail.getHeaders.bind(gmail);
    gmail.getHeaders = async (id, names) => {
      if (++calls > 220) throw new Error("network down");
      return real(id, names);
    };
    await expect(countSent(gmail, store, "me@gmail.com")).rejects.toThrow("network down");
    const saved = (await store.getSenderStats())!;
    expect(saved.counted.length).toBe(200);
    expect(saved.complete).toBe(false);

    gmail.getHeaders = real;
    const getHeaders = vi.spyOn(gmail, "getHeaders");
    const stats = await countSent(gmail, store, "me@gmail.com");
    expect(getHeaders).toHaveBeenCalledTimes(53);
    expect(stats.people.find((p) => p.address === "cy@z.net")!.sent).toBe(250);
    expect(stats.complete).toBe(true);
  });

  it("stays complete while a recount of new mail is interrupted", async () => {
    const { store, gmail } = await setup();
    await countSent(gmail, store, "me@gmail.com");
    for (let i = 0; i < 250; i++) gmail.sent.set(`n${i}`, { to: "cy@z.net", cc: "", date: "" });
    let calls = 0;
    const real = gmail.getHeaders.bind(gmail);
    gmail.getHeaders = async (id, names) => {
      if (++calls > 220) throw new Error("network down");
      return real(id, names);
    };
    await expect(countSent(gmail, store, "me@gmail.com")).rejects.toThrow("network down");
    expect((await store.getSenderStats())!.complete).toBe(true);
  });

  it("is incomplete when counting starts over for another account", async () => {
    const { store, gmail } = await setup();
    await countSent(gmail, store, "other@gmail.com");
    gmail.getHeaders = async () => {
      throw new Error("down");
    };
    await expect(countSent(gmail, store, "me@gmail.com")).rejects.toThrow("down");
    const saved = await store.getSenderStats();
    expect(saved === null || (saved.ownAddress === "me@gmail.com" && !saved.complete) || saved.ownAddress === "other@gmail.com").toBe(true);
    expect((await loadCloseContext(store, "me@gmail.com")).known).toBe(false);
  });
});
