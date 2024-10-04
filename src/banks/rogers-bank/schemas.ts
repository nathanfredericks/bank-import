import { tz } from "@date-fns/tz";
import { formatISO, parse } from "date-fns";
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
  })
  .transform((data) => ({
    id: uuidv5(data.accountId, env.UUID_NAMESPACE),
    name: `${data.productName} (${data.accountId})`,
    balance: data.currentBalance.value * -1,
    _number: data.accountId,
    _customerId: data.customer.customerId,
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
    time: z.string(),
    merchant: z.object({
      name: z.string(),
    }),
  })
  .transform((transaction) => ({
    date: formatISO(
      parse(
        `${transaction.date} ${transaction.time}`,
        "yyyy-MM-dd HH:mm:ss",
        new Date(),
        {
          in: tz("America/Toronto"),
        },
      ),
      {
        representation: "date",
        in: tz(env.TZ),
      },
    ),
    amount: transaction.amount.value,
    description: transaction.merchant.name,
  }));

const ActivityResponse = z
  .object({
    activities: z.preprocess(
      (transactions: any) =>
        transactions.filter(
          (transaction: any) =>
            transaction.activityType === "TRANS" &&
            transaction.activityStatus === "APPROVED",
        ),
      z.array(Transaction),
    ),
  })
  .transform(({ activities }) => activities);
export { Account, ActivityResponse, UserResponse };
