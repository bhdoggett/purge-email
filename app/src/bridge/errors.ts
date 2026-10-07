export type AppErrorPayload =
  | { kind: "SignInExpired" }
  | { kind: "SignInTimeout" }
  | { kind: "NotConfigured"; detail: string }
  | { kind: "HostNotAllowed"; detail: string }
  | { kind: "Google"; detail: { code: string; message: string } }
  | { kind: "Network"; detail: string }
  | { kind: "Keychain"; detail: string }
  | { kind: "Invalid"; detail: string };

function describe(p: AppErrorPayload): string {
  switch (p.kind) {
    case "SignInExpired":
      return "Google sign-in expired";
    case "SignInTimeout":
      return "The Google sign-in window timed out";
    case "Google":
      return `Google: ${p.detail.code} ${p.detail.message}`;
    default:
      return `${p.kind}: ${p.detail}`;
  }
}

export class AppError extends Error {
  constructor(public readonly payload: AppErrorPayload) {
    super(describe(payload));
  }
}

export class SignInExpiredError extends AppError {
  constructor() {
    super({ kind: "SignInExpired" });
  }
}

function isPayload(e: unknown): e is AppErrorPayload {
  return typeof e === "object" && e !== null && typeof (e as { kind?: unknown }).kind === "string";
}

/** Converts a rejected Tauri invoke value into an AppError. */
export function toAppError(e: unknown): AppError {
  if (e instanceof AppError) return e;
  if (isPayload(e)) return e.kind === "SignInExpired" ? new SignInExpiredError() : new AppError(e);
  return new AppError({ kind: "Network", detail: String(e) });
}
