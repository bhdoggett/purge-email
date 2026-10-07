import type { Answers } from "@core/questions.ts";
import { QUESTIONS_VERSION } from "@core/questions.ts";
import type { Gmail, Summary } from "../gmail/client.ts";

export function makeSummary(id: string, overrides: Partial<Summary> = {}): Summary {
  return { id, threadId: `t-${id}`, from: `sender ${id}`, to: "me", cc: "", subject: `subject ${id}`, date: "2014", snippet: "", labels: [], hasListUnsubscribe: false, attachmentNames: [], ...overrides };
}

export function fakeAnswers(kind: Partial<Answers["kind"]>, protect: Partial<Answers["protect"]> = {}): Answers {
  return {
    version: QUESTIONS_VERSION,
    kind: { newsletter: 0, promotion: 0, social: 0, securityAlert: 0, shipping: 0, scam: 0, work: 0, automated: 0, none: 0, ...kind },
    protect: { personal: 0, financial: 0, accountLegal: 0, ...protect },
    inputTokens: 1000,
  };
}

export interface FakeGmail extends Gmail {
  /** Message id -> label names. The fake uses the label name as the label id. */
  labelsOf: Map<string, Set<string>>;
  /** Messages the user moved to Trash in Gmail (the app never does). */
  trashed: Set<string>;
  getSummaryCalls: number;
  failIds: Set<string>;
  expireAfter: number | null;
  /** Age in years per message, used for `older_than:` queries. Defaults to 20. */
  ages: Map<string, number>;
}

/** In-memory Gmail. `labelsOf` maps each message to the label names it carries. */
export function createFakeGmail(messages: Summary[]): FakeGmail {
  const byId = new Map(messages.map((m) => [m.id, m]));
  const created = new Set<string>();
  const fake: FakeGmail = {
    labelsOf: new Map(),
    trashed: new Set(),
    getSummaryCalls: 0,
    failIds: new Set(),
    expireAfter: null,
    ages: new Map(),
    async listIds(q, limit = Infinity, opts) {
      let ids: { id: string; threadId: string }[];
      // The STARRED system label comes from the message summary; the others from `labelsOf`.
      const has = (id: string, set: Set<string>, n: string) => (n === "STARRED" ? (byId.get(id)?.labels.includes("STARRED") ?? false) : set.has(n));
      const withLabels = (names: string[], anywhere: boolean) =>
        [...fake.labelsOf]
          .filter(([id, set]) => names.every((n) => has(id, set, n)) && (anywhere || !fake.trashed.has(id)))
          .map(([id]) => ({ id, threadId: id }));
      if (opts?.labelIds) {
        if (q !== "") throw new Error(`the fake reads labels by id only, got q=${JSON.stringify(q)}`);
        ids = withLabels(opts.labelIds, opts.includeSpamTrash ?? false);
      } else if (q.startsWith("in:sent")) ids = [];
      else {
        const years = Number(/older_than:(\d+)y/.exec(q)?.[1] ?? 0);
        ids = messages.filter((m) => (fake.ages.get(m.id) ?? 20) >= years).map((m) => ({ id: m.id, threadId: m.threadId }));
      }
      return ids.slice(0, limit);
    },
    async getSummary(id) {
      fake.getSummaryCalls++;
      if (fake.expireAfter !== null && fake.getSummaryCalls > fake.expireAfter) {
        const { SignInExpiredError } = await import("../bridge/errors.ts");
        throw new SignInExpiredError();
      }
      if (fake.failIds.has(id)) throw new Error(`boom ${id}`);
      return byId.get(id)!;
    },
    async ensureLabel(name) {
      created.add(name);
      return name;
    },
    async findLabelId(name) {
      if (created.has(name) || [...fake.labelsOf.values()].some((set) => set.has(name))) return name;
      return null;
    },
    async addLabel(label, ids) {
      created.add(label);
      for (const id of ids) {
        const set = fake.labelsOf.get(id) ?? new Set<string>();
        set.add(label);
        fake.labelsOf.set(id, set);
      }
    },
    async removeLabel(label, ids) {
      for (const id of ids) fake.labelsOf.get(id)?.delete(label);
    },
    async getProfile() {
      return { emailAddress: "me@gmail.com" };
    },
  };
  return fake;
}

/** Ids of messages carrying `label`, in insertion order. */
export function idsWithLabel(fake: FakeGmail, label: string): string[] {
  return [...fake.labelsOf].filter(([, set]) => set.has(label)).map(([id]) => id);
}
