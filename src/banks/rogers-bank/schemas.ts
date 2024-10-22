import { v5 as uuidv5 } from "uuid";
import { z } from "zod";
import env from "../../utils/env.js";

const Account = z
  .object({
    accountId: z.string(),
    productName: z.string(),
    currentBalance: z.object({
      value: z.coerce.number(),
    }),
    customer: z.object({
      customerId: z.string(),
    }),
    previousStatementDate: z.string().optional(),
  })
  .transform((data) => ({
    id: uuidv5(data.accountId, env.UUID_NAMESPACE),
    name: `${data.productName} (${data.accountId})`,
    balance: data.currentBalance.value * -1,
    _number: data.accountId,
    _customerId: data.customer.customerId,
    _previousStatementDate: data.previousStatementDate,
  }));

const UserResponse = z
  .object({
    accounts: z.array(Account),
  })
  .transform(({ accounts }) => accounts);

const Transaction = z
  .object({
    amount: z.object({
      value: z.coerce.number(),
    }),
    date: z.string(),
    merchant: z.object({
      name: z.string(),
    }),
    postedDate: z.string(),
  })
  .transform((transaction) => {
    const amount = transaction.amount.value * -1;
    return {
      date: amount > 0 ? transaction.postedDate : transaction.date,
      amount: amount,
      description: transaction.merchant.name,
    };
  });

const ActivityResponse = z
  .object({
    activities: z.preprocess(
      (transactions: any) =>
        transactions.filter((transaction: any) => !!transaction.postedDate),
      z.array(Transaction),
    ),
  })
  .transform(({ activities }) => activities);

export { Account, ActivityResponse, UserResponse };
