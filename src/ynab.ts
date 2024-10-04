import * as ynab from "ynab";
import { z } from "zod";
import { Account } from "./banks/types.js";
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

  if (!accounts.some((account) => !!account.transactions.length)) {
    logger.debug(`Imported 0 transaction(s)`);
    return;
  }

  const importedTransactionMap: Record<string, number> = {};
  const {
    data: { transactions },
  } = await ynabAPI.transactions.createTransactions(env.YNAB_BUDGET_ID, {
    transactions: accounts
      .filter((account) => !!account.transactions.length)
      .flatMap((account) =>
        account.transactions.map((transaction) => {
          const accountId = ynabAccounts.find((ynabAccount) =>
            ynabAccount.note?.includes(account.id),
          )?.id;
          const amount = Math.round(transaction.amount * 1000);
          const key = `${accountId}:${amount}:${transaction.date}`;

          if (importedTransactionMap[key]) {
            importedTransactionMap[key]++;
          } else {
            importedTransactionMap[key] = 1;
          }

          return {
            account_id: accountId,
            date: transaction.date,
            amount,
            payee_name: transaction.description,
            cleared: "cleared",
            import_id: `YNAB:${amount}:${transaction.date}:${importedTransactionMap[key]}`,
          };
        }),
      ),
  });

  logger.debug(`Imported ${transactions?.length} transaction(s)`, transactions);
}
