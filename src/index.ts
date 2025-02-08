import { BMO } from "./banks/bmo/BMO.js";
import { ManulifeBank } from "./banks/manulife-bank/ManulifeBank.js";
import { RogersBank } from "./banks/rogers-bank/RogersBank.js";
import { Tangerine } from "./banks/tangerine/Tangerine.js";
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
      const bmoAccounts = bmo.getAccounts();
      await importTransactions(bmoAccounts);
      logger.info("Imported transactions from BMO");
      break;
    case BankName.Tangerine:
      logger.info("Importing transactions from Tangerine");
      const tangerine = await Tangerine.create(
        secrets.TANGERINE_LOGIN_ID,
        secrets.TANGERINE_PIN,
      );
      const tangerineAccounts = tangerine.getAccounts();
      if (!tangerineAccounts.length) {
        logger.error("Error fetching accounts from Tangerine");
        process.exit(1);
      }
      await importTransactions(tangerine.getAccounts());
      logger.info("Imported transactions from Tangerine");
      break;
    case BankName.ManulifeBank:
      logger.info("Importing transactions from Manulife Bank");
      const manulifeBank = await ManulifeBank.create(
        secrets.MANULIFE_BANK_USERNAME,
        secrets.MANULIFE_BANK_PASSWORD,
      );
      const manulifeBankAccounts = manulifeBank.getAccounts();
      if (!manulifeBankAccounts.length) {
        logger.error("Error fetching accounts from Manulife Bank");
        process.exit(1);
      }
      await importTransactions(manulifeBankAccounts);
      logger.info("Imported transactions from Manulife Bank");
      break;
    case BankName.RogersBank:
      logger.info("Importing transactions from Rogers Bank");
      const rogersBank = await RogersBank.create(
        secrets.ROGERS_BANK_USERNAME,
        secrets.ROGERS_BANK_PASSWORD,
      );
      const rogersBankAccounts = rogersBank.getAccounts();
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
