import { APIError } from "@typesafe-ai/sdk";
import { AppError, errorAndCause } from "../bridge/errors.ts";
import { GmailError } from "../gmail/client.ts";
import type { Step } from "./steps.ts";

type Mapped = { step: Step; message: string };
const result = (step: Step, message: string): Mapped => ({ step, message });

const API_DISABLED = new Set(["SERVICE_DISABLED", "accessNotConfigured"]);
const SCOPE_INSUFFICIENT = new Set(["insufficientPermissions", "ACCESS_TOKEN_SCOPE_INSUFFICIENT"]);
const API_DISABLED_MESSAGE = "The Gmail API isn't turned on for your Google Cloud project yet. If you just turned it on, wait two minutes and try again.";
const SCOPE_MESSAGE = "Google didn't get permission to your Gmail. Sign in again and tick the box that allows access to Gmail.";

/** Maps a setup-related error to the wizard step that fixes it, or null if it isn't one. */
export function errorToStep(err: unknown): Mapped | null {
  for (const e of errorAndCause(err)) {
    const mapped = mapOne(e);
    if (mapped) return mapped;
  }
  return null;
}

function mapOne(err: unknown): Mapped | null {
  if (err instanceof APIError) {
    if (err.status === 401 || err.status === 403) return result(1, "TypeSafe didn't accept the Jev key. Check that you copied the whole key.");
    if (err.status === 402) return result(1, "Your TypeSafe account is out of credit. Add credit, then try again.");
    return null;
  }
  if (err instanceof GmailError) {
    if (API_DISABLED.has(err.reason)) return result(3, API_DISABLED_MESSAGE);
    if (err.status === 403 && SCOPE_INSUFFICIENT.has(err.reason)) return result(6, SCOPE_MESSAGE);
    return null;
  }
  if (!(err instanceof AppError)) return null;
  const p = err.payload;
  switch (p.kind) {
    case "SignInExpired":
      return result(6, "Your Google sign-in expired. Testing-mode sign-ins last 7 days. Sign in again.");
    case "SignInTimeout":
      return result(6, "The sign-in window closed before Google answered. Try again.");
    case "NotConfigured":
      if (p.detail === "jev") return result(1, "Add your Jev key first.");
      if (p.detail === "google_client") return result(5, "Add your Google client ID and secret first.");
      return result(6, "Sign in to Gmail first.");
    case "Google":
      if (p.detail.code === "access_denied") {
        return result(4, "Google blocked the sign-in. Add your Gmail address as a test user, then try again.");
      }
      if (API_DISABLED.has(p.detail.code)) return result(3, API_DISABLED_MESSAGE);
      if (SCOPE_INSUFFICIENT.has(p.detail.code)) return result(6, SCOPE_MESSAGE);
      if (["redirect_uri_mismatch", "invalid_client", "unauthorized_client"].includes(p.detail.code)) {
        return result(5, "Google didn't accept the client. Make sure its type is Desktop app and the ID and secret are copied exactly.");
      }
      return null;
    default:
      return null;
  }
}
