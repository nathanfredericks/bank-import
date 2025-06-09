import { v5 as uuidv5 } from "uuid";
import { z } from "zod";
import env from "../../utils/env";

const AuthnResponse = z
  .object({
    status: z.string(),
  })
  .transform(({ status }) => status === "MFA_REQUIRED");

const CurrencyEvaluation = z
  .object({
    CAD: z.object({
      total: z.number(),
    }),
  })
  .transform(({ CAD: { total } }) => total);

const Account = z
  .object({
    acctNo: z.string(),
    acctTypeDesc: z.string(),
    accountSummaryEvalByCurrency: CurrencyEvaluation,
  })
  .transform((account) => ({
    id: uuidv5(account.acctNo, env.UUID_NAMESPACE),
    name: account.acctTypeDesc,
    balance: account.accountSummaryEvalByCurrency,
    transactions: [],
  }));

const Portfolio = z.object({
  accountSummaries: z.array(Account),
});

const SummaryResponse = z
  .object({
    data: z.object({
      portfolioSummaryList: z.array(Portfolio),
    }),
  })
  .transform(({ data: { portfolioSummaryList } }) => {
    const [portfolio] = portfolioSummaryList;

    return portfolio.accountSummaries;
  });

export { AuthnResponse, SummaryResponse };
