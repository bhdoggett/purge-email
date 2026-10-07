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
  labeled: Set<string>;
  trashed: Set<string>;
  getSummaryCalls: number;
  failIds: Set<string>;
  expireAfter: number | null;
  spamIds: string[];
  trashErrors: Map<string, Error>;
  /** Age in years per message, used for `older_than:` queries. Defaults to 20. */
  ages: Map<string, number>;
}

/** In-memory Gmail. `labeled` holds IDs carrying the app's label. */
export function createFakeGmail(messages: Summary[]): FakeGmail {
  const byId = new Map(messages.map((m) => [m.id, m]));
  const fake: FakeGmail = {
    labeled: new Set(),
    trashed: new Set(),
    getSummaryCalls: 0,
    failIds: new Set(),
    expireAfter: null,
    spamIds: [],
    trashErrors: new Map(),
    ages: new Map(),
    async listIds(q, limit = Infinity) {
      let ids: { id: string; threadId: string }[];
      if (q.startsWith("in:sent")) ids = [];
      else if (q === "in:spam") ids = fake.spamIds.map((id) => ({ id, threadId: id }));
      else if (q.startsWith("label:")) ids = [...fake.labeled].filter((id) => (q.includes("in:anywhere") || !fake.trashed.has(id)) && !(q.includes("-is:starred") && byId.get(id)?.labels.includes("STARRED"))).map((id) => ({ id, threadId: id }));
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
    async ensureLabel() {
      return "L1";
    },
    async addLabel(_label, ids) {
      for (const id of ids) fake.labeled.add(id);
    },
    async removeLabel(_label, ids) {
      for (const id of ids) fake.labeled.delete(id);
    },
    async trash(id) {
      const err = fake.trashErrors.get(id);
      if (err) throw err;
      fake.trashed.add(id);
    },
    async getProfile() {
      return { emailAddress: "me@gmail.com" };
    },
  };
  return fake;
}
