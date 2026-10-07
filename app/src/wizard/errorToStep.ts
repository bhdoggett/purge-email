import { APIError } from "@typesafe-ai/sdk";
import { AppError } from "../bridge/errors.ts";
import { GmailError } from "../gmail/client.ts";

type Step = 1 | 2 | 3 | 4 | 5 | 6;
const result = (step: Step, message: string) => ({ step, message });

const API_DISABLED = new Set(["SERVICE_DISABLED", "accessNotConfigured"]);

export function errorToStep(err: unknown): { step: Step; message: string } | null {
  if (err instanceof APIError && (err.status === 401 || err.status === 403)) {
    return result(1, "TypeSafe didn't accept the Jev key. Check that you copied the whole key.");
  }
  if (err instanceof GmailError && API_DISABLED.has(err.reason)) {
    return result(3, "The Gmail API isn't turned on for your Google Cloud project yet. If you just turned it on, wait two minutes and try again.");
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
      if (API_DISABLED.has(p.detail.code)) {
        return result(3, "The Gmail API isn't turned on for your Google Cloud project yet. If you just turned it on, wait two minutes and try again.");
      }
      if (["redirect_uri_mismatch", "invalid_client", "unauthorized_client"].includes(p.detail.code)) {
        return result(5, "Google didn't accept the client. Make sure its type is Desktop app and the ID and secret are copied exactly.");
      }
      return null;
    case "Invalid":
      return null;
    default:
      return null;
  }
}
