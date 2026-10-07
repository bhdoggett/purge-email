import pLimit from "p-limit";
import type { Gmail } from "../gmail/client.ts";
import type { SenderStat, SenderStats, Store } from "../storage/db.ts";

export type { SenderStat, SenderStats };

/** Someone is close, unless the user says otherwise, after this many emails sent to them... */
export const CLOSE_MIN_SENT = 10;
/** ...spread over at least this many different years. */
export const CLOSE_MIN_YEARS = 2;

/** Sent emails read between saves, so an interrupted count resumes from the last save. */
export const COUNT_BATCH = 200;

const NO_REPLY = /noreply|no-reply|donotreply/i;
const ADDRESS = /^[^\s@<>",;:()]+@[^\s@<>",;:()]+\.[^\s@<>",;:()]+$/;
const ADDRESS_IN_TEXT = /[^\s@<>",;:()]+@[^\s@<>",;:()]+\.[^\s@<>",;:()]+/;

/** Splits an address list on commas outside quotes and angle brackets. */
function splitList(header: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  let angle = false;
  for (let i = 0; i < header.length; i++) {
    const c = header[i]!;
    if (quoted && c === "\\" && i + 1 < header.length) {
      current += c + header[++i];
      continue;
    }
    if (c === '"') quoted = !quoted;
    else if (!quoted && c === "<") angle = true;
    else if (!quoted && c === ">") angle = false;
    if (c === "," && !quoted && !angle) {
      parts.push(current);
      current = "";
    } else current += c;
  }
  parts.push(current);
  return parts;
}

function cleanName(raw: string): string {
  let name = raw.trim();
  if (name.length >= 2 && name.startsWith('"') && name.endsWith('"')) name = name.slice(1, -1).replace(/\\(.)/g, "$1");
  return name.trim();
}

/**
 * Reads a To, Cc or From header into addresses (lowercase) with display names. Entries without a
 * valid address, no-reply addresses, and `own` (the account's own address) are left out.
 */
export function parseAddresses(header: string, own?: string): { address: string; name: string }[] {
  const out: { address: string; name: string }[] = [];
  const ownLower = own?.toLowerCase();
  for (const part of splitList(header)) {
    const text = part.trim();
    if (!text) continue;
    let address: string;
    let name = "";
    const open = text.lastIndexOf("<");
    const close = text.lastIndexOf(">");
    if (open >= 0 && close > open) {
      address = text.slice(open + 1, close).trim();
      name = cleanName(text.slice(0, open));
    } else {
      // A bare address, maybe with a comment or a group name around it.
      address = ADDRESS_IN_TEXT.exec(text)?.[0] ?? "";
    }
    address = address.toLowerCase();
    if (!ADDRESS.test(address) || NO_REPLY.test(address) || address === ownLower) continue;
    out.push({ address, name });
  }
  return out;
}

/** The sender's address of a From header, lowercase, or null when it can't be read. */
export function senderAddress(from: string): string | null {
  return parseAddresses(from)[0]?.address ?? null;
}

/**
 * Who counts as close: an explicit tick wins either way; with none, someone the user wrote to at
 * least CLOSE_MIN_SENT times over at least CLOSE_MIN_YEARS years.
 */
export function closeSet(stats: SenderStats | null, choices: Record<string, boolean>): Set<string> {
  const close = new Set<string>();
  for (const p of stats?.people ?? []) {
    if (choices[p.address] === undefined && isAutoClose(p)) close.add(p.address);
  }
  for (const [address, on] of Object.entries(choices)) if (on) close.add(address);
  return close;
}

export const isAutoClose = (p: Pick<SenderStat, "sent" | "years">): boolean => p.sent >= CLOSE_MIN_SENT && p.years.length >= CLOSE_MIN_YEARS;

/** The close set from what the store holds; empty when nothing was counted or chosen. */
export async function loadCloseSet(store: Store): Promise<Set<string>> {
  const [stats, choices] = await Promise.all([store.getSenderStats(), store.getCloseChoices()]);
  return closeSet(stats, choices);
}

function addMessage(people: Map<string, SenderStat>, headers: Record<string, string>, own: string): void {
  const at = Date.parse(headers.date ?? "");
  const year = Number.isNaN(at) ? null : new Date(at).getFullYear();
  const seen = new Set<string>();
  for (const { address, name } of parseAddresses([headers.to ?? "", headers.cc ?? ""].filter(Boolean).join(", "), own)) {
    if (seen.has(address)) continue;
    seen.add(address);
    const p = people.get(address) ?? { address, name: "", nameAt: 0, sent: 0, years: [] };
    p.sent++;
    if (year !== null && !p.years.includes(year)) p.years = [...p.years, year].sort((a, b) => a - b);
    if (name && (p.name === "" || (!Number.isNaN(at) && at >= p.nameAt))) {
      p.name = name;
      p.nameAt = Number.isNaN(at) ? 0 : at;
    }
    people.set(address, p);
  }
}

/**
 * Counts who the user writes to, from the To and Cc headers of their Sent mail (Gmail only; Jev
 * isn't used). Only mail not counted before is read, and the counts are saved after every batch.
 * `onProgress` gets sent emails counted so far and in all.
 */
export async function countSent(
  gmail: Gmail,
  store: Store,
  ownAddress: string,
  onProgress?: (done: number, total: number) => void,
  opts: { concurrency?: number } = {},
): Promise<SenderStats> {
  const own = ownAddress.toLowerCase();
  const saved = await store.getSenderStats();
  // Counts from another account (signed in as someone else since) start over.
  const base = saved && saved.ownAddress === own ? saved : { ownAddress: own, counted: [], people: [] };
  const counted = new Set(base.counted);
  const people = new Map(base.people.map((p) => [p.address, { ...p, years: [...p.years] }]));

  const ids = (await gmail.listIds("in:sent")).map((m) => m.id);
  const todo = ids.filter((id) => !counted.has(id));
  const total = ids.length;
  let done = total - todo.length;
  onProgress?.(done, total);

  const snapshot = (): SenderStats => ({ ownAddress: own, counted: [...counted], people: [...people.values()] });
  const run = pLimit(opts.concurrency ?? 4);
  for (let i = 0; i < todo.length; i += COUNT_BATCH) {
    const batch = todo.slice(i, i + COUNT_BATCH);
    // After one email fails, the rest of the batch is skipped and the batch is read again next time.
    let failure: { err: unknown } | null = null;
    const results = await Promise.all(
      batch.map((id) =>
        run(async () => {
          if (failure) return null;
          try {
            const headers = await gmail.getHeaders(id, ["To", "Cc", "Date"]);
            onProgress?.(++done, total);
            return headers;
          } catch (err) {
            failure ??= { err };
            return null;
          }
        }),
      ),
    );
    if (failure) throw (failure as { err: unknown }).err;
    results.forEach((headers, j) => {
      if (headers === null) return;
      addMessage(people, headers, own);
      counted.add(batch[j]!);
    });
    await store.putSenderStats(snapshot());
  }
  const stats = snapshot();
  if (todo.length === 0) await store.putSenderStats(stats);
  return stats;
}
