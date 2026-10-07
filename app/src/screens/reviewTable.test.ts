import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "@core/decide.ts";
import { fakeAnswers, makeSummary } from "../scan/fakes.ts";
import { buildTableRows, EMPTY_SELECTION, filterRows, NO_FILTERS, pruneSelection, select, selectAll, suggestedOverrides, type TableRow } from "./reviewTable.ts";

const summaries = new Map([
  ["p", makeSummary("p", { from: "Groupon", subject: "70% off", date: "Mon, 01 Jan 2014 00:00:00 +0000" })],
  ["m", makeSummary("m", { from: "Mom", subject: "Dinner", date: "Tue, 02 Jan 2014 00:00:00 +0000" })],
  ["s", makeSummary("s", { from: "Bank", subject: "Alert", date: "Wed, 03 Jan 2014 00:00:00 +0000", labels: ["STARRED"] })],
  ["u", makeSummary("u", { from: "Shop", subject: "Maybe deal", date: "bad date" })],
]);
const answers = new Map([
  ["p", fakeAnswers({ promotion: 0.91 })],
  ["m", fakeAnswers({ none: 1 }, { personal: 0.84 })],
  ["s", fakeAnswers({ securityAlert: 0.9 })],
  ["u", fakeAnswers({ promotion: 0.6, none: 0.4 })],
]);
const ids = ["p", "m", "s", "u"];
const NOW = new Date(2026, 9, 7, 12).getTime();
/** Any age, so the row with a bad date is judged rather than kept as too new. */
const ANY_AGE = { ...DEFAULT_SETTINGS, ageMonths: 0 };
const rows = (overrides = new Map()) => buildTableRows(ids, summaries, answers, overrides, ANY_AGE, NOW);

describe("buildTableRows", () => {
  it("sorts newest first with bad dates last", () => {
    expect(rows().map((r) => r.id)).toEqual(["s", "m", "p", "u"]);
  });
  it("explains each decision in plain words", () => {
    const byId = new Map(rows().map((r) => [r.id, r]));
    expect(byId.get("p")!.reason).toBe("promotions 91%");
    expect(byId.get("m")!.reason).toBe("Kept: family and friends 84%");
    expect(byId.get("s")!.reason).toBe("Kept: starred");
    expect(byId.get("u")!.reason).toBe("Unsure: promotions 60%");
    expect(byId.get("u")!.label).toBe("purge/maybe");
  });
  it("suggests a label for kept rows", () => {
    expect(rows().find((r) => r.id === "s")!.suggested).toBe("security-alert");
  });
  it("says a kind is unchecked when that is why an email was kept", () => {
    const settings = { ...DEFAULT_SETTINGS, purgeKinds: DEFAULT_SETTINGS.purgeKinds.filter((k) => k !== "promotion") };
    const r = buildTableRows(["p"], summaries, answers, new Map(), settings, NOW)[0]!;
    expect(r.label).toBeNull();
    expect(r.reason).toBe("Kept: kind not checked");
  });
  it("says when an email was kept for being newer than the age", () => {
    const recent = new Map([["n", makeSummary("n", { date: new Date(2026, 7, 1).toUTCString() })]]);
    const promo = new Map([["n", fakeAnswers({ promotion: 0.95 })]]);
    const r = buildTableRows(["n"], recent, promo, new Map(), { ...DEFAULT_SETTINGS, ageMonths: 6 }, NOW)[0]!;
    expect(r).toMatchObject({ label: null, decision: "keep", reason: "Kept: newer than 6 months" });
    const ten = buildTableRows(["n"], recent, promo, new Map(), DEFAULT_SETTINGS, NOW)[0]!;
    expect(ten.reason).toBe("Kept: newer than 10 years");
  });
  it("keeps an email with a bad date when an age is set", () => {
    const r = buildTableRows(["u"], summaries, answers, new Map(), DEFAULT_SETTINGS, NOW)[0]!;
    expect(r).toMatchObject({ label: null, decision: "keep", reason: "Kept: date unknown" });
  });
  it("marks overridden rows", () => {
    const r = rows(new Map([["m", { id: "m", slug: "social", at: 1 }]])).find((x) => x.id === "m")!;
    expect(r).toMatchObject({ label: "purge/social", slug: "social", overridden: true, reason: "Changed by you" });
  });
});

describe("filterRows", () => {
  const all = rows(new Map([["m", { id: "m", slug: null, at: 1 }]]));
  it("filters by decision bucket", () => {
    expect(filterRows(all, { ...NO_FILTERS, decision: "purge" }, NOW).map((r) => r.id)).toEqual(["p"]);
    expect(filterRows(all, { ...NO_FILTERS, decision: "maybe" }, NOW).map((r) => r.id)).toEqual(["u"]);
    expect(filterRows(all, { ...NO_FILTERS, decision: "keep" }, NOW).map((r) => r.id)).toEqual(["s", "m"]);
    expect(filterRows(all, { ...NO_FILTERS, decision: "changed" }, NOW).map((r) => r.id)).toEqual(["m"]);
  });
  it("matches category on the label, or the suggestion for kept rows", () => {
    expect(filterRows(all, { ...NO_FILTERS, slug: "security-alert" }, NOW).map((r) => r.id)).toEqual(["s"]);
    expect(filterRows(all, { ...NO_FILTERS, slug: "promotion" }, NOW).map((r) => r.id)).toEqual(["p"]);
  });
  it("matches text in sender or subject, ignoring case", () => {
    expect(filterRows(all, { ...NO_FILTERS, text: " groupon " }, NOW).map((r) => r.id)).toEqual(["p"]);
    expect(filterRows(all, { ...NO_FILTERS, text: "DINNER" }, NOW).map((r) => r.id)).toEqual(["m"]);
  });
  it("combines filters", () => {
    expect(filterRows(all, { ...NO_FILTERS, decision: "keep", slug: "security-alert", text: "bank" }, NOW).map((r) => r.id)).toEqual(["s"]);
  });
});

describe("filterRows: age", () => {
  const dated = new Map([
    ["old", makeSummary("old", { date: new Date(2016, 0, 1).toUTCString() })],
    ["mid", makeSummary("mid", { date: new Date(2026, 0, 1).toUTCString() })],
    ["new", makeSummary("new", { date: new Date(2026, 9, 1).toUTCString() })],
    ["bad", makeSummary("bad", { date: "bad date" })],
  ]);
  const promo = new Map([...dated.keys()].map((id) => [id, fakeAnswers({ promotion: 0.95 })]));
  const all = buildTableRows([...dated.keys()], dated, promo, new Map(), ANY_AGE, NOW);

  it("is off at 0 and keeps rows with bad dates", () => {
    expect(NO_FILTERS.olderThanMonths).toBe(0);
    expect(filterRows(all, NO_FILTERS, NOW).map((r) => r.id)).toEqual(["new", "mid", "old", "bad"]);
  });
  it("shows only rows at least that old, leaving out bad dates", () => {
    expect(filterRows(all, { ...NO_FILTERS, olderThanMonths: 6 }, NOW).map((r) => r.id)).toEqual(["mid", "old"]);
    expect(filterRows(all, { ...NO_FILTERS, olderThanMonths: 24 }, NOW).map((r) => r.id)).toEqual(["old"]);
  });
  it("includes a row dated exactly at the cutoff", () => {
    const edge = new Map([["e", makeSummary("e", { date: new Date(2026, 3, 7, 12).toUTCString() })]]);
    const r = buildTableRows(["e"], edge, new Map(), new Map(), ANY_AGE, NOW);
    expect(filterRows(r, { ...NO_FILTERS, olderThanMonths: 6 }, NOW).map((x) => x.id)).toEqual(["e"]);
  });
  it("combines with other filters", () => {
    expect(filterRows(all, { ...NO_FILTERS, olderThanMonths: 6, text: "sender old" }, NOW).map((r) => r.id)).toEqual(["old"]);
    expect(filterRows(all, { ...NO_FILTERS, olderThanMonths: 6, decision: "keep" }, NOW)).toEqual([]);
  });
});

describe("select", () => {
  const list = rows();
  const none = { shift: false, meta: false };
  it("selects one row on a plain click", () => {
    const s = select(select(EMPTY_SELECTION, list, 0, none), list, 2, none);
    expect([...s.ids]).toEqual([list[2]!.id]);
  });
  it("toggles with Cmd-click", () => {
    let s = select(EMPTY_SELECTION, list, 0, none);
    s = select(s, list, 2, { shift: false, meta: true });
    expect(s.ids).toEqual(new Set([list[0]!.id, list[2]!.id]));
    s = select(s, list, 0, { shift: false, meta: true });
    expect(s.ids).toEqual(new Set([list[2]!.id]));
  });
  it("selects a range with Shift-click in either direction", () => {
    const down = select(select(EMPTY_SELECTION, list, 1, none), list, 3, { shift: true, meta: false });
    expect(down.ids).toEqual(new Set(list.slice(1, 4).map((r) => r.id)));
    const up = select(select(EMPTY_SELECTION, list, 3, none), list, 1, { shift: true, meta: false });
    expect(up.ids).toEqual(new Set(list.slice(1, 4).map((r) => r.id)));
  });
  it("treats Shift-click with no anchor as a plain click (after a filter change resets selection)", () => {
    expect(select(EMPTY_SELECTION, list, 2, { shift: true, meta: false }).ids).toEqual(new Set([list[2]!.id]));
  });
  it("selects every filtered row, not only rendered ones", () => {
    const many: TableRow[] = Array.from({ length: 5000 }, (_, i) => ({ ...list[0]!, id: `x${i}` }));
    expect(selectAll(many).ids.size).toBe(5000);
  });
});

describe("suggestedOverrides", () => {
  it("gives each selected row its own suggestion and counts rows without one", () => {
    const list = rows();
    const noSuggestion = { ...list[0]!, id: "z", suggested: null };
    const r = suggestedOverrides([...list, noSuggestion], new Set(["s", "m", "z"]), 9);
    expect(r.list).toEqual([
      { id: "s", slug: "security-alert", at: 9 },
      { id: "m", slug: expect.any(String), at: 9 },
    ]);
    expect(r.skipped).toBe(1);
  });
});

describe("pruneSelection", () => {
  it("drops ids that are not in the filtered rows and forgets the anchor", () => {
    const list = rows();
    const sel = { ids: new Set(["s", "m", "gone"]), anchor: 1 };
    const r = pruneSelection(sel, list.filter((x) => x.id !== "m"));
    expect(r.ids).toEqual(new Set(["s"]));
    expect(r.anchor).toBeNull();
  });
  it("keeps the selection and anchor unchanged when nothing is dropped", () => {
    const sel = { ids: new Set(["s", "m"]), anchor: 1 };
    const r = pruneSelection(sel, rows());
    expect(r.ids).toEqual(new Set(["s", "m"]));
    expect(r.anchor).toBe(1);
  });
  it("never mutates its input", () => {
    const sel = { ids: new Set(["s", "gone"]), anchor: 0 };
    pruneSelection(sel, rows());
    expect(sel.ids).toEqual(new Set(["s", "gone"]));
    expect(sel.anchor).toBe(0);
    pruneSelection(EMPTY_SELECTION, rows());
    expect(EMPTY_SELECTION.ids.size).toBe(0);
  });
});

describe("attachments in Review", () => {
  const withFiles = new Map([
    ["inv", makeSummary("inv", { from: "Shop", subject: "Your order", attachmentNames: ["invoice-2014.pdf"] })],
    ["pic", makeSummary("pic", { from: "Aunt", subject: "Photos", attachmentNames: ["beach.JPG", "dog.jpg"] })],
    ["none", makeSummary("none", { from: "News", subject: "Weekly" })],
  ]);
  const judged = new Map([...withFiles.keys()].map((id) => [id, fakeAnswers({ promotion: 0.97 })]));
  const settings = { ...DEFAULT_SETTINGS, ageMonths: 0, keepAttachments: false };
  const all = buildTableRows([...withFiles.keys()], withFiles, judged, new Map(), settings, NOW);
  const ids = (f: Partial<typeof NO_FILTERS>) => filterRows(all, { ...NO_FILTERS, ...f }, NOW).map((r) => r.id).sort();

  it("carries each email's attachment names on its row", () => {
    expect(all.find((r) => r.id === "pic")!.attachmentNames).toEqual(["beach.JPG", "dog.jpg"]);
    expect(all.find((r) => r.id === "none")!.attachmentNames).toEqual([]);
  });
  it("filters to emails with or without attachments", () => {
    expect(ids({ attachments: "with" })).toEqual(["inv", "pic"]);
    expect(ids({ attachments: "without" })).toEqual(["none"]);
    expect(ids({ attachments: "all" })).toEqual(["inv", "none", "pic"]);
  });
  it("matches search text in attachment names, ignoring case", () => {
    expect(ids({ text: "invoice" })).toEqual(["inv"]);
    expect(ids({ text: ".jpg" })).toEqual(["pic"]);
  });
  it("combines the attachments filter with the others", () => {
    expect(ids({ attachments: "with", text: "aunt" })).toEqual(["pic"]);
  });
});
