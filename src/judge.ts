import { noul, TypeSafeClient } from "@typesafe-ai/sdk";
import type { MessageSummary } from "./gmail.ts";

// Accept JEV_API_KEY as an alias for the SDK's TYPESAFE_API_KEY.
const client = new TypeSafeClient({ apiKey: process.env.TYPESAFE_API_KEY ?? process.env.JEV_API_KEY });

// Each question is an independent "reason to keep". They run in parallel
// over the same state; code combines them into a decision.
const questions = {
  personal: noul(
    "Is this personal correspondence between the account owner and family or friends?",
    {
      true: "A real person the owner knows personally (family, friend, partner) writing about personal life, plans, news, photos, or feelings. Includes the owner's own replies in such threads.",
      false:
        "Work or professional mail, coworkers, recruiters, customer service, newsletters, marketing, automated notifications, or mail from strangers.",
    },
  ),
  financial: noul("Is this a receipt or financial record worth keeping?", {
    true: "Purchase receipt, invoice, order confirmation, bank or credit card statement, tax document, insurance, payroll, investment, or loan record.",
    false: "Promotional offers, sales, deals, or anything without a record of a real transaction or account.",
  }),
  accountLegal: noul("Is this an account, legal, medical, or government record worth keeping?", {
    true: "Account creation or ownership details, contracts, leases, legal notices, medical records, government or immigration correspondence, warranties, licenses, or deeds.",
    false: "Routine notifications, marketing, social media updates, or password-reset and login alerts with no lasting value.",
  }),
  bulk: noul("Is this bulk or automated mail?", {
    true: "Newsletter, marketing, promotion, social network notification, mailing list, or other machine-sent message.",
    false: "Written by a person to the owner specifically.",
  }),
};

export type Judgment = { [K in keyof typeof questions]: number };

export async function judge(msg: MessageSummary, youRepliedInThread: boolean): Promise<Judgment> {
  const res = await client.systemOne({
    state: {
      email: {
        from: msg.from,
        to: msg.to,
        cc: msg.cc,
        subject: msg.subject,
        date: msg.date,
        snippet: msg.snippet,
      },
      facts: {
        ownerRepliedInThisThread: youRepliedInThread,
        hasListUnsubscribeHeader: msg.hasListUnsubscribe,
        gmailLabels: msg.labels,
      },
    },
    questions,
  });
  return {
    personal: res.answers.personal.noul,
    financial: res.answers.financial.noul,
    accountLegal: res.answers.accountLegal.noul,
    bulk: res.answers.bulk.noul,
  };
}
