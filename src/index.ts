import { BMO } from "./banks/bmo/BMO.js";
import { RogersBank } from "./banks/rogers-bank/RogersBank.js";
import { BankName } from "./banks/types.js";
import env from "./utils/env.js";
import logger from "./utils/logger.js";
import secrets from "./utils/secrets.js";
import { importTransactions } from "./ynab.js";

try {
  switch (env.BANK) {
    case BankName.BMO:
      logger.info("Importing transactions from BMO");
      const bmo = await BMO.create(
        secrets.BMO_CARD_NUMBER,
        secrets.BMO_PASSWORD,
      );
      const bmoAccounts = await bmo.getAccounts();
      await importTransactions(bmoAccounts);
      logger.info("Imported transactions from BMO");
      break;
    case BankName.RogersBank:
      logger.info("Importing transactions from Rogers Bank");
      const rogersBank = await RogersBank.create(
        secrets.ROGERS_BANK_USERNAME,
        secrets.ROGERS_BANK_PASSWORD,
      );
      const rogersBankAccounts = await rogersBank.getAccounts();
      if (!rogersBankAccounts.length) {
        logger.error("Error fetching accounts from Rogers Bank");
        process.exit(1);
      }
      await importTransactions(rogersBankAccounts);
      logger.info("Imported transactions from Rogers Bank");
  }
} catch (error) {
  console.error(error);
}
