import { describe, expect, it } from "vitest";
import { otherTheme, resolveTheme } from "./theme.ts";

describe("theme", () => {
  it("uses the stored choice, else the system setting", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme(null, true)).toBe("dark");
    expect(resolveTheme(null, false)).toBe("light");
    expect(resolveTheme("bogus", true)).toBe("dark");
  });

  it("toggles between light and dark", () => {
    expect(otherTheme("light")).toBe("dark");
    expect(otherTheme("dark")).toBe("light");
  });
});
