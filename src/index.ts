import { BMO } from "./banks/bmo/BMO";
import { NBDB } from "./banks/nbdb/NBDB";
import { RogersBank } from "./banks/rogers-bank/RogersBank";
import { BankName } from "./banks/types";
import env from "./utils/env";
import logger from "./utils/logger";
import secrets from "./utils/secrets";
import { importTransactions, updateAccountBalances } from "./ynab";

switch (env.BANK) {
  case BankName.BMO:
    logger.info("Importing transactions from BMO");
    const bmo = await BMO.create(secrets.BMO_CARD_NUMBER, secrets.BMO_PASSWORD);
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
      throw new Error("Error fetching accounts from Rogers Bank");
    }
    await importTransactions(rogersBankAccounts);
    logger.info("Imported transactions from Rogers Bank");
    break;
  case BankName.NBDB:
    logger.info("Importing transactions from NBDB");
    const nbdb = await NBDB.create(secrets.NBDB_USER_ID, secrets.NBDB_PASSWORD);
    const nbdbAccounts = await nbdb.getAccounts();
    if (!nbdbAccounts.length) {
      throw new Error("Error fetching accounts from NBDB");
    }
    await updateAccountBalances(nbdbAccounts, BankName.NBDB);
    logger.info("Updated account balances from NBDB");
    break;
}
