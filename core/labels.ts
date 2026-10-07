import { type Decision, PERSONAL_SLUG, type Settings } from "./decide.ts";
import { type Answers, PURGE_KINDS, type PurgeKind, QUESTIONS_VERSION } from "./questions.ts";

export const KIND_SLUGS: Record<PurgeKind, string> = {
  newsletter: "newsletter",
  promotion: "promotion",
  social: "social",
  securityAlert: "security-alert",
  shipping: "shipping",
  scam: "scam",
  work: "work",
  automated: "automated",
};
export const MAYBE = "maybe";
export { PERSONAL_SLUG };

/** The trivial personal mail category: a label of its own, but not a Jev kind. */
export const TRIVIAL_PERSONAL = {
  label: "Trivial personal mail",
  description: "Personal mail from people you're not close to that Jev finds trivial: logistics, quick replies, forwards.",
} as const;

/** Every label slug in display order with its name: the kinds, trivial personal mail, then maybe. */
export const SLUG_NAMES: readonly { slug: string; label: string }[] = [
  ...PURGE_KINDS.map((k) => ({ slug: KIND_SLUGS[k.id], label: k.label })),
  { slug: PERSONAL_SLUG, label: TRIVIAL_PERSONAL.label },
];

export function appLabelNames(prefix: string): string[] {
  return [...PURGE_KINDS.map((k) => `${prefix}/${KIND_SLUGS[k.id]}`), `${prefix}/${PERSONAL_SLUG}`, `${prefix}/${MAYBE}`];
}

export const ALL_SLUGS: readonly string[] = [...PURGE_KINDS.map((k) => KIND_SLUGS[k.id]), PERSONAL_SLUG, MAYBE];

export function kindOfSlug(slug: string): PurgeKind | null {
  return PURGE_KINDS.find((k) => KIND_SLUGS[k.id] === slug)?.id ?? null;
}

export function slugOfLabel(label: string, prefix: string): string | null {
  const head = `${prefix}/`;
  return label.startsWith(head) ? label.slice(head.length) : null;
}

/** Jev's top kind across every kind, checked or not: what a kept email would most likely be filed under. */
export function suggestedSlug(answers: Answers | null): string | null {
  if (!answers || answers.version !== QUESTIONS_VERSION) return null;
  let best: PurgeKind = PURGE_KINDS[0]!.id;
  for (const k of PURGE_KINDS) if (answers.kind[k.id] > answers.kind[best]) best = k.id;
  return KIND_SLUGS[best];
}

/** `slug` is the one decide() chose, if any; otherwise the strongest checked kind names the label. */
export function labelFor(decision: Decision, answers: Answers | null, settings: Settings, slug?: string): string | null {
  if (decision === "keep") return null;
  if (!answers || answers.version !== QUESTIONS_VERSION) return null;
  if (decision === "review") return `${settings.labelPrefix}/${MAYBE}`;
  if (slug !== undefined) return `${settings.labelPrefix}/${slug}`;
  let best: PurgeKind | null = null;
  for (const k of PURGE_KINDS) {
    if (!settings.purgeKinds.includes(k.id)) continue;
    if (best === null || answers.kind[k.id] > answers.kind[best]) best = k.id;
  }
  return best === null ? null : `${settings.labelPrefix}/${KIND_SLUGS[best]}`;
}

export function validatePrefix(raw: string): string | null {
  const s = raw.trim();
  if (!s) return "Enter a label name.";
  if (s.length > 40) return "Keep the label name to 40 characters or fewer.";
  if (!/^[A-Za-z0-9 _-]+$/.test(s)) return "Use letters, numbers, spaces, - or _ only.";
  return null;
}

/** Gmail age term for `months`, or null for 0 months (any age). */
export function olderThan(months: number): string | null {
  return months > 0 ? `older_than:${months}m` : null;
}

/** "1 month", "6 months", "2 years": whole years when the months divide by 12. */
export function ageText(months: number): string {
  const [n, unit] = months > 0 && months % 12 === 0 ? [months / 12, "year"] : [months, "month"];
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

export function candidateQuery(settings: Settings): string {
  return [
    olderThan(settings.ageMonths),
    settings.keepAttachments ? "-has:attachment" : null,
    settings.keepStarred ? "-is:starred" : null,
    "-in:spam -in:trash -in:chats",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * True when the rules `now` could include emails the scan under `atScan` never listed: a lower age
 * (0 is any age, the widest), or a protection turned off. Narrower rules need no rescan: decide()
 * keeps newer, starred and attachment mail from the wider candidate list.
 */
export function needsRescan(atScan: Settings, now: Settings): boolean {
  const ageWidened = atScan.ageMonths > 0 && (now.ageMonths === 0 || now.ageMonths < atScan.ageMonths);
  return ageWidened || (atScan.keepAttachments && !now.keepAttachments) || (atScan.keepStarred && !now.keepStarred);
}
