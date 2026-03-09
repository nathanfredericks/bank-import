import { v5 as uuidv5 } from "uuid";
import { z } from "zod";
import env from "../../utils/env";

const AccountResponse = z
  .object({
    accountDetail: z.object({
      accountId: z.string(),
      productName: z.string(),
      currentBalance: z.object({
        value: z.coerce.number(),
      }),
      customer: z.object({
        customerId: z.string(),
        cardLast4: z.string(),
      }),
    }),
  })
  .transform(({ accountDetail: data }) => ({
    id: uuidv5(data.accountId, env.UUID_NAMESPACE),
    name: `${data.productName} (${data.customer.cardLast4})`,
    balance: data.currentBalance.value * -1,
    _accountId: data.accountId,
    _customerId: data.customer.customerId,
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

const PendingTransaction = z
  .object({
    activityId: z.string(),
    amount: z.object({
      value: z.coerce.number(),
    }),
    merchant: z.object({
      name: z.string(),
    }),
    date: z.string(),
    cardNumber: z.string(),
  })
  .transform((transaction) => ({
    activityId: transaction.activityId,
    amount: transaction.amount.value,
    merchant: transaction.merchant.name,
    date: transaction.date,
    cardNumber: transaction.cardNumber,
  }));

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

const PendingTransactionsResponse = z
  .object({
    activitySummary: z.object({
      activities: z.preprocess(
        (transactions: any) =>
          transactions.filter(
            (transaction: any) => transaction.activityStatus === "PENDING",
          ),
        z.array(PendingTransaction),
      ),
    }),
  })
  .transform(({ activitySummary }) => activitySummary.activities);

export { AccountResponse, PendingTransactionsResponse, TransactionsResponse };
