import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "@core/decide.ts";
import { buildRows, gmailLabelUrl, labelsWarning, scanState, SETTLING_NOTE, totalOf, updateMessage } from "./reviewModel.ts";

const S = { ...DEFAULT_SETTINGS, labelPrefix: "purge" };

describe("reviewModel", () => {
  const counts = new Map([["purge/maybe", 4], ["purge/shipping", 2], ["purge/newsletter", 5], ["purge/scam", 0]]);

  it("orders kinds by PURGE_KINDS with maybe last and drops empty labels", () => {
    expect(buildRows(counts, "purge").map((r) => r.name)).toEqual(["purge/newsletter", "purge/shipping", "purge/maybe"]);
  });

  it("totals all rows", () => {
    expect(totalOf(buildRows(counts, "purge"))).toBe(11);
  });

  describe("scanState", () => {
    it("is ok when the labels were made with the current rules and nothing is waiting", () => {
      expect(scanState({ settingsAtScan: S }, S)).toEqual({ action: "ok", prefixChanged: false, settling: false });
      expect(scanState({ settingsAtScan: S, deferred: 0 }, S)).toEqual({ action: "ok", prefixChanged: false, settling: false });
      expect(labelsWarning(scanState({ settingsAtScan: S }, S))).toBeNull();
    });

    it("asks for Update labels when rules changed without needing a rescan", () => {
      expect(scanState({ settingsAtScan: S }, { ...S, strictness: "careful" })).toEqual({ action: "update", prefixChanged: false, settling: false });
      expect(scanState({ settingsAtScan: S }, { ...S, labelPrefix: "x" })).toEqual({ action: "update", prefixChanged: true, settling: false });
      expect(labelsWarning(scanState({ settingsAtScan: S }, { ...S, purgeKinds: [] }))).toBe(
        "Your labels don't match your current rules yet. Click Update labels before deleting anything in Gmail.",
      );
    });

    it("asks for Update labels again when the last update deferred changes, even with unchanged rules", () => {
      const state = scanState({ settingsAtScan: S, deferred: 3 }, S);
      expect(state).toEqual({ action: "update", prefixChanged: false, settling: true });
      expect(labelsWarning(state)).toContain("Click Update labels");
      expect(SETTLING_NOTE).toBe("Some labels are still settling in Gmail. Try Update labels again in a few minutes.");
    });

    it("asks for Rescan when the age or a protection checkbox changed", () => {
      expect(scanState({ settingsAtScan: S }, { ...S, years: 3 })).toMatchObject({ action: "rescan" });
      expect(scanState({ settingsAtScan: S }, { ...S, keepStarred: false })).toMatchObject({ action: "rescan" });
      expect(scanState({ settingsAtScan: S, deferred: 2 }, { ...S, keepAttachments: false })).toMatchObject({ action: "rescan", settling: true });
      expect(labelsWarning(scanState({ settingsAtScan: S }, { ...S, years: 3 }))).toBe(
        "Your labels don't match your current rules yet. Click Rescan before deleting anything in Gmail.",
      );
    });

    it("asks for a scan, never Update labels, when the labels' settings are unknown", () => {
      // No scan record (e.g. after Settings, Clear scan data), or a scan that never finished.
      for (const scan of [null, { settingsAtScan: null }, { settingsAtScan: null, deferred: 4 }]) {
        const state = scanState(scan, S);
        expect(state).toEqual({ action: "scan", prefixChanged: false, settling: false });
        expect(labelsWarning(state)).toContain("Scan first before deleting anything in Gmail.");
        expect(labelsWarning(state)).not.toContain("Update labels");
      }
    });
  });

  it("builds the Gmail link with + for spaces and %2F for the nesting slash", () => {
    expect(gmailLabelUrl("my box/maybe")).toBe("https://mail.google.com/mail/u/0/#label/my+box%2Fmaybe");
    expect(gmailLabelUrl("purge/security-alert")).toBe("https://mail.google.com/mail/u/0/#label/purge%2Fsecurity-alert");
    expect(gmailLabelUrl("a  b_c/work")).toBe("https://mail.google.com/mail/u/0/#label/a++b_c%2Fwork");
  });

  it("appends the old-label note only when the prefix changed", () => {
    const r = { moved: 1, added: 2, removed: 3 };
    expect(updateMessage(r, null)).toBe("Moved 1, added 2, removed 3.");
    expect(updateMessage(r, "old")).toContain('The old labels under "old" are now empty. You can delete them in Gmail.');
  });
});
