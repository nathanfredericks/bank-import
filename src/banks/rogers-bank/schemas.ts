import { v5 as uuidv5 } from "uuid";
import { z } from "zod";
import env from "../../utils/env";

const UserResponse = z
  .object({
    authenticateResponse: z.object({
      accountId: z.string(),
      customerId: z.string(),
    }),
  })
  .transform(({ authenticateResponse }) => authenticateResponse);

const ValidateCodeResponse = z
  .object({
    validateCodeResponse: z.object({
      accountId: z.string(),
      customerId: z.string(),
    }),
  })
  .transform(({ validateCodeResponse }) => validateCodeResponse);

const AccountResponse = z
  .object({
    accountDetail: z.object({
      accountId: z.string(),
      productName: z.string(),
      currentBalance: z.object({
        value: z.coerce.number(),
      }),
      customer: z.object({
        cardLast4: z.string(),
      }),
    }),
  })
  .transform(({ accountDetail: data }) => ({
    id: uuidv5(data.accountId, env.UUID_NAMESPACE),
    name: `${data.productName} (************${data.customer.cardLast4})`,
    balance: data.currentBalance.value * -1,
  }));

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
      amount,
      description: transaction.merchant.name,
    };
  });

const TransactionsResponse = z
  .object({
    activitySummary: z.object({
      activities: z.preprocess(
        (transactions: any) =>
          transactions.filter((transaction: any) => !!transaction.postedDate),
        z.array(Transaction),
      ),
    }),
  })
  .transform(({ activitySummary }) => activitySummary.activities);

export {
  AccountResponse,
  TransactionsResponse,
  UserResponse,
  ValidateCodeResponse,
};
