import type { SystemOneResult } from "@typesafe-ai/sdk";

/** Bump when question wording or options change; older answers are then ignored. */
export const QUESTIONS_VERSION = 2;

export type PurgeKind =
  | "newsletter"
  | "promotion"
  | "social"
  | "securityAlert"
  | "shipping"
  | "scam"
  | "work"
  | "automated";
export type KindLabel = PurgeKind | "none";
export type ProtectId = "personal" | "financial" | "accountLegal";

export const PURGE_KINDS: readonly { id: PurgeKind; label: string; examples: string }[] = [
  { id: "newsletter", label: "Newsletters and mailing lists", examples: "Church or club bulletins, digests, mailing lists" },
  { id: "promotion", label: "Promotions", examples: "Sales, deals, coupons, marketing" },
  { id: "social", label: "Social notifications", examples: "Facebook, LinkedIn, Twitter updates" },
  { id: "securityAlert", label: "Security alerts", examples: "Password changed, new sign-in, verification codes" },
  { id: "shipping", label: "Shipping updates", examples: "Shipped, out for delivery, delivered" },
  { id: "scam", label: "Scams and phishing", examples: "Fake delivery notices, prize claims" },
  { id: "work", label: "Work email", examples: "Coworkers, work projects, meetings" },
  { id: "automated", label: "Other automated mail", examples: "App notifications, calendar invites, system mail" },
];

export const PROTECTS: readonly { id: ProtectId; label: string; examples: string }[] = [
  { id: "personal", label: "Family and friends", examples: "Personal mail between people you know" },
  { id: "financial", label: "Receipts and financial records", examples: "Orders, invoices, bank, tax, insurance" },
  { id: "accountLegal", label: "Account, legal, and medical records", examples: "Contracts, leases, medical, government" },
];

const KIND_CRITERIA = {
  newsletter: "Newsletter, mailing list, digest, or bulletin from an organization, church, club, or publication.",
  promotion: "Marketing, sales, deals, coupons, or other advertising.",
  social: "Notification from a social network, such as a like, comment, friend request, or activity summary.",
  securityAlert: "Automated account security message: password changed, new sign-in, verification code, or login alert.",
  shipping: "Shipping or delivery status update for a package.",
  scam: "Scam or phishing: fake delivery problems, prize claims, impersonated companies, requests for credentials or money.",
  work: "Work email: from coworkers, clients, or about work projects, meetings, or jobs.",
  automated: "Other automated or machine-sent notification not covered above.",
  none: "None of these, such as personal mail written by a person to the owner, receipts, or records.",
} satisfies Record<KindLabel, string>;

export const QUESTIONS = {
  kind: { type: "choice", instructions: "What kind of email is this?", criteria: KIND_CRITERIA },
  personal: {
    type: "noul",
    instructions: "Is this personal correspondence between the account owner and family or friends?",
    criteria: {
      true: "A real person the owner knows personally (family, friend, partner) writing about personal life, plans, news, photos, or feelings. Includes the owner's own replies in such threads.",
      false: "Work or professional mail, coworkers, recruiters, customer service, newsletters, marketing, automated notifications, or mail from strangers.",
    },
  },
  financial: {
    type: "noul",
    instructions: "Is this a receipt or financial record worth keeping?",
    criteria: {
      true: "Purchase receipt, invoice, order confirmation, bank or credit card statement, tax document, insurance, payroll, investment, or loan record.",
      false: "Promotional offers, sales, deals, or anything without a record of a real transaction or account.",
    },
  },
  accountLegal: {
    type: "noul",
    instructions: "Is this an account, legal, medical, or government record worth keeping?",
    criteria: {
      true: "Account creation or ownership details, contracts, leases, legal notices, medical records, government or immigration correspondence, warranties, licenses, or deeds.",
      false: "Routine notifications, marketing, social media updates, or password-reset and login alerts with no lasting value.",
    },
  },
} as const;

/**
 * Asked only for personal mail from someone who isn't close, when "Trivial personal mail" is on.
 * Kept apart from QUESTIONS so answers saved before it existed stay valid.
 */
export const SIGNIFICANCE_QUESTIONS = {
  meaningful: {
    type: "noul",
    instructions: "Is this email personally meaningful to keep?",
    criteria: {
      true: "Real news, milestones, life events, heartfelt or substantial conversation, memories, photos of people, or anything the owner would likely want to reread years later.",
      false: "Trivial logistics (running late, see you at 5), quick acknowledgements (ok, thanks, lol), forwards, chain mail, jokes, or small talk with no lasting value.",
    },
  },
} as const;

export interface Significance {
  /** Probability that the email is personally meaningful. */
  meaningful: number;
  inputTokens: number;
}

export function toSignificance(result: SystemOneResult<typeof SIGNIFICANCE_QUESTIONS>): Significance {
  return { meaningful: result.answers.meaningful.noul, inputTokens: result.usage.input_tokens };
}

export interface EmailFacts {
  from: string;
  to: string;
  cc: string;
  subject: string;
  date: string;
  snippet: string;
  ownerReplied: boolean;
  hasListUnsubscribe: boolean;
  labels: string[];
  attachmentNames: string[];
}

export function buildState(f: EmailFacts) {
  return {
    email: { from: f.from, to: f.to, cc: f.cc, subject: f.subject, date: f.date, snippet: f.snippet },
    facts: {
      ownerRepliedInThisThread: f.ownerReplied,
      hasListUnsubscribeHeader: f.hasListUnsubscribe,
      gmailLabels: f.labels,
      attachmentFileNames: f.attachmentNames,
    },
  };
}

export interface Answers {
  version: number;
  kind: Record<KindLabel, number>;
  protect: Record<ProtectId, number>;
  inputTokens: number;
  /** Probability the email is personally meaningful; missing until the significance question is asked. */
  significance?: number;
}

export function toAnswers(result: SystemOneResult<typeof QUESTIONS>): Answers {
  const p = result.answers.kind.probabilities;
  const kind = Object.fromEntries(
    (Object.keys(KIND_CRITERIA) as KindLabel[]).map((k) => [k, p[k] ?? 0]),
  ) as Record<KindLabel, number>;
  return {
    version: QUESTIONS_VERSION,
    kind,
    protect: {
      personal: result.answers.personal.noul,
      financial: result.answers.financial.noul,
      accountLegal: result.answers.accountLegal.noul,
    },
    inputTokens: result.usage.input_tokens,
  };
}
