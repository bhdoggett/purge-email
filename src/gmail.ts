import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { google, type gmail_v1 } from "googleapis";

const SCOPES = ["https://www.googleapis.com/auth/gmail.modify"];
const TOKEN_PATH = "token.json";

export type Gmail = gmail_v1.Gmail;

export interface MessageSummary {
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

function oauthClient(redirectUri?: string) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env");
  }
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

/**
 * Runs the browser OAuth flow on a loopback port and stores the refresh token
 * in token.json. Requires a "Desktop app" OAuth client, which accepts any
 * loopback redirect port.
 */
export async function login(): Promise<void> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const client = oauthClient(`http://127.0.0.1:${port}`);
  const url = client.generateAuthUrl({ access_type: "offline", prompt: "consent", scope: SCOPES });

  const code = await new Promise<string>((resolve, reject) => {
    server.on("request", (req, res) => {
      const params = new URL(req.url ?? "/", `http://127.0.0.1:${port}`).searchParams;
      const code = params.get("code");
      // Ignore stray requests such as /favicon.ico.
      if (!code && !params.has("error")) {
        res.statusCode = 404;
        res.end();
        return;
      }
      res.end(code ? "Authorized. You can close this tab." : `Authorization failed: ${params.get("error")}`);
      if (code) resolve(code);
      else reject(new Error(`OAuth error: ${params.get("error")}`));
    });
    console.log(`Opening browser. If it doesn't open, visit:\n${url}`);
    execFile("open", [url]);
  });
  server.close();

  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) throw new Error("Google returned no refresh token. Try again.");
  await writeFile(TOKEN_PATH, JSON.stringify({ refresh_token: tokens.refresh_token }));
}

export async function connect(): Promise<Gmail> {
  let token: string;
  try {
    token = await readFile(TOKEN_PATH, "utf8");
  } catch {
    throw new Error("No token.json. Run `npm run auth` first.");
  }
  const auth = oauthClient();
  auth.setCredentials(JSON.parse(token));
  return google.gmail({ version: "v1", auth });
}

function isRateLimit(err: unknown): boolean {
  const e = err as { status?: number; message?: string };
  return e.status === 429 || (e.status === 403 && /quota|rate limit/i.test(e.message ?? ""));
}

/** Retries Gmail calls that hit per-minute quota, backing off up to about a minute. */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isRateLimit(err) || attempt >= 6) throw err;
      const delay = Math.min(2 ** attempt * 2000, 60_000) * (0.75 + Math.random() * 0.5);
      console.warn(`Gmail rate limit hit; retrying in ${Math.round(delay / 1000)}s`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

/** Lists message IDs (and their thread IDs) matching a Gmail search query. */
export async function listIds(
  gmail: Gmail,
  q: string,
  limit = Infinity,
): Promise<{ id: string; threadId: string }[]> {
  const out: { id: string; threadId: string }[] = [];
  let pageToken: string | undefined;
  do {
    const res = await withRetry(() => gmail.users.messages.list({
      userId: "me",
      q,
      maxResults: 500,
      pageToken,
    }));
    for (const m of res.data.messages ?? []) {
      if (m.id && m.threadId) out.push({ id: m.id, threadId: m.threadId });
      if (out.length >= limit) return out;
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return out;
}

function collectAttachmentNames(part: gmail_v1.Schema$MessagePart | undefined, out: string[]): void {
  if (!part) return;
  if (part.filename) out.push(part.filename);
  for (const child of part.parts ?? []) collectAttachmentNames(child, out);
}

export async function getSummary(gmail: Gmail, id: string): Promise<MessageSummary> {
  const res = await withRetry(() => gmail.users.messages.get({
    userId: "me",
    id,
    format: "full",
    // Skip body data; we only need headers, snippet, and part filenames.
    fields:
      "id,threadId,labelIds,snippet,payload(headers,filename,parts(filename,parts(filename,parts(filename))))",
  }));
  const m = res.data;
  const headers = new Map(
    (m.payload?.headers ?? []).map((h) => [h.name?.toLowerCase() ?? "", h.value ?? ""]),
  );
  const attachmentNames: string[] = [];
  collectAttachmentNames(m.payload, attachmentNames);
  return {
    id: m.id ?? id,
    threadId: m.threadId ?? "",
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
}

/** Returns the ID of the user label with this name, creating it if needed. */
export async function ensureLabel(gmail: Gmail, name: string): Promise<string> {
  const res = await gmail.users.labels.list({ userId: "me" });
  const existing = res.data.labels?.find((l) => l.name === name);
  if (existing?.id) return existing.id;
  const created = await gmail.users.labels.create({
    userId: "me",
    requestBody: { name, labelListVisibility: "labelShow", messageListVisibility: "show" },
  });
  return created.data.id!;
}

export async function addLabel(gmail: Gmail, labelId: string, ids: string[]): Promise<void> {
  // batchModify accepts up to 1000 IDs per call.
  for (let i = 0; i < ids.length; i += 1000) {
    await withRetry(() =>
      gmail.users.messages.batchModify({
        userId: "me",
        requestBody: { ids: ids.slice(i, i + 1000), addLabelIds: [labelId] },
      }),
    );
  }
}

export async function trash(gmail: Gmail, id: string): Promise<void> {
  await withRetry(() => gmail.users.messages.trash({ userId: "me", id }));
}
