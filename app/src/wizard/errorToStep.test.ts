import { APIConnectionError, APIError } from "@typesafe-ai/sdk";
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
    [new APIError(403, {}, new Headers()), 1],
    [APIError.fromResponse(402, {}, new Headers()), 1],
    [google("unauthorized_client"), 5],
    [new AppError({ kind: "NotConfigured", detail: "google_token" }), 6],
    [google("insufficientPermissions"), 6],
    [google("ACCESS_TOKEN_SCOPE_INSUFFICIENT"), 6],
    [new GmailError(403, "insufficientPermissions", "Request had insufficient authentication scopes."), 6],
    [new GmailError(403, "ACCESS_TOKEN_SCOPE_INSUFFICIENT", "Request had insufficient authentication scopes."), 6],
    [new APIConnectionError("Connection error.", { cause: new AppError({ kind: "NotConfigured", detail: "jev" }) }), 1],
    [new APIConnectionError("Connection error.", { cause: new AppError({ kind: "Keychain", detail: "locked" }) }), null],
  ])("maps %o to step %s", (err, step) => {
    expect(errorToStep(err)?.step ?? null).toBe(step);
  });

  it("returns null for errors it doesn't recognize", () => {
    expect(errorToStep(new Error("weird"))).toBeNull();
    expect(errorToStep(google("something_new"))).toBeNull();
  });

  it("explains an out-of-credit TypeSafe account and missing Gmail permission", () => {
    expect(errorToStep(APIError.fromResponse(402, {}, new Headers()))?.message).toBe("Your TypeSafe account is out of credit. Add credit, then try again.");
    expect(errorToStep(new GmailError(403, "insufficientPermissions", "x"))?.message).toBe(
      "Google didn't get permission to your Gmail. Sign in again and tick the box that allows access to Gmail.",
    );
  });
});
