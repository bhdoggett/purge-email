import { AppError } from "../bridge/errors.ts";

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

export interface Summary {
  id: string;
  threadId: string;
  from: string;
  to: string;
  cc: string;
  subject: string;
  date: string;
  snippet: string;
  labels: string[];
  hasListUnsubscribe: boolean;
  attachmentNames: string[];
}

export class GmailError extends Error {
  constructor(
    public readonly status: number,
    public readonly reason: string,
    message: string,
  ) {
    super(message);
  }
}

/** Per-minute limits clear in seconds and are worth waiting out; the daily quota is not. */
export function isRateLimit(e: GmailError): boolean {
  if (e.reason === "dailyLimitExceeded") return false;
  if (e.status === 429) return true;
  return e.status === 403 && (/rateLimitExceeded|userRateLimitExceeded|RATE_LIMIT_EXCEEDED/.test(e.reason) || /quota|rate limit/i.test(e.message));
}

export interface GmailOptions {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
  onRateLimit?: (waitMs: number) => void;
  random?: () => number;
}

export interface ListOptions {
  labelIds?: string[];
  includeSpamTrash?: boolean;
}

export interface Gmail {
  listIds(q: string, limit?: number, opts?: ListOptions): Promise<{ id: string; threadId: string }[]>;
  getSummary(id: string): Promise<Summary>;
  ensureLabel(name: string): Promise<string>;
  findLabelId(name: string): Promise<string | null>;
  addLabel(labelId: string, ids: string[]): Promise<void>;
  removeLabel(labelId: string, ids: string[]): Promise<void>;
  getProfile(): Promise<{ emailAddress: string }>;
}

interface Part {
  filename?: string;
  headers?: { name?: string; value?: string }[];
  parts?: Part[];
}

function collectAttachmentNames(part: Part | undefined, out: string[]): void {
  if (!part) return;
  if (part.filename) out.push(part.filename);
  for (const child of part.parts ?? []) collectAttachmentNames(child, out);
}

async function toGmailError(res: Response): Promise<GmailError> {
  const text = await res.text();
  try {
    const err = JSON.parse(text).error ?? {};
    const reason = err.details?.[0]?.reason ?? err.errors?.[0]?.reason ?? err.status ?? "unknown";
    return new GmailError(res.status, reason, err.message ?? text);
  } catch {
    return new GmailError(res.status, "unknown", text);
  }
}

/** Gmail label names are case-insensitive: "Purge/News" and "purge/news" are the same label. */
function findByName(labels: { id: string; name: string }[] | undefined, name: string): string | undefined {
  const want = name.toLowerCase();
  return labels?.find((l) => l.name.toLowerCase() === want)?.id;
}

export function createGmail(opts: GmailOptions): Gmail {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = opts.random ?? Math.random;
  const backoff = (attempt: number) => Math.min(2 ** Math.min(attempt, 5) * 2000, 60_000) * (0.75 + random() * 0.5);

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await opts.fetch(BASE + path, {
          method,
          headers: body === undefined ? {} : { "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (err) {
        const transient = err instanceof AppError && err.payload.kind === "Network";
        if (!transient || attempt >= 5) throw err;
        await sleep(backoff(attempt));
        continue;
      }
      if (res.ok) {
        const text = await res.text();
        return (text ? JSON.parse(text) : undefined) as T;
      }
      const err = await toGmailError(res);
      const rateLimited = isRateLimit(err);
      if (!rateLimited && !(err.status >= 500 && attempt < 5)) throw err;
      const wait = backoff(attempt);
      if (rateLimited) opts.onRateLimit?.(wait);
      await sleep(wait);
    }
  }

  async function modify(labelId: string, ids: string[], key: "addLabelIds" | "removeLabelIds") {
    for (let i = 0; i < ids.length; i += 1000) {
      await call("POST", "/messages/batchModify", { ids: ids.slice(i, i + 1000), [key]: [labelId] });
    }
  }

  return {
    async listIds(q, limit = Infinity, listOpts) {
      const out: { id: string; threadId: string }[] = [];
      let pageToken: string | undefined;
      do {
        const params = new URLSearchParams({ q, maxResults: "500" });
        for (const id of listOpts?.labelIds ?? []) params.append("labelIds", id);
        if (listOpts?.includeSpamTrash) params.set("includeSpamTrash", "true");
        if (pageToken) params.set("pageToken", pageToken);
        const page = await call<{ messages?: { id: string; threadId: string }[]; nextPageToken?: string }>(
          "GET",
          `/messages?${params}`,
        );
        for (const m of page.messages ?? []) {
          out.push({ id: m.id, threadId: m.threadId });
          if (out.length >= limit) return out;
        }
        pageToken = page.nextPageToken;
      } while (pageToken);
      return out;
    },

    async getSummary(id) {
      const fields = "id,threadId,labelIds,snippet,payload(headers,filename,parts(filename,parts(filename,parts(filename))))";
      const m = await call<{ id: string; threadId: string; labelIds?: string[]; snippet?: string; payload?: Part }>(
        "GET",
        `/messages/${id}?format=full&fields=${encodeURIComponent(fields)}`,
      );
      const headers = new Map((m.payload?.headers ?? []).map((h) => [(h.name ?? "").toLowerCase(), h.value ?? ""]));
      const attachmentNames: string[] = [];
      collectAttachmentNames(m.payload, attachmentNames);
      return {
        id: m.id,
        threadId: m.threadId,
        from: headers.get("from") ?? "",
        to: headers.get("to") ?? "",
        cc: headers.get("cc") ?? "",
        subject: headers.get("subject") ?? "",
        date: headers.get("date") ?? "",
        snippet: m.snippet ?? "",
        labels: m.labelIds ?? [],
        hasListUnsubscribe: headers.has("list-unsubscribe"),
        attachmentNames,
      };
    },

    async ensureLabel(name) {
      const res = await call<{ labels?: { id: string; name: string }[] }>("GET", "/labels");
      const find = (n: string) => findByName(res.labels, n);
      const create = async (n: string) =>
        (await call<{ id: string }>("POST", "/labels", { name: n, labelListVisibility: "labelShow", messageListVisibility: "show" })).id;
      // Gmail nests by name: make sure the parent exists before the child.
      const slash = name.indexOf("/");
      if (slash > 0 && !find(name.slice(0, slash))) await create(name.slice(0, slash));
      return find(name) ?? (await create(name));
    },

    async findLabelId(name) {
      const res = await call<{ labels?: { id: string; name: string }[] }>("GET", "/labels");
      return findByName(res.labels, name) ?? null;
    },

    addLabel: (labelId, ids) => modify(labelId, ids, "addLabelIds"),
    removeLabel: (labelId, ids) => modify(labelId, ids, "removeLabelIds"),

    getProfile: () => call<{ emailAddress: string }>("GET", "/profile"),
  };
}
