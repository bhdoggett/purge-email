import { decide, type Decision, type MessageFlags, type Settings } from "@core/decide.ts";
import { labelFor } from "@core/labels.ts";
import type { Answers } from "@core/questions.ts";
import type { Summary } from "../gmail/client.ts";
import type { Override } from "../storage/db.ts";
import { type CloseContext, parseAddresses, senderAddress } from "./closeness.ts";

export interface Effective {
  /** Full app label the email should carry, or null for none. */
  label: string | null;
  source: "jev" | "override";
  /** Jev's decision under `settings`, kept even when overridden so the table can explain it. */
  decision: Decision;
  reason: string;
}

/**
 * Whether the email involves a close person: the sender's address, or for mail the user sent (From
 * is the account, or the SENT label) any To or Cc recipient. Null when no address can be read.
 */
function closenessOf(summary: Summary, ctx: CloseContext): boolean | null {
  const from = senderAddress(summary.from);
  const sentByUser = summary.labels.includes("SENT") || (ctx.own !== null && from === ctx.own);
  if (sentByUser) {
    const recipients = parseAddresses([summary.to, summary.cc].filter(Boolean).join(", "), ctx.own ?? from ?? undefined);
    return recipients.length === 0 ? null : recipients.some((r) => ctx.close.has(r.address));
  }
  return from === null ? null : ctx.close.has(from);
}

/** What decide() needs to know about an email. An unreadable Date header gives a null `receivedAt`. */
export function flagsOf(summary: Summary, ctx: CloseContext): MessageFlags {
  const receivedAt = Date.parse(summary.date);
  return {
    starred: summary.labels.includes("STARRED"),
    attachmentCount: summary.attachmentNames.length,
    receivedAt: Number.isNaN(receivedAt) ? null : receivedAt,
    senderClose: closenessOf(summary, ctx),
    closeKnown: ctx.known,
  };
}

/** The one place that turns an email into its label, so Review, Apply and reconcile never disagree. */
export function effectiveLabel(summary: Summary, answers: Answers | null, override: Override | undefined, settings: Settings, now: number, close: CloseContext): Effective {
  const { decision, reason, slug } = decide(flagsOf(summary, close), answers, settings, now);
  if (override) {
    return { label: override.slug === null ? null : `${settings.labelPrefix}/${override.slug}`, source: "override", decision, reason };
  }
  return { label: labelFor(decision, answers, settings, slug), source: "jev", decision, reason };
}
