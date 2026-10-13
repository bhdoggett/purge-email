import { describe, expect, it } from "vitest";
import { appliedMessage, breakdownText, buildRows, checkedText, gmailLabelUrl, previewSummary, SETTLING_NOTE, skippedNotes, totalOf } from "./applyModel.ts";

describe("applyModel", () => {
  const none = { wanted: 0, toAdd: 0, already: 0, inTrash: 0, changedInGmail: 0, waiting: 0 };

  it("explains how the emails Review labels split up, leaving out zero parts", () => {
    const b = { ...none, wanted: 515, toAdd: 88, already: 300, inTrash: 120, changedInGmail: 7 };
    expect(breakdownText(b)).toBe("515 emails get a label from your review: 88 to add, 300 already labeled, 120 in Trash or Spam, 7 you unlabeled or relabeled in Gmail.");
    expect(breakdownText({ ...none, wanted: 1, waiting: 1 })).toBe("1 email gets a label from your review: 1 waiting on Gmail.");
  });

  it("says nothing extra when every email is to add, or every one already labeled", () => {
    expect(breakdownText({ ...none, wanted: 5, toAdd: 5 })).toBeNull();
    expect(breakdownText({ ...none, wanted: 5, already: 5 })).toBeNull();
    expect(breakdownText(none)).toBeNull();
    expect(breakdownText({ ...none, wanted: 5, toAdd: 2, already: 3 })).toBe("5 emails get a label from your review: 2 to add, 3 already labeled.");
  });

  it("explains only the reasons that apply", () => {
    expect(skippedNotes({ ...none, wanted: 2, toAdd: 2 })).toEqual([]);
    expect(skippedNotes({ ...none, wanted: 2, inTrash: 1, changedInGmail: 1 })).toHaveLength(2);
  });

  const counts = new Map([["purge/maybe", 4], ["purge/shipping", 2], ["purge/newsletter", 5], ["purge/scam", 0]]);

  it("orders kinds by PURGE_KINDS with maybe last and drops empty labels", () => {
    expect(buildRows(counts, "purge").map((r) => r.name)).toEqual(["purge/newsletter", "purge/shipping", "purge/maybe"]);
  });

  it("puts trivial personal mail after the kinds and before maybe", () => {
    const withPersonal = new Map([...counts, ["purge/personal", 3]]);
    expect(buildRows(withPersonal, "purge").map((r) => r.name)).toEqual(["purge/newsletter", "purge/shipping", "purge/personal", "purge/maybe"]);
  });

  it("totals all rows", () => {
    expect(totalOf(buildRows(counts, "purge"))).toBe(11);
  });

  it("words the settling note for Apply", () => {
    expect(SETTLING_NOTE).toBe("Some labels are still settling in Gmail. Click Check again in a few minutes.");
  });

  it("builds the Gmail link with + for spaces and %2F for the nesting slash", () => {
    expect(gmailLabelUrl("my box/maybe")).toBe("https://mail.google.com/mail/u/0/#label/my+box%2Fmaybe");
    expect(gmailLabelUrl("purge/security-alert")).toBe("https://mail.google.com/mail/u/0/#label/purge%2Fsecurity-alert");
    expect(gmailLabelUrl("a  b_c/work")).toBe("https://mail.google.com/mail/u/0/#label/a++b_c%2Fwork");
  });

  it("summarises the preview, leaving out zero parts", () => {
    expect(previewSummary({ added: 1204, moved: 37, removed: 0 })).toBe("Add 1,204 labels · Move 37");
    expect(previewSummary({ added: 0, moved: 0, removed: 0 })).toBe("Gmail already matches your review.");
  });

  it("reports what Apply did and names emptied old prefixes", () => {
    expect(appliedMessage({ added: 2, moved: 1, removed: 0 }, [])).toBe("Added 2, moved 1, removed 0.");
    expect(appliedMessage({ added: 0, moved: 3, removed: 0 }, ["purge"])).toBe(
      'Added 0, moved 3, removed 0. The old labels under "purge" are now empty. You can delete them in Gmail.',
    );
  });

  it("says when Gmail was last checked in local time, with the date when it wasn't today", () => {
    const at = new Date(2026, 9, 7, 15, 5);
    const time = at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    expect(checkedText(at.getTime(), new Date(2026, 9, 7, 23, 0).getTime())).toBe(`Checked ${time}`);
    const date = at.toLocaleDateString([], { month: "short", day: "numeric" });
    expect(checkedText(at.getTime(), new Date(2026, 9, 8, 9, 0).getTime())).toBe(`Checked ${date}, ${time}`);
    // Same day of the month, another month: still not today.
    expect(checkedText(at.getTime(), new Date(2026, 10, 7, 15, 6).getTime())).toBe(`Checked ${date}, ${time}`);
  });
});
