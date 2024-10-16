import { tz } from "@date-fns/tz";
import { formatISO } from "date-fns";
import { v5 as uuidv5 } from "uuid";
import { z } from "zod";
import env from "../../utils/env.js";

const Account = z
  .object({
    type: z.enum(["CHEQUING", "SAVINGS", "CREDIT_CARD"]),
    number: z.string(),
    account_balance: z.number(),
    display_name: z.string(),
    description: z.string(),
  })
  .transform((account) => ({
    id: uuidv5(account.number, env.UUID_NAMESPACE),
    name: `${account.description} (${account.display_name})`,
    balance:
      account.account_balance * (account.type === "CREDIT_CARD" ? -1 : 1),
    _number: account.number,
  }));

const AccountResponse = z
  .object({
    accounts: z.array(Account),
  })
  .transform(({ accounts }) => accounts);

const Transaction = z
  .object({
    transaction_date: z.string(),
    posted_date: z.string(),
    amount: z.number(),
    description: z.string(),
    is_uncleared: z.boolean(),
    status: z.string(),
  })
  .transform((transaction) => {
    const date =
      transaction.amount > 0
        ? transaction.posted_date
        : transaction.transaction_date;
    return {
      date: formatISO(date, {
        representation: "date",
        in: tz(env.TZ),
      }),
      amount: transaction.amount,
      description: transaction.description,
    };
  });

const TransactionsResponse = z
  .object({
    transactions: z.array(Transaction),
  })
  .transform(({ transactions }) => transactions);

export { Account, AccountResponse, TransactionsResponse };
