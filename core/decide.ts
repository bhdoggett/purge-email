import { type Answers, type ProtectId, type PurgeKind, PURGE_KINDS, PROTECTS, QUESTIONS_VERSION } from "./questions.ts";

export type Strictness = "careful" | "balanced" | "aggressive";

export const STRICTNESS: Record<Strictness, { purgeAt: number; protectAt: number }> = {
  careful: { purgeAt: 0.9, protectAt: 0.3 },
  balanced: { purgeAt: 0.8, protectAt: 0.5 },
  aggressive: { purgeAt: 0.6, protectAt: 0.7 },
};

export const REVIEW_AT = 0.5;

export interface Settings {
  purgeKinds: PurgeKind[];
  protects: ProtectId[];
  years: number;
  strictness: Strictness;
}

export const DEFAULT_SETTINGS: Settings = {
  purgeKinds: PURGE_KINDS.map((k) => k.id),
  protects: PROTECTS.map((p) => p.id),
  years: 10,
  strictness: "balanced",
};

export type Decision = "purge" | "keep" | "review";

export interface MessageFlags {
  starred: boolean;
  attachmentCount: number;
}

export function decide(
  flags: MessageFlags,
  answers: Answers | null,
  settings: Settings,
): { decision: Decision; reason: string } {
  if (flags.starred) return { decision: "keep", reason: "starred" };
  if (flags.attachmentCount > 0) return { decision: "keep", reason: "attachment" };
  if (!answers || answers.version !== QUESTIONS_VERSION) return { decision: "review", reason: "not judged" };

  const { purgeAt, protectAt } = STRICTNESS[settings.strictness];

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
