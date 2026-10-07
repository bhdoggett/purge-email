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
const rows = (overrides = new Map()) => buildTableRows(ids, summaries, answers, overrides, DEFAULT_SETTINGS);

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
    const r = buildTableRows(["p"], summaries, answers, new Map(), settings)[0]!;
    expect(r.label).toBeNull();
    expect(r.reason).toBe("Kept: kind not checked");
  });
  it("marks overridden rows", () => {
    const r = rows(new Map([["m", { id: "m", slug: "social", at: 1 }]])).find((x) => x.id === "m")!;
    expect(r).toMatchObject({ label: "purge/social", slug: "social", overridden: true, reason: "Changed by you" });
  });
});

describe("filterRows", () => {
  const all = rows(new Map([["m", { id: "m", slug: null, at: 1 }]]));
  it("filters by decision bucket", () => {
    expect(filterRows(all, { ...NO_FILTERS, decision: "purge" }).map((r) => r.id)).toEqual(["p"]);
    expect(filterRows(all, { ...NO_FILTERS, decision: "maybe" }).map((r) => r.id)).toEqual(["u"]);
    expect(filterRows(all, { ...NO_FILTERS, decision: "keep" }).map((r) => r.id)).toEqual(["s", "m"]);
    expect(filterRows(all, { ...NO_FILTERS, decision: "changed" }).map((r) => r.id)).toEqual(["m"]);
  });
  it("matches category on the label, or the suggestion for kept rows", () => {
    expect(filterRows(all, { ...NO_FILTERS, slug: "security-alert" }).map((r) => r.id)).toEqual(["s"]);
    expect(filterRows(all, { ...NO_FILTERS, slug: "promotion" }).map((r) => r.id)).toEqual(["p"]);
  });
  it("matches text in sender or subject, ignoring case", () => {
    expect(filterRows(all, { ...NO_FILTERS, text: " groupon " }).map((r) => r.id)).toEqual(["p"]);
    expect(filterRows(all, { ...NO_FILTERS, text: "DINNER" }).map((r) => r.id)).toEqual(["m"]);
  });
  it("combines filters", () => {
    expect(filterRows(all, { decision: "keep", slug: "security-alert", text: "bank" }).map((r) => r.id)).toEqual(["s"]);
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
