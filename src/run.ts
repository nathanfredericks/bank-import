import * as ynab from "ynab";
import { NBDB } from "./banks/nbdb/NBDB";
import { RogersBank } from "./banks/rogers-bank/RogersBank";
import { BankName } from "./banks/types";
import env from "./utils/env";
import logger from "./utils/logger";
import secrets from "./utils/secrets";
import { createYnabImporter } from "./ynab";

export async function run() {
  const importer = createYnabImporter(new ynab.API(secrets.YNAB_ACCESS_TOKEN), {
    budgetId: env.YNAB_BUDGET_ID,
    adjustmentPayeeId: env.YNAB_ADJUSTMENT_PAYEE_ID,
    dryRun: env.DRY_RUN,
    log: (message) => logger.info(message),
  });
  logger.info(
    `Starting ${env.BANK}${env.DRY_RUN ? " (dry run; no YNAB writes)" : ""}`,
  );
  if (env.BANK === BankName.RogersBank) {
    const bank = await RogersBank.create(
      secrets.ROGERS_BANK_USERNAME,
      secrets.ROGERS_BANK_PASSWORD,
    );
    await importer.importTransactions(bank.getAccounts());
  } else {
    const bank = await NBDB.create(secrets.NBDB_USER_ID, secrets.NBDB_PASSWORD);
    const accounts = bank.getAccounts().filter((account) => {
      if (!env.NBDB_EXCLUDED_ACCOUNT_IDS.includes(account.id)) return true;
      logger.info(
        `Explicitly excluded NBDB account ${account.id} (${account.name})`,
      );
      return false;
    });
    await importer.updateAccountBalances(accounts);
  }
  logger.info(`Completed ${env.BANK}`);
}
