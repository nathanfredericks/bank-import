import { v5 as uuidv5 } from "uuid";
import { z } from "zod";
import env from "../../utils/env.js";

const Account = z
  .object({
    accountNumber: z.string(),
    productName: z.string(),
    accountBalance: z.coerce.number(),
    accountIndex: z.number(),
    accountType: z.string(),
  })
  .transform((data) => ({
    id: uuidv5(data.accountNumber, env.UUID_NAMESPACE),
    name: `${data.productName} (${data.accountNumber})`,
    balance:
      data.accountBalance * (data.accountType === "CREDIT_CARD" ? -1 : 1),
    _index: data.accountIndex,
    _type: data.accountType,
  }));

const BaseCategory = z.object({
  products: z.array(Account).optional(),
});

const NestedCategory = BaseCategory.extend({
  categoryName: z.string(),
});

const InvestmentsCategory = BaseCategory.extend({
  categoryName: z.literal("IN"),
  categories: z.array(NestedCategory).optional(),
}).transform((data) => {
  const nestedAccounts = data.categories?.flatMap(
    (category) => category.products || [],
  );
  return {
    ...data,
    products: (data.products || []).concat(nestedAccounts || []),
  };
});

const CategoryName = z.enum(["BA", "CC", "LM", "IN"]);

const Category = BaseCategory.extend({
  categoryName: CategoryName.exclude(["IN"]),
});

const VerifyCredentialResponse = z
  .object({
    VerifyCredentialRs: z.object({
      BodyRs: z.object({
        isOTPSignIn: z.enum(["Y", "N"]),
        mySummary: z.object({
          categories: z
            .array(z.union([Category, InvestmentsCategory]))
            .optional(),
        }),
      }),
    }),
  })
  .transform(({ VerifyCredentialRs: { BodyRs: response } }) => ({
    isTwoFactorAuthenticationRequired: response.isOTPSignIn === "Y",
    accounts:
      response.mySummary?.categories?.flatMap(
        (category) => category.products || [],
      ) || null,
  }));

const AuthenticateResponse = z
  .object({
    AuthenticateRs: z.object({
      BodyRs: z.object({
        mySummary: z.object({
          categories: z.array(z.union([Category, InvestmentsCategory])),
        }),
      }),
    }),
  })
  .transform(({ AuthenticateRs: { BodyRs: response } }) =>
    response.mySummary.categories.flatMap(
      (category) => category.products || [],
    ),
  );

const VerifyTwoFactorAuthenticationCodeResponse = z
  .object({
    SignOnOTPRs: z.object({
      BodyRs: z.object({
        deviceBound: z.boolean(),
      }),
    }),
  })
  .transform(
    ({
      SignOnOTPRs: {
        BodyRs: { deviceBound },
      },
    }) => deviceBound,
  );

const BankAccountTransaction = z
  .object({
    txnDate: z.string(),
    descr: z.string(),
    txnAmount: z.string(),
  })
  .transform((transaction) => {
    return {
      date: transaction.txnDate,
      description: transaction.descr.replace(/\s+/g, " ").trim(),
      amount: parseFloat(transaction.txnAmount),
    };
  });

const BankAccountTransactionsResponse = z
  .object({
    GetBankAccountDetailsRs: z.object({
      BodyRs: z.object({
        bankAccountTransactions: z.array(BankAccountTransaction),
      }),
    }),
  })
  .transform(
    ({
      GetBankAccountDetailsRs: {
        BodyRs: { bankAccountTransactions },
      },
    }) => bankAccountTransactions,
  );

const CreditCardTransaction = z
  .object({
    txnDate: z.string().date(),
    postDate: z.string().date(),
    descr: z.string(),
    txnIndicator: z.literal("CR").optional(),
    amount: z.coerce.number(),
  })
  .transform((transaction) => {
    const isCredit = transaction.txnIndicator === "CR";
    return {
      date: isCredit ? transaction.postDate : transaction.txnDate,
      amount: transaction.amount * (isCredit ? 1 : -1),
      description: transaction.descr.replace(/\s+/g, " ").trim(),
    };
  });

const CreditCardTransactionsResponse = z
  .object({
    GetCCAccountDetailsRs: z.object({
      BodyRs: z.object({
        lendingTransactions: z.preprocess(
          (transactions: any) =>
            transactions.filter((transaction: any) => !!transaction.postDate),
          z.array(CreditCardTransaction),
        ),
      }),
    }),
  })
  .transform(
    ({
      GetCCAccountDetailsRs: {
        BodyRs: { lendingTransactions },
      },
    }) => lendingTransactions,
  );

export {
  Account,
  AuthenticateResponse,
  BankAccountTransactionsResponse,
  CreditCardTransactionsResponse,
  VerifyCredentialResponse,
  VerifyTwoFactorAuthenticationCodeResponse,
};
