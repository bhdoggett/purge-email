import { describe, expect, it } from "vitest";
import { appliedMessage, buildRows, gmailLabelUrl, previewSummary, SETTLING_NOTE, totalOf } from "./applyModel.ts";

describe("applyModel", () => {
  const counts = new Map([["purge/maybe", 4], ["purge/shipping", 2], ["purge/newsletter", 5], ["purge/scam", 0]]);

  it("orders kinds by PURGE_KINDS with maybe last and drops empty labels", () => {
    expect(buildRows(counts, "purge").map((r) => r.name)).toEqual(["purge/newsletter", "purge/shipping", "purge/maybe"]);
  });

  it("totals all rows", () => {
    expect(totalOf(buildRows(counts, "purge"))).toBe(11);
  });

  it("words the settling note for Apply", () => {
    expect(SETTLING_NOTE).toBe("Some labels are still settling in Gmail. Try Apply again in a few minutes.");
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
});
