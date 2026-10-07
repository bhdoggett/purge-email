import { APIError } from "@typesafe-ai/sdk";
import { describe, expect, it } from "vitest";
import { AppError, SignInExpiredError } from "../bridge/errors.ts";
import { GmailError } from "../gmail/client.ts";
import { errorToStep } from "./errorToStep.ts";

const google = (code: string) => new AppError({ kind: "Google", detail: { code, message: "" } });

describe("errorToStep", () => {
  it.each([
    [google("access_denied"), 4],
    [google("SERVICE_DISABLED"), 3],
    [google("accessNotConfigured"), 3],
    [google("redirect_uri_mismatch"), 5],
    [google("invalid_client"), 5],
    [new AppError({ kind: "NotConfigured", detail: "jev" }), 1],
    [new AppError({ kind: "NotConfigured", detail: "google_client" }), 5],
    [new SignInExpiredError(), 6],
    [new AppError({ kind: "SignInTimeout" }), 6],
    [new GmailError(403, "SERVICE_DISABLED", "Gmail API has not been used"), 3],
    [new APIError(401, {}, new Headers()), 1],
  ])("maps %o to step %i", (err, step) => {
    expect(errorToStep(err)?.step).toBe(step);
  });

  it("returns null for errors it doesn't recognize", () => {
    expect(errorToStep(new Error("weird"))).toBeNull();
  });
});
