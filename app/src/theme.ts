export type Theme = "light" | "dark";

const KEY = "purge-email-theme";

/** The stored choice wins; with none, the theme follows the system. */
export function resolveTheme(stored: string | null, systemDark: boolean): Theme {
  if (stored === "light" || stored === "dark") return stored;
  return systemDark ? "dark" : "light";
}

export const otherTheme = (t: Theme): Theme => (t === "dark" ? "light" : "dark");

function storedTheme(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

/** The theme in effect now. */
export function currentTheme(): Theme {
  return resolveTheme(storedTheme(), window.matchMedia("(prefers-color-scheme: dark)").matches);
}

/** Applies a stored choice at startup. Without one, tokens.css follows the system. */
export function applyStoredTheme(): void {
  const stored = storedTheme();
  if (stored === "light" || stored === "dark") document.documentElement.dataset.theme = stored;
}

export function setTheme(t: Theme): void {
  document.documentElement.dataset.theme = t;
  try {
    localStorage.setItem(KEY, t);
  } catch {
    // The choice still applies for this session.
  }
}
