import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "@core/decide.ts";
import { buildRows, gmailLabelUrl, moveAllRows, scanState, totalOf, trashConfirmBody, updateMessage } from "./reviewModel.ts";

const S = { ...DEFAULT_SETTINGS, labelPrefix: "purge" };

describe("reviewModel", () => {
  const counts = new Map([["purge/maybe", 4], ["purge/shipping", 2], ["purge/newsletter", 5], ["purge/scam", 0]]);

  it("orders kinds by PURGE_KINDS with maybe last and drops empty labels", () => {
    expect(buildRows(counts, "purge").map((r) => r.name)).toEqual(["purge/newsletter", "purge/shipping", "purge/maybe"]);
  });

  it("totals all rows but Move all leaves out maybe", () => {
    const rows = buildRows(counts, "purge");
    expect(totalOf(rows)).toBe(11);
    expect(moveAllRows(rows).map((r) => r.name)).toEqual(["purge/newsletter", "purge/shipping"]);
  });

  it("flags rescan, changed and prefixChanged", () => {
    expect(scanState(null, S)).toEqual({ rescan: false, changed: false, prefixChanged: false });
    expect(scanState({ settingsAtScan: S }, S)).toEqual({ rescan: false, changed: false, prefixChanged: false });
    expect(scanState({ settingsAtScan: S }, { ...S, years: 3 })).toMatchObject({ rescan: true, changed: false });
    expect(scanState({ settingsAtScan: S }, { ...S, keepStarred: false })).toMatchObject({ rescan: true, changed: false });
    expect(scanState({ settingsAtScan: S }, { ...S, strictness: "careful" })).toEqual({ rescan: false, changed: true, prefixChanged: false });
    expect(scanState({ settingsAtScan: S }, { ...S, labelPrefix: "x" })).toEqual({ rescan: false, changed: true, prefixChanged: true });
  });

  it("builds the Gmail link and confirm text", () => {
    expect(gmailLabelUrl("my box/maybe")).toBe("https://mail.google.com/mail/u/0/#label/my%20box%2Fmaybe");
    const rows = buildRows(counts, "purge").slice(0, 2);
    const kept = trashConfirmBody(rows, true);
    expect(kept).toContain("purge/newsletter: 5");
    expect(kept).toContain("7 emails in total");
    expect(kept).toContain("Starred emails are skipped.");
    expect(trashConfirmBody(rows, false)).toContain("Includes starred emails.");
  });

  it("appends the old-label note only when the prefix changed", () => {
    const r = { moved: 1, added: 2, removed: 3 };
    expect(updateMessage(r, null)).toBe("Moved 1, added 2, removed 3.");
    expect(updateMessage(r, "old")).toContain('The old labels under "old" are now empty. You can delete them in Gmail.');
  });
});
