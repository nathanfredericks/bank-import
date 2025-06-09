import * as ynab from "ynab";
import { TransactionClearedStatus } from "ynab";
import { z } from "zod";
import { Account, BankName, bankNames } from "./banks/types.js";
import env from "./utils/env.js";
import logger from "./utils/logger.js";
import secrets from "./utils/secrets.js";

const ynabAPI = new ynab.API(secrets.YNAB_ACCESS_TOKEN);

export async function importTransactions(accounts: z.infer<typeof Account>[]) {
  logger.debug("Importing transactions to YNAB");

  logger.debug("Fetching YNAB accounts");
  const ynabAccounts = await ynabAPI.accounts
    .getAccounts(env.YNAB_BUDGET_ID)
    .then((response) =>
      response.data.accounts.filter((account) => !account.deleted),
    );

  if (
    !accounts.some(
      (account) => account.transactions && account.transactions.length,
    )
  ) {
    logger.debug("Imported 0 transaction(s)");
    return;
  }

  const importedTransactionMap: Record<string, number> = {};

  const findYnabAccount = (account: z.infer<typeof Account>) => {
    return ynabAccounts.find((ynabAccount) =>
      ynabAccount.note?.includes(account.id),
    );
  };

  const transactionsToImport = accounts
    .filter((account) => account.transactions && account.transactions.length)
    .flatMap((account) => {
      const matchedYnabAccount = findYnabAccount(account);

      if (!matchedYnabAccount) {
        return [];
      }

      return account.transactions
        .filter((transaction) => {
          const transactionDate = new Date(transaction.date);
          const now = new Date();
          const fiveYearsAgo = new Date();
          fiveYearsAgo.setFullYear(now.getFullYear() - 5);
          return transactionDate <= now && transactionDate >= fiveYearsAgo;
        })
        .map((transaction) => {
          const amount = Math.round(transaction.amount * 1000);

          const key = `${matchedYnabAccount.id}:${amount}:${transaction.date}`;
          if (importedTransactionMap[key]) {
            importedTransactionMap[key]++;
          } else {
            importedTransactionMap[key] = 1;
          }

          return {
            account_id: matchedYnabAccount.id,
            date: transaction.date,
            amount,
            payee_name: transaction.description,
            cleared: TransactionClearedStatus.Cleared,
            import_id: `YNAB:${amount}:${transaction.date}:${importedTransactionMap[key]}`,
          };
        });
    });

  if (!transactionsToImport.length) {
    logger.debug("Imported 0 transaction(s)");
    return;
  }

  const response = await ynabAPI.transactions.createTransactions(
    env.YNAB_BUDGET_ID,
    { transactions: transactionsToImport },
  );

  const { transactions: imported } = response.data;
  logger.debug(`Imported ${imported?.length} transaction(s)`, imported);
}

export async function updateAccountBalances(
  accounts: z.infer<typeof Account>[],
  bankName: BankName,
) {
  logger.debug("Updating account balances in YNAB");

  logger.debug("Fetching YNAB accounts");
  const ynabAccounts = await ynabAPI.accounts
    .getAccounts(env.YNAB_BUDGET_ID)
    .then((response) =>
      response.data.accounts.filter((account) => !account.deleted),
    );

  logger.debug(`Fetched ${ynabAccounts.length} YNAB accounts`);

  let adjustmentsCreated = 0;

  const findYnabAccount = (account: z.infer<typeof Account>) => {
    return ynabAccounts.find((ynabAccount) =>
      ynabAccount.note?.includes(account.id),
    );
  };

  for (const account of accounts) {
    const matchedYnabAccount = findYnabAccount(account);

    if (!matchedYnabAccount) {
      logger.debug(
        `No matching YNAB account found for bank account ${account.id}`,
      );
      continue;
    }

    const desiredBalance = Math.round(account.balance * 1000);
    const currentBalance = matchedYnabAccount.balance;
    const adjustment = desiredBalance - currentBalance;

    if (adjustment !== 0) {
      const transaction = {
        account_id: matchedYnabAccount.id,
        payee_id: "df22f16d-449b-4214-98da-2844de326faf",
        date: new Date().toLocaleDateString("en-CA", {
          timeZone: "America/Halifax",
        }),
        amount: adjustment,
        memo: `Entered automatically from ${bankNames[bankName]}`,
        cleared: TransactionClearedStatus.Reconciled,
        approved: true,
      };

      await ynabAPI.transactions.createTransaction(env.YNAB_BUDGET_ID, {
        transaction,
      });

      adjustmentsCreated++;
      logger.debug(
        `Created balance adjustment for YNAB account ${matchedYnabAccount.id} (${matchedYnabAccount.name}): ${adjustment} milliunits`,
      );
    } else {
      logger.debug(
        `No adjustment needed for YNAB account ${matchedYnabAccount.id} (${matchedYnabAccount.name})`,
      );
    }
  }

  logger.debug(`Created ${adjustmentsCreated} balance adjustment(s)`);
}
