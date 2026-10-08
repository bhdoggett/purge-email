import { describe, expect, it } from "vitest";
import { DEFAULT_CLOSE_RULE as RULE, type SenderStats } from "../storage/db.ts";
import { closeCount, closeRows, countStatus, emailsText, PAGE_SIZE } from "./closePeopleModel.ts";

const person = (address: string, name: string, sent: number, years: number[]) => ({ address, name, nameAt: 0, sent, years });
const stats: SenderStats = {
  ownAddress: "me@gmail.com",
  counted: [],
  complete: true,
  people: [person("bo@x.com", "Bo Lee", 3, [2020]), person("ann@x.com", "Ann Smith", 214, [2010, 2011, 2012]), person("cy@y.org", "", 12, [2019, 2020])],
};

describe("closeRows", () => {
  it("sorts by emails sent, most first, and marks auto and chosen ticks", () => {
    expect(closeRows(stats, { "bo@x.com": true }, "", RULE)).toEqual([
      { address: "ann@x.com", name: "Ann Smith", sent: 214, years: 3, close: true, auto: true },
      { address: "cy@y.org", name: "", sent: 12, years: 2, close: false, auto: false },
      { address: "bo@x.com", name: "Bo Lee", sent: 3, years: 1, close: true, auto: false },
    ]);
  });
  it("ticks automatically by the rule it is given", () => {
    expect(closeRows(stats, {}, "", { minSent: 10, minYears: 2 }).find((r) => r.address === "cy@y.org")).toMatchObject({ close: true, auto: true });
  });
  it("lets an explicit untick win over the automatic list", () => {
    expect(closeRows(stats, { "ann@x.com": false }, "", RULE)[0]).toMatchObject({ close: false, auto: false });
  });
  it("searches names and addresses, ignoring case", () => {
    expect(closeRows(stats, {}, " SMITH ", RULE).map((r) => r.address)).toEqual(["ann@x.com"]);
    expect(closeRows(stats, {}, "y.org", RULE).map((r) => r.address)).toEqual(["cy@y.org"]);
  });
  it("is empty without counts", () => {
    expect(closeRows(null, { "a@x.com": true }, "", RULE)).toEqual([]);
  });
  it("shows 100 at a time", () => {
    expect(PAGE_SIZE).toBe(100);
  });
});

describe("closeCount", () => {
  it("counts everyone close, including chosen people not in the counts", () => {
    expect(closeCount(stats, { "bo@x.com": true, "new@x.com": true, "cy@y.org": false }, RULE)).toBe(3);
  });
});

describe("emailsText", () => {
  it("words emails and years", () => {
    expect(emailsText(214, 12)).toBe("214 emails over 12 years");
    expect(emailsText(1, 1)).toBe("1 email over 1 year");
    expect(emailsText(1200, 0)).toBe("1,200 emails");
  });
});

describe("countStatus", () => {
  it("is none without counts, or with counts from another account", () => {
    expect(countStatus(null, "me@gmail.com")).toBe("none");
    expect(countStatus(stats, "other@gmail.com")).toBe("none");
    expect(countStatus(stats, null)).toBe("none");
  });
  it("is partial while counting is unfinished, and done once complete", () => {
    expect(countStatus({ ...stats, complete: false }, "Me@Gmail.com")).toBe("partial");
    expect(countStatus(stats, "me@gmail.com")).toBe("done");
  });
});
