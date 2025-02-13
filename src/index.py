import logging
from banks.bmo.BMO import BMO
from banks.manulife_bank.ManulifeBank import ManulifeBank
from banks.rogers_bank.RogersBank import RogersBank
from banks.tangerine.Tangerine import Tangerine
from banks.types import BankName
from utils.env import env
from utils.logger import logger
from utils.secrets import secrets
from ynab import import_transactions

try:
    if env.BANK == BankName.BMO:
        logger.info("Importing transactions from BMO")
        bmo = BMO.create(secrets.BMO_CARD_NUMBER, secrets.BMO_PASSWORD)
        bmo_accounts = bmo.get_accounts()
        import_transactions(bmo_accounts)
        logger.info("Imported transactions from BMO")
    elif env.BANK == BankName.Tangerine:
        logger.info("Importing transactions from Tangerine")
        tangerine = Tangerine.create(secrets.TANGERINE_LOGIN_ID, secrets.TANGERINE_PIN)
        tangerine_accounts = tangerine.get_accounts()
        if not tangerine_accounts:
            logger.error("Error fetching accounts from Tangerine")
            exit(1)
        import_transactions(tangerine_accounts)
        logger.info("Imported transactions from Tangerine")
    elif env.BANK == BankName.ManulifeBank:
        logger.info("Importing transactions from Manulife Bank")
        manulife_bank = ManulifeBank.create(secrets.MANULIFE_BANK_USERNAME, secrets.MANULIFE_BANK_PASSWORD)
        manulife_bank_accounts = manulife_bank.get_accounts()
        if not manulife_bank_accounts:
            logger.error("Error fetching accounts from Manulife Bank")
            exit(1)
        import_transactions(manulife_bank_accounts)
        logger.info("Imported transactions from Manulife Bank")
    elif env.BANK == BankName.RogersBank:
        logger.info("Importing transactions from Rogers Bank")
        rogers_bank = RogersBank.create(secrets.ROGERS_BANK_USERNAME, secrets.ROGERS_BANK_PASSWORD)
        rogers_bank_accounts = rogers_bank.get_accounts()
        if not rogers_bank_accounts:
            logger.error("Error fetching accounts from Rogers Bank")
            exit(1)
        import_transactions(rogers_bank_accounts)
        logger.info("Imported transactions from Rogers Bank")
except Exception as e:
    logger.error(e)
