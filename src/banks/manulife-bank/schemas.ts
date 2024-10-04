import { tz } from "@date-fns/tz";
import { formatISO } from "date-fns";
import { v5 as uuidv5 } from "uuid";
import { z } from "zod";
import env from "../../utils/env.js";

const Account = z
  .object({
    id: z.string(),
    displayName: z.string(),
    accountId: z.object({
      accountNumber: z.string(),
    }),
    balance: z.number(),
  })
  .transform((account) => ({
    id: uuidv5(account.accountId.accountNumber, env.UUID_NAMESPACE),
    name: `${account.displayName} (${account.accountId.accountNumber})`,
    balance: account.balance,
    _index: account.id,
  }));

const AccountResponse = z
  .object({
    assetAccounts: z.object({
      assetAccount: z.array(Account),
    }),
  })
  .transform(({ assetAccounts: { assetAccount: accounts } }) => accounts);

const Transaction = z
  .object({
    date: z.number(),
    description: z.string(),
    transactionAmount: z.number(),
  })
  .transform((transaction) => ({
    date: formatISO(new Date(transaction.date), {
      representation: "date",
      in: tz(env.TZ),
    }),
    amount: transaction.transactionAmount,
    description: transaction.description,
  }));

const TransactionsResponse = z
  .object({
    historyTransactions: z.object({
      transaction: z.array(Transaction),
    }),
  })
  .transform(
    ({ historyTransactions: { transaction: transactions } }) => transactions,
  );

export { Account, AccountResponse, TransactionsResponse };
