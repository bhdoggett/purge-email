import { describe, expect, it, vi } from "vitest";
import { AppError, SignInExpiredError } from "../bridge/errors.ts";
import { createGmail, GmailError, isRateLimit } from "./client.ts";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
const rateLimited = () =>
  json(429, { error: { code: 429, message: "Quota exceeded", errors: [{ reason: "rateLimitExceeded" }] } });
const noSleep = () => Promise.resolve();

describe("gmail client", () => {
  it("retries rate limits until they clear and reports each wait", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(rateLimited())
      .mockResolvedValueOnce(rateLimited())
      .mockResolvedValueOnce(json(200, { emailAddress: "me@gmail.com" }));
    const onRateLimit = vi.fn();
    const gmail = createGmail({ fetch, sleep: noSleep, onRateLimit, random: () => 0.5 });
    await expect(gmail.getProfile()).resolves.toEqual({ emailAddress: "me@gmail.com" });
    expect(onRateLimit).toHaveBeenCalledTimes(2);
    expect(onRateLimit).toHaveBeenNthCalledWith(1, 2000);
  });

  it("retries server errors 5 times then throws", async () => {
    const fetch = vi.fn().mockImplementation(async () => json(503, { error: { code: 503, message: "busy" } }));
    const gmail = createGmail({ fetch, sleep: noSleep });
    await expect(gmail.getProfile()).rejects.toBeInstanceOf(GmailError);
    expect(fetch).toHaveBeenCalledTimes(6);
  });

  it("does not retry other client errors", async () => {
    const fetch = vi.fn().mockResolvedValue(
      json(403, { error: { code: 403, message: "Gmail API has not been used", details: [{ reason: "SERVICE_DISABLED" }] } }),
    );
    const gmail = createGmail({ fetch, sleep: noSleep });
    const err = await gmail.getProfile().catch((e) => e);
    expect(err).toBeInstanceOf(GmailError);
    expect(err.reason).toBe("SERVICE_DISABLED");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not retry the daily quota, even though its message mentions quota", async () => {
    const fetch = vi.fn().mockResolvedValue(
      json(403, { error: { code: 403, message: "Quota exceeded for quota metric 'Queries' and limit 'Queries per day'", errors: [{ reason: "dailyLimitExceeded" }] } }),
    );
    const onRateLimit = vi.fn();
    const err = await createGmail({ fetch, sleep: noSleep, onRateLimit }).getProfile().catch((e) => e);
    expect(err).toBeInstanceOf(GmailError);
    expect(err.reason).toBe("dailyLimitExceeded");
    expect(isRateLimit(err)).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(onRateLimit).not.toHaveBeenCalled();
    expect(isRateLimit(new GmailError(403, "unknown", "Quota exceeded for quota metric per minute"))).toBe(true);
  });

  it("retries proxy network errors but not an expired sign-in", async () => {
    const fetch = vi.fn()
      .mockRejectedValueOnce(new AppError({ kind: "Network", detail: "reset" }))
      .mockResolvedValueOnce(json(200, { emailAddress: "a" }));
    await expect(createGmail({ fetch, sleep: noSleep }).getProfile()).resolves.toEqual({ emailAddress: "a" });

    const expired = vi.fn().mockRejectedValue(new SignInExpiredError());
    await expect(createGmail({ fetch: expired, sleep: noSleep }).getProfile()).rejects.toBeInstanceOf(SignInExpiredError);
    expect(expired).toHaveBeenCalledTimes(1);
  });

  it("pages through listIds and stops at the limit", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json(200, { messages: [{ id: "1", threadId: "t1" }, { id: "2", threadId: "t2" }], nextPageToken: "p2" }))
      .mockResolvedValueOnce(json(200, { messages: [{ id: "3", threadId: "t3" }] }));
    const gmail = createGmail({ fetch, sleep: noSleep });
    expect(await gmail.listIds("older_than:10y")).toHaveLength(3);
    expect(fetch.mock.calls[1]![0]).toContain("pageToken=p2");

    const limited = createGmail({ fetch: vi.fn().mockResolvedValue(json(200, { messages: [{ id: "1", threadId: "t" }, { id: "2", threadId: "t" }], nextPageToken: "x" })), sleep: noSleep });
    expect(await limited.listIds("q", 1)).toEqual([{ id: "1", threadId: "t" }]);
  });

  it("handles an empty result with no messages field", async () => {
    const gmail = createGmail({ fetch: vi.fn().mockResolvedValue(json(200, { resultSizeEstimate: 0 })), sleep: noSleep });
    expect(await gmail.listIds("q")).toEqual([]);
  });

  it("builds a summary with nested attachment names and missing headers as empty strings", async () => {
    const fetch = vi.fn().mockResolvedValue(
      json(200, {
        id: "m1",
        threadId: "t1",
        labelIds: ["INBOX", "STARRED"],
        snippet: "hi",
        payload: {
          headers: [{ name: "From", value: "Mom <mom@x.com>" }, { name: "List-Unsubscribe", value: "<mailto:u>" }],
          parts: [{ filename: "" }, { filename: "", parts: [{ filename: "photo.jpg" }] }],
        },
      }),
    );
    const s = await createGmail({ fetch, sleep: noSleep }).getSummary("m1");
    expect(s).toEqual({
      id: "m1",
      threadId: "t1",
      from: "Mom <mom@x.com>",
      to: "",
      cc: "",
      subject: "",
      date: "",
      snippet: "hi",
      labels: ["INBOX", "STARRED"],
      hasListUnsubscribe: true,
      attachmentNames: ["photo.jpg"],
    });
  });

  it("splits label changes into batches of 1000", async () => {
    const fetch = vi.fn().mockImplementation(async () => new Response(null, { status: 204 }));
    const ids = Array.from({ length: 2500 }, (_, i) => String(i));
    await createGmail({ fetch, sleep: noSleep }).addLabel("L1", ids);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(JSON.parse(fetch.mock.calls[2]![1].body).ids).toHaveLength(500);
  });

  it("sends labelIds and includeSpamTrash on list requests", async () => {
    const fetch = vi.fn().mockResolvedValue(json(200, {}));
    await createGmail({ fetch, sleep: noSleep }).listIds("", undefined, { labelIds: ["L1"], includeSpamTrash: true });
    const url = fetch.mock.calls[0]![0] as string;
    expect(url).toContain("labelIds=L1");
    expect(url).toContain("includeSpamTrash=true");
  });

  it("creates the parent label before a nested child", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json(200, { labels: [] }))
      .mockResolvedValueOnce(json(200, { id: "P" }))
      .mockResolvedValueOnce(json(200, { id: "C" }));
    expect(await createGmail({ fetch, sleep: noSleep }).ensureLabel("purge/newsletter")).toBe("C");
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(JSON.parse(fetch.mock.calls[1]![1].body).name).toBe("purge");
    expect(JSON.parse(fetch.mock.calls[2]![1].body).name).toBe("purge/newsletter");
  });

  it("creates only the child when the parent label exists", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json(200, { labels: [{ id: "P", name: "purge" }] }))
      .mockResolvedValueOnce(json(200, { id: "C" }));
    expect(await createGmail({ fetch, sleep: noSleep }).ensureLabel("purge/newsletter")).toBe("C");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetch.mock.calls[1]![1].body).name).toBe("purge/newsletter");
  });

  it("finds a label id without creating anything", async () => {
    const fetch = vi.fn().mockImplementation(async () => json(200, { labels: [{ id: "L9", name: "y" }] }));
    const gmail = createGmail({ fetch, sleep: noSleep });
    expect(await gmail.findLabelId("x")).toBeNull();
    expect(await gmail.findLabelId("y")).toBe("L9");
    expect(fetch.mock.calls.every((c) => (c[1] as RequestInit).method === "GET")).toBe(true);
  });

  it("matches label names case-insensitively, like Gmail", async () => {
    const fetch = vi.fn().mockImplementation(async () => json(200, { labels: [{ id: "P", name: "Purge" }, { id: "C", name: "Purge/Newsletter" }] }));
    const gmail = createGmail({ fetch, sleep: noSleep });
    expect(await gmail.findLabelId("purge/newsletter")).toBe("C");
    expect(await gmail.ensureLabel("purge/newsletter")).toBe("C");
    expect(fetch.mock.calls.every((c) => (c[1] as RequestInit).method === "GET")).toBe(true);

    // Only the child is missing: the existing parent is reused whatever its case.
    const create = vi.fn()
      .mockResolvedValueOnce(json(200, { labels: [{ id: "P", name: "PURGE" }] }))
      .mockResolvedValueOnce(json(200, { id: "M" }));
    expect(await createGmail({ fetch: create, sleep: noSleep }).ensureLabel("purge/maybe")).toBe("M");
    expect(create).toHaveBeenCalledTimes(2);
    expect(JSON.parse(create.mock.calls[1]![1].body).name).toBe("purge/maybe");
  });
});
