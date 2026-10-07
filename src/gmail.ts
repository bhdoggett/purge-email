import { readFile, writeFile } from "node:fs/promises";
import { authenticate } from "@google-cloud/local-auth";
import { google, type gmail_v1 } from "googleapis";

const SCOPES = ["https://www.googleapis.com/auth/gmail.modify"];
const CREDENTIALS_PATH = "credentials.json";
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

/** Runs the browser OAuth flow and stores a refresh token in token.json. */
export async function login(): Promise<void> {
  const client = await authenticate({ keyfilePath: CREDENTIALS_PATH, scopes: SCOPES });
  const keys = JSON.parse(await readFile(CREDENTIALS_PATH, "utf8"));
  const key = keys.installed ?? keys.web;
  await writeFile(
    TOKEN_PATH,
    JSON.stringify({
      type: "authorized_user",
      client_id: key.client_id,
      client_secret: key.client_secret,
      refresh_token: client.credentials.refresh_token,
    }),
  );
}

export async function connect(): Promise<Gmail> {
  let token: string;
  try {
    token = await readFile(TOKEN_PATH, "utf8");
  } catch {
    throw new Error("No token.json. Run `npm run auth` first.");
  }
  const auth = google.auth.fromJSON(JSON.parse(token));
  return google.gmail({ version: "v1", auth: auth as never });
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
    const res = await gmail.users.messages.list({
      userId: "me",
      q,
      maxResults: 500,
      pageToken,
    });
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
  const res = await gmail.users.messages.get({
    userId: "me",
    id,
    format: "full",
    // Skip body data; we only need headers, snippet, and part filenames.
    fields:
      "id,threadId,labelIds,snippet,payload(headers,filename,parts(filename,parts(filename,parts(filename))))",
  });
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

export async function trash(gmail: Gmail, id: string): Promise<void> {
  await gmail.users.messages.trash({ userId: "me", id });
}
