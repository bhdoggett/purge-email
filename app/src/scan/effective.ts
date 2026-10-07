import { decide, type Decision, type Settings } from "@core/decide.ts";
import { labelFor } from "@core/labels.ts";
import type { Answers } from "@core/questions.ts";
import type { Summary } from "../gmail/client.ts";
import type { Override } from "../storage/db.ts";

export interface Effective {
  /** Full app label the email should carry, or null for none. */
  label: string | null;
  source: "jev" | "override";
  /** Jev's decision under `settings`, kept even when overridden so the table can explain it. */
  decision: Decision;
  reason: string;
}

/** The one place that turns an email into its label, so Review, Apply and reconcile never disagree. */
export function effectiveLabel(summary: Summary, answers: Answers | null, override: Override | undefined, settings: Settings): Effective {
  const { decision, reason } = decide({ starred: summary.labels.includes("STARRED"), attachmentCount: summary.attachmentNames.length }, answers, settings);
  if (override) {
    return { label: override.slug === null ? null : `${settings.labelPrefix}/${override.slug}`, source: "override", decision, reason };
  }
  return { label: labelFor(decision, answers, settings), source: "jev", decision, reason };
}
