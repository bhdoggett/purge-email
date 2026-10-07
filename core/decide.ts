import { type Answers, type ProtectId, type PurgeKind, PURGE_KINDS, PROTECTS, QUESTIONS_VERSION } from "./questions.ts";

export type Strictness = "careful" | "balanced" | "aggressive";

export const STRICTNESS: Record<Strictness, { purgeAt: number; protectAt: number }> = {
  careful: { purgeAt: 0.9, protectAt: 0.3 },
  balanced: { purgeAt: 0.8, protectAt: 0.5 },
  aggressive: { purgeAt: 0.6, protectAt: 0.7 },
};

export const REVIEW_AT = 0.5;

/** Personal mail is labeled trivial only when the chance it is meaningful is below this line. */
export const TRIVIAL_LINE: Record<Strictness, number> = { careful: 0.2, balanced: 0.3, aggressive: 0.4 };

/** Label slug for trivial personal mail. */
export const PERSONAL_SLUG = "personal";

export interface Settings {
  purgeKinds: PurgeKind[];
  protects: ProtectId[];
  /** Only mail at least this many months old is labeled; 0 means any age. */
  ageMonths: number;
  strictness: Strictness;
  labelPrefix: string;
  keepAttachments: boolean;
  keepStarred: boolean;
  /** Send each email's ~200-character body preview to Jev. Off: Jev judges from headers, labels and file names only. */
  sendPreviews: boolean;
  /** Label personal mail that Jev finds trivial, unless the sender is a close person. */
  trivialPersonal: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  purgeKinds: PURGE_KINDS.map((k) => k.id),
  protects: PROTECTS.map((p) => p.id),
  ageMonths: 120,
  strictness: "balanced",
  labelPrefix: "purge",
  keepAttachments: true,
  keepStarred: true,
  sendPreviews: true,
  trivialPersonal: false,
};

/**
 * Settings as stored by any version of the app. Older versions saved `years` instead of `ageMonths`;
 * missing fields come from `defaults`.
 */
export function normalizeSettings(raw: Partial<Settings> & { years?: number }, defaults: Settings): Settings {
  const { years, ...rest } = raw;
  const settings: Settings = { ...defaults, ...rest };
  if (rest.ageMonths === undefined && typeof years === "number") settings.ageMonths = years * 12;
  return settings;
}

/**
 * The moment `months` calendar months before `now` (local time). Mail received after it is too new.
 * A day the earlier month lacks becomes its last day (Mar 31 minus 1 month is Feb 28), never a later date.
 */
export function cutoff(now: number, months: number): number {
  const d = new Date(now);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() - months);
  const daysInMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, daysInMonth));
  return d.getTime();
}

export type Decision = "purge" | "keep" | "review";

export interface MessageFlags {
  starred: boolean;
  attachmentCount: number;
  /** ms since epoch from the Date header; null when it is missing or can't be read. */
  receivedAt: number | null;
  /**
   * The sender (for mail the user sent: any recipient) is one of the user's close people; null when
   * the address can't be read, so closeness is unknown.
   */
  senderClose: boolean | null;
  /** The close people list is known: Sent mail fully counted for the signed-in account. */
  closeKnown: boolean;
}

export interface DecideResult {
  decision: Decision;
  reason: string;
  /** Label slug chosen by the rule itself (trivial personal mail); otherwise labelFor picks the kind. */
  slug?: string;
}

const PERSONAL_UNCHECKED = "personal unchecked";

/**
 * True when the email would be labeled or kept by the trivial-personal rule, but Jev hasn't been
 * asked whether it is meaningful yet. Close or unknown senders, mail kept for other reasons, and mail
 * seen before the close list is known are never asked.
 */
export function needsSignificance(flags: MessageFlags, answers: Answers | null, settings: Settings, now: number): boolean {
  return flags.closeKnown && decide(flags, answers, settings, now).reason === PERSONAL_UNCHECKED;
}

export function decide(
  flags: MessageFlags,
  answers: Answers | null,
  settings: Settings,
  now: number,
): DecideResult {
  if (flags.starred && settings.keepStarred) return { decision: "keep", reason: "starred" };
  if (flags.attachmentCount > 0 && settings.keepAttachments) return { decision: "keep", reason: "attachment" };
  if (settings.ageMonths > 0) {
    // Mail with no readable date can't be shown to be old enough, so it is kept.
    if (flags.receivedAt === null) return { decision: "keep", reason: "no date" };
    if (flags.receivedAt > cutoff(now, settings.ageMonths)) return { decision: "keep", reason: "too new" };
  }
  if (!answers || answers.version !== QUESTIONS_VERSION) return { decision: "review", reason: "not judged" };

  const { purgeAt, protectAt } = STRICTNESS[settings.strictness];

  if (settings.trivialPersonal && answers.protect.personal >= protectAt) {
    const records = settings.protects
      .filter((id) => id !== "personal")
      .map((id) => [id, answers.protect[id]] as const)
      .sort((a, b) => b[1] - a[1]);
    const top = records[0];
    if (top && top[1] >= protectAt) return { decision: "keep", reason: `${top[0]} ${top[1].toFixed(2)}` };
    // Without a complete close list, nobody can be ruled out as close.
    if (!flags.closeKnown) return { decision: "keep", reason: PERSONAL_UNCHECKED };
    if (flags.senderClose === true) return { decision: "keep", reason: "close person" };
    if (flags.senderClose === null) return { decision: "keep", reason: "sender unknown" };
    const s = answers.significance;
    if (s === undefined) return { decision: "keep", reason: PERSONAL_UNCHECKED };
    if (s >= TRIVIAL_LINE[settings.strictness]) return { decision: "keep", reason: `meaningful ${s.toFixed(2)}` };
    return { decision: "purge", reason: `personal trivial ${(1 - s).toFixed(2)}`, slug: PERSONAL_SLUG };
  }

  const protects = settings.protects
    .map((id) => [id, answers.protect[id]] as const)
    .sort((a, b) => b[1] - a[1]);
  const topProtect = protects[0];
  if (topProtect && topProtect[1] >= protectAt) {
    return { decision: "keep", reason: `${topProtect[0]} ${topProtect[1].toFixed(2)}` };
  }

  const kinds = settings.purgeKinds
    .map((id) => [id, answers.kind[id]] as const)
    .filter(([, p]) => p >= 0.05)
    .sort((a, b) => b[1] - a[1]);
  const purgeScore = settings.purgeKinds.reduce((sum, id) => sum + answers.kind[id], 0);
  const reason = kinds.map(([id, p]) => `${id} ${p.toFixed(2)}`).join(", ") || `purge score ${purgeScore.toFixed(2)}`;

  if (purgeScore >= purgeAt) return { decision: "purge", reason };
  if (purgeScore >= REVIEW_AT) return { decision: "review", reason };
  return { decision: "keep", reason: `purge score ${purgeScore.toFixed(2)}` };
}
