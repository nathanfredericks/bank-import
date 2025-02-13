import ynab
from ynab import TransactionClearedStatus
from pydantic import BaseModel
from typing import List
from .banks.types import Account
from .utils.env import env
from .utils.logger import logger
from .utils.secrets import secrets

ynabAPI = ynab.API(secrets.YNAB_ACCESS_TOKEN)

class Transaction(BaseModel):
    account_id: str
    date: str
    amount: int
    payee_name: str
    cleared: str
    import_id: str

async def import_transactions(accounts: List[Account]):
    logger.debug("Importing transactions to YNAB")

    logger.debug("Fetching YNAB accounts")
    ynab_accounts = await ynabAPI.accounts.get_accounts(env.YNAB_BUDGET_ID)
    ynab_accounts = [account for account in ynab_accounts.data.accounts if not account.deleted]

    if not any(account.transactions for account in accounts):
        logger.debug("Imported 0 transaction(s)")
        return

    imported_transaction_map = {}

    def find_ynab_account(account: Account):
        return next((ynab_account for ynab_account in ynab_accounts if account.id in (ynab_account.note or "")), None)

    transactions_to_import = []
    for account in accounts:
        if not account.transactions:
            continue

        matched_ynab_account = find_ynab_account(account)
        if not matched_ynab_account:
            continue

        for transaction in account.transactions:
            transaction_date = datetime.strptime(transaction.date, "%Y-%m-%d")
            now = datetime.now()
            five_years_ago = now - timedelta(days=5*365)
            if not (five_years_ago <= transaction_date <= now):
                continue

            amount = round(transaction.amount * 1000)
            key = f"{matched_ynab_account.id}:{amount}:{transaction.date}"
            imported_transaction_map[key] = imported_transaction_map.get(key, 0) + 1

            transactions_to_import.append(Transaction(
                account_id=matched_ynab_account.id,
                date=transaction.date,
                amount=amount,
                payee_name=transaction.description,
                cleared=TransactionClearedStatus.Cleared,
                import_id=f"YNAB:{amount}:{transaction.date}:{imported_transaction_map[key]}"
            ))

    if not transactions_to_import:
        logger.debug("Imported 0 transaction(s)")
        return

    response = await ynabAPI.transactions.create_transactions(env.YNAB_BUDGET_ID, {"transactions": transactions_to_import})
    imported = response.data.transactions
    logger.debug(f"Imported {len(imported)} transaction(s)", imported)
